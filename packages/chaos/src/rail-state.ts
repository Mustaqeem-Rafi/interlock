import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  InstantSettlement,
  MockRailJournalEvent,
  MockRailSnapshot,
  Order,
  Payment,
  Refund,
} from '@interlock/gate';

/**
 * Upstream rail state that outlives the process holding it.
 *
 * The matrix SIGKILLs the gate mid-refund, so "did the rail apply it" has to be
 * answerable from disk afterwards. The rail is therefore journalled the way a
 * real one is: append-only, one line per effect, fsynced before the call
 * returns.
 *
 * Append-only rather than rewriting a snapshot blob, for the same reason the
 * ledger is: rewriting means a window where the file holds neither the old
 * state nor the new one, and SIGKILL will eventually land in it. An append that
 * has been fsynced is either fully there or not there at all.
 */

const EFFECTS = 'effects.jsonl';
const SEED = 'seed.json';

export interface RailStateFiles {
  readonly dir: string;
  readonly effects: string;
  readonly seed: string;
}

export function railStateFiles(dir: string): RailStateFiles {
  return { dir, effects: join(dir, EFFECTS), seed: join(dir, SEED) };
}

interface Seed {
  readonly payments: readonly Payment[];
  readonly orders: readonly Order[];
}

/** Write the payments and orders a trial starts with. Done once, before any child. */
export function writeSeed(files: RailStateFiles, seed: Seed): void {
  mkdirSync(files.dir, { recursive: true });
  const fd = openSync(files.seed, 'w');
  try {
    writeSync(fd, JSON.stringify(seed));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one effect and fsync before returning.
 *
 * This is the line that makes the whole matrix meaningful: when it returns, the
 * effect has happened upstream whatever the gate does next, including dying.
 */
export function appendEffect(files: RailStateFiles, event: MockRailJournalEvent): void {
  mkdirSync(dirname(files.effects), { recursive: true });
  const fd = openSync(files.effects, 'a');
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Rebuild upstream state from disk.
 *
 * A trailing partial line is dropped: it means SIGKILL landed inside a write,
 * so that effect was never durable and the rail never acknowledged it.
 */
export function readRailState(files: RailStateFiles): MockRailSnapshot {
  const seed: Seed = existsSync(files.seed)
    ? (JSON.parse(readFileSync(files.seed, 'utf8')) as Seed)
    : { payments: [], orders: [] };

  const refunds: Refund[] = [];
  const settlements: InstantSettlement[] = [];

  if (existsSync(files.effects)) {
    const lines = readFileSync(files.effects, 'utf8').split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      let event: MockRailJournalEvent;
      try {
        event = JSON.parse(line) as MockRailJournalEvent;
      } catch {
        // Torn trailing write. Never acknowledged, so it never happened.
        continue;
      }
      if (event.kind === 'refund') refunds.push(event.refund);
      else settlements.push(event.settlement);
    }
  }

  return { payments: seed.payments, orders: seed.orders, refunds, settlements };
}

/** Refunds upstream carrying this sik. The number the matrix asserts on. */
export function refundsForSik(state: MockRailSnapshot, sik: string): readonly Refund[] {
  return state.refunds.filter(
    (refund) => refund.notes['interlock_sik'] === sik || refund.receipt === `ilk_${sik}`,
  );
}
