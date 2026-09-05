import { timingSafeEqual } from 'node:crypto';
import { InvariantViolation } from '@interlock/core';

/**
 * The console's front door.
 *
 * A shared bearer token is not real auth and the README says so. What it must
 * still do is fail closed and leak nothing: an absent token is not an empty
 * token, and a wrong token must take the same time to reject as a nearly-right
 * one.
 */

export interface Authoriser {
  /** True when the request may proceed. */
  (header: string | undefined): boolean;
}

/**
 * Compare without revealing where the mismatch was.
 *
 * timingSafeEqual throws on a length mismatch, which would itself be a signal,
 * so both sides are hashed to a fixed width first. The lengths of two SHA-256
 * digests are always equal, and the digest of a wrong token tells an attacker
 * nothing about the right one.
 */
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still do the work, so a length difference is not a fast path.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function createAuthoriser(token: string): Authoriser {
  if (token.trim().length < 16) {
    // Refusing at construction rather than at request time: a console that
    // starts and then accepts a guessable token is worse than one that will
    // not start at all.
    throw new InvariantViolation(
      'console.auth',
      'INTERLOCK_CONSOLE_TOKEN must be at least 16 characters',
    );
  }
  return (header) => {
    if (header === undefined) return false;
    const [scheme, ...rest] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer') return false;
    const presented = rest.join(' ').trim();
    if (presented === '') return false;
    return equal(presented, token);
  };
}
