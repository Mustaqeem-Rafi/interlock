export { railStateFiles, readRailState, refundsForSik, writeSeed, appendEffect } from './rail-state.js';
export type { RailStateFiles } from './rail-state.js';

export { ChaosConfigError, ChaosTrialError } from './errors.js';

export { configFromEnv, runChild, sikForTrial } from './child.js';
export type { ChildConfig, ChildMode, ChildResult } from './child.js';

export { EXPECTATION, GUARANTEE, judge } from './verdict.js';
export type { TrialObservation, Violation, ViolationKind } from './verdict.js';

export { renderResults, totalViolations } from './results.js';
export type { KillPointSummary, MatrixResults } from './results.js';

export { main, parseTrials, resultsPath, runMatrix } from './matrix.js';
export type { MatrixOptions } from './matrix.js';
