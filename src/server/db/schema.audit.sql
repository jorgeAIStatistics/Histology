-- Stage 6 Phase C: tamper-evident audit seal and traceability columns.
-- Additive only. Applied after schema.sql by scripts/gen-schema-module.mjs for a
-- new database; ensureAuditSchema() (src/server/db/audit-schema.ts) applies this
-- same section to an existing database (each ALTER only when its column is
-- missing; tables, indexes and triggers with IF NOT EXISTS). Never rewrites rows.
-- See docs/release/audit-integrity.md for what this does and does NOT protect.

-- Traceability (C2). All three are NULL on events written before Phase C and on
-- events that have no such context (system, simulator, seed).
--   permission   the permission the command that wrote the event required
--   session_ref  secured mode: HMAC-SHA256(audit key, session id hash), first
--                16 hex characters. Never the session id or its stored hash.
--   source_ref   importer events: "<sourceId>:<messageId>:v<version>"
ALTER TABLE audit_event ADD COLUMN permission TEXT;
ALTER TABLE audit_event ADD COLUMN session_ref TEXT;
ALTER TABLE audit_event ADD COLUMN source_ref TEXT;

-- One seal per audit event, in seq order (C1). Written in the same transaction
-- as the event (src/server/core/audit.ts -> sealPending). For event n:
--   mac(n) = HMAC-SHA256(key, prev_mac + "\n" + canonical(event n))
--   prev_mac(n) = mac(n-1); for the first event "genesis:" + the lab scope.
-- canonical(event) is a JSON array of every audit_event column in a fixed order
-- (AUDIT_COLUMNS in src/server/core/audit-seal.ts). key_id names the key
-- (never the key). sealed_at is wall-clock time and is NOT covered by the MAC.
CREATE TABLE IF NOT EXISTS audit_seal (
  seq       INTEGER PRIMARY KEY REFERENCES audit_event(seq), -- = audit_event.seq
  event_id  TEXT NOT NULL UNIQUE,                            -- = audit_event.id
  prev_mac  TEXT NOT NULL,
  mac       TEXT NOT NULL,
  key_id    TEXT NOT NULL,
  sealed_at TEXT NOT NULL
);

-- Append-only, like audit_event. These triggers stop the application (and any
-- client that leaves them in place); they do NOT stop someone with write access
-- to the file, who can drop them. Verification is what detects that.
CREATE TRIGGER IF NOT EXISTS audit_seal_no_update BEFORE UPDATE ON audit_seal
BEGIN SELECT RAISE(ABORT, 'audit_seal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_seal_no_delete BEFORE DELETE ON audit_seal
BEGIN SELECT RAISE(ABORT, 'audit_seal is append-only'); END;
-- Seals are appended in seq order only (never inserted behind the head).
CREATE TRIGGER IF NOT EXISTS audit_seal_in_order BEFORE INSERT ON audit_seal
WHEN NEW.seq <= (SELECT COALESCE(MAX(seq), 0) FROM audit_seal)
BEGIN SELECT RAISE(ABORT, 'audit_seal is appended in seq order only'); END;
