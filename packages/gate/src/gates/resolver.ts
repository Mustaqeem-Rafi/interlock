import type { Order, Payment, Rail } from '../rail/rail.js';

/**
 * The referent resolver.
 *
 * Gate 2 compares a proposed amount against constraints, and every value in
 * that comparison has to come from somewhere. This is the somewhere: our own
 * credentialed read-only client, talking to the rail directly.
 *
 * Nothing here reads the call's arguments, and nothing here believes a number
 * that arrived in conversation. If an agent says "refund the 1,899 rupee damage
 * claim", the 1,899 is a claim about the world, not a fact about it — and the
 * whole attack surface of an agentic payment system is the gap between those
 * two. We close it by looking the order up ourselves. The only thing taken from
 * the arguments is an *identifier* to look up, and even that is then replaced
 * by the entity the rail returned.
 *
 * Resolutions are cached briefly and stamped with the time they were fetched,
 * so the decision record can say not just what the values were but when they
 * were true.
 */

/** Short enough that a stale read cannot outlive a decision by much. */
export const RESOLUTION_TTL_MS = 30_000;

export type Resolution<T> =
  | { readonly ok: true; readonly value: T; readonly fetched_at: number; readonly cached: boolean }
  | { readonly ok: false; readonly reason: string };

export interface ReferentResolver {
  payment(id: string): Promise<Resolution<Payment>>;
  order(id: string): Promise<Resolution<Order>>;
  /** Entries currently held, for tests and for the operator console. */
  size(): number;
}

export interface ResolverOptions {
  readonly rail: Rail;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

interface Entry {
  readonly value: unknown;
  readonly fetched_at: number;
}

export function createReferentResolver(options: ResolverOptions): ReferentResolver {
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? RESOLUTION_TTL_MS;
  const cache = new Map<string, Entry>();

  async function resolve<T>(
    kind: string,
    id: string,
    fetch: (id: string) => Promise<T>,
  ): Promise<Resolution<T>> {
    const key = `${kind}:${id}`;
    const at = now();
    const hit = cache.get(key);
    if (hit !== undefined && at - hit.fetched_at < ttlMs) {
      return { ok: true, value: hit.value as T, fetched_at: hit.fetched_at, cached: true };
    }

    try {
      const value = await fetch(id);
      cache.set(key, { value, fetched_at: at });
      return { ok: true, value, fetched_at: at, cached: false };
    } catch (error) {
      // A referent we cannot read is not a referent we may assume. The caller
      // decides what that means; see onUnresolvable on the grant.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    payment: (id) => resolve('payment', id, (target) => options.rail.fetchPayment(target)),
    order: (id) => resolve('order', id, (target) => options.rail.fetchOrder(target)),
    size: () => cache.size,
  };
}
