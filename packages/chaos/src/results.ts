import type { KillPoint } from '@interlock/gate';
import { EXPECTATION, GUARANTEE, type Violation } from './verdict.js';

/** One row of the table: everything observed at one kill point. */
export interface KillPointSummary {
  readonly killPoint: KillPoint;
  readonly trials: number;
  /** Histogram of rail-entity counts, e.g. { 0: 20 }. */
  readonly counts: Readonly<Record<number, number>>;
  /** Histogram of terminal intent states. */
  readonly states: Readonly<Record<string, number>>;
  readonly killedAsExpected: number;
  readonly violations: readonly Violation[];
}

export interface MatrixResults {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly trialsPerPoint: number;
  readonly summaries: readonly KillPointSummary[];
}

function histogram(entries: Readonly<Record<string, number>>): string {
  const keys = Object.keys(entries).sort();
  if (keys.length === 0) return '—';
  return keys.map((key) => `${key} ×${String(entries[key] ?? 0)}`).join(', ');
}

function observedCell(summary: KillPointSummary): string {
  const counts = Object.fromEntries(
    Object.entries(summary.counts).map(([count, n]) => [
      `${count} refund${count === '1' ? '' : 's'}`,
      n,
    ]),
  );
  return `${histogram(counts)}<br>${histogram(summary.states)}`;
}

export function totalViolations(results: MatrixResults): number {
  return results.summaries.reduce((sum, summary) => sum + summary.violations.length, 0);
}

export function renderResults(results: MatrixResults): string {
  const total = totalViolations(results);
  const trials = results.summaries.reduce((sum, summary) => sum + summary.trials, 0);

  const lines: string[] = [
    '# Chaos matrix results',
    '',
    `Five kill points, ${String(results.trialsPerPoint)} trials each, ` +
      `${String(trials)} trials total.`,
    '',
    `**Exactly-once violations: ${String(total)}**`,
    '',
    '## The guarantee',
    '',
    `> ${GUARANTEE}`,
    '',
    'Not "always one". Killing the gate before it writes anything, or inside the',
    'request before the rail acts on it, correctly ends with no refund at all —',
    'so `before_wal` and `during_call` legitimately observe zero. A matrix that',
    'demanded one refund per trial would be asserting the wrong property and',
    'would fail two of the five points for entirely correct behaviour.',
    '',
    'A trial passes only if all four hold after the restart:',
    '',
    '1. At most one rail entity carries the sik — *never two*.',
    '2. The intent is in a state that needs nothing further from the rail — *never unknown*.',
    '3. If money moved, the ledger says `APPLIED` — no silent loss.',
    '4. If the ledger says `APPLIED`, money moved — no phantom success.',
    '',
    '## Results',
    '',
    '| Kill point | Trials | Expected | Observed | Violations |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const summary of results.summaries) {
    lines.push(
      `| \`${summary.killPoint}\` | ${String(summary.trials)} | ${EXPECTATION[summary.killPoint]} ` +
        `| ${observedCell(summary)} | ${String(summary.violations.length)} |`,
    );
  }

  lines.push('');
  lines.push(
    `| **Total** | **${String(trials)}** | | | **${String(total)}** |`,
  );
  lines.push('');

  const killed = results.summaries.reduce((sum, summary) => sum + summary.killedAsExpected, 0);
  lines.push(
    `All ${String(killed)} of ${String(trials)} issuing processes were confirmed killed before`,
    'completing. That check is a violation in its own right, because a SIGKILL that',
    'silently failed to land would leave every other assertion passing on a trial',
    'that exercised nothing.',
    '',
  );

  if (total > 0) {
    lines.push('## Violations', '');
    for (const summary of results.summaries) {
      for (const violation of summary.violations) {
        lines.push(`- **${violation.kind}** — ${violation.message}`);
      }
    }
    lines.push('');
  }

  lines.push('## How this was produced', '');
  lines.push(
    'For each kill point, each trial starts a gate process against a fresh SQLite',
    'ledger and a fresh append-only rail journal, issues one refund, and waits for',
    'the process to be SIGKILLed at that exact lifecycle position. `SIGKILL` is',
    'used rather than a thrown error because an exception unwinds — `finally`',
    'blocks run, buffers flush, SQLite rolls back cleanly — and a machine losing',
    'power does none of that.',
    '',
    'A second process is then started against the same two files. It runs boot',
    'recovery to completion before doing anything else, and only then is the',
    'ledger compared against the rail journal.',
    '',
    `Run it with \`pnpm chaos:matrix --trials ${String(results.trialsPerPoint)}\`.`,
    '',
    `Started ${results.startedAt}, took ${String(Math.round(results.durationMs / 1000))}s.`,
    '',
  );

  return lines.join('\n');
}
