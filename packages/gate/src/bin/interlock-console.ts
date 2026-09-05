#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InvariantViolation } from '@interlock/core';
import { openStore, type Store } from '@interlock/store';
import { createConsoleApp } from '../api/server.js';
import { ledgerReadiness } from '../api/readiness.js';
import { loadMandate } from './interlock-mcp.js';

/**
 * `interlock-console` — the operator's window onto the ledger.
 *
 * Runs beside the proxy against the same SQLite file. It is a separate process
 * on purpose: the proxy speaks MCP on stdio and must never have an HTTP
 * listener bolted to it, and an operator restarting the console must not be
 * able to interrupt a refund.
 *
 * Nothing it exposes can call the rail. The most it can do is move an intent
 * along an edge the state machine already permits, which is what makes a
 * mis-click survivable.
 */

const VERSION = '0.2.0';

const HELP = `interlock-console ${VERSION}

Read the ledger, and let a human resolve what the engine cannot.

USAGE
  interlock-console --mandate <path> [options]

OPTIONS
  --mandate <path>  Mandate YAML. Read for the merchant id only.
  --db <path>       SQLite ledger. Defaults to INTERLOCK_DB_PATH, and failing
                    that to the file beside the mandate.
  --port <n>        Default 8787, or PORT.
  --host <addr>     Default 127.0.0.1. Bind 0.0.0.0 only behind a proxy.
  --help, --version

ENVIRONMENT
  INTERLOCK_CONSOLE_TOKEN  required, >= 16 chars. Bearer token for /api/*.
  INTERLOCK_DB_PATH        where the ledger lives; overridden by --db

ROUTES
  GET  /health                              no token; 503 until recovery ends
  GET  /api/summary                         counts, 24h spend, audit head
  GET  /api/attention                       everything waiting on a person
  GET  /api/intents?state=HELD&limit=100
  GET  /api/decisions?verdict=BLOCK
  GET  /api/audit?from=0&limit=100          includes whether the chain verifies
  POST /api/intents/:sik/approve            HELD -> AUTHORIZED
  POST /api/intents/:sik/deny               HELD -> BLOCKED
  POST /api/intents/:sik/confirm-applied    QUARANTINED -> APPLIED
  POST /api/intents/:sik/confirm-not-applied  QUARANTINED -> CONFIRMED_NOT_APPLIED

Every POST requires {"reason": "..."} and records it verbatim in the audit log.
confirm-applied also requires {"rail_entity_id": "..."} — the entity you found.
`;

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/** Same rule as the proxy: the ledger belongs beside the mandate that authorised it. */
function ledgerBesideMandate(mandatePath: string): string {
  const full = resolve(mandatePath);
  return join(dirname(full), `${basename(full).replace(/\.[^.]+$/, '')}.ledger.db`);
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

  const mandatePath = flag(argv, 'mandate');
  if (mandatePath === undefined) {
    process.stderr.write('--mandate <path> is required. See --help.\n');
    return 2;
  }

  const token = process.env['INTERLOCK_CONSOLE_TOKEN'];
  if (token === undefined || token.trim() === '') {
    process.stderr.write(
      'INTERLOCK_CONSOLE_TOKEN is not set. The console shows every decision and ' +
        'can resolve held money; it will not start without one.\n',
    );
    return 2;
  }

  const mandate = loadMandate(mandatePath);
  const dbPath =
    flag(argv, 'db') ?? process.env['INTERLOCK_DB_PATH'] ?? ledgerBesideMandate(mandatePath);
  const port = Number(flag(argv, 'port') ?? process.env['PORT'] ?? 8787);
  const host = flag(argv, 'host') ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvariantViolation('console.port', `--port must be a port number, got ${String(port)}`);
  }

  const store: Store = openStore(dbPath);

  const app = createConsoleApp({
    store,
    // Health is a fact about the ledger here, not about a recovery pass this
    // process does not run. See ledgerReadiness.
    readiness: () => ledgerReadiness(store, Date.now()),
    token,
    mandate,
  });

  await new Promise<void>((ready) => app.listen(port, host, ready));
  process.stderr.write(
    `interlock-console: http://${host}:${String(port)} · ledger ${dbPath} · ` +
      `merchant ${mandate.merchant_id}\n`,
  );

  const shutdown = (): void => {
    app.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise<number>(() => {
    // Resolves only on signal, via shutdown above.
  });
}

function invokedAsProgram(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return moduleUrl === pathToFileURL(entry).href;
  }
}

if (invokedAsProgram(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
