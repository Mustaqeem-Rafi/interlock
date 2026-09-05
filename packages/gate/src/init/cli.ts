import { draftMandate, type AuthoringModel, type MandateDraft } from './author.js';
import { buildAuthoringPrompt, type InitAnswers } from './questions.js';

/**
 * `interlock init --upstream <url>` — the authoring flow, minus its terminal.
 *
 * Four questions, one model call, one human approval, one file. The model is on
 * the near side of that approval and nothing else in Interlock is: after this
 * runs, the mandate is read only by gates that compare integers.
 *
 * All I/O arrives as callbacks. `confirm` is somebody's prompt loop, `write` is
 * somebody's fs.writeFileSync, `print` is somebody's console — so the whole
 * flow, including the case where a human says no, is testable without a tty.
 */

const RULE = '-'.repeat(76);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Names and descriptions out of a fetched manifest.
 *
 * Typed as unknown[] because that is honestly what it is: bytes another server
 * chose. Anything without a string name is skipped rather than coerced — the
 * prompt is better off not mentioning a tool than mentioning a malformed one.
 */
function toolSummaries(
  tools: readonly unknown[],
): readonly { name: string; description?: string }[] {
  const summaries: { name: string; description?: string }[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = tool['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const description = tool['description'];
    summaries.push({
      name,
      ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
    });
  }
  return summaries;
}

/**
 * A model can emit an epoch that is an integer, non-negative, and still outside
 * the range Date can represent. That must not throw here: this is the function
 * printing the draft a human is about to judge, and a crash at that moment
 * hides the very defect the human would have caught.
 */
function iso(epochMs: number): string {
  const at = new Date(epochMs);
  if (Number.isNaN(at.getTime())) return `${String(epochMs)} (not a representable time)`;
  return at.toISOString();
}

/**
 * What a human sees before deciding.
 *
 * The summary comes first because it is what makes a wrong draft obvious in
 * five seconds; the full YAML follows because it is what gets written and the
 * summary is not a substitute for it. Amounts are printed in minor units, the
 * unit the mandate is actually enforced in — dividing by 100 to show rupees
 * would be the codebase's one float and would hide a factor-of-ten error behind
 * a decimal point.
 */
export function formatDraft(draft: MandateDraft): string {
  const mandate = draft.mandate;
  const lines: string[] = [
    RULE,
    'interlock init: proposed mandate. Nothing has been written yet.',
    RULE,
    `  mandate   ${mandate.mandate_id}`,
    `  agent     ${mandate.agent_id}   (merchant ${mandate.merchant_id})`,
    `  valid     ${iso(mandate.issued_at)} to ${iso(mandate.expires_at)}`,
    `  purpose   ${mandate.purpose}`,
    '',
    '  Tools this would authorise:',
  ];

  const grants = Object.entries(mandate.scope.grants);
  if (grants.length === 0) {
    lines.push('    (none: this mandate authorises no tool at all)');
  }
  for (const [tool, grant] of grants) {
    lines.push(
      `    ${tool}  [${grant.reversibility}]  up to ` +
        `${String(grant.value.max_amount_minor)} minor units per call ` +
        `(${grant.value.currencies.join(', ')})`,
    );
  }

  lines.push('', '  Caps across time:');
  if (mandate.limits.windows.length === 0) {
    lines.push('    (none)');
  }
  for (const window of mandate.limits.windows) {
    lines.push(
      `    every ${String(window.window_ms)}ms: at most ${String(window.max_calls)} calls and ` +
        `${String(window.max_amount_minor)} minor units of ${window.currency}`,
    );
  }
  for (const [currency, budget] of Object.entries(mandate.limits.fee_budgets)) {
    lines.push(
      `    fees: at most ${String(budget.max_fee_minor)} minor units of ${currency} per ` +
        `${String(budget.window_ms)}ms`,
    );
  }

  lines.push('', RULE, draft.yaml.trimEnd(), RULE);

  if (draft.warnings.length === 0) {
    lines.push('No warnings. Read the YAML anyway.');
  } else {
    lines.push(`${String(draft.warnings.length)} thing(s) to look at twice:`);
    for (const warning of draft.warnings) lines.push(`  !  ${warning}`);
  }

  return lines.join('\n');
}

export interface RunInitOptions {
  readonly upstream: string;
  readonly answers: InitAnswers;
  readonly model: AuthoringModel;
  readonly manifest: { readonly sha256: string; readonly tools: readonly unknown[] };
  readonly merchantId: string;
  readonly agentId: string;
  /**
   * Ask the human. Resolving false is a first-class outcome, not an error path.
   */
  readonly confirm: (yaml: string, warnings: readonly string[]) => Promise<boolean>;
  /**
   * Persist the approved YAML. Returning the path it landed at is optional; if
   * it does, runInit reports it back to the caller.
   */
  readonly write: (yaml: string) => void | string;
  /** Where the draft is shown. Defaults to the console; injected in tests. */
  readonly print?: (line: string) => void;
}

/**
 * Run the authoring flow.
 *
 * THE APPROVAL IS NOT OPTIONAL AND IT DOES NOT DEFAULT TO YES. There is no
 * --yes, no non-interactive mode and no "assume approval in CI", and adding one
 * would end the argument this project is making. A mandate the human did not
 * read is a mandate the model wrote — which is precisely the thing this design
 * refuses, since a mandate is standing authority to move real money and the
 * only reason it is safe for a model to draft one is that a person stands
 * between the draft and the file.
 *
 * If confirm resolves false, nothing is written. Not a partial file, not a
 * draft on disk for later, nothing: the next run starts from four questions.
 */
export async function runInit(
  options: RunInitOptions,
): Promise<{ approved: boolean; path?: string }> {
  const print = options.print ?? ((line: string): void => { console.log(line); });

  const prompt = buildAuthoringPrompt({
    answers: options.answers,
    tools: toolSummaries(options.manifest.tools),
    merchantId: options.merchantId,
    agentId: options.agentId,
    upstream: options.upstream,
  });

  // A MandateInitError propagates. The operator needs to see that the model
  // produced something unusable, and a caught-and-defaulted mandate would be
  // the worst possible recovery.
  const draft = await draftMandate({
    model: options.model,
    prompt,
    manifest: { sha256: options.manifest.sha256, tools: options.manifest.tools },
  });

  print(formatDraft(draft));

  const approved = await options.confirm(draft.yaml, draft.warnings);
  if (!approved) {
    print('Not approved. Nothing was written.');
    return { approved: false };
  }

  const written = options.write(draft.yaml);
  return typeof written === 'string' ? { approved: true, path: written } : { approved: true };
}
