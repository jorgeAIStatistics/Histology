-- S6 Integration & settings — additive tables only (never edits core tables).
--
-- integration_event keeps ONE row per (source, message id). Every receipt of a
-- message — the first one, every duplicate re-delivery and every manual retry —
-- is also written here so the integration log can show that a duplicate was
-- received and ignored (the event row itself only counts receipts).
CREATE TABLE integration_receipt (
  id           TEXT PRIMARY KEY,
  event_id     TEXT REFERENCES integration_event(id),
  source_id    TEXT NOT NULL REFERENCES integration_source(id),
  message_id   TEXT NOT NULL,
  message_type TEXT NOT NULL,
  received_at  TEXT NOT NULL,             -- demo-clock time
  outcome      TEXT NOT NULL CHECK (outcome IN ('applied','duplicate_ignored','stale_ignored','conflict_review','failed')),
  detail       TEXT,
  via          TEXT NOT NULL              -- pump | replay | retry | sync
);
CREATE INDEX idx_integration_receipt_at ON integration_receipt(received_at);
CREATE INDEX idx_integration_receipt_event ON integration_receipt(event_id);
CREATE TRIGGER integration_receipt_no_update BEFORE UPDATE ON integration_receipt
BEGIN SELECT RAISE(ABORT, 'integration_receipt is append-only'); END;
CREATE TRIGGER integration_receipt_no_delete BEFORE DELETE ON integration_receipt
BEGIN SELECT RAISE(ABORT, 'integration_receipt is append-only'); END;

-- Optimistic-concurrency version for the office contact / coverage directory.
-- Kept in a side table so the core office_contact table is not altered.
-- A missing row means version 1 (never edited).
CREATE TABLE office_contact_revision (
  contact_id TEXT PRIMARY KEY REFERENCES office_contact(id),
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE INDEX idx_outbox_pending ON sim_source_outbox(source_id, delivered_at, available_at);
