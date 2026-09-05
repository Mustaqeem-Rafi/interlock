/**
 * Typed errors. Nothing in this system throws a bare Error — every failure
 * carries a stable `code` so the transport can map it to the client shape
 * `{ success: false, error: { code, message, requestId } }` without string
 * matching, and so tests can assert on the reason rather than the wording.
 */

export type InterlockErrorCode =
  | 'ENV_INVALID'
  | 'CANONICAL_UNDEFINED'
  | 'CANONICAL_NON_INTEGER'
  | 'CANONICAL_UNSUPPORTED_TYPE'
  | 'CANONICAL_CYCLE'
  | 'CANONICAL_DEPTH'
  | 'INVARIANT_VIOLATION'
  | 'STORE_OPEN_FAILED'
  | 'STORE_DURABILITY_UNAVAILABLE'
  | 'STORE_DUPLICATE_INTENT'
  | 'STORE_NOT_FOUND'
  | 'STORE_STALE_STATE'
  | 'STORE_CONSTRAINT'
  | 'RAIL_TIMEOUT'
  | 'RAIL_UNAVAILABLE'
  | 'RAIL_DUPLICATE_RECEIPT'
  | 'RAIL_NOT_FOUND'
  | 'RAIL_REJECTED'
  | 'RAIL_RESPONSE_MISMATCH'
  | 'CHAOS_CONFIG'
  | 'CHAOS_TRIAL_FAILED'
  | 'BENCH_CATALOGUE_INVALID'
  | 'BENCH_CACHE_MISS'
  | 'BENCH_NO_LIVE_MODEL'
  | 'MANDATE_INIT_FAILED';

export abstract class InterlockError extends Error {
  abstract readonly code: InterlockErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A value was handed to the canonicaliser that has no deterministic encoding. */
export class CanonicalizationError extends InterlockError {
  readonly code: InterlockErrorCode;
  readonly path: string;

  constructor(code: InterlockErrorCode, path: string, detail: string) {
    super(`${detail} (at ${path})`);
    this.code = code;
    this.path = path;
  }
}

/**
 * One of the invariants in CLAUDE.md was about to be broken. This is never
 * recoverable and never caught to continue — it means the caller's model of the
 * system is wrong.
 */
export class InvariantViolation extends InterlockError {
  readonly code = 'INVARIANT_VIOLATION' as const;
  readonly invariant: string;

  constructor(invariant: string, detail: string) {
    super(`${invariant}: ${detail}`);
    this.invariant = invariant;
  }
}
