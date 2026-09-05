import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KILL_POINTS, type IntentState, type KillPoint } from '@interlock/gate';
import { ChaosConfigError, ChaosTrialError } from './errors.js';
import { railStateFiles, readRailState, refundsForSik, writeSeed } from './rail-state.js';
import { renderResults, totalViolations, type KillPointSummary, type MatrixResults } from './results.js';
import { judge, type TrialObservation, type Violation } from './verdict.js';

/**
 * The kill-point matrix.
 *
 * Five positions in the money path, N trials each. Every trial is a real
 * process being SIGKILLed and a real process starting up afterwards with
 * nothing but two files to work out what happened.
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
  readonly recovered?: number;
  readonly ready?: boolean;
  readonly error?: string;
}

/** The last JSON line a child printed, if it lived long enough to print one. */
function lastLine(stdout: string): ChildLine | null {
  const lines = stdout.trim().split('\n').filter((line) => line.trim() !== '');
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
  trial: number,
  root: string,
): Promise<TrialObservation> {
  const setup = setUpTrial(root, trial);
  const base: Record<string, string> = {
    INTERLOCK_DB_PATH: setup.dbPath,
    INTERLOCK_CHAOS_RAIL_DIR: setup.railDir,
    INTERLOCK_CHAOS_MERCHANT: setup.merchantId,
    INTERLOCK_CHAOS_PAYMENT: setup.paymentId,
    INTERLOCK_CHAOS_AMOUNT: String(setup.amountMinor),
    INTERLOCK_CONSOLE_TOKEN: 'chaos-matrix-token-000000000000',
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

  // 2. Restart. Boot recovery runs to completion before anything else.
  const recovered = await runGate({
    ...base,
    INTERLOCK_CHAOS_MODE: 'recover',
  });
  const recoverLine = lastLine(recovered.stdout);

  if (recoverLine === null || recoverLine.ok !== true) {
    throw new ChaosTrialError(
      `recovery process failed for ${killPoint} trial ${String(trial)}: ` +
        `${recoverLine?.error ?? recovered.stderr.slice(0, 400)}`,
    );
  }

  const sik = recoverLine.sik ?? '';
  const state = readRailState(railStateFiles(setup.railDir));
  const entities = refundsForSik(state, sik).map((refund) => refund.id);

  const observation: TrialObservation = {
    killPoint,
    trial,
    sik,
    railEntities: entities,
    state: recoverLine.state ?? null,
    recovered: recoverLine.recovered ?? 0,
    ready: recoverLine.ready === true,
    killed,
  };

  // Trials are self-contained; keep the disk from filling on long runs.
  rmSync(setup.root, { recursive: true, force: true });
  return observation;
}

export interface MatrixOptions {
  readonly trials: number;
  readonly killPoints?: readonly KillPoint[];
  readonly onTrial?: (observation: TrialObservation, violations: readonly Violation[]) => void;
}

export async function runMatrix(options: MatrixOptions): Promise<MatrixResults> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const points = options.killPoints ?? KILL_POINTS;
  const root = mkdtempSync(join(tmpdir(), 'interlock-chaos-'));
  const summaries: KillPointSummary[] = [];

  try {
    for (const killPoint of points) {
      const counts: Record<number, number> = {};
      const states: Record<string, number> = {};
      const violations: Violation[] = [];
      let killedAsExpected = 0;

      for (let trial = 1; trial <= options.trials; trial += 1) {
        const observation = await runTrial(killPoint, trial, join(root, killPoint));
        const found = judge(observation);

        counts[observation.railEntities.length] =
          (counts[observation.railEntities.length] ?? 0) + 1;
        const stateKey = observation.state ?? 'no intent row';
        states[stateKey] = (states[stateKey] ?? 0) + 1;
        if (observation.killed) killedAsExpected += 1;
        violations.push(...found);

        options.onTrial?.(observation, found);
      }

      summaries.push({
        killPoint,
        trials: options.trials,
        counts,
        states,
        killedAsExpected,
        violations,
      });
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

/** RESULTS.md at the repository root: packages/chaos/dist -> ../../.. */
export function resultsPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'RESULTS.md');
}

export async function main(argv: readonly string[]): Promise<number> {
  const trials = parseTrials(argv);
  process.stdout.write(
    `chaos matrix: ${String(KILL_POINTS.length)} kill points x ${String(trials)} trials\n`,
  );

  const results = await runMatrix({
    trials,
    onTrial: (observation, violations) => {
      const mark = violations.length === 0 ? 'ok  ' : 'FAIL';
      process.stdout.write(
        `  ${mark} ${observation.killPoint} #${String(observation.trial)} ` +
          `rail=${String(observation.railEntities.length)} state=${observation.state ?? 'none'}\n`,
      );
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
