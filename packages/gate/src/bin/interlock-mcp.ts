#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InvariantViolation, Mandate, loadEnv, type Mandate as MandateType } from '@interlock/core';
import { openStore, type Store } from '@interlock/store';
import { parse } from 'yaml';
import { createReconciler } from '../exactly-once/reconciler.js';
import { createRecovery } from '../exactly-once/recovery.js';
import { createWal } from '../exactly-once/wal.js';
import { createMockRail, type MockRail } from '../rail/mock.js';
import type { Rail } from '../rail/rail.js';
import { createEngine } from '../proxy/engine.js';
import { createProxyServer } from '../proxy/server.js';
import { createUpstream, type Upstream, type UpstreamTool } from '../proxy/upstream.js';

/**
 * `interlock-mcp` — the front door.
 *
 * An agent points at this instead of at the payment API's MCP server. One line
 * of config changes and no code does:
 *
 *   "mcpServers": {
 *     "razorpay": { "command": "npx", "args": ["-y", "interlock-mcp", "--mandate", "./mandate.yaml"] }
 *   }
 *
 * Everything the agent sends arrives on stdin as MCP, goes through the gate
 * ladder and the exactly-once engine, and only then reaches the rail.
 *
 * STDOUT IS THE PROTOCOL CHANNEL. Every diagnostic in this file goes to stderr;
 * a stray console.log here corrupts the JSON-RPC stream and the agent sees a
 * parse error rather than a refund.
 */

const VERSION = '0.1.0';

const HELP = `interlock-mcp ${VERSION}

An MCP proxy that sits between an AI agent and a payment API so the agent
cannot pay twice, and cannot pay more than it was authorised to.

USAGE
  interlock-mcp --mandate <path> [options]

OPTIONS
  --mandate <path>       Mandate YAML a human approved. Required.
                         Generate one with: interlock init --upstream <url>
  --rail <name>          mock (default) | razorpay
  --db <path>            SQLite ledger. Defaults to INTERLOCK_DB_PATH.
  --upstream-command <c> Spawn a real upstream MCP server, e.g.
                         --upstream-command "docker run -i --rm razorpay/mcp"
                         Omit to use the built-in mock rail.
  --agent <id>           Agent identity checked by Gate 1. Defaults to the
                         mandate's agent_id.
  --purpose-check        Enable the advisory purpose gate. NOT IMPLEMENTED in
                         v0.1 — the flag exists so the default is visibly "off".
  --help, --version

ENVIRONMENT
  INTERLOCK_DB_PATH        where the ledger lives (required unless --db)
  INTERLOCK_CONSOLE_TOKEN  bearer token for the operator console (required)
  RAZORPAY_KEY_ID/SECRET   required only when --rail razorpay

The money path is deterministic. No model is consulted at decision time.
`;

interface Args {
  readonly mandate: string | undefined;
  readonly rail: string;
  readonly db: string | undefined;
  readonly upstreamCommand: string | undefined;
  readonly agent: string | undefined;
  readonly purposeCheck: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    mandate: flag('mandate'),
    rail: flag('rail') ?? 'mock',
    db: flag('db'),
    upstreamCommand: flag('upstream-command'),
    agent: flag('agent'),
    purposeCheck: argv.includes('--purpose-check'),
  };
}

/** stderr, always. stdout belongs to the protocol. */
function note(message: string): void {
  process.stderr.write(`interlock: ${message}\n`);
}

export function loadMandate(path: string): MandateType {
  const raw = readFileSync(resolve(path), 'utf8');
  const parsed = Mandate.safeParse(parse(raw));
  if (!parsed.success) {
    throw new InvariantViolation(
      'bin.mandate',
      `${path} is not a valid mandate:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join('.')} ${i.message}`).join('\n'),
    );
  }
  return parsed.data;
}

/**
 * The tools we present when there is no upstream server to ask.
 *
 * Used by the mock rail so the demo is self-contained. With
 * --upstream-command we ask the real server instead and never invent a manifest.
 */
export const MOCK_MANIFEST: readonly UpstreamTool[] = [
  {
    name: 'fetch_payment',
    description: 'Fetch a payment by id.',
    inputSchema: { type: 'object', properties: { payment_id: { type: 'string' } } },
  },
  {
    name: 'fetch_order',
    description: 'Fetch an order by id.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } },
  },
  {
    name: 'create_refund',
    description: 'Refund a payment. amount is in minor units (paise).',
    inputSchema: {
      type: 'object',
      properties: { payment_id: { type: 'string' }, amount: { type: 'integer' } },
      required: ['payment_id', 'amount'],
    },
  },
  {
    name: 'create_instant_settlement',
    description: 'Settle available balance on demand. amount is in minor units.',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'integer' } },
      required: ['amount'],
    },
  },
];

