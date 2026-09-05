import { InterlockError, Mandate, sha256Hex } from '@interlock/core';
import { parse, stringify } from 'yaml';
import { stableStringify } from '../proxy/upstream.js';

/**
 * Turn a model's draft into a mandate a human can approve.
 *
 * The order of operations here is the security argument, so it is worth stating
 * plainly: parse the model's text, overwrite the parts of it the model is not
 * allowed to choose, validate the result, and only then hand it to a human. The
 * model gets to propose scope and numbers — every one of which a person reads —
 * and gets no say at all in what the manifest pin says, because the pin is the
 * record of what we actually fetched. A model that could write its own pin
 * could authorise a tool description nobody ever saw.
 *
 * Nothing in this file runs at decision time. By the time a payment call
 * arrives, this has already happened, a human has already said yes, and the
 * only thing reading the mandate is a gate that cannot be argued with.
 */

/** 24h in ms. Used for the "is this window the daily cap" test, not for policy. */
const DAY_MS = 86_400_000;
const NINETY_DAYS_MS = 90 * DAY_MS;

/**
 * How far a period cap may exceed a single-action cap before it stops looking
 * like a cap. Rough on purpose: 100 actions a day at the ceiling is a plausible
 * refund desk, 10,000 is a typo or a runaway.
 */
const CAP_RATIO = 100;

/**
 * The draft failed to become a mandate.
 *
 * `issues` carries every zod problem rather than the first, because an operator
 * fixing a prompt needs the whole list — re-running the model to discover the
 * next error one at a time is how a deadline gets eaten.
 */
export class MandateInitError extends InterlockError {
  readonly code = 'MANDATE_INIT_FAILED' as const;
  readonly issues: readonly string[];

