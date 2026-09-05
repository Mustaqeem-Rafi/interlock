import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Mandate, mandateHash } from '@interlock/core';
import { openStore, type Store } from '@interlock/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReconciler } from '../exactly-once/reconciler.js';
import { createWal } from '../exactly-once/wal.js';
import { createMockRail, type MockRail } from '../rail/mock.js';
import { createEngine, type Engine } from './engine.js';
import { createProxyServer } from './server.js';
import { createUpstream } from './upstream.js';

/**
 * End to end through the real MCP SDK.
 *
 * The client below is a stock `Client` with no knowledge of Interlock. It is
 * the "one line of config and no code change" claim, executed rather than
 * asserted: everything it does, it would have done against the upstream server.
 */

const T0 = 1_757_000_000_000;
const MERCHANT = 'acc_KtqXyZ01';
const AGENT = 'agent_support_bot';

/** 1,899 rupees, in paise. The damage claim the refund is supposedly against. */
const CLAIM_MINOR = 189_900;
/** 48,000 rupees, in paise. What the agent asks for. */
const OVERREACH_MINOR = 4_800_000;

const MANDATE = Mandate.parse({
  v: 1,
  mandate_id: 'mnd_support',
  merchant_id: MERCHANT,
  agent_id: AGENT,
  issued_at: T0 - 1_000,
  expires_at: T0 + 86_400_000,
  purpose: 'Refund damage claims raised by order support.',
  scope: {
    grants: {
      create_refund: {
        reversibility: 'irreversible',
        value: { max_amount_minor: 5_000_000, min_amount_minor: 100, currencies: ['INR'] },
      },
      fetch_payment: {
        reversibility: 'reversible',
        value: { max_amount_minor: 0, min_amount_minor: 0, currencies: ['INR'] },
      },
    },
  },
  limits: { windows: [], fee_budgets: {} },
  idempotency: {
    create_refund: { key_fields: ['payment_id'], window_ms: null },
    fetch_payment: { key_fields: [], window_ms: 60_000 },
  },
  provenance: {
    server_id: 'razorpay-mcp@0.2.1',
    pinned_manifests: {
      create_refund: { sha256: 'a'.repeat(64), trust_tier: 'pinned' },
      fetch_payment: { sha256: 'b'.repeat(64), trust_tier: 'pinned' },
    },
  },
  degraded_mode: { reversible: 'hold', compensable: 'hold', irreversible: 'block' },
});

/** Stands in for the Razorpay MCP server. Lists more than the mandate grants. */
function upstreamServer(): Server {
  const server = new Server({ name: 'razorpay', version: '0.2.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        { name: 'create_refund', description: 'Refund a payment', inputSchema: { type: 'object' } },
        {
          name: 'create_instant_settlement',
          description: 'Settle funds on demand',
          inputSchema: { type: 'object' },
        },
        { name: 'fetch_payment', description: 'Read a payment', inputSchema: { type: 'object' } },
      ],
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    Promise.resolve({
      content: [{ type: 'text' as const, text: JSON.stringify({ upstream: request.params.name }) }],
    }),
  );
  return server;
}

interface Harness {
  readonly client: Client;
  readonly rail: MockRail;
  readonly store: Store;
  readonly engine: Engine;
  readonly paymentId: string;
  close(): Promise<void>;
}

let dir: string;
let harness: Harness;

async function build(): Promise<Harness> {
  const store = openStore(join(dir, 'interlock.db'));
  const rail = createMockRail({ now: () => T0 });
  const order = rail.seedOrder({ amount_minor: CLAIM_MINOR });
  const payment = rail.seedPayment({ amount_minor: 500_000, order_id: order.id });

  // Our client, facing the upstream server.
  const [upA, upB] = InMemoryTransport.createLinkedPair();
  const upServer = upstreamServer();
  const upClient = new Client({ name: 'interlock', version: '0.1.0' }, { capabilities: {} });
  await Promise.all([upServer.connect(upB), upClient.connect(upA)]);

  const engine = createEngine({
    store,
    rail,
    wal: createWal({ store, rail, now: () => T0, owner: 'proxy-test' }),
    reconciler: createReconciler({ store, rail, now: () => T0, minDelayMs: 0 }),
    mandate: MANDATE,
    upstream: createUpstream({
      listTools: async () => {
        const listed = await upClient.listTools();
        return { tools: listed.tools as never };
      },
      callTool: async (request) =>
        (await upClient.callTool({
          name: request.name,
          ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
        })) as Record<string, unknown>,
    }),
    agentId: AGENT,
    now: () => T0,
  });

  // A stock MCP client, facing us. No Interlock code on this side.
  const [inA, inB] = InMemoryTransport.createLinkedPair();
  const proxy = createProxyServer({ engine });
  const client = new Client({ name: 'stock-agent', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([proxy.connect(inB), client.connect(inA)]);

  return {
    client,
    rail,
    store,
    engine,
    paymentId: payment.id,
    async close() {
      await client.close();
      await proxy.close();
      await upClient.close();
      await upServer.close();
      store.close();
    },
  };
}

function envelope(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  const parsed = JSON.parse(content[0]?.text.split('\n\n').slice(1).join('\n\n') ?? '{}') as {
    interlock?: Record<string, unknown>;
  };
  return parsed.interlock ?? {};
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'interlock-proxy-'));
  harness = await build();
});

afterEach(async () => {
  await harness.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tools/list', () => {
  it('shows only what the mandate grants', async () => {
    const listed = await harness.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();

    // Upstream offers three. The mandate grants two.
    expect(names).toEqual(['create_refund', 'fetch_payment']);

    // An agent that cannot see create_instant_settlement cannot be talked into
    // calling it, which is the point.
    expect(names).not.toContain('create_instant_settlement');
  });

  it('passes the upstream description through unchanged', async () => {
    const listed = await harness.client.listTools();
    const refund = listed.tools.find((tool) => tool.name === 'create_refund');
    expect(refund?.description).toBe('Refund a payment');
  });
});

