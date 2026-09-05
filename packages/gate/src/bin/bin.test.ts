import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvariantViolation } from '@interlock/core';
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
/** Read, not hardcoded: a literal here rots silently on the next release. */
const VERSION = (
  JSON.parse(readFileSync(join(REPO, 'packages', 'gate', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/**
 * Can a child process here open a real ledger?
 *
 * This is the precondition the whole suite rests on, and it is worth probing
 * directly rather than inferring. Two weaker probes were wrong: `--version`
 * short-circuits before the store is opened, so it passes on a machine whose
 * better-sqlite3 has no binding for its Node ABI and every test below then
 * fails with "Connection closed" as if the proxy were broken; and running the
 * server itself proves nothing either way, because with no stdin attached it
 * sees EOF and exits immediately, which is correct behaviour and not a fault.
 *
 * So ask the store, in a child, with the real driver.
 */
function cannotOpenALedger(): string | undefined {
  const probe = mkdtempSync(join(tmpdir(), 'interlock-probe-'));
  const storeUrl = pathToFileURL(join(REPO, 'packages', 'store', 'dist', 'index.js')).href;
  // JSON.stringify escapes the Windows separators for the -e literal.
  const db = join(probe, 'p.db');
  try {
    execFileSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(storeUrl)}).then((m) => m.openStore(${JSON.stringify(db)}).close())`],
      { stdio: 'pipe', timeout: 20_000 },
    );
    return undefined;
  } catch (error) {
    const e = error as { stderr?: Buffer };
    const text = e.stderr?.toString() ?? String(error);
    const lines = text.split(String.fromCharCode(10)).filter((line) => line.trim() !== '');
    // Node prints the offending source line first; the cause is further down.
    return lines.find((line) => /^[A-Za-z_$][\w$]*Error:/.test(line.trim())) ?? lines[0] ?? text;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 5 });
  }
}

const cannotServe = cannotOpenALedger();

// Locally a missing native binding is a fact about the laptop, so skipping is
// honest. In CI it is the only thing proving the front door works, so a skip
// there would quietly delete the coverage this file exists to provide.
if (cannotServe !== undefined && process.env['CI'] !== undefined) {
  throw new InvariantViolation(
    'bin.test',
    `a child process cannot open a ledger, and this is CI: ${cannotServe}`,
  );
}
if (cannotServe !== undefined) {
  process.stderr.write(`bin.test: skipping the stdio suite - ${cannotServe}` + String.fromCharCode(10));
}

const maybe = cannotServe === undefined ? describe : describe.skip;

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

describe('interlock-mcp: invoked the way npm installs it', () => {
  // npm links bins as symlinks, so argv[1] is the link and import.meta.url is
  // the realpath. Comparing them without resolving made main() never run: the
  // process exited 0 in silence, which every shell reads as success. Windows
  // refuses symlinks without elevation, hence the guard rather than a skip
  // that would hide the same failure on Linux.
  const link = join(tmpdir(), `interlock-link-${String(process.pid)}`);
  let linkable = false;
  try {
    symlinkSync(BIN, link);
    linkable = true;
  } catch {
    linkable = false;
  }

  it.runIf(linkable)('prints its version through a symlink, rather than exiting silently', () => {
    const printed = execFileSync(process.execPath, [link, '--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    expect(printed).toBe(VERSION);
    rmSync(link, { force: true });
  });

  it('runs when argv[0] needs normalising, which is the same comparison', () => {
    const indirect = join(dirname(BIN), '..', 'bin', 'interlock-mcp.js');
    const printed = execFileSync(process.execPath, [indirect, '--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    expect(printed).toBe(VERSION);
  });
});
