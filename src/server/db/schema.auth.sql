-- Stage 6 Phase B: sign-in, sessions and identity links (secured mode).
-- Additive only. Applied after schema.sql by scripts/gen-schema-module.mjs for a
-- new database; ensureAuthSchema() (src/server/db/auth-schema.ts) applies this
-- same section to an existing database (the column only when it is missing, the
-- tables and indexes with IF NOT EXISTS). Every time below is WALL-CLOCK time
-- (ISO-8601 UTC), never the demo clock.

-- The laboratory a staff member belongs to. One deployment serves one lab
-- (HLOS_LAB_ID); a session is refused unless the staff member's lab matches.
ALTER TABLE staff ADD COLUMN lab_id TEXT NOT NULL DEFAULT 'lab:local';

-- (issuer, subject) at the identity provider -> staff member, per lab. Created
-- ONLY by a laboratory administrator (scripts/admin.ts link-identity, audited);
-- sign-in never creates a link. Unlinking sets active = 0 (the row is kept).
CREATE TABLE IF NOT EXISTS staff_identity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id    TEXT NOT NULL,
  issuer    TEXT NOT NULL,
  subject   TEXT NOT NULL,
  staff_id  TEXT NOT NULL REFERENCES staff(id),
  active    INTEGER NOT NULL DEFAULT 1,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  UNIQUE (lab_id, issuer, subject)
);
CREATE INDEX IF NOT EXISTS idx_staff_identity_staff ON staff_identity(staff_id);

-- One row per signed-in browser session. Only the SHA-256 of the 256-bit
-- random session id is stored; the id itself lives only in the HttpOnly cookie.
CREATE TABLE IF NOT EXISTS auth_session (
  id_hash          TEXT PRIMARY KEY,          -- sha256(session id), hex
  staff_id         TEXT NOT NULL REFERENCES staff(id),
  lab_id           TEXT NOT NULL,
  issuer           TEXT NOT NULL,
  subject          TEXT NOT NULL,
  auth_time        TEXT NOT NULL,             -- when the person last authenticated at the provider
  created_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,             -- last user-driven request (polling never counts)
  expires_at       TEXT NOT NULL,             -- absolute expiry
  locked_at        TEXT,                      -- idle or manual lock; cleared by re-authentication
  revoked_at       TEXT,
  revoked_reason   TEXT,
  user_agent_hash  TEXT                       -- HMAC of the User-Agent (forensics only)
);
CREATE INDEX IF NOT EXISTS idx_auth_session_staff ON auth_session(staff_id);

-- One row per sign-in attempt (OIDC state). Consumed exactly once by the
-- callback; expires after 10 minutes.
CREATE TABLE IF NOT EXISTS auth_transaction (
  state         TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  reauth        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_transaction_expires ON auth_transaction(expires_at);
