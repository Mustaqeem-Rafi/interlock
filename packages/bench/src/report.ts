import { InvariantViolation } from '@interlock/core';
import { FAMILY_TITLES } from './types.js';
import type {
  BenchReport,
  Family,
  FamilyScore,
  HarnessName,
  ModeScore,
  Observation,
  RunMode,
  RunProvenance,
} from './types.js';

/**
 * BenchReport -> markdown. Pure string building: no I/O, no clock, no state, no
 * lookup outside the report handed in, so the same report always renders the
 * same bytes and a RESULTS.md diff shows changed measurements rather than churn.
 *
 * Three rules shape everything below.
 *
 *  - Every table restates its own provenance. Tables get screenshotted into
 *    decks, pasted into issues and quoted in threads, where a header block at
 *    the top of the file is no longer there. A number that cannot say which run
 *    produced it is a claim, not a result.
 *  - A row is never dropped for being empty, unscored or broken. To anyone
 *    skimming, a missing row reads exactly like a clean one, so absence is
 *    spelled out as its own row with em dashes where the numbers would be.
 *  - Nothing is computed here that the scorer did not already compute, except
 *    presentation (rupees from paise, percent from a rate) and row totals for
 *    the `n` in a provenance line. A renderer that derives a metric is a second,
 *    untested implementation of the metric.
 */

const EM_DASH = '—';

/** Fixed report order, independent of input order, so diffs show numbers moving and not lines. */
const HARNESS_ORDER: readonly HarnessName[] = ['naive', 'langgraph'];
const MODE_ORDER: readonly RunMode[] = ['direct', 'gated'];
const FAMILY_ORDER: readonly Family[] = ['A', 'B', 'C', 'D', 'E'];

/**
 * Footnote markers, handed out in order.
 *
 * Deliberately not GitHub's `[^1]` footnotes: those render collected at the
 * very bottom of the document, which is precisely the "caveat far away from the
 * number" this report is trying not to do.
 */
const MARKERS: readonly string[] = ['†', '‡', '§', '¶'];

function marker(index: number): string {
  return MARKERS[index] ?? `*${String(index + 1)}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Thousands separators, locale-independent. `toLocaleString` would render
 * differently on a machine with a different default locale and make a committed
 * RESULTS.md churn for reasons that have nothing to do with the run.
 */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatInteger(value: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + groupThousands(String(Math.abs(Math.trunc(value))));
}

function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  const sign = value < 0 ? '-' : '';
  const text = Math.abs(value).toFixed(digits);
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot);
  return sign + groupThousands(whole) + fraction;
}

/** Rates arrive in [0,1] from the scorer; the reader wants percent. */
function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EM_DASH;
  return `${formatFixed(value * 100, 1)}%`;
}

/**
 * Both units, always: the system thinks in paise and the reader thinks in
 * rupees, and every argument this project has had about an amount started with
 * one side reading the other's unit as its own.
 */
function formatMoneyMinor(minor: number | null): string {
  if (minor === null) return EM_DASH;
  if (!Number.isSafeInteger(minor)) {
    throw new InvariantViolation(
      'money-is-minor-units',
      `${String(minor)} reached the report as money but is not an integer of minor units`,
    );
  }
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const rupees = groupThousands(String(Math.trunc(abs / 100)));
  const paise = abs % 100;
  const major = paise === 0 ? rupees : `${rupees}.${String(paise).padStart(2, '0')}`;
  return `${sign}${groupThousands(String(abs))} (Rs ${sign}${major})`;
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EM_DASH;
  return `${Number.isInteger(value) ? formatInteger(value) : formatFixed(value, 1)} ms`;
}

/** A pipe would split the cell and a newline would end the table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** Backticks in an id would break out of the span. There are none in practice, but ids are data. */
function inlineCode(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``;
}

function sumOf<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new InvariantViolation(
        'report-table-shape',
        `row has ${String(row.length)} cells but the header has ${String(headers.length)}`,
      );
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * The line that goes directly under every table heading.
 *
 * `n` is the count for *that* table, not for the run, so a family table and the
 * headline table honestly disagree about it.
 */
function provenanceLine(n: number, provenance: RunProvenance): string {
  const cache =
    `${String(provenance.cache.hits)} hit / ${String(provenance.cache.misses)} miss / ` +
    `${String(provenance.cache.writes)} write`;
  return (
    `_n = ${formatInteger(n)} · model ${inlineCode(provenance.model_id)} · ` +
    `commit ${inlineCode(provenance.commit_sha)} · ${inlineCode(provenance.timestamp)} · ` +
    `rail ${inlineCode(provenance.rail)} · seed ${formatInteger(provenance.seed)} · ` +
    `prompt cache ${cache}_`
  );
}

// ---------------------------------------------------------------------------
// Harness annotation: strawman flags and availability
// ---------------------------------------------------------------------------

/**
 * The strawman flag has to be recovered from `report.notes`, because
 * `BenchReport` carries `ModeScore[]` and not the `Harness` objects, so
 * `Harness.note` — the field that documents whether a harness is a strawman —
 * is not reachable from here. The runner appends exactly one `"<name>: <note>"`
 * line per harness, which is what this matches. A harness whose note stops
 * saying "strawman" simply stops being flagged; it never mislabels one.
 */
function harnessNote(harness: HarnessName, notes: readonly string[]): string | undefined {
  const prefix = `${harness}: `;
  for (const note of notes) {
    if (note.startsWith(prefix)) return note.slice(prefix.length);
  }
  return undefined;
}

function isStrawman(note: string | undefined): boolean {
  return note !== undefined && /strawman/i.test(note);
}

/**
 * First sentence only. The full note is reproduced verbatim under `## Notes`;
 * a 900-character paragraph wedged under the headline table is a caveat nobody
 * reads, which defeats the point of putting it next to the number.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed);
  return match?.[0] ?? trimmed;
}