describe('acceptance: a stock client completes a refund with no code change', () => {
  it('applies the refund and returns the rail entity', async () => {
    const result = await harness.client.callTool({
      name: 'create_refund',
      arguments: { payment_id: harness.paymentId, amount: 100_000, currency: 'INR' },
    });

    const env = envelope(result);
    expect(env['outcome']).toBe('APPLIED');
    expect(env['rail_entity_id']).toBe('rfnd_MOCK0000000001');
    expect(result.isError).toBe(false);

    expect(harness.rail.inspect.refundsForPayment(harness.paymentId)).toHaveLength(1);
    const [refund] = harness.rail.inspect.refundsForPayment(harness.paymentId);
    expect(refund?.notes['interlock_sik']).toBe(env['sik']);
    expect(harness.store.audit.verifyChain()).toBeNull();
  });

  it('is idempotent: asking twice returns the original entity, not a second refund', async () => {
    const args = { payment_id: harness.paymentId, amount: 100_000, currency: 'INR' };

    const first = envelope(await harness.client.callTool({ name: 'create_refund', arguments: args }));
    const second = envelope(await harness.client.callTool({ name: 'create_refund', arguments: args }));

    expect(first['outcome']).toBe('APPLIED');
    expect(second['outcome']).toBe('ALREADY_APPLIED');
    expect(second['idempotent_replay']).toBe(true);
    expect(second['rail_entity_id']).toBe(first['rail_entity_id']);
    expect(second['retryable']).toBe(false);

    // The drop-in promise: money moved exactly once.
    expect(harness.rail.inspect.refundsForPayment(harness.paymentId)).toHaveLength(1);
    expect(harness.rail.inspect.callCount('createRefund')).toBe(1);
  });
});

describe('acceptance: a 48,000 refund against a 1,899 claim is blocked', () => {
  it('refuses it and records the resolved order on the decision', async () => {
    const result = await harness.client.callTool({
      name: 'create_refund',
      arguments: {
        payment_id: harness.paymentId,
        amount: OVERREACH_MINOR,
        currency: 'INR',
        // The agent's own account of the world. Not consulted.
        note: 'customer says the damage claim was for 48000',
      },
    });

    const env = envelope(result);
    expect(env['outcome']).toBe('BLOCKED');
    expect(env['retryable']).toBe(false);
    expect(harness.rail.inspect.refundsForPayment(harness.paymentId)).toHaveLength(0);

    // The decision record carries the order we resolved ourselves.
    const decision = harness.store.decisions.find(String(env['request_id']));
    expect(decision?.verdict).toBe('BLOCK');
    expect(decision?.mandate_hash).toBe(mandateHash(MANDATE));

    const results = JSON.parse(decision?.results_json ?? '[]') as {
      gate: string;
      reason_code: string;
      evidence: { order?: { id: string; amount_paid_minor: number } };
    }[];
    const g2 = results.find((r) => r.gate === 'g2_value');
    expect(g2?.evidence.order?.amount_paid_minor).toBe(CLAIM_MINOR);
    expect(g2?.reason_code).toBe('AMOUNT_ABOVE_REFUNDABLE');
  });

  it('never returns a bare error, because a bare error is what makes agents retry', async () => {
    const result = await harness.client.callTool({
      name: 'create_refund',
      arguments: { payment_id: harness.paymentId, amount: OVERREACH_MINOR, currency: 'INR' },
    });

    expect(result.isError).toBe(false);
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('Refused');
    expect(text).toContain('Do not retry');
    expect(envelope(result)['retryable']).toBe(false);
  });

  it('stays blocked when asked again', async () => {
    const args = { payment_id: harness.paymentId, amount: OVERREACH_MINOR, currency: 'INR' };
    await harness.client.callTool({ name: 'create_refund', arguments: args });
    const again = envelope(await harness.client.callTool({ name: 'create_refund', arguments: args }));

    expect(again['outcome']).toBe('BLOCKED');
    expect(harness.rail.inspect.refundsForPayment(harness.paymentId)).toHaveLength(0);
  });
});

describe('refusals the agent can act on', () => {
  it('blocks a tool the mandate does not grant, even called by name', async () => {
    // Stripped from tools/list, but an agent could have learned the name
    // elsewhere. The refusal has to say it is out of scope, not that the
    // arguments were wrong — the latter invites another attempt.
    const result = await harness.client.callTool({
      name: 'create_instant_settlement',
      arguments: { amount: 1_000, payment_id: harness.paymentId },
    });
    const env = envelope(result);
    expect(env['outcome']).toBe('BLOCKED');
    expect(env['reason_code']).toBe('TOOL_NOT_GRANTED');
    expect(harness.rail.inspect.settlements()).toHaveLength(0);
  });

  it('blocks malformed arguments to a tool that is granted', async () => {
    const result = await harness.client.callTool({
      name: 'create_refund',
      arguments: { payment_id: harness.paymentId, amount: 100.5 },
    });
    expect(envelope(result)['reason_code']).toBe('MALFORMED_ARGUMENTS');
  });

  it('forwards a granted read-only tool straight upstream', async () => {
    const result = await harness.client.callTool({
      name: 'fetch_payment',
      arguments: { payment_id: harness.paymentId },
    });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('fetch_payment');
  });

  it('reports the same manifest hash for an unchanged upstream', async () => {
    const before = await harness.engine.listTools();
    const after = await harness.engine.listTools();
    expect(after.map((t) => t.name)).toEqual(before.map((t) => t.name));
  });
});