/** A demo payment and order, so a fresh clone has something to refund. */
function seedMock(rail: MockRail): void {
  const order = rail.seedOrder({ amount_minor: 189_900 });
  rail.seedPayment({ amount_minor: 189_900, order_id: order.id });
}

async function buildUpstream(
  args: Args,
  rail: MockRail | Rail,
): Promise<{ upstream: Upstream; close: () => Promise<void> }> {
  if (args.upstreamCommand === undefined) {
    // Self-contained: the mock rail answers reads directly.
    const mock = rail as MockRail;
    return {
      upstream: createUpstream({
        listTools: () => Promise.resolve({ tools: [...MOCK_MANIFEST] as never }),
        callTool: async (request) => {
          const a = request.arguments ?? {};
          const paymentId = typeof a['payment_id'] === 'string' ? a['payment_id'] : '';
          if (request.name === 'fetch_payment') {
            return { ...(await mock.fetchPayment(paymentId)) } as Record<string, unknown>;
          }
          if (request.name === 'fetch_order') {
            const id = typeof a['order_id'] === 'string' ? a['order_id'] : '';
            return { ...(await mock.fetchOrder(id)) } as Record<string, unknown>;
          }
          return { error: `unsupported read tool ${request.name}` };
        },
      }),
      close: () => Promise.resolve(),
    };
  }

  const [command, ...commandArgs] = args.upstreamCommand.split(' ').filter((p) => p !== '');
  if (command === undefined) {
    throw new InvariantViolation('bin.upstream', '--upstream-command was empty');
  }
  note(`spawning upstream: ${args.upstreamCommand}`);
  const client = new Client({ name: 'interlock', version: VERSION }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command, args: commandArgs }));
  return {
    upstream: createUpstream({
      listTools: async () => {
        const listed = await client.listTools();
        return { tools: listed.tools as never };
      },
      callTool: async (request) =>
        (await client.callTool({
          name: request.name,
          ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
        })) as Record<string, unknown>,
    }),
    close: () => client.close(),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const args = parseArgs(argv);
  if (args.mandate === undefined) {
    process.stderr.write('--mandate <path> is required. See --help.\n');
    return 2;
  }
  if (args.rail !== 'mock') {
    process.stderr.write(
      `--rail ${args.rail} is not available in v0.1; only the mock rail ships. ` +
        `The envelope is stated in the README rather than implied.\n`,
    );
    return 2;
  }
  if (args.purposeCheck) {
    note('--purpose-check: the advisory purpose gate is not implemented in v0.1; continuing without it');
  }

  // Fails loudly and early if the environment is incomplete. This is the only
  // place loadEnv is called, which is why it is called before anything opens.
  const env = loadEnv();
  const mandate = loadMandate(args.mandate);
  const dbPath = args.db ?? env.INTERLOCK_DB_PATH;

  const store: Store = openStore(dbPath);
  const rail = createMockRail({});
  seedMock(rail);

  const reconciler = createReconciler({ store, rail });

  // Boot recovery runs to completion before a single request is served. An
  // in-flight intent left by a killed process is settled here or not at all.
  const recovery = createRecovery({ store, reconciler });
  const report = await recovery.run();
  if (report.recovered > 0) {
    note(
      `recovered ${String(report.recovered)} intent(s) left in flight by a previous process: ` +
        `${String(report.applied)} applied, ${String(report.confirmed_not_applied)} not applied, ` +
        `${String(report.quarantined)} quarantined`,
    );
  }

  const { upstream, close } = await buildUpstream(args, rail);

  const engine = createEngine({
    store,
    rail,
    wal: createWal({ store, rail }),
    reconciler,
    mandate,
    upstream,
    agentId: args.agent ?? mandate.agent_id,
  });

  const server = createProxyServer({ engine });
  await server.connect(new StdioServerTransport());

  note(
    `ready · mandate ${mandate.mandate_id} · rail ${args.rail} · ledger ${dbPath} · ` +
      `${String(Object.keys(mandate.scope.grants).length)} tool(s) granted`,
  );

  const shutdown = (): void => {
    void (async () => {
      await close();
      await server.close();
      store.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Resolves only when the transport closes.
  return new Promise<number>((resolvePromise) => {
    server.onclose = () => {
      resolvePromise(0);
    };
  });
}

// Only when actually invoked as a program. Matching on the filename alone would
// also fire when a test or a script merely imports this module.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
