#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The demo driver. Not a test - a narrator.
 *
 * It plays one scripted agent session against a running Interlock proxy and
 * pauses between beats so the story can be told over it. Everything printed is
 * the proxy's own response text; nothing in this file decides anything.
 *
 *   node scripts/demo.mjs            step through with [enter]
 *   node scripts/demo.mjs --no-pause run straight through
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BIN = join(REPO, 'packages', 'gate', 'dist', 'bin', 'interlock-mcp.js');
const MANDATE = join(REPO, 'examples', 'mandate.yaml');

const requireFromGate = createRequire(pathToFileURL(join(REPO, 'packages', 'gate', 'noop.js')));
const { Client } = requireFromGate('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireFromGate('@modelcontextprotocol/sdk/client/stdio.js');

const E = '\u001b[';
const BOLD = E + '1m', DIM = E + '2m', RED = E + '31m', GRN = E + '32m', OFF = E + '0m';

const PAUSE = !process.argv.includes('--no-pause');
const rl = PAUSE ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

const rule = (title) => {
  process.stdout.write('\n' + DIM + '-'.repeat(74) + OFF + '\n' + BOLD + title + OFF + '\n\n');
};
const beat = async () => {
  if (rl) await rl.question('\n' + DIM + '   [enter]' + OFF + ' ');
};

const client = new Client({ name: 'support-agent', version: '1.0.0' }, { capabilities: {} });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--mandate', MANDATE, '--db', join(REPO, '.demo', 'demo.db')],
    env: { ...process.env },
    stderr: 'ignore',
  }),
);

const say = (result) => {
  const text = (result.content?.[0]?.text ?? '').trim();
  const [headline, ...rest] = text.split('\n');
  const refused = headline.startsWith('Refused');
  process.stdout.write('   ' + (refused ? RED : GRN) + headline + OFF + '\n');
  // The JSON block travels in the same text, so search all of it.
  for (const key of ['outcome', 'reason_code', 'retryable']) {
    const m = new RegExp('"' + key + '":\\s*("[^"]*"|[a-z]+|null)').exec(text);
    if (m) process.stdout.write('   ' + DIM + key.padEnd(11) + OFF + ' ' + m[1] + '\n');
  }
  const guidance = rest.find((l) => l.includes('Do not retry'));
  if (guidance) process.stdout.write('   ' + DIM + guidance.trim() + OFF + '\n');
};

const call = (amount, extra = {}) =>
  client.callTool({
    name: 'create_refund',
    arguments: { payment_id: 'pay_MOCK0000000001', amount, ...extra },
  });

const entityOf = (result) => /rfnd_[A-Za-z0-9]+/.exec(result.content?.[0]?.text ?? '')?.[0] ?? '(none)';

rule('The mandate decides which tools the agent can even see');
for (const tool of (await client.listTools()).tools) process.stdout.write('   ' + tool.name + '\n');
process.stdout.write('\n   ' + DIM + 'Anything the mandate does not grant is never listed.' + OFF + '\n');
await beat();

rule('1 - The agent asks for Rs 48,000 on a Rs 1,899 order');
say(await call(4800000));
await beat();

rule('2 - Rs 2,500: under the mandate ceiling, over the order');
say(await call(250000));
process.stdout.write(
  '\n   ' + DIM + '189900 is the order Interlock resolved itself.' + OFF + '\n' +
  '   ' + DIM + 'It appears nowhere in the agent request.' + OFF + '\n',
);
await beat();

rule('3 - A legitimate Rs 1,000 refund');
const first = await call(100000);
say(first);
const entity = entityOf(first);
process.stdout.write('\n   ' + DIM + 'rail entity' + OFF + ' ' + entity + '\n');
await beat();

rule('4 - The call times out, so the agent asks again. Identical request.');
const second = await call(100000);
say(second);
const again = entityOf(second);
process.stdout.write('\n   ' + DIM + 'rail entity' + OFF + ' ' + again + '  ' +
  (entity === again ? GRN + 'the same refund. Money moved once.' + OFF
                    : RED + 'DIFFERENT - that would be a double refund' + OFF) + '\n');
await beat();

rule('5 - A genuine second refund, with a reason the agent has to state');
say(await call(100000, { interlock_distinct_reason: 'second damaged item on the same order' }));
process.stdout.write(
  '\n   ' + DIM + 'The reason enters the idempotency key and is recorded verbatim.' + OFF + '\n' +
  '   ' + DIM + 'Possible. Never accidental.' + OFF + '\n\n',
);

rl?.close();
await client.close();
