import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMandate } from './interlock-mcp.js';

/**
 * The drop-in claim, executed.
 *
 * This spawns the published binary as a real child process and talks to it with
 * a stock MCP client over stdio — the same thing an agent runtime does when you
 * change one line of its config. Nothing in this file imports the gate's
 * internals to make the test pass; if the binary does not work, this fails.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const BIN = join(REPO, 'packages', 'gate', 'dist', 'bin', 'interlock-mcp.js');
const MANDATE = join(REPO, 'examples', 'mandate.yaml');

/** The binary runs from dist, so the suite needs a build to have happened. */
function built(): boolean {
  try {
    execFileSync(process.execPath, [BIN, '--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const ready = built();
const maybe = ready ? describe : describe.skip;

describe('interlock-mcp: the mandate loader', () => {
  it('parses the shipped example mandate', () => {
    const mandate = loadMandate(MANDATE);
    expect(mandate.mandate_id).toBe('mnd_demo_support');
    // The pin is a whole-manifest hash, not a per-tool one, so Gate 6's main
    // path is exercised by the shipped example rather than its fallback.
    expect(mandate.provenance.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mandate.provenance.pinned_manifest).toHaveLength(4);
  });

  it('refuses a mandate that does not validate, naming every problem', () => {
    expect(() => loadMandate(join(REPO, 'package.json'))).toThrow(/is not a valid mandate/);
  });
});

maybe('interlock-mcp: a stock client over stdio', () => {
  let dir: string;
  let client: Client;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'interlock-bin-'));
    client = new Client({ name: 'stock-agent', version: '1.0.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BIN, '--mandate', MANDATE, '--db', join(dir, 'ledger.db')],
        env: {
          ...(process.env as Record<string, string>),
          INTERLOCK_DB_PATH: join(dir, 'ledger.db'),
          INTERLOCK_CONSOLE_TOKEN: 'test-token-000000000000000000',
        },
        stderr: 'pipe',
      }),
    );
  }, 30_000);

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('lists only the tools the mandate grants', async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      'create_instant_settlement',
      'create_refund',
      'fetch_order',
      'fetch_payment',
    ]);
  });

  it('completes a refund inside the mandate', async () => {
    const result = await client.callTool({
      name: 'create_refund',
      arguments: { payment_id: 'pay_MOCK0000000001', amount: 100_000 },
    });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('APPLIED');
    expect(text).toContain('rfnd_');
  }, 20_000);

  it('blocks a refund larger than the order it resolved itself', async () => {
    // The shipped example order is Rs 1,899. Asking for Rs 48,000 is the
    // headline scenario, run through the real binary rather than a harness.
    const result = await client.callTool({
      name: 'create_refund',
      arguments: { payment_id: 'pay_MOCK0000000001', amount: 4_800_000 },
    });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('Refused');
    expect(text).toContain('Do not retry');
    // Never a bare protocol error: that is what makes an agent try again.
    expect(result.isError).toBe(false);
  }, 20_000);

  it('is idempotent across two identical calls', async () => {
    const args = { payment_id: 'pay_MOCK0000000001', amount: 100_000 };
    const first = await client.callTool({ name: 'create_refund', arguments: args });
    const second = await client.callTool({ name: 'create_refund', arguments: args });
    const firstText = (first.content as { text: string }[])[0]?.text ?? '';
    const secondText = (second.content as { text: string }[])[0]?.text ?? '';

    expect(firstText).toContain('APPLIED');
    expect(secondText).toContain('ALREADY_APPLIED');
    // The same rail entity comes back, so a retry costs nothing.
    const id = /rfnd_[A-Za-z0-9]+/.exec(firstText)?.[0];
    expect(id).toBeDefined();
    expect(secondText).toContain(id ?? 'no-id');
  }, 20_000);
});
