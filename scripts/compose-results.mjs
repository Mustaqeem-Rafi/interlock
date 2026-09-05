#!/usr/bin/env node
/**
 * Compose RESULTS.md from the fragments each generator writes.
 *
 * RESULTS.md is machine-written and never edited by hand. Two separate
 * generators contribute to it — the chaos matrix and the benchmark — and
 * neither may clobber the other's section, so each writes its own fragment and
 * this stitches them together. A number in RESULTS.md can therefore always be
 * traced to the command that produced it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FRAGMENTS = [
  { file: 'RESULTS.bench.md', label: 'benchmark', command: 'pnpm bench --rail mock' },
  { file: 'RESULTS.chaos.md', label: 'chaos matrix', command: 'pnpm chaos:matrix --trials 20' },
];

const header = [
  '<!--',
  '  GENERATED FILE - DO NOT EDIT.',
  '',
  '  Composed by scripts/compose-results.mjs from the fragments listed below.',
  '  Every number here was written by a command, not by a person. If a section is',
  '  missing it is because its generator did not run, which is itself the finding.',
  '-->',
  '',
  '# Interlock results',
  '',
];

const parts = [];
const missing = [];

for (const fragment of FRAGMENTS) {
  const path = join(ROOT, fragment.file);
  if (!existsSync(path)) {
    missing.push(fragment);
    continue;
  }
  parts.push(readFileSync(path, 'utf8').trimEnd());
}

if (missing.length > 0) {
  parts.push(
    ['## Missing sections', '', ...missing.map((m) => `- **${m.label}** — not generated. Run \`${m.command}\`.`), ''].join(
      '\n',
    ),
  );
}

writeFileSync(join(ROOT, 'RESULTS.md'), `${header.join('\n')}${parts.join('\n\n---\n\n')}\n`, 'utf8');
console.log(
  `compose-results: wrote RESULTS.md from ${String(FRAGMENTS.length - missing.length)}/${String(FRAGMENTS.length)} fragments`,
);
if (missing.length > 0) {
  console.log(`  missing: ${missing.map((m) => m.file).join(', ')}`);
}
