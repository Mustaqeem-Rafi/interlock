import { canonicalJson } from './canonical.js';
import { InvariantViolation } from './errors.js';
import { base32Encode, sha256Bytes } from './hash.js';

/**
 * The semantic idempotency key.
 *
 * Not a transport-level idempotency key: it is a hash of what the call *means*,
 * so a retry phrased differently by the model still collides with the original.
 * Two calls share a SIK exactly when they would move the same money out of the
 * same account for the same reason.
 */

export const SIK_LENGTH = 32;
export const SIK_VERSION = 1;

/** Tools for which a time window is meaningless — see NO_WINDOW_TOOLS below. */
const NO_WINDOW_TOOLS: ReadonlySet<string> = new Set(['create_refund']);

declare const RailResolvedBrand: unique symbol;

/**
 * A rail entity id that *we* resolved by querying the rail.
 *
 * The brand exists so that passing a model-supplied string into the key is a
 * type error rather than a code review question. `subject` is the one field an
 * agent could otherwise use to split a duplicate into two distinct keys just by
 * describing the same payment differently.
 */
export type RailSubjectId = string & { readonly [RailResolvedBrand]: true };

/**
 * Brand an id as rail-resolved. Call this **only** from the rail adapter, at the
 * point where the id came back in a rail response. Never from argument parsing.
 */
export function railSubjectId(id: string): RailSubjectId {
  if (id.trim() === '') {
    throw new InvariantViolation('sik.subject', 'a rail subject id cannot be empty');
  }
  return id as RailSubjectId;
}

export interface SikWindow {
  readonly window_ms: number;
  readonly bucket: number;
}

/**
 * Bucket a timestamp for tools whose repeats are legitimate once enough time has
 * passed. `window_ms` is part of the key so that changing the mandate's window
 * invalidates old keys instead of silently re-scoping them.
 */
export function timeWindow(nowMs: number, windowMs: number | null): SikWindow | null {
  if (windowMs === null) return null;
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new InvariantViolation('sik.window', `window_ms must be a positive integer, got ${String(windowMs)}`);
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new InvariantViolation('sik.window', `now must be a non-negative epoch ms integer, got ${String(nowMs)}`);
  }
  return { window_ms: windowMs, bucket: Math.floor(nowMs / windowMs) };
}

export interface SikInput {
  readonly merchant_id: string;
  readonly tool: string;
  /** The rail entity id we resolved ourselves — never the model's phrasing. */
  readonly subject: RailSubjectId;
  /** Integer, minor units. */
  readonly amount_minor: number;
  readonly currency: string;
  /** Tool-specific discriminators drawn from the mandate's `key_fields`. */
  readonly extra?: unknown;
  /** `null` for tools where repetition is never legitimate. */
  readonly window?: SikWindow | null;
  /** `interlock_distinct_reason`, entered verbatim when the agent supplies one. */
  readonly distinct?: string | null;
}

/** The exact object that gets hashed. Field set is frozen by SIK_VERSION. */
export interface SikPayload {
  readonly v: number;
  readonly merchant_id: string;
  readonly tool: string;
  readonly subject: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly extra: unknown;
  readonly window: SikWindow | null;
  readonly distinct: string | null;
}

function assertNonEmpty(field: string, value: string): void {
  if (value.trim() === '') {
    throw new InvariantViolation(`sik.${field}`, `${field} cannot be empty`);
  }
}

/**
 * Build the payload. Exported so tests and the audit log can show exactly what
 * was hashed rather than asking the reader to trust the digest.
 */
export function sikPayload(input: SikInput): SikPayload {
  assertNonEmpty('merchant_id', input.merchant_id);
  assertNonEmpty('tool', input.tool);
  assertNonEmpty('subject', input.subject);

  if (!Number.isSafeInteger(input.amount_minor)) {
    throw new InvariantViolation(
      'sik.amount_minor',
      `amount must be an integer in minor units, got ${String(input.amount_minor)}`,
    );
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new InvariantViolation('sik.currency', `expected an ISO 4217 code, got "${input.currency}"`);
  }

  const window = input.window ?? null;
  if (window !== null && NO_WINDOW_TOOLS.has(input.tool)) {
    // Two refunds of the same amount on the same payment are indistinguishable
    // by meaning. A window would make the second one legitimate merely because
    // time passed, which is exactly the double-refund this project prevents.
    // The escape hatch is an explicit distinct reason, not a clock.
    throw new InvariantViolation(
      'sik.window',
      `${input.tool} must not carry a time window; use interlock_distinct_reason instead`,
    );
  }

  return {
    v: SIK_VERSION,
    merchant_id: input.merchant_id,
    tool: input.tool,
    subject: input.subject,
    amount_minor: input.amount_minor,
    currency: input.currency,
    extra: input.extra ?? null,
    window,
    distinct: input.distinct ?? null,
  };
}

/** base32(sha256(canonicalJson(payload))) truncated to 32 characters. */
export function computeSik(input: SikInput): string {
  return base32Encode(sha256Bytes(canonicalJson(sikPayload(input)))).slice(0, SIK_LENGTH);
}

/** Razorpay treats `receipt` as a per-payment idempotency key. Stamp it. */
export function sikReceipt(sik: string): string {
  return `ilk_${sik}`;
}
