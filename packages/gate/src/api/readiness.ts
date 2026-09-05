import type { Store } from '@interlock/store';

export interface Health {
  readonly ready: boolean;
  readonly phase: string;
  readonly outstanding: number;
  readonly status: 200 | 503;
}

/**
 * Is this ledger settled enough to serve from?
 *
 * The proxy answers readiness from the recovery pass it actually runs. The
 * console cannot: it is a reader beside a writer, it must not reclaim leases
 * the proxy is reclaiming, and asking its own idle Recovery object gives the
 * answer "still scanning" forever — a health endpoint that never goes green
 * and a load balancer that never routes to it.
 *
 * So it asks the shared state instead. An intent holding a lapsed lease means
 * some process died mid-refund and boot recovery has not finished settling it.
 * Serving decisions from a ledger in that condition is what the 503 is for,
 * and it becomes true again on its own once the proxy has recovered.
 */
export function ledgerReadiness(store: Store, now: number): Health {
  const stranded = store.intents.sweepExpiredLeases(now, {
    states: ['IN_FLIGHT', 'RECONCILING'],
    limit: 100,
  });
  return stranded.length === 0
    ? { ready: true, phase: 'ready', outstanding: 0, status: 200 }
    : { ready: false, phase: 'unrecovered', outstanding: stranded.length, status: 503 };
}
