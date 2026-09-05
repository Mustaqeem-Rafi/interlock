import { InvariantViolation } from '@interlock/core';

/**
 * Kill points.
 *
 * A crash-safety claim that has only been tested by throwing exceptions is not
 * a crash-safety claim. Exceptions unwind: finally blocks run, buffers flush,
 * SQLite gets a chance to roll back cleanly. A machine losing power does none of
 * that. So these call process.kill(pid, 'SIGKILL') — no handlers, no flush, no
 * unwinding — at five named positions in the money path, and the matrix runner
 * restarts the gate afterwards to see what survived.
 *
 * The five positions, and what each one is asking:
 *
 *   before_wal               Did we die before writing anything? Then nothing
 *                            was attempted and nothing may have moved.
 *   after_wal_before_call    The IN_FLIGHT row is on disk but the request never
 *                            left. Recovery must find the row and conclude
 *                            absence — not assume it.
 *   during_call              We died inside the request. This is the case where
 *                            we genuinely cannot know from our side alone.
 *   after_call_before_commit The rail applied it and we died before recording
 *                            that. The single most dangerous window in the
 *                            system: money moved and the ledger does not say so.
 *   after_commit_before_ack  Recorded, but the caller never heard. The agent
 *                            will retry, and the primary key has to catch it.
 *
 * SAFETY: INTERLOCK_CHAOS_KILL_AT must never be set in a deployed process. It is
 * read on every issue, so setting it in production would kill the gate on the
 * first refund. It is validated eagerly below so a typo fails loudly rather than
 * quietly disarming the matrix.
 */

export const KILL_POINT_ENV = 'INTERLOCK_CHAOS_KILL_AT';

export const KILL_POINTS = [
  'before_wal',
  'after_wal_before_call',
  'during_call',
  'after_call_before_commit',
  'after_commit_before_ack',
] as const;

export type KillPoint = (typeof KILL_POINTS)[number];

export function isKillPoint(value: string): value is KillPoint {
  return (KILL_POINTS as readonly string[]).includes(value);
}

/**
 * Kill this process if it is armed for `point`.
 *
 * Returns normally when unarmed, which is every case outside the chaos matrix.
 */
export function killAt(point: KillPoint, env: NodeJS.ProcessEnv = process.env): void {
  const armed = env[KILL_POINT_ENV];
  if (armed === undefined || armed === '') return;
  if (!isKillPoint(armed)) {
    // A typo here would silently produce a green matrix that tested nothing.
    throw new InvariantViolation(
      'chaos.kill_point',
      `${KILL_POINT_ENV} is ${JSON.stringify(armed)}, which is not one of ${KILL_POINTS.join(', ')}`,
    );
  }
  if (armed !== point) return;
  process.kill(process.pid, 'SIGKILL');
}
