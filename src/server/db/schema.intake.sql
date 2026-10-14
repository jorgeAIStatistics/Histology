------------------------------------------------------------------------------
-- S1 Intake & accession — additive schema (owner: intake slice).
-- Additive only: new tables, indexes, triggers and ADD COLUMN.
------------------------------------------------------------------------------

-- Free-text working note on an intake item (generic edit used to demonstrate
-- stale-update detection between two accessioners).
ALTER TABLE intake_item ADD COLUMN notes TEXT;

-- Every explicit human attestation "staff verified against physical
-- container", with the field-level comparison it was based on and the order
-- version it was compared against (INV-12, INV-13). Append-only.
CREATE TABLE container_verification (
  id                   TEXT PRIMARY KEY,
  container_id         TEXT NOT NULL REFERENCES container(id),
  intake_item_id       TEXT NOT NULL REFERENCES intake_item(id),
  order_part_id        TEXT NOT NULL REFERENCES source_order_part(id),
  source_order_version INTEGER NOT NULL,
  result               TEXT NOT NULL CHECK (result IN ('verified','discrepancy')),
  comparison           TEXT NOT NULL,          -- JSON rows: field, order / observed / requisition values (originals kept), status
  attested_by          TEXT NOT NULL REFERENCES staff(id),
  attested_at          TEXT NOT NULL,
  origin               TEXT NOT NULL CHECK (origin IN ('user','demo')) -- never system / simulator / assistant
);
CREATE INDEX idx_container_verification ON container_verification(container_id, attested_at);
CREATE TRIGGER container_verification_no_update BEFORE UPDATE ON container_verification
BEGIN SELECT RAISE(ABORT, 'container_verification is append-only'); END;
CREATE TRIGGER container_verification_no_delete BEFORE DELETE ON container_verification
BEGIN SELECT RAISE(ABORT, 'container_verification is append-only'); END;

-- Pre-accession discrepancies found at intake. Every conflicting value is kept
-- (INV-14); resolution adds a decision and never overwrites a value.
CREATE TABLE intake_discrepancy (
  id              TEXT PRIMARY KEY,
  intake_item_id  TEXT NOT NULL REFERENCES intake_item(id),
  kind            TEXT NOT NULL CHECK (kind IN ('field_mismatch','missing_container','unmatched_container','order_not_linked')),
  field           TEXT,                        -- field_mismatch only: patient_name | birth_date | mrn | site | laterality | procedure | part_designation | collection_date
  container_id    TEXT REFERENCES container(id),
  order_part_id   TEXT REFERENCES source_order_part(id),
  values_json     TEXT NOT NULL,               -- JSON {order, observed, requisition, detail} as found
  status          TEXT NOT NULL CHECK (status IN ('open','resolved','withdrawn')),
  detected_at     TEXT NOT NULL,
  detected_by     TEXT,
  resolved_at     TEXT,
  resolved_by     TEXT,
  resolution_note TEXT,
  version         INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX intake_discrepancy_open_unique
  ON intake_discrepancy(intake_item_id, kind, COALESCE(container_id, ''), COALESCE(order_part_id, ''), COALESCE(field, ''))
  WHERE status = 'open';
CREATE INDEX idx_intake_discrepancy_item ON intake_discrepancy(intake_item_id, status);
CREATE TRIGGER intake_discrepancy_no_delete BEFORE DELETE ON intake_discrepancy
BEGIN SELECT RAISE(ABORT, 'intake_discrepancy rows are never deleted'); END;
CREATE TRIGGER intake_discrepancy_values_frozen BEFORE UPDATE OF values_json, kind, field, container_id, order_part_id ON intake_discrepancy
WHEN OLD.values_json IS NOT NEW.values_json OR OLD.kind IS NOT NEW.kind OR OLD.field IS NOT NEW.field
  OR OLD.container_id IS NOT NEW.container_id OR OLD.order_part_id IS NOT NEW.order_part_id
BEGIN SELECT RAISE(ABORT, 'INVARIANT: discrepancy evidence is kept as found; record a resolution instead'); END;

-- One accession per accession request (a request is never issued twice).
CREATE UNIQUE INDEX accession_request_one_accession ON accession_request(accession_id) WHERE accession_id IS NOT NULL;

-- Helpful lookups for the bench.
CREATE INDEX idx_intake_item_delivery ON intake_item(delivery_id);
CREATE INDEX idx_intake_order_link_order ON intake_order_link(source_order_id);
CREATE INDEX idx_container_item ON container(intake_item_id);
CREATE INDEX idx_routing_decision_item ON routing_decision(intake_item_id, status);
CREATE INDEX idx_related_a ON related_order_candidate(order_a_id);
CREATE INDEX idx_related_b ON related_order_candidate(order_b_id);
CREATE INDEX idx_sim_physical_delivery ON sim_physical_item(delivery_id, seq);
