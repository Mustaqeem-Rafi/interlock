import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KILL_POINTS, type IntentState, type KillPoint } from '@interlock/gate';
import { ChaosConfigError, ChaosTrialError } from './errors.js';
import { railStateFiles, readRailState, refundsForSik, writeSeed } from './rail-state.js';
import {
  renderResults,
  totalViolations,
  type KillPointSummary,
  type MatrixResults,
} from './results.js';
import {
  FAULT_PROFILES,
  judge,
  type FaultProfile,
  type TrialObservation,
  type TrialPhase,
  type Violation,
} from './verdict.js';

/**
 * The kill-point matrix.
 *
 * Five positions in the money path, crossed with rail fault profiles, N trials
 * each. Every trial is a real process being SIGKILLed and real processes
 * starting up afterwards with nothing but two files to work out what happened.
 */

const CHILD = fileURLToPath(new URL('./child.js', import.meta.url));

interface ChildOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runGate(env: Record<string, string>): Promise<ChildOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (exitCode, signal) => {
      resolvePromise({ exitCode, signal, stdout, stderr });
    });
  });
}

interface ChildLine {
  readonly ok?: boolean;
  readonly sik?: string;
  readonly state?: IntentState | null;
  readonly railEntityId?: string | null;
  readonly recovered?: number;
  readonly ready?: boolean;
  readonly disposition?: string;
  readonly error?: string;
}

/** The last JSON line a child printed, if it lived long enough to print one. */
function lastLine(stdout: string): ChildLine | null {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
  try {
    return JSON.parse(last) as ChildLine;
  } catch {
    return null;
  }
}

export interface TrialSetup {
  readonly root: string;
  readonly dbPath: string;
  readonly railDir: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly amountMinor: number;
}

