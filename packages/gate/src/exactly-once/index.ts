export {
  IllegalTransitionError,
  MACHINE_EVENTS,
  allEdges,
  assertMayIssueRailCall,
  canTransition,
  isAbsorbing,
  nextState,
} from './machine.js';
export type { MachineEvent } from './machine.js';

export { LEASE_MS, assertStamped, createWal, stampRefund } from './wal.js';
export type { IssueOutcome, RefundOrder, Wal, WalOptions } from './wal.js';

export { propose } from './propose.js';
export type { ProposeDisposition, ProposeResult } from './propose.js';

export {
  MAX_BACKOFF_SECONDS,
  MAX_RECONCILE_ATTEMPTS,
  RECONCILE_MIN_DELAY_MS,
  backoffMs,
  createReconciler,
  matchesSik,
  scanForSik,
  sikOf,
} from './reconciler.js';
export type {
  ReconcileOutcome,
  Reconciler,
  ReconcilerOptions,
  ScanResult,
} from './reconciler.js';

export { RECOVERY_REASON, createRecovery } from './recovery.js';
export type { Readiness, Recovery, RecoveryOptions, RecoveryPhase, RecoveryReport } from './recovery.js';

export { SWEEP_INTERVAL_MS, SWEEP_WINDOW_MS, createSweep } from './sweep.js';
export type {
  DuplicateFinding,
  OrphanFinding,
  PhantomFinding,
  Sweep,
  SweepFinding,
  SweepOptions,
  SweepReport,
} from './sweep.js';
