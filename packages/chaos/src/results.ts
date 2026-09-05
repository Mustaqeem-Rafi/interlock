import type { KillPoint } from '@interlock/gate';
import { EXPECTATION, GUARANTEE, type Violation } from './verdict.js';

/** One row of the table: everything observed at one kill point. */
export interface KillPointSummary {
  readonly killPoint: KillPoint;
  readonly profile: string;
  readonly trials: number;
  /** Rail-entity counts after boot recovery, e.g. { 0: 20 }. */
  readonly counts: Readonly<Record<number, number>>;
  /** Intent states after boot recovery. */
  readonly states: Readonly<Record<string, number>>;
  /** The same, after the agent has asked for the refund again. */
  readonly retryCounts: Readonly<Record<number, number>>;
  readonly retryStates: Readonly<Record<string, number>>;
  readonly killedAsExpected: number;
  /** Trials where a fault threw before the kill point, so surviving is correct. */
  readonly preempted: number;
  /** Ended QUARANTINED: not a violation, but a human has to finish it. */
  readonly escalated: number;
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

function cell(
  counts: Readonly<Record<number, number>>,
  states: Readonly<Record<string, number>>,
): string {
  const labelled = Object.fromEntries(
    Object.entries(counts).map(([count, n]) => [
      `${count} refund${count === '1' ? '' : 's'}`,
      n,
    ]),
  );
  return `${histogram(labelled)}<br>${histogram(states)}`;
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
    '| Kill point | Fault | Trials | Expected after recovery | Observed after recovery '
      + '| After the agent retries | Violations |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const summary of results.summaries) {
    lines.push(
      `| \`${summary.killPoint}\` | ${summary.profile} | ${String(summary.trials)} ` +
        `| ${EXPECTATION[summary.killPoint]} | ${cell(summary.counts, summary.states)} ` +
        `| ${cell(summary.retryCounts, summary.retryStates)} ` +
        `| ${String(summary.violations.length)} |`,
    );
  }

  lines.push('');
  lines.push(
    `| **Total** | | **${String(trials)}** | | | | **${String(total)}** |`,
  );
  lines.push('');

  const killed = results.summaries.reduce((sum, summary) => sum + summary.killedAsExpected, 0);
  const preempted = results.summaries.reduce((sum, summary) => sum + summary.preempted, 0);
  lines.push(
    `${String(killed)} of ${String(trials)} issuing processes were confirmed killed at their`,
    `kill point. The other ${String(preempted)} were preempted: a fault threw inside the rail`,
    'call before the kill point could be reached, so surviving there is correct',
    'behaviour rather than a disarmed matrix. A kill that was reachable and did not',
    'land is a violation in its own right, because a SIGKILL that silently failed',
    'would leave every other assertion passing on a trial that exercised nothing.',
    '',
    'The two right-hand columns answer different questions. Observed after recovery',
    'is the crash-safety claim: what a restart alone establishes. After the agent',
    'retries is what happens when it asks for the same refund again, which is the',
    'request most likely to produce a second one. A row reading 0 refunds and then',
    '1 refund is the system working: the crash left nothing applied, and the retry',
    'completed it exactly once.',
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

  lines.push('## Regressions this matrix has caught', '');
  lines.push(
    'Kept here because they are the reason the matrix exists, and because a table',
    'of zeroes says nothing about whether it was ever capable of saying otherwise.',
    '',
    '- **An intent left in `UNKNOWN` was never reconciled by anything.** A rail call',
    '  that ends ambiguously records `UNKNOWN` and hands the intent to whoever',
    '  reconciles next. Nothing did: the periodic sweep only detects drift, and boot',
    '  recovery only looked at `IN_FLIGHT` and `RECONCILING`. So an intent that',
    '  reached `UNKNOWN` cleanly sat there forever, with the money possibly already',
    '  gone and nothing ever going to check. Surfaced as `SILENT_LOSS` plus',
    '  `UNRESOLVED_AFTER_RECOVERY` on every `ambiguous_504` cell. Fixed by making',
    '  `UNKNOWN` a recoverable state.',
    '',
    '- **The write-ahead log trusted the id the rail returned.** Under `dup_response`',
    '  the gateway replays a previous response, so the ledger recorded a refund id',
    '  belonging to somebody else while our own refund sat upstream unclaimed. This',
    '  is trap 3 — amount is not an identity — applied to the response rather than to',
    '  reconciliation, and it had only ever been applied to reconciliation. Surfaced',
    '  as `WRONG_ENTITY_RECORDED`. Fixed by checking the response carries the stamp',
    '  we sent; if it does not, the outcome is ambiguous and the reconciler goes and',
    '  finds the real one.',
    '',
  );

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
