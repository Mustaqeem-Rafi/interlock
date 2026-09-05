import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { StoreDurabilityError, StoreOpenError } from './errors.js';

/**
 * schema.sql sits at the package root, one level above both src/ and dist/, so
 * this resolves identically whether we are running from source under vitest or
 * from the built output.
 */
const SCHEMA_URL = new URL('../schema.sql', import.meta.url);

/**
 * DO NOT RELAX THESE PRAGMAS.
 *
 * `synchronous = FULL` is not a conservative default that someone can trade away
 * for throughput later. It is the entire exactly-once guarantee.
 *
 * Invariant I2 says no rail call is issued unless a durable IN_FLIGHT row exists
 * on disk first. "Durable" means fsynced. Under `synchronous = NORMAL` in WAL
 * mode, SQLite does not fsync on every commit — it lets the OS flush the WAL
 * whenever it likes. A commit therefore returns before the bytes have reached
 * the platter. If the process issues the rail call in that window and the
 * machine loses power, the money moves and the row saying so does not survive.
 * On restart the intent looks untried, the engine retries it, and the customer
 * is refunded twice. That is precisely the bug this project exists to prevent,
 * and it is invisible in testing because it needs a real crash to show up.
 *
 * The cost is one fsync per commit. We commit once per state transition, not
 * per request. This is not the bottleneck, and if it ever becomes one the
 * answer is fewer transitions, never a weaker pragma.
 *
 * WAL is here so a reader (the console, the sweep) never blocks the writer.
 * WAL + FULL together mean: one fsync of the write-ahead log per commit.
 */
const REQUIRED_PRAGMAS = {
  journal_mode: 'wal',
  /**
   * SQLite reports `synchronous` as an integer, not a name:
   * 0 = OFF, 1 = NORMAL, 2 = FULL, 3 = EXTRA. FULL is 2.
   */
  synchronous: 2,
} as const;

export type Db = SqliteDatabase;

/**
 * Open the ledger, apply the schema, and refuse to continue unless the
 * durability settings actually took effect. They can silently fail to apply on
 * some network filesystems, and a store that lies about durability is worse
 * than one that will not start.
 */
export function openDatabase(path: string): Db {
  if (path.trim() === '') {
    throw new StoreOpenError(path, 'path is empty');
  }
  if (path.startsWith(':')) {
    // :memory: cannot be fsynced, so it cannot satisfy I2. Tests use temp files.
    throw new StoreOpenError(path, 'the ledger must be file-backed; in-memory cannot satisfy I2');
  }

  let db: Db;
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
  } catch (error) {
    throw new StoreOpenError(path, error instanceof Error ? error.message : String(error));
  }

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  assertDurability(db);

  try {
    db.exec(readFileSync(fileURLToPath(SCHEMA_URL), 'utf8'));
  } catch (error) {
    db.close();
    throw new StoreOpenError(path, error instanceof Error ? error.message : String(error));
  }

  return db;
}

function assertDurability(db: Db): void {
  for (const [pragma, expected] of Object.entries(REQUIRED_PRAGMAS)) {
    const actual: unknown = db.pragma(pragma, { simple: true });
    const normalised = typeof actual === 'string' ? actual.toLowerCase() : actual;
    if (normalised !== expected) {
      db.close();
      throw new StoreDurabilityError(pragma, String(expected), String(actual));
    }
  }
}

/**
 * Run `fn` in an immediate write transaction.
 *
 * IMMEDIATE rather than the default deferred: the write lock is taken up front,
 * so two writers cannot both read the audit head, both decide they are seq N,
 * and then have one of them fail on upgrade halfway through.
 */
export function inWriteTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}
