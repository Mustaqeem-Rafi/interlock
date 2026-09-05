-- Interlock store schema, v1.
--
-- Every table is STRICT. Money columns are INTEGER minor units, and STRICT is
-- what makes SQLite refuse a float there instead of quietly storing 1000.5 in a
-- column the rest of the system believes is an integer.
--
-- The pragmas that matter (journal_mode = WAL, synchronous = FULL) are set in
-- db.ts, and the reason they must not be relaxed is written out there.

PRAGMA user_version = 1;

-- ---------------------------------------------------------------------------
-- intents
--
-- I1: at most one intent per (merchant_id, sik), enforced by this PRIMARY KEY
-- and by nothing else. There is no lock anywhere in this system. Two racing
-- proposals for the same meaning both try to INSERT; exactly one wins and the
-- other gets a constraint violation, which is the whole concurrency control.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intents (
  merchant_id        TEXT    NOT NULL,
  sik                TEXT    NOT NULL,
  tool               TEXT    NOT NULL,
  subject_id         TEXT    NOT NULL,
  amount_minor       INTEGER NOT NULL,
  currency           TEXT    NOT NULL,
  reversibility      TEXT    NOT NULL,
  params_hash        TEXT    NOT NULL,
  state              TEXT    NOT NULL,
  -- I5: strictly monotone per intent. Bumped only by startAttempt.
  attempt_seq        INTEGER NOT NULL DEFAULT 0,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner        TEXT,
  lease_expires_at   INTEGER,
  rail_entity_id     TEXT,
  mandate_hash       TEXT    NOT NULL,
  first_seen_at      INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,

  PRIMARY KEY (merchant_id, sik),

  -- Must stay in step with IntentState in @interlock/core and with the
  -- transition switch in gate/exactly-once/machine.ts.
  CHECK (state IN (
    'PROPOSED', 'HELD', 'BLOCKED', 'AUTHORIZED', 'IN_FLIGHT', 'APPLIED',
    'FAILED_TERMINAL', 'UNKNOWN', 'RECONCILING', 'CONFIRMED_NOT_APPLIED',
    'QUARANTINED'
  )),
  CHECK (reversibility IN ('reversible', 'compensable', 'irreversible')),
  CHECK (amount_minor > 0),
  CHECK (attempt_seq >= 0),
  CHECK (reconcile_attempts >= 0),
  CHECK (length(currency) = 3),
  CHECK (length(sik) = 32)
) STRICT, WITHOUT ROWID;

-- The recovery sweep looks for IN_FLIGHT rows whose lease has expired.
CREATE INDEX IF NOT EXISTS intents_sweep ON intents (state, lease_expires_at);

-- ---------------------------------------------------------------------------
-- intent_attempts
--
-- One row per rail call ever issued for an intent. Written before the call and
-- updated after it, so an attempt with finished_at IS NULL is exactly the set
-- the recovery sweep has to reconcile.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intent_attempts (
  merchant_id    TEXT    NOT NULL,
  sik            TEXT    NOT NULL,
  attempt_seq    INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  outcome        TEXT,
  rail_entity_id TEXT,
  http_status    INTEGER,
  -- Read from the rail response. Never computed from a rate we assumed.
  fee_minor      INTEGER,
  tax_minor      INTEGER,
  error_code     TEXT,
  request_json   TEXT    NOT NULL,
  response_json  TEXT,

  PRIMARY KEY (merchant_id, sik, attempt_seq),
  FOREIGN KEY (merchant_id, sik) REFERENCES intents (merchant_id, sik) ON DELETE RESTRICT,

  CHECK (attempt_seq >= 1),
  CHECK (outcome IS NULL OR outcome IN ('APPLIED', 'FAILED', 'TIMEOUT', 'AMBIGUOUS')),
  CHECK (fee_minor IS NULL OR fee_minor >= 0),
  CHECK (tax_minor IS NULL OR tax_minor >= 0)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- audit_log
--
-- I6: every state change appends exactly one record, and seq is gapless.
--
-- hash = sha256(prev_hash + "\n" + canonicalJson({seq, ts, kind, payload}))
-- from a genesis of sha256("interlock-genesis-v1").
--
-- seq is AUTOINCREMENT so a value is never reused for the lifetime of the file,
-- but the value is assigned explicitly on insert because seq is an input to the
-- hash and therefore has to be known before the row is written.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  prev_hash    TEXT    NOT NULL,
  hash         TEXT    NOT NULL,

  CHECK (length(prev_hash) = 64),
  CHECK (length(hash) = 64),
  CHECK (length(kind) > 0)
) STRICT;

-- ---------------------------------------------------------------------------
-- decisions
--
-- What the gate ladder concluded, pinned to the exact mandate it read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
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

CREATE INDEX IF NOT EXISTS decisions_intent ON decisions (merchant_id, sik);

-- ---------------------------------------------------------------------------
-- recon_findings
--
-- One row per reconciliation pass.
--
-- The last CHECK is reconciler trap 1 made structural: absence on page one is
-- not absence. A pass may only record CONFIRMED_NOT_APPLIED — the one outcome
-- that unlocks a retry — if pagination ran to exhaustion in that same pass.
-- The database will not store the claim otherwise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recon_findings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id          TEXT    NOT NULL,
  sik                  TEXT    NOT NULL,
  attempt_seq          INTEGER NOT NULL,
  outcome              TEXT    NOT NULL,
  pages_scanned        INTEGER NOT NULL,
  pagination_exhausted INTEGER NOT NULL,
  matched_entity_id    TEXT,
  queried_at           INTEGER NOT NULL,
  detail_json          TEXT    NOT NULL,

  CHECK (outcome IN ('APPLIED', 'CONFIRMED_NOT_APPLIED', 'STILL_UNKNOWN')),
  CHECK (pagination_exhausted IN (0, 1)),
  CHECK (pages_scanned >= 0),
  CHECK (attempt_seq >= 1),
  CHECK (outcome <> 'CONFIRMED_NOT_APPLIED' OR pagination_exhausted = 1)
) STRICT;

CREATE INDEX IF NOT EXISTS recon_findings_intent
  ON recon_findings (merchant_id, sik, attempt_seq);