interface HarnessFlag {
  readonly harness: HarnessName;
  readonly marker: string;
  readonly footnote: string;
}

function harnessFlags(report: BenchReport): readonly HarnessFlag[] {
  const flags: HarnessFlag[] = [];
  for (const harness of HARNESS_ORDER) {
    const note = harnessNote(harness, report.notes);
    if (!isStrawman(note) || note === undefined) continue;
    const mark = marker(flags.length);
    flags.push({
      harness,
      marker: mark,
      footnote:
        `${mark} ${inlineCode(harness)} is a **strawman harness** — its rows demonstrate a ` +
        `failure mechanism and are not an upper bound on careful engineering without ` +
        `Interlock. ${escapeCell(firstSentence(note))} Full note under [Notes](#notes).`,
    });
  }
  return flags;
}

function harnessLabel(harness: HarnessName, flags: readonly HarnessFlag[]): string {
  const flag = flags.find((candidate) => candidate.harness === harness);
  return flag === undefined ? inlineCode(harness) : `${inlineCode(harness)} ${flag.marker}`;
}

function keyOf(harness: HarnessName, mode: RunMode): string {
  return `${harness}/${mode}`;
}

interface Groups {
  /** Scored (harness, mode) groups, by key. */
  readonly scored: ReadonlyMap<string, ModeScore>;
  /** Observation counts per (harness, mode), including groups the scorer did not emit. */
  readonly observed: ReadonlyMap<string, number>;
}

function groupReport(report: BenchReport): Groups {
  const scored = new Map<string, ModeScore>();
  for (const score of report.scores) scored.set(keyOf(score.harness, score.mode), score);

  const observed = new Map<string, number>();
  for (const observation of report.observations) {
    const key = keyOf(observation.harness, observation.mode);
    observed.set(key, (observed.get(key) ?? 0) + 1);
  }
  return { scored, observed };
}

// ---------------------------------------------------------------------------
// 1. Headline table
// ---------------------------------------------------------------------------

const HEADLINE_HEADERS: readonly string[] = [
  'Harness',
  'Mode',
  'n',
  'Attack success',
  'Utility under attack',
  'False block',
  'Money at risk',
  'Dupes / 1k entities',
  'Exactly-once violations',
  'Orphan rate',
  'Latency p50',
  'Latency p99',
];

function headlineRow(score: ModeScore, label: string): readonly string[] {
  // `unavailable` is stated in the row itself, not only in the notes: the numbers
  // to its right are real but were produced by a group where nothing executed.
  const mode = score.unavailable === undefined ? score.mode : `${score.mode} (unavailable)`;
  return [
    label,
    mode,
    formatInteger(score.n),
    formatPercent(score.attack_success_rate),
    formatPercent(score.utility_under_attack),
    formatPercent(score.false_block_rate),
    formatMoneyMinor(score.money_at_risk_minor),
    formatFixed(score.duplicates_per_1000, 1),
    formatInteger(score.exactly_once_violations),
    formatPercent(score.orphan_rate),
    formatMs(score.latency_p50_ms),
    formatMs(score.latency_p99_ms),
  ];
}

/** A row that exists to say a number does not. Nine metric columns, all em dash. */
function placeholderRow(label: string, mode: string, n: number): readonly string[] {
  return [label, mode, formatInteger(n), ...Array<string>(9).fill(EM_DASH)];
}

