import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '@interlock/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleApp } from './server.js';
import { ledgerReadiness } from './views.js';

/**
 * The console exists to close two holes in the state machine.
 *
 * HOLD_RELEASED and HOLD_REJECTED were edges nothing fired, and QUARANTINED
 * had no outbound edge at all — an intent that reached either sat there
 * forever with its idempotency key poisoned. These tests are mostly about
 * proving those rooms now have doors, and that only a human can open them.
 */

const TOKEN = 'test-token-0123456789abcdef';

interface Harness {
  readonly base: string;
  readonly store: Store;
  setReadiness(readiness: Health): void;
}

let dir: string;
let server: Server;
let harness: Harness;

interface Health {
  ready: boolean;
  phase: string;
  outstanding: number;
  status: number;
}

const READY: Health = { ready: true, phase: 'ready', outstanding: 0, status: 200 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'interlock-api-'));
  const store = openStore(join(dir, 'ledger.db'));
  const state = { readiness: READY as Health };
  server = createConsoleApp({
    store,
    readiness: () => state.readiness,
    token: TOKEN,
    merchantId: 'acc_TEST00000001',
    now: () => 1_700_000_000_000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  harness = {
    base: `http://127.0.0.1:${String(port)}`,
    store,
    setReadiness: (readiness) => {
      state.readiness = readiness;
    },
  };
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  harness.store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * `undefined` here would select the default parameter, so an explicit
 * `get(path, undefined)` sends the real token and the assertion passes for the
 * wrong reason. NO_TOKEN is a value that cannot be confused with "unspecified".
 */
const NO_TOKEN = Symbol('no token');
type Token = string | typeof NO_TOKEN;

const authHeaders = (token: Token): Record<string, string> =>
  token === NO_TOKEN ? {} : { authorization: `Bearer ${token}` };

const get = (path: string, token: Token = TOKEN): Promise<Response> =>
  fetch(`${harness.base}${path}`, { headers: authHeaders(token) });

const post = (path: string, body: unknown, token: Token = TOKEN): Promise<Response> =>
  fetch(`${harness.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(body),
  });

/** A SIK is base32 over A–Z2–7, so no 0, 1, 8 or 9 may appear in a fixture. */
function seedIntent(state: string, sik = 'HELDSIK'.padEnd(32, 'A')): string {
  harness.store.intents.create({
    merchant_id: 'acc_TEST00000001',
    sik,
    tool: 'create_refund',
    subject_id: 'pay_TEST0000000001',
    amount_minor: 189_900,
    currency: 'INR',
    reversibility: 'irreversible',
    params_hash: 'a'.repeat(64),
    mandate_hash: 'b'.repeat(64),
    state: 'PROPOSED',
    at: 1_699_999_000_000,
  });
  if (state !== 'PROPOSED') {
    harness.store.intents.transition({
      merchant_id: 'acc_TEST00000001',
      sik,
      from: 'PROPOSED',
      to: state as 'HELD',
      at: 1_699_999_500_000,
      audit_kind: 'TEST_SEED',
    });
  }
  return sik;
}

describe('console: health', () => {
  it('needs no token, because a load balancer does not have one', async () => {
    const res = await get('/health', NO_TOKEN);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ready');
  });

  it('answers 503 while recovery is still running', async () => {
    // The Block 5 acceptance. A process that has not finished settling intents
    // left by a killed predecessor must not be sent traffic: it would decide
    // against a ledger that is still incomplete.
    harness.setReadiness({ ready: false, phase: 'reconciling', outstanding: 3, status: 503 });
    const res = await get('/health', NO_TOKEN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; outstanding: number };
    expect(body.status).toBe('recovering');
    expect(body.outstanding).toBe(3);
  });
});

describe('console: readiness derived from the ledger', () => {
  it('a clean ledger is ready', () => {
    expect(ledgerReadiness(harness.store, 1_700_000_000_000)).toMatchObject({
      ready: true,
      status: 200,
    });
  });

  it('an intent stranded in flight holds the console at 503', () => {
    // The bug this replaced: the console reported its own Recovery object,
    // which it never runs, so /health said "scanning" forever and nothing
    // would ever route to it. Readiness has to be a fact about shared state.
    const sik = seedIntent('PROPOSED', 'STRANDED'.padEnd(32, 'D'));
    harness.store.intents.transition({
      merchant_id: 'acc_TEST00000001',
      sik,
      from: 'PROPOSED',
      to: 'AUTHORIZED',
      at: 1_699_999_600_000,
      audit_kind: 'TEST_SEED',
    });
    harness.store.intents.transition({
      merchant_id: 'acc_TEST00000001',
      sik,
      from: 'AUTHORIZED',
      to: 'IN_FLIGHT',
      at: 1_699_999_700_000,
      lease: { owner: 'a-process-that-died', expires_at: 1_699_999_800_000 },
      audit_kind: 'TEST_SEED',
    });
    const health = ledgerReadiness(harness.store, 1_700_000_000_000);
    expect(health).toMatchObject({ ready: false, phase: 'unrecovered', status: 503 });
    expect(health.outstanding).toBe(1);
  });

  it('becomes ready again once the lease is gone', () => {
    const sik = seedIntent('PROPOSED', 'RECOVERED'.padEnd(32, 'E'));
    harness.store.intents.transition({
      merchant_id: 'acc_TEST00000001',
      sik,
      from: 'PROPOSED',
      to: 'AUTHORIZED',
      at: 1_699_999_600_000,
      lease: null,
      audit_kind: 'TEST_SEED',
    });
    expect(ledgerReadiness(harness.store, 1_700_000_000_000).ready).toBe(true);
  });
});

describe('console: the door', () => {
  it('refuses with no token, a wrong token, and the wrong scheme', async () => {
    expect((await get('/api/summary', NO_TOKEN)).status).toBe(401);
    expect((await get('/api/summary', 'not-the-token-aaaaaaaa')).status).toBe(401);
    const basic = await fetch(`${harness.base}/api/summary`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect(basic.status).toBe(401);
  });

  it('does not accept a token that is merely a prefix of the real one', async () => {
    expect((await get('/api/summary', TOKEN.slice(0, -1))).status).toBe(401);
    expect((await get('/api/summary', `${TOKEN}x`)).status).toBe(401);
  });
});

describe('console: a HELD intent can leave HELD', () => {
  it('approve moves it to AUTHORIZED and records who and why', async () => {
    const sik = seedIntent('HELD');
    const res = await post(`/api/intents/${sik}/approve`, {
      reason: 'confirmed with the customer on ticket 4471',
      operator: 'priya',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: 'HELD', to: 'AUTHORIZED' });

    const audit = harness.store.audit.read(0, 100);
    const entry = audit.find((r) => r.kind === 'OPERATOR_APPROVE');
    expect(entry).toBeDefined();
    const payload = (entry?.payload ?? {}) as { operator: string; reason: string; event: string };
    expect(payload.operator).toBe('priya');
    expect(payload.reason).toBe('confirmed with the customer on ticket 4471');
    // The edge that had no caller until this file existed.
    expect(payload.event).toBe('HOLD_RELEASED');
  });

  it('approving grants authority without moving money', async () => {
    const sik = seedIntent('HELD');
    await post(`/api/intents/${sik}/approve`, { reason: 'ok' });
    const row = harness.store.intents.require('acc_TEST00000001', sik);
    // Not APPLIED, and no rail entity: the agent's next request spends this.
    // A mis-click in a console must never be the thing that pays someone.
    expect(row.state).toBe('AUTHORIZED');
    expect(row.rail_entity_id).toBeNull();
  });

  it('deny moves it to BLOCKED, which is absorbing', async () => {
    const sik = seedIntent('HELD');
    expect((await post(`/api/intents/${sik}/deny`, { reason: 'not a real return' })).status).toBe(
      200,
    );
    expect(harness.store.intents.require('acc_TEST00000001', sik).state).toBe('BLOCKED');
    const again = await post(`/api/intents/${sik}/approve`, { reason: 'changed my mind' });
    expect(again.status).toBe(409);
  });

  it('refuses a state change with no stated reason', async () => {
    const sik = seedIntent('HELD');
    const res = await post(`/api/intents/${sik}/approve`, { reason: '   ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REASON_REQUIRED');
    expect(harness.store.intents.require('acc_TEST00000001', sik).state).toBe('HELD');
  });
});

describe('console: a QUARANTINED intent can be resolved by a human', () => {
  it('confirm-applied requires the rail entity the operator found', async () => {
    const sik = seedIntent('QUARANTINED');
    const missing = await post(`/api/intents/${sik}/confirm-applied`, { reason: 'saw it' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'RAIL_ENTITY_REQUIRED',
    );
    // Still quarantined: a claim that money moved with nothing to point at is
    // worse than the quarantine it would replace.
    expect(harness.store.intents.require('acc_TEST00000001', sik).state).toBe('QUARANTINED');
  });

  it('confirm-applied records the entity and lands in APPLIED', async () => {
    const sik = seedIntent('QUARANTINED');
    const res = await post(`/api/intents/${sik}/confirm-applied`, {
      reason: 'found in the dashboard',
      rail_entity_id: 'rfnd_REAL0000000001',
    });
    expect(res.status).toBe(200);
    const row = harness.store.intents.require('acc_TEST00000001', sik);
    expect(row.state).toBe('APPLIED');
    expect(row.rail_entity_id).toBe('rfnd_REAL0000000001');
  });

  it('confirm-not-applied lands in CONFIRMED_NOT_APPLIED, not AUTHORIZED', async () => {
    // The guarantee names exactly one way back to AUTHORIZED after a first
    // attempt. An operator saying "it did not happen" must re-enter through
    // that edge rather than becoming a second way in.
    const sik = seedIntent('QUARANTINED');
    expect(
      (await post(`/api/intents/${sik}/confirm-not-applied`, { reason: 'not on the rail' })).status,
    ).toBe(200);
    expect(harness.store.intents.require('acc_TEST00000001', sik).state).toBe(
      'CONFIRMED_NOT_APPLIED',
    );
  });

  it('refuses an operation the machine does not allow from that state', async () => {
    const sik = seedIntent('PROPOSED');
    const res = await post(`/api/intents/${sik}/approve`, { reason: 'nope' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'PROPOSED',
    );
  });

  it('404s an intent that does not exist', async () => {
    const res = await post('/api/intents/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/approve', {
      reason: 'x',
    });
    expect(res.status).toBe(404);
  });
});

describe('console: reads', () => {
  it('summarises by state and separates what needs a human', async () => {
    seedIntent('HELD', 'HELDSIK'.padEnd(32, 'A'));
    seedIntent('QUARANTINED', 'QSIK'.padEnd(32, 'B'));
    const body = (await (await get('/api/summary')).json()) as {
      counts: Record<string, number>;
      needs_attention: number;
    };
    expect(body.counts['HELD']).toBe(1);
    expect(body.counts['QUARANTINED']).toBe(1);
    expect(body.needs_attention).toBe(2);
  });

  it('/api/attention returns exactly what a person has to act on', async () => {
    seedIntent('HELD', 'HELDSIK'.padEnd(32, 'A'));
    seedIntent('APPLIED', 'ASIK'.padEnd(32, 'C'));
    const body = (await (await get('/api/attention')).json()) as { intents: { state: string }[] };
    expect(body.intents.map((i) => i.state).sort()).toEqual(['HELD']);
  });

  it('reports whether the audit chain still verifies, rather than implying it', async () => {
    seedIntent('HELD');
    const body = (await (await get('/api/audit')).json()) as {
      count: number;
      first_broken_seq: number | null;
    };
    expect(body.count).toBeGreaterThan(0);
    expect(body.first_broken_seq).toBeNull();
  });
});
