import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from './index.js';

/**
 * A ledger written by an earlier build must still open.
 *
 * CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so
 * columns added later never appear in an existing file and every insert naming
 * one fails. On this system that is not a degraded read path — it is refunds
 * stopping, on a restart nobody thought was risky.
 */
describe('opening a ledger written before the decision columns existed', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'interlock-migrate-'));
    path = join(dir, 'old.db');

    // The decisions table exactly as it was before agent_id, tool,
    // amount_minor and latency_ms were added.
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    old.exec(`
      CREATE TABLE decisions (
        request_id   TEXT    NOT NULL PRIMARY KEY,
        merchant_id  TEXT    NOT NULL,
        sik          TEXT    NOT NULL,
        mandate_hash TEXT    NOT NULL,
        verdict      TEXT    NOT NULL,
        results_json TEXT    NOT NULL,
        decided_at   INTEGER NOT NULL,
        audit_seq    INTEGER NOT NULL,
        CHECK (verdict IN ('ALLOW', 'HOLD', 'BLOCK')),
        CHECK (length(mandate_hash) = 64)
      ) STRICT, WITHOUT ROWID;
    `);
    old.prepare(
      `INSERT INTO decisions VALUES ('req_old', 'acc_OLD', ?, ?, 'BLOCK', '[]', 1, 1)`,
    ).run('A'.repeat(32), 'b'.repeat(64));
    old.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('adds the missing columns instead of refusing to open', () => {
    const store = openStore(path);
    try {
      const columns = (
        store.decisions.recent({ limit: 1 })[0] ?? {}
      ) as Record<string, unknown>;
      expect(Object.keys(columns)).toEqual(
        expect.arrayContaining(['agent_id', 'tool', 'amount_minor', 'latency_ms']),
      );
    } finally {
      store.close();
    }
  });

  it('gives the old row defined values, not nulls', () => {
    const store = openStore(path);
    try {
      const row = store.decisions.find('req_old');
      expect(row).toBeDefined();
      // A default, not null: new code reading an old row must not have to
      // guard every field it just added.
      expect(row?.agent_id).toBe('');
      expect(row?.amount_minor).toBe(0);
      expect(row?.latency_ms).toBe(0);
    } finally {
      store.close();
    }
  });

  it('is idempotent — opening twice does not try to add them again', () => {
    openStore(path).close();
    expect(() => openStore(path).close()).not.toThrow();
  });
});