function renderHeadline(report: BenchReport, flags: readonly HarnessFlag[]): string {
  const { scored, observed } = groupReport(report);
  const rows: string[][] = [];
  const footnotes: string[] = [...flags.map((flag) => flag.footnote)];

  for (const harness of HARNESS_ORDER) {
    const label = harnessLabel(harness, flags);
    const present = MODE_ORDER.filter((mode) => {
      const key = keyOf(harness, mode);
      return scored.has(key) || (observed.get(key) ?? 0) > 0;
    });

    if (present.length === 0) {
      rows.push([...placeholderRow(label, 'did not run', 0)]);
      footnotes.push(
        `${inlineCode(harness)} produced no observations in this run. The row is kept because a ` +
          `missing row reads as a passing row.`,
      );
      continue;
    }

    for (const mode of present) {
      const key = keyOf(harness, mode);
      const score = scored.get(key);
      if (score !== undefined) {
        rows.push([...headlineRow(score, label)]);
        if (score.unavailable !== undefined) {
          footnotes.push(
            `${inlineCode(key)}: no run in this group executed — ${escapeCell(score.unavailable)}`,
          );
        }
        continue;
      }
      // Observations exist but the scorer emitted no row for them. Report the
      // count and refuse to invent the metrics.
      const n = observed.get(key) ?? 0;
      rows.push([...placeholderRow(label, `${mode} (not scored)`, n)]);
      footnotes.push(
        `${inlineCode(key)}: ${formatInteger(n)} observation(s) reached the report with no score ` +
          `row, so its metrics are unknown rather than zero.`,
      );
    }
  }

  const n = sumOf(report.scores, (score) => score.n);
  const parts = ['## Benchmark', '', provenanceLine(n, report.provenance), ''];

  parts.push(renderTable(HEADLINE_HEADERS, rows), '');
  parts.push(
    '`direct` and `gated` are the same harness, the same scenarios and the same model; the only',
    'variable is whether the tool calls go through Interlock, so the delta between the two rows is',
    'attributable to the gate and to nothing else.',
  );
  for (const footnote of footnotes) parts.push('', footnote);
  return parts.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// 2. Per-family tables
// ---------------------------------------------------------------------------

const FAMILY_HEADERS: readonly string[] = [
  'Family',
  'Mode',
  'n',
  'Attack success',
  'Utility under attack',
  'False block',
  'Money at risk',
  'Dupes / 1k entities',
  'Exactly-once violations',
  'Orphan rate',
  'Detect p50',
];

function familyRow(score: FamilyScore, mode: RunMode): readonly string[] {
  return [
    `${score.family} — ${FAMILY_TITLES[score.family]}`,
    mode,
    formatInteger(score.n),
    formatPercent(score.attack_success_rate),
    formatPercent(score.utility_under_attack),
    formatPercent(score.false_block_rate),
    formatMoneyMinor(score.money_at_risk_minor),
    formatFixed(score.duplicates_per_1000, 1),
    formatInteger(score.exactly_once_violations),
    formatPercent(score.orphan_rate),
    formatMs(score.time_to_detect_p50_ms),
  ];
}

function renderFamilies(report: BenchReport, flags: readonly HarnessFlag[]): string {
  const { scored, observed } = groupReport(report);
  const parts = ['## By family', ''];
  parts.push(
    'Family rows are grouped so the two modes for one family sit next to each other; that',
    'adjacency is the whole comparison.',
    '',
  );

  for (const harness of HARNESS_ORDER) {
    const label = harnessLabel(harness, flags);
    parts.push(`### ${label}`, '');

    const modeScores = MODE_ORDER.map((mode) => scored.get(keyOf(harness, mode))).filter(
      (score): score is ModeScore => score !== undefined,
    );

    if (modeScores.length === 0) {
      const seen = sumOf(MODE_ORDER, (mode) => observed.get(keyOf(harness, mode)) ?? 0);
      parts.push(provenanceLine(seen, report.provenance), '');
      parts.push(
        seen === 0
          ? '**This harness produced no observations in this run.** The section is kept empty ' +
              'rather than omitted, because an absent section is indistinguishable from a clean one.'
          : `**This harness produced ${formatInteger(seen)} observation(s) and no score rows**, so ` +
              'its per-family metrics are unknown rather than zero.',
        '',
      );
      continue;
    }

    const rows: string[][] = [];
    for (const family of FAMILY_ORDER) {
      for (const score of modeScores) {
        const inFamily = score.families.find((candidate) => candidate.family === family);
        if (inFamily === undefined) continue;
        rows.push([...familyRow(inFamily, score.mode)]);
      }
    }

    const n = sumOf(modeScores, (score) => sumOf(score.families, (family) => family.n));
    parts.push(provenanceLine(n, report.provenance), '');

    // The unavailability lines are emitted either way. A section that says only
    // "no rows" leaves the reader to guess whether the harness was skipped or
    // broke, and those are very different facts about a benchmark.
    parts.push(
      rows.length === 0
        ? '**No family rows were scored for this harness.**'
        : renderTable(FAMILY_HEADERS, rows),
      '',
    );

    for (const score of modeScores) {
      if (score.unavailable === undefined) continue;
      parts.push(
        `${inlineCode(keyOf(score.harness, score.mode))}: no run in this group executed — ` +
          `${escapeCell(score.unavailable)}`,
        '',
      );
    }
    const flag = flags.find((candidate) => candidate.harness === harness);
    if (flag !== undefined) parts.push(flag.footnote, '');
  }

  return parts.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// 3. Per-scenario table
// ---------------------------------------------------------------------------

const SCENARIO_HEADERS: readonly string[] = [
  'Scenario',
  'Family',
  'Harness',
  'Mode',
  'Money moved',
  'Entities',
  'Result',
  'Assertion failures',
];

function rankOf<T>(order: readonly T[], value: T): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function scenarioRow(observation: Observation, flags: readonly HarnessFlag[]): readonly string[] {
  const result = observation.assertion_passed
    ? 'pass'
    : observation.unavailable === undefined
      ? '**FAIL**'
      : '**FAIL** (unavailable)';
  const failures =
    observation.assertion_failures.length === 0
      ? EM_DASH
      : escapeCell(observation.assertion_failures.join('; '));
  return [
    inlineCode(observation.scenario_id),
    observation.family,
    harnessLabel(observation.harness, flags),
    observation.mode,
    formatMoneyMinor(observation.money_moved_minor),
    formatInteger(observation.rail_entities),
    result,
    failures,
  ];
}

function renderScenarios(report: BenchReport, flags: readonly HarnessFlag[]): string {
  const parts = ['## Scenarios', ''];
  parts.push(provenanceLine(report.observations.length, report.provenance), '');

  if (report.observations.length === 0) {
    parts.push('**No scenario was observed in this run.**', '');
    return parts.join('\n').trimEnd();
  }

  // Sorted on a copy: the caller's array is not ours to reorder, and a rendered
  // table that depends on runner iteration order diffs for no reason.
  const ordered = [...report.observations].sort((a, b) => {
    const byHarness = rankOf(HARNESS_ORDER, a.harness) - rankOf(HARNESS_ORDER, b.harness);
    if (byHarness !== 0) return byHarness;
    const byMode = rankOf(MODE_ORDER, a.mode) - rankOf(MODE_ORDER, b.mode);
    if (byMode !== 0) return byMode;
    if (a.scenario_id < b.scenario_id) return -1;
    if (a.scenario_id > b.scenario_id) return 1;
    return 0;
  });

  parts.push(renderTable(SCENARIO_HEADERS, ordered.map((o) => [...scenarioRow(o, flags)])));
  parts.push('');
  parts.push(
    'Money moved and entities are read off the rail after the run, not off the transcript. A',
    'scenario passes on those numbers and on nothing a human read into what the agent said.',
  );
  return parts.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// 4. Notes
// ---------------------------------------------------------------------------

/** A multi-line note stays one list item: continuation lines are indented, text untouched. */
function asListItem(note: string): string {
  return `- ${note.replace(/\r?\n/g, '\n  ')}`;
}

function renderNotes(report: BenchReport): string {
  const parts = ['## Notes', ''];

  if (report.notes.length === 0) {
    parts.push('_No notes were recorded for this run._', '');
  } else {
    for (const note of report.notes) parts.push(asListItem(note));
    parts.push('');
  }

  const { scored, observed } = groupReport(report);
  const availability: string[] = [];

  for (const score of report.scores) {
    if (score.unavailable === undefined) continue;
    availability.push(
      `- ${inlineCode(keyOf(score.harness, score.mode))} (n = ${formatInteger(score.n)}): every ` +
        `run in this group failed to execute — ${score.unavailable}`,
    );
  }

  for (const harness of HARNESS_ORDER) {
    for (const mode of MODE_ORDER) {
      const key = keyOf(harness, mode);
      const seen = observed.get(key) ?? 0;
      if (scored.has(key)) continue;
      availability.push(
        seen === 0
          ? `- ${inlineCode(key)}: did not run in this report. Its absence is not a pass.`
          : `- ${inlineCode(key)}: ${formatInteger(seen)} observation(s) with no score row, so its ` +
            `metrics are unknown rather than zero.`,
      );
    }
  }

  parts.push('### Availability', '');
  if (availability.length === 0) {
    parts.push('- Every (harness, mode) group in this report ran and was scored.');
  } else {
    parts.push(...availability);
  }
  parts.push('');

  return parts.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render a scored run as the markdown fragment that becomes the benchmark
 * section of RESULTS.md. No heading above `##`: this file is composed with
 * other generators' fragments, and owning the document title would let one
 * generator silently claim the whole file.
 */
export function renderBenchReport(report: BenchReport): string {
  const flags = harnessFlags(report);
  return (
    [
      renderHeadline(report, flags),
      renderFamilies(report, flags),
      renderScenarios(report, flags),
      renderNotes(report),
    ].join('\n\n') + '\n'
  );
}
