import { createAuditRepository, type AuditRepository } from './audit.js';
import { createDecisionRepository, type DecisionRepository } from './decisions.js';
import { openDatabase } from './db.js';
import { createIntentRepository, type IntentRepository } from './intents.js';
import { createReconRepository, type ReconRepository } from './recon.js';

/**
 * The ledger.
 *
 * Callers get repositories, never a connection. No SQL is written outside this
 * package: the gate asks for a transition, it does not compose an UPDATE.
 */
export interface Store {
  readonly path: string;
  readonly intents: IntentRepository;
  readonly audit: AuditRepository;
  readonly decisions: DecisionRepository;
  readonly recon: ReconRepository;
  close(): void;
}

export function openStore(path: string): Store {
  const db = openDatabase(path);
  return {
    path,
    intents: createIntentRepository(db),
    audit: createAuditRepository(db),
    decisions: createDecisionRepository(db),
    recon: createReconRepository(db),
    close() {
      db.close();
    },
  };
}

export {
  AUDIT_GENESIS_HASH,
  AUDIT_GENESIS_SEED,
  auditHash,
  nextChainRow,
  verifyChainOver,
} from './chain.js';
export type { ChainRow } from './chain.js';

export { createAuditRepository } from './audit.js';
export type { AppendAuditInput, AuditRecord, AuditRepository } from './audit.js';

export { openDatabase, inWriteTransaction } from './db.js';
export type { Db } from './db.js';

export { NewIntent, createIntentRepository } from './intents.js';
export type {
  AttemptRow,
  FinishAttemptInput,
  IntentRepository,
  IntentRow,
  StartAttemptInput,
  TransitionInput,
  WindowTotals,
} from './intents.js';

export { createDecisionRepository } from './decisions.js';
export type { DecisionRepository, DecisionRow } from './decisions.js';

export { createReconRepository } from './recon.js';
export type { NewReconFinding, ReconFindingRow, ReconRepository } from './recon.js';

export {
  DuplicateIntentError,
  IntentNotFoundError,
  StaleIntentStateError,
  StoreConstraintError,
  StoreDurabilityError,
  StoreOpenError,
} from './errors.js';
