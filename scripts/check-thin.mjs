#!/usr/bin/env node
/**
 * Thin-spine budget.
 *
 * Each gate is a single small predicate over an already-resolved proposed action.
 * The moment one of them needs more than 120 lines it has stopped being a
 * predicate and started being a subsystem, and the policy has drifted out of the
 * place a human can read in one sitting. That is a real regression in the claim
 * this project makes, so it is checked by CI rather than left to discipline.
 *
 * Budget is total lines, imports and comments included. Split, do not shrink.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINES = 120;

const BUDGETED = [
  'packages/gate/src/gates/g1_scope.ts',
  'packages/gate/src/gates/g2_value.ts',
  'packages/gate/src/gates/g3_limits.ts',
  'packages/gate/src/gates/g6_provenance.ts',
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Total lines in a file, ignoring a single trailing newline. */
function countLines(absolutePath) {
  const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

const violations = [];
const report = [];

for (const relativePath of BUDGETED) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    report.push(`  skip  ${relativePath} (not written yet)`);
    continue;
  }
  const lines = countLines(absolutePath);
  const over = lines > MAX_LINES;
  report.push(`  ${over ? 'FAIL' : 'ok  '}  ${relativePath} — ${lines}/${MAX_LINES} lines`);
  if (over) violations.push({ relativePath, lines });
}

console.log(`check-thin: gate line budget (${MAX_LINES} lines, imports included)`);
console.log(report.join('\n'));

if (violations.length > 0) {
  console.error('\ncheck-thin: FAILED — the gate spine is no longer thin.');
  for (const { relativePath, lines } of violations) {
    console.error(`  ${relativePath} is ${lines - MAX_LINES} lines over budget.`);
  }
  console.error('\nExtract the extra logic into a helper module. Do not raise the budget.');
  process.exit(1);
}
