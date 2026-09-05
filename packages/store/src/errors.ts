import { InterlockError } from '@interlock/core';

/** The store could not be opened, or its schema could not be applied. */
export class StoreOpenError extends InterlockError {
  readonly code = 'STORE_OPEN_FAILED' as const;

  constructor(path: string, detail: string) {
    super(`cannot open store at ${path}: ${detail}`);
  }
}

/**
 * The database did not come up with the durability settings the exactly-once
 * guarantee depends on. Refusing to start is the only safe response: without
 * synchronous = FULL, a rail call can outlive the row that says it happened.
 */
export class StoreDurabilityError extends InterlockError {
  readonly code = 'STORE_DURABILITY_UNAVAILABLE' as const;

  constructor(pragma: string, expected: string, actual: string) {
    super(
      `${pragma} is "${actual}" but must be "${expected}"; ` +
        `refusing to start without the durability the exactly-once guarantee assumes`,
    );
  }
}

/**
 * I1. Another intent already exists for this (merchant_id, sik).
 *
 * This is not an error condition to smooth over — it is the duplicate being
 * caught. The caller decides whether it is a benign retry or a real conflict.
 */
export class DuplicateIntentError extends InterlockError {
  readonly code = 'STORE_DUPLICATE_INTENT' as const;
  readonly merchantId: string;
  readonly sik: string;

  constructor(merchantId: string, sik: string) {
    super(`an intent already exists for merchant ${merchantId} and sik ${sik}`);
    this.merchantId = merchantId;
    this.sik = sik;
  }
}

export class IntentNotFoundError extends InterlockError {
  readonly code = 'STORE_NOT_FOUND' as const;

  constructor(merchantId: string, sik: string) {
    super(`no intent for merchant ${merchantId} and sik ${sik}`);
  }
}

/**
 * A compare-and-set lost. The intent was not in the state the caller expected,
 * which means someone else moved it first. The caller must re-read, never retry
 * blindly — a blind retry here is how a second rail call gets issued.
 */
export class StaleIntentStateError extends InterlockError {
  readonly code = 'STORE_STALE_STATE' as const;
  readonly expected: string;
  readonly actual: string;

  constructor(merchantId: string, sik: string, expected: string, actual: string) {
    super(
      `intent ${merchantId}/${sik} is in state ${actual}, not ${expected}; ` +
        `re-read before deciding what to do next`,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/** A schema-level constraint rejected the write. */
export class StoreConstraintError extends InterlockError {
  readonly code = 'STORE_CONSTRAINT' as const;

  constructor(detail: string) {
    super(detail);
  }
}
