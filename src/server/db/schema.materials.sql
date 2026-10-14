-- S5 Materials (labels, print queue, trays, retrieval) — additive columns only.
-- Applied after schema.sql by scripts/gen-schema-module.mjs. The same columns
-- are also ensured at runtime by ensureMaterialsSchema() so an older local
-- database file keeps working until the next demo reset.

-- A reprinted label points at the physical label it replaces.
ALTER TABLE label ADD COLUMN replaces_label_id TEXT;

-- Disposition recorded when a work order canceled/amended at the source is
-- reviewed. The slide row is never deleted; the decision is recorded here.
ALTER TABLE slide ADD COLUMN review_disposition TEXT;   -- retained_per_review | voided_unprepared | kept_active
ALTER TABLE slide ADD COLUMN review_note TEXT;
ALTER TABLE slide ADD COLUMN reviewed_by TEXT;
ALTER TABLE slide ADD COLUMN reviewed_at TEXT;

ALTER TABLE work_order ADD COLUMN review_decision TEXT;  -- retain_prepared_material | void_unprepared | keep_active
ALTER TABLE work_order ADD COLUMN review_note TEXT;
ALTER TABLE work_order ADD COLUMN reviewed_by TEXT;
ALTER TABLE work_order ADD COLUMN reviewed_at TEXT;

-- Why a tray scan was not accepted (plain language, shown to the operator).
ALTER TABLE tray_scan ADD COLUMN detail TEXT;

-- Retrieval item bookkeeping.
ALTER TABLE retrieval_item ADD COLUMN mismatch_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retrieval_item ADD COLUMN delivered_at TEXT;
ALTER TABLE retrieval_item ADD COLUMN returned_at TEXT;

CREATE INDEX IF NOT EXISTS idx_print_job_target ON print_job(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_label_target ON label(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_tray_scan_tray ON tray_scan(tray_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_item_request ON retrieval_item(request_id);
