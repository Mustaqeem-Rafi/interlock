#!/usr/bin/env node
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The README's first instruction, executed against an installed package.
 *
 * Usage: node smoke-npm.mjs <path-to-interlock-mcp> <path-to-mandate>
 *
 * Run from the consumer's directory, never from the repo. Everything the repo
 * can lend it — a workspace link, a hoisted dependency, a built dist — is
 * exactly what a stranger running `npx interlock-mcp` will not have, so the
 * SDK is resolved from the working directory rather than from beside this
 * file. That is the whole reason this test is worth running at all.
 */

const [binary, mandate] = process.argv.slice(2);
if (binary === undefined || mandate === undefined) {
  console.error('usage: smoke-npm.mjs <interlock-mcp binary> <mandate.yaml>');
  process.exit(2);
}

const requireFromHere = createRequire(pathToFileURL(join(process.cwd(), 'noop.js')));
const { Client } = requireFromHere('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireFromHere('@modelcontextprotocol/sdk/client/stdio.js');

const client = new Client({ name: 'stock-agent', version: '1.0.0' }, { capabilities: {} });

// Deliberately unset: the proxy serves no console, so it must not demand the
// console's token, and it must find a ledger without being told where.
const env = { ...process.env };
delete env.INTERLOCK_DB_PATH;
delete env.INTERLOCK_CONSOLE_TOKEN;

// On Linux the installed bin is an executable with a shebang, which is what a
// consumer actually runs. Pointing this at a plain .js file is how it gets run
// on Windows, and how the bundle can be checked before it is ever packed.
const direct = binary.endsWith('.js');

await client.connect(
  new StdioClientTransport({
    command: direct ? process.execPath : resolve(binary),
    args: [...(direct ? [resolve(binary)] : []), '--mandate', resolve(mandate)],
    env,
    stderr: 'inherit',
  }),
);

const text = (result) => (result.content?.[0]?.text ?? '').replace(/\s+/g, ' ');
const failures = [];
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok    ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures.push(`${label}: ${detail}`);
  }
};

const granted = (await client.listTools()).tools.map((t) => t.name).sort();
check(
  'the mandate decides which tools exist',
  granted.join(',') === 'create_instant_settlement,create_refund,fetch_order,fetch_payment',
  granted.join(','),
);

const args = { payment_id: 'pay_MOCK0000000001', amount: 100000 };
const first = await client.callTool({ name: 'create_refund', arguments: args });
const second = await client.callTool({ name: 'create_refund', arguments: args });
const beyond = await client.callTool({
  name: 'create_refund',
  arguments: { payment_id: 'pay_MOCK0000000001', amount: 4800000 },
});

const entity = /rfnd_[A-Za-z0-9]+/.exec(text(first))?.[0];

check('a refund inside the mandate applies', text(first).includes('APPLIED'), text(first));
check(
  'the same call twice moves money once',
  text(second).includes('ALREADY_APPLIED') && entity !== undefined && text(second).includes(entity),
  text(second),
);
check(
  'a refund past the mandate is refused',
  text(beyond).includes('Refused'),
  text(beyond),
);
// A protocol error is what makes an agent try again. A refusal must arrive as
// an ordinary answer that happens to say no.
check('the refusal is an answer, not an error', beyond.isError === false, String(beyond.isError));

await client.close();

if (failures.length > 0) {
  console.error(`\nsmoke-npm: the installed package does not work\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\nsmoke-npm: the installed package works');