  constructor(detail: string, issues: readonly string[] = []) {
    super(
      issues.length === 0
        ? detail
        : `${detail}\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.issues = issues;
  }
}

export interface MandateDraft {
  readonly yaml: string;
  readonly mandate: Mandate;
  readonly warnings: readonly string[];
}

/**
 * The authoring model, as narrowly as we need it.
 *
 * One method, text in and text out. Interlock does not depend on a provider, a
 * tool-calling protocol or a streaming API, and the whole model surface of the
 * project is this interface — which is a claim you can check by grepping for
 * it.
 */
export interface AuthoringModel {
  complete(prompt: string): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Models emit fenced code blocks however firmly you ask them not to. Stripping
 * one fence is cheaper than a retry and cannot change the YAML inside it.
 */
const FENCE = /^```(?:ya?ml)?\r?\n([\s\S]*?)\r?\n?```$/;

function unfence(text: string): string {
  const match = FENCE.exec(text.trim());
  return match?.[1] ?? text;
}

/**
 * Pins we computed, keyed by tool name.
 *
 * The hash is over the tool entry exactly as the upstream server served it —
 * same encoder the proxy uses for the whole-manifest pin, so a description that
 * changes under us changes this hash too. `stableStringify` rather than
 * canonicalJson: a JSON Schema may legitimately contain 1.5, and canonicalJson
 * refuses non-integer numbers because in this codebase a float is money going
 * wrong.
 */
function computePins(tools: readonly unknown[]): Map<string, string> {
  const pins = new Map<string, string>();
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = tool['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    pins.set(name, sha256Hex(stableStringify(tool)));
  }
  return pins;
}

/**
 * Overwrite everything about provenance that the model does not get to decide.
 *
 * The whole-manifest hash and the pinned tool list are ours outright. Per-tool
 * pins are ours for every tool we actually fetched; a tool the model invented
 * keeps whatever placeholder it wrote, which is exactly why `warnings` calls
 * that case out by name. Trust tier is the one field where the model's answer
 * survives, and only when it is more restrictive than what we would have said:
 * a model may distrust a tool we fetched, it may not vouch for one.
 */
function pinProvenance(
  draft: Record<string, unknown>,
  manifest: { sha256: string; tools: readonly unknown[] },
  pins: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const provenance: Record<string, unknown> = isRecord(draft['provenance'])
    ? { ...draft['provenance'] }
    : {};
  const declaredPins: Record<string, unknown> = isRecord(provenance['pinned_manifests'])
    ? { ...provenance['pinned_manifests'] }
    : {};

  for (const [name, sha256] of pins) {
    const declared = declaredPins[name];
    const tier = isRecord(declared) ? declared['trust_tier'] : undefined;
    const trust_tier = tier === 'untrusted' || tier === 'known' ? tier : 'pinned';
    declaredPins[name] = { sha256, trust_tier };
  }

  return {
    ...draft,
    provenance: {
      ...provenance,
      pinned_manifests: declaredPins,
      manifest_sha256: manifest.sha256,
      pinned_manifest: [...manifest.tools],
    },
  };
}

/**
 * Things an operator should look twice at before approving.
 *
 * Not errors: every one of these is a mandate that validates and would work.
 * They are the four ways a draft can be technically correct and still not be
 * what the person answering four questions meant, and they exist because a
 * human skimming ninety lines of YAML at 11pm will read a warning list and will
 * not re-derive it.
 */
function collectWarnings(mandate: Mandate, manifestNames: ReadonlySet<string>): string[] {
  const warnings: string[] = [];
  const grants = Object.entries(mandate.scope.grants);

  for (const [tool, grant] of grants) {
    if (grant.reversibility === 'irreversible') {
      warnings.push(
        `${tool} is granted and is irreversible: up to ${String(grant.value.max_amount_minor)} ` +
          `minor units can leave per call with no call that brings it back.`,
      );
    }
    if (!manifestNames.has(tool)) {
      warnings.push(
        `${tool} is granted but the upstream server advertised no tool of that name, so its ` +
          `pin is a placeholder rather than a hash of anything we fetched. The model may have ` +
          `invented this tool.`,
      );
    }
  }

  // The per-action ceiling a period cap should be measured against, per currency.
  const perAction = new Map<string, number>();
  for (const [, grant] of grants) {
    for (const currency of grant.value.currencies) {
      const seen = perAction.get(currency) ?? 0;
      if (grant.value.max_amount_minor > seen) {
        perAction.set(currency, grant.value.max_amount_minor);
      }
    }
  }

  if (mandate.limits.windows.length === 0) {
    warnings.push(
      'no velocity window was written, so nothing caps the total across a day — ' +
        'Gate 3 has only the per-action ceiling to work with.',
    );
  }

  for (const window of mandate.limits.windows) {
    // Only day-or-shorter windows are the "daily cap" the operator was asked
    // about. A 30-day window at 100x a single action is unremarkable.
    if (window.window_ms > DAY_MS) continue;
    const ceiling = perAction.get(window.currency) ?? 0;
    if (ceiling <= 0) continue;
    if (window.max_amount_minor > ceiling * CAP_RATIO) {
      warnings.push(
        `the ${String(window.window_ms)}ms ${window.currency} cap of ` +
          `${String(window.max_amount_minor)} minor units is more than ${String(CAP_RATIO)}x the ` +
          `${String(ceiling)} allowed in one action, which is a cap in name only.`,
      );
    }
  }

  const life = mandate.expires_at - mandate.issued_at;
  if (life > NINETY_DAYS_MS) {
    warnings.push(
      `this mandate is valid for ${String(Math.round(life / DAY_MS))} days. Standing authority ` +
        `to move money outlives the reason it was granted; 30 days and a renewal is safer.`,
    );
  }

  return warnings;
}

/**
 * Draft a mandate: ask the model, pin what is ours to pin, validate, re-emit.
 *
 * The returned YAML is serialised from the *validated* object, not from the
 * model's text. What the human reads is therefore exactly what passed the
 * schema — no stray key that zod dropped, no comment the model slipped in, no
 * difference at all between the bytes reviewed and the bytes enforced.
 */
export async function draftMandate(input: {
  model: AuthoringModel;
  prompt: string;
  manifest: { sha256: string; tools: readonly unknown[] };
}): Promise<MandateDraft> {
  const raw = await input.model.complete(input.prompt);

  let document: unknown;
  try {
    document = parse(unfence(raw));
  } catch (error) {
    throw new MandateInitError(`the model's draft is not valid YAML: ${describe(error)}`);
  }

  if (!isRecord(document)) {
    throw new MandateInitError(
      `the model's draft parsed as ${document === null ? 'null' : typeof document}, ` +
        'not a YAML mapping, so there is no mandate in it',
    );
  }

  const pins = computePins(input.manifest.tools);
  const parsed = Mandate.safeParse(pinProvenance(document, input.manifest, pins));

  if (!parsed.success) {
    throw new MandateInitError(
      'the model drafted a mandate that does not satisfy the schema',
      parsed.error.issues.map((issue) => {
        const path = issue.path.map((segment) => String(segment)).join('.');
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      }),
    );
  }

  const manifestNames = new Set(pins.keys());

  return {
    // aliasDuplicateObjects: false because YAML anchors (`*a1`) are correct and
    // unreadable, and this document exists to be read. lineWidth: 0 keeps a long
    // tool description on one line so two mandates diff cleanly.
    yaml: stringify(parsed.data, { lineWidth: 0, aliasDuplicateObjects: false }),
    mandate: parsed.data,
    warnings: collectWarnings(parsed.data, manifestNames),
  };
}
