export {
  RANK,
  assertNoUpgrade,
  floor,
  rankOf,
  runLadder,
  verdictOf,
} from './ladder.js';
export type {
  DeterministicGate,
  GateContext,
  LadderInput,
  LadderOutcome,
  ModelGate,
  ModelVerdict,
} from './ladder.js';

export { G1_SCOPE, g1Scope } from './g1_scope.js';
export { createG2Value } from './g2_value.js';
export { RESOLUTION_TTL_MS, createReferentResolver } from './resolver.js';
export type { ReferentResolver, Resolution, ResolverOptions } from './resolver.js';
