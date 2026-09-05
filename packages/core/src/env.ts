import { z } from 'zod';
import { InterlockError } from './errors.js';

/**
 * Process configuration, validated once at boot.
 *
 * The rule this file exists to enforce: a missing or empty required variable is
 * a crash, never a default and never a degraded mode. Interlock's guarantees are
 * about durable state on a known disk path and about which rail we are talking
 * to; guessing either would be worse than not starting.
 */

export class EnvValidationError extends InterlockError {
  readonly code = 'ENV_INVALID' as const;
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.issues = issues;
  }
}

const nonEmpty = z.string().trim().min(1);

/** Which rail the gate issues money-out calls against. */
export const RailKind = z.enum(['mock', 'razorpay']);
export type RailKind = z.infer<typeof RailKind>;

export const EnvSchema = z
  .object({
    /** Path to the SQLite intent/audit ledger. Opened with synchronous = FULL. */
    INTERLOCK_DB_PATH: nonEmpty,
    /** Shared bearer token for the operator console and HTTP surface. */
    INTERLOCK_CONSOLE_TOKEN: nonEmpty.min(16, 'must be at least 16 characters'),
    /** Defaults to the mock rail so the chaos matrix needs no live credentials. */
    INTERLOCK_RAIL: RailKind.default('mock'),
    RAZORPAY_KEY_ID: nonEmpty.optional(),
    RAZORPAY_KEY_SECRET: nonEmpty.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.INTERLOCK_RAIL !== 'razorpay') return;
    for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] as const) {
      if (value[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when INTERLOCK_RAIL=razorpay',
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate an environment. Pure: pass an explicit source in tests.
 * Throws {@link EnvValidationError} listing every problem, not just the first.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  throw new EnvValidationError(
    parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path} ${issue.message}`;
    }),
  );
}

let cached: Env | undefined;

/**
 * The process-wide environment. Call this at the top of every entrypoint so a
 * bad configuration fails at boot rather than at the first rail call.
 */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: drop the memoised environment so the next `env()` re-reads. */
export function resetEnvCache(): void {
  cached = undefined;
}