function setUpTrial(root: string, index: number): TrialSetup {
  const dir = join(root, `trial-${String(index).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  const railDir = join(dir, 'rail');
  const files = railStateFiles(railDir);

  const paymentId = 'pay_CHAOS0000001';
  writeSeed(files, {
    payments: [
      {
        id: paymentId,
        entity: 'payment',
        amount_minor: 1_000_000,
        amount_refunded_minor: 0,
        currency: 'INR',
        status: 'captured',
        order_id: null,
        created_at: 1_757_000_000_000,
      },
    ],
    orders: [],
  });

  return {
    root: dir,
    dbPath: join(dir, 'interlock.db'),
    railDir,
    merchantId: 'acc_CHAOS01',
    paymentId,
    amountMinor: 340_000,
  };
}

async function runTrial(
  killPoint: KillPoint,
  profile: FaultProfile,
  trial: number,
  root: string,
  withRetry: boolean,
): Promise<readonly TrialObservation[]> {
  const setup = setUpTrial(root, trial);
  const base: Record<string, string> = {
    INTERLOCK_DB_PATH: setup.dbPath,
    INTERLOCK_CHAOS_RAIL_DIR: setup.railDir,
    INTERLOCK_CHAOS_MERCHANT: setup.merchantId,
    INTERLOCK_CHAOS_PAYMENT: setup.paymentId,
    INTERLOCK_CHAOS_AMOUNT: String(setup.amountMinor),
    INTERLOCK_CONSOLE_TOKEN: 'chaos-matrix-token-000000000000',
    INTERLOCK_CHAOS_FAULTS: JSON.stringify(profile.faults),
    INTERLOCK_CHAOS_DECOY: profile.decoy ? '1' : '0',
    // Small on purpose: a partitioned trial would otherwise sleep through
    // 2+4+8+16+32 seconds of real backoff. The ordering is under test, not the
    // wall clock.
    INTERLOCK_CHAOS_BACKOFF_CAP: '1',
    INTERLOCK_CHAOS_MAX_RECON: '3',
  };

  // 1. Issue one refund into a process armed to die at `killPoint`.
  const issued = await runGate({
    ...base,
    INTERLOCK_CHAOS_MODE: 'issue',
    INTERLOCK_CHAOS_KILL_AT: killPoint,
  });

  // Killed means: it never printed its completion line. On Windows the signal
  // is not reported, so the absence of the line is the reliable signal.
  const issueLine = lastLine(issued.stdout);
  const killed = issueLine === null || issueLine.ok !== true;

  // A fault that throws inside the rail call preempts any kill point after it,
  // so the process surviving there is correct rather than a disarmed matrix.
  const killExpected = !profile.preempts.includes(killPoint);

  const observations: TrialObservation[] = [];

  const observe = async (mode: 'recover' | 'retry', phase: TrialPhase): Promise<void> => {
    const run = await runGate({ ...base, INTERLOCK_CHAOS_MODE: mode });
    const line = lastLine(run.stdout);
    if (line === null || line.ok !== true) {
      throw new ChaosTrialError(
        `${mode} process failed for ${killPoint}/${profile.name} trial ${String(trial)}: ` +
          `${line?.error ?? run.stderr.slice(0, 400)}`,
      );
    }
    const sik = line.sik ?? '';
    const railState = readRailState(railStateFiles(setup.railDir));
    observations.push({
      killPoint,
      profile: profile.name,
      phase,
      trial,
      sik,
      railEntities: refundsForSik(railState, sik).map((refund) => refund.id),
      state: line.state ?? null,
      recordedEntityId: line.railEntityId ?? null,
      recovered: line.recovered ?? 0,
      ready: line.ready === true,
      killed,
      killExpected,
      disposition: line.disposition ?? null,
    });
  };

  // 2. Restart, running boot recovery to completion before anything else.
  await observe('recover', 'recover');

  // 3. The agent asks for the same refund again — the request most likely to
  //    produce a second one.
  if (withRetry) await observe('retry', 'retry');

  rmSync(setup.root, { recursive: true, force: true });
  return observations;
}

export interface MatrixOptions {
  readonly trials: number;
  readonly killPoints?: readonly KillPoint[];
  readonly profiles?: readonly FaultProfile[];
  readonly withRetry?: boolean;
  readonly onTrial?: (observation: TrialObservation, violations: readonly Violation[]) => void;
}

export async function runMatrix(options: MatrixOptions): Promise<MatrixResults> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const points = options.killPoints ?? KILL_POINTS;
  const profiles = options.profiles ?? [FAULT_PROFILES[0]!];
  const withRetry = options.withRetry ?? false;
  const root = mkdtempSync(join(tmpdir(), 'interlock-chaos-'));
  const summaries: KillPointSummary[] = [];

  try {
    for (const killPoint of points) {
      for (const profile of profiles) {
        const counts: Record<number, number> = {};
        const states: Record<string, number> = {};
        const retryCounts: Record<number, number> = {};
        const retryStates: Record<string, number> = {};
        const violations: Violation[] = [];
        let killedAsExpected = 0;
        let preempted = 0;
        let escalated = 0;

        for (let trial = 1; trial <= options.trials; trial += 1) {
          const observed = await runTrial(
            killPoint,
            profile,
            trial,
            join(root, `${killPoint}-${profile.name}`),
            withRetry,
          );

          for (const observation of observed) {
            const found = judge(observation);
            violations.push(...found);
            options.onTrial?.(observation, found);

            // The two phases answer different questions and are tallied apart.
            const isRecover = observation.phase === 'recover';
            const intoCounts = isRecover ? counts : retryCounts;
            const intoStates = isRecover ? states : retryStates;
            intoCounts[observation.railEntities.length] =
              (intoCounts[observation.railEntities.length] ?? 0) + 1;
            const stateKey = observation.state ?? 'no intent row';
            intoStates[stateKey] = (intoStates[stateKey] ?? 0) + 1;
            if (isRecover && observation.state === 'QUARANTINED') escalated += 1;
          }
          if (observed[0]?.killed === true) killedAsExpected += 1;
          if (observed[0]?.killExpected === false) preempted += 1;
        }

        summaries.push({
          killPoint,
          profile: profile.name,
          trials: options.trials,
          counts,
          states,
          retryCounts,
          retryStates,
          killedAsExpected,
          preempted,
          escalated,
          violations,
        });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return { startedAt, durationMs: Date.now() - start, trialsPerPoint: options.trials, summaries };
}

export function parseTrials(argv: readonly string[]): number {
  const flag = argv.indexOf('--trials');
  if (flag === -1) return 20;
  const raw = argv[flag + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ChaosConfigError(`--trials needs a positive integer, got ${String(raw)}`);
  }
  return parsed;
}

/** RESULTS.chaos.md at the repo root. Composed into RESULTS.md by scripts/compose-results.mjs. */
export function resultsPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'RESULTS.chaos.md');
}

export async function main(argv: readonly string[]): Promise<number> {
  const trials = parseTrials(argv);
  const full = argv.includes('--full');
  const profiles = full ? FAULT_PROFILES : [FAULT_PROFILES[0]!];

  process.stdout.write(
    `chaos matrix: ${String(KILL_POINTS.length)} kill points x ` +
      `${String(profiles.length)} fault profile(s) x ${String(trials)} trials` +
      `${full ? ', plus a retry phase' : ''}\n`,
  );

  const results = await runMatrix({
    trials,
    profiles,
    withRetry: full,
    onTrial: (observation, violations) => {
      const mark = violations.length === 0 ? 'ok  ' : 'FAIL';
      const via = observation.disposition === null ? '' : ` via ${observation.disposition}`;
      process.stdout.write(
        `  ${mark} ${observation.killPoint}/${observation.profile}/${observation.phase} ` +
          `#${String(observation.trial)} rail=${String(observation.railEntities.length)} ` +
          `state=${observation.state ?? 'none'}${via}\n`,
      );
      for (const violation of violations) {
        process.stdout.write(`       ${violation.kind}: ${violation.message}\n`);
      }
    },
  });

  const path = resultsPath();
  writeFileSync(path, renderResults(results), 'utf8');

  const total = totalViolations(results);
  process.stdout.write(`\nwrote ${path}\n`);
  process.stdout.write(`exactly-once violations: ${String(total)}\n`);
  return total === 0 ? 0 : 1;
}

if (import.meta.url.endsWith('matrix.js')) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
