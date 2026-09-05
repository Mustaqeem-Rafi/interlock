import { InterlockError } from '@interlock/core';

/** A chaos run was misconfigured. Fails before any trial starts. */
export class ChaosConfigError extends InterlockError {
  readonly code = 'CHAOS_CONFIG' as const;
}

/**
 * A trial could not be carried out — distinct from a trial that ran and found a
 * violation. This means the harness broke, so the run proves nothing and must
 * not be reported as green.
 */
export class ChaosTrialError extends InterlockError {
  readonly code = 'CHAOS_TRIAL_FAILED' as const;
}
