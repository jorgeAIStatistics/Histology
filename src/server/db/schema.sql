-- Histology Lab OS — local relational model (SQLite).
-- Synthetic demonstration only. Times are stored as ISO-8601 UTC strings and
-- displayed in America/New_York. Mutable operational rows carry `version` for
-- optimistic concurrency (stale updates are rejected, never silently applied).
--
-- Naming: "source_*" tables hold data that belongs to the authoritative
-- EHR/LIS (here: SIMULATED). Everything else is operational data owned by the
-- companion app (tasks, discrepancies, holds, print jobs, custody, audit).

PRAGMA foreign_keys = ON;

------------------------------------------------------------------------------
-- Settings, sequences, idempotency
------------------------------------------------------------------------------
CREATE TABLE app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE id_sequence (
  name       TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL
);

-- Every command may carry an idempotency key (one per user intent). A repeated
-- key returns the original result instead of executing twice (double clicks,
-- network retries).
CREATE TABLE command_receipt (
  idempotency_key TEXT PRIMARY KEY,
  command         TEXT NOT NULL,
  actor_id        TEXT,
  result_json     TEXT NOT NULL,
  at              TEXT NOT NULL
);

------------------------------------------------------------------------------
-- Source systems, organizations, people
------------------------------------------------------------------------------
-- A source tenant is the namespace for external identifiers. The same MRN in
-- two tenants refers to two different patient references.
CREATE TABLE source_tenant (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  system_kind  TEXT NOT NULL,             -- e.g. 'EMA (simulated)'
  is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE practice (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES source_tenant(id)
);

CREATE TABLE office (
  id               TEXT PRIMARY KEY,
  practice_id      TEXT REFERENCES practice(id),
  tenant_id        TEXT NOT NULL REFERENCES source_tenant(id),
  source_office_id TEXT NOT NULL,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  working_hours    TEXT NOT NULL,          -- JSON {"mon":[["08:00","17:00"]],...}
  timezone         TEXT NOT NULL DEFAULT 'America/New_York',
  status           TEXT NOT NULL DEFAULT 'active', -- active | new_unreviewed | inactive
  UNIQUE (tenant_id, source_office_id)
);

-- Configurable contact / coverage directory for clarifications. Contact
-- details are fictional and channels are SIMULATED.
CREATE TABLE office_contact (
  id                TEXT PRIMARY KEY,
  office_id         TEXT NOT NULL REFERENCES office(id),
  display_name      TEXT NOT NULL,
  contact_role      TEXT NOT NULL,          -- e.g. 'Biopsy coordinator (MA lead)'
  channel           TEXT NOT NULL,          -- simulated_portal | simulated_ema_message | simulated_phone
  is_primary        INTEGER NOT NULL DEFAULT 0,
  is_escalation     INTEGER NOT NULL DEFAULT 0,
  covers_categories TEXT NOT NULL DEFAULT '[]', -- JSON list of clarification categories ([] = all)
  out_until         TEXT,                   -- coverage gap: unavailable until this time
  backup_contact_id TEXT REFERENCES office_contact(id)
);

CREATE TABLE clinician (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES source_tenant(id),
  source_provider_id TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  credential         TEXT NOT NULL,
  office_id          TEXT NOT NULL REFERENCES office(id),
  UNIQUE (tenant_id, source_provider_id)
);

-- Lab staff. Roles: accessioner, accessioning_lead, grosser, histology_assistant,
-- histotech, supervisor, pathologist, director, medical_director.
CREATE TABLE staff (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  short_name   TEXT NOT NULL,
  role         TEXT NOT NULL,
  initials     TEXT NOT NULL,
  color_token  TEXT,                       -- pathologists: 'teal' | 'violet' | 'amber'
  active       INTEGER NOT NULL DEFAULT 1
);

------------------------------------------------------------------------------
-- Routing (office -> assigned dermatopathologist), versioned
------------------------------------------------------------------------------
CREATE TABLE routing_rule_set (
  id             TEXT PRIMARY KEY,
  version        INTEGER NOT NULL UNIQUE,
  status         TEXT NOT NULL,            -- draft | approved | retired
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  approved_by    TEXT REFERENCES staff(id),
  approved_at    TEXT,
  notes          TEXT
);

CREATE TABLE routing_rule (
  id             TEXT PRIMARY KEY,
  rule_set_id    TEXT NOT NULL REFERENCES routing_rule_set(id),
  office_id      TEXT NOT NULL REFERENCES office(id),
  pathologist_id TEXT NOT NULL REFERENCES staff(id),
  UNIQUE (rule_set_id, office_id)
);

CREATE TABLE coverage_exception (
  id                      TEXT PRIMARY KEY,
  pathologist_id          TEXT NOT NULL REFERENCES staff(id),
  covering_pathologist_id TEXT NOT NULL REFERENCES staff(id),
  starts_at               TEXT NOT NULL,
  ends_at                 TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'approved', -- approved | retired
  approved_by             TEXT REFERENCES staff(id)
);

------------------------------------------------------------------------------
-- Source clinical data (authoritative elsewhere; SIMULATED here)
------------------------------------------------------------------------------
CREATE TABLE patient_ref (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES source_tenant(id),
  source_mrn        TEXT NOT NULL,
  family_name       TEXT NOT NULL,
  given_name        TEXT NOT NULL,
  birth_date        TEXT NOT NULL,
  sex               TEXT,
  source_updated_at TEXT,
  imported_at       TEXT NOT NULL,
  UNIQUE (tenant_id, source_mrn)            -- a name is never a key
);

CREATE TABLE encounter (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES source_tenant(id),
  source_encounter_id TEXT NOT NULL,
  patient_ref_id     TEXT NOT NULL REFERENCES patient_ref(id),
  office_id          TEXT NOT NULL REFERENCES office(id),
  clinician_id       TEXT REFERENCES clinician(id),
  encounter_at       TEXT,                  -- NULL = unknown
  source_updated_at  TEXT,
  imported_at        TEXT NOT NULL,
  UNIQUE (tenant_id, source_encounter_id)
);

CREATE TABLE source_order (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES source_tenant(id),
  source_order_id       TEXT NOT NULL,
  patient_ref_id        TEXT NOT NULL REFERENCES patient_ref(id),
  encounter_id          TEXT REFERENCES encounter(id),
  office_id             TEXT NOT NULL REFERENCES office(id),
  ordering_clinician_id TEXT REFERENCES clinician(id),
  source_status         TEXT NOT NULL,      -- active | amended | canceled
  source_version        INTEGER NOT NULL,
  source_updated_at     TEXT NOT NULL,
  imported_at           TEXT NOT NULL,
  import_event_id       TEXT,
  clinical_note         TEXT,               -- untrusted free text from the source; data only
  review_state          TEXT NOT NULL DEFAULT 'unreviewed', -- unreviewed | reviewed | needs_reconciliation
  version               INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, source_order_id)
);

-- Every imported version of an order is preserved (original values kept).
CREATE TABLE source_order_version (
  id                TEXT PRIMARY KEY,
  source_order_id   TEXT NOT NULL REFERENCES source_order(id),
  source_version    INTEGER NOT NULL,
  source_updated_at TEXT NOT NULL,
  imported_at       TEXT NOT NULL,
  payload           TEXT NOT NULL,          -- JSON exactly as received from the (simulated) source
  change_summary    TEXT,
  UNIQUE (source_order_id, source_version)
);

CREATE TABLE source_order_part (
  id                  TEXT PRIMARY KEY,
  source_order_id     TEXT NOT NULL REFERENCES source_order(id),
  designation         TEXT NOT NULL,        -- as written by the office: 'A', 'B', ...
  site_text           TEXT NOT NULL,        -- original source value
  site_normalized     TEXT,                 -- working value (normalized), original kept above
  laterality          TEXT,                 -- left | right | midline | bilateral | not_stated (NULL = unknown)
  procedure           TEXT,                 -- shave | punch | excision | curettage | nail_clipping | other | not_stated
  orientation_note    TEXT,
  collected_at        TEXT,                 -- NULL = unknown (never invented)
  expected_containers INTEGER,              -- NULL = unknown
  requested_stains    TEXT NOT NULL DEFAULT '[]', -- JSON [{"stain":"PAS","source":"order"}]
  status              TEXT NOT NULL DEFAULT 'active', -- active | canceled
  UNIQUE (source_order_id, designation)
);

-- Paper requisition as observed at the bench (may differ from the order).
CREATE TABLE requisition_doc (
  id               TEXT PRIMARY KEY,
  source_order_id  TEXT REFERENCES source_order(id),
  intake_item_id   TEXT REFERENCES intake_item(id),
  observed_fields  TEXT NOT NULL,           -- JSON of what staff read on the paper
  handwritten_note TEXT,
  doc_ref          TEXT NOT NULL            -- synthetic document reference
);

------------------------------------------------------------------------------
-- Arrival, intake (provisional), containers
------------------------------------------------------------------------------
CREATE TABLE courier_delivery (
  id          TEXT PRIMARY KEY,
  display_id  TEXT NOT NULL UNIQUE,         -- 'CR-1014-11'
  courier_name TEXT NOT NULL,
  route_label TEXT,
  expected_at TEXT,
  arrived_at  TEXT,
  received_by TEXT REFERENCES staff(id),
  status      TEXT NOT NULL,                -- expected | arrived | reconciling | reconciled
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE manifest_line (
  id                    TEXT PRIMARY KEY,
  delivery_id           TEXT NOT NULL REFERENCES courier_delivery(id),
  office_id             TEXT REFERENCES office(id),
  observed_office_text  TEXT,               -- for unknown offices
  manifest_source       TEXT NOT NULL,      -- office_manifest | none
  expected_containers   INTEGER,            -- NULL = unknown (no manifest)
  expected_requisitions INTEGER,
  note                  TEXT
);

-- Provisional receipt/tracking record. Its display id (INT-...) is deliberately
-- unlike an official accession number. It is NOT an accession.
CREATE TABLE intake_item (
  id                   TEXT PRIMARY KEY,
  display_id           TEXT NOT NULL UNIQUE CHECK (display_id GLOB 'INT-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]'), -- 'INT-1014-031'
  delivery_id          TEXT REFERENCES courier_delivery(id),
  office_id            TEXT REFERENCES office(id), -- NULL = office not recognized
  observed_office_text TEXT,
  received_at          TEXT NOT NULL,
  received_by          TEXT REFERENCES staff(id),
  status               TEXT NOT NULL CHECK (status IN ('received','in_review','ready_for_accession','accession_requested','accessioned','canceled')),
  current_owner_id     TEXT REFERENCES staff(id),
  accession_id         TEXT REFERENCES accession(id),
  version              INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT NOT NULL,
  updated_by           TEXT
);

CREATE TABLE intake_order_link (
  intake_item_id  TEXT NOT NULL REFERENCES intake_item(id),
  source_order_id TEXT NOT NULL REFERENCES source_order(id),
  link_basis      TEXT NOT NULL,            -- requisition_barcode | staff_search | simulator
  linked_by       TEXT,
  linked_at       TEXT NOT NULL,
  PRIMARY KEY (intake_item_id, source_order_id)
);

-- The actual vessel received. The container->order-part link is explicit and
-- local; one order does not imply one bottle.
CREATE TABLE container (
  id                 TEXT PRIMARY KEY,
  intake_item_id     TEXT NOT NULL REFERENCES intake_item(id),
  seq                INTEGER NOT NULL,
  observed_label     TEXT NOT NULL,         -- JSON: patient_name, birth_date, mrn, site_text, laterality, part_designation, procedure, raw_text
  label_capture      TEXT NOT NULL,         -- typed | synthetic_image | barcode_read
  order_part_id      TEXT REFERENCES source_order_part(id),
  link_basis         TEXT,                  -- barcode_read | staff_match | unknown
  verification_state TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_state IN ('unverified','verified','discrepancy')),
  verified_by        TEXT REFERENCES staff(id),
  verified_at        TEXT,
  condition_note     TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (intake_item_id, seq)
);

-- SIMULATOR ONLY: the physical contents of a courier delivery (what staff will
-- find when they unpack it). Real deployments have no such table; it exists so
-- the demo can "arrive" reproducibly.
CREATE TABLE sim_physical_item (
  id                      TEXT PRIMARY KEY,
  delivery_id             TEXT NOT NULL REFERENCES courier_delivery(id),
  seq                     INTEGER NOT NULL,
  observed_office_text    TEXT NOT NULL,
  requisition_order_ref   TEXT,               -- order id printed on the requisition (NULL = none)
  requisition_fields      TEXT NOT NULL,      -- JSON: what the paper says
  containers              TEXT NOT NULL,      -- JSON list of observed bottle labels
  received_intake_item_id TEXT REFERENCES intake_item(id),
  UNIQUE (delivery_id, seq)
);

-- Candidate grouping of related orders. Review only; it never merges.
CREATE TABLE related_order_candidate (
  id              TEXT PRIMARY KEY,
  display_id      TEXT NOT NULL UNIQUE,     -- 'REL-0112'
  order_a_id      TEXT NOT NULL REFERENCES source_order(id),
  order_b_id      TEXT NOT NULL REFERENCES source_order(id),
  reasons         TEXT NOT NULL,            -- JSON [{code,label,detail}]
  conflicts       TEXT NOT NULL,            -- JSON [{code,label,detail}]
  detection_rule  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending_review','single_accession_approved','keep_separate','not_related','escalated_to_office')),
  detected_at     TEXT NOT NULL,
  reviewed_by     TEXT REFERENCES staff(id),
  reviewed_at     TEXT,
  decision_reason TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (order_a_id, order_b_id),
  CHECK (order_a_id < order_b_id)
);

CREATE TABLE routing_decision (
  id                       TEXT PRIMARY KEY,
  intake_item_id           TEXT NOT NULL REFERENCES intake_item(id),
  status                   TEXT NOT NULL,   -- suggested | confirmed | overridden | exception | superseded
  suggested_pathologist_id TEXT REFERENCES staff(id),
  final_pathologist_id     TEXT REFERENCES staff(id),
  rule_set_id              TEXT REFERENCES routing_rule_set(id),
  rule_id                  TEXT REFERENCES routing_rule(id),
  coverage_exception_id    TEXT REFERENCES coverage_exception(id),
  explanation              TEXT NOT NULL,
  override_reason          TEXT,
  decided_by               TEXT REFERENCES staff(id),
  decided_at               TEXT,
  created_at               TEXT NOT NULL,
  CHECK (status IN ('suggested','confirmed','overridden','exception','superseded')),
  CHECK (status <> 'overridden' OR (override_reason IS NOT NULL AND length(trim(override_reason)) > 0)),
  CHECK (status <> 'exception' OR suggested_pathologist_id IS NULL)
);
CREATE UNIQUE INDEX routing_decision_one_active
  ON routing_decision(intake_item_id) WHERE status <> 'superseded';

------------------------------------------------------------------------------
-- Official accession (issued by the authoritative system; SIMULATED here)
------------------------------------------------------------------------------
CREATE TABLE accession_request (
  id                   TEXT PRIMARY KEY,
  display_id           TEXT NOT NULL UNIQUE, -- 'AR-0201'
  status               TEXT NOT NULL,        -- submitted | issued | failed | canceled
  related_candidate_id TEXT REFERENCES related_order_candidate(id),
  requested_by         TEXT REFERENCES staff(id),
  requested_at         TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL UNIQUE,
  accession_id         TEXT REFERENCES accession(id),
  failure_detail       TEXT,
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE accession_request_item (
  request_id     TEXT NOT NULL REFERENCES accession_request(id),
  intake_item_id TEXT NOT NULL REFERENCES intake_item(id),
  PRIMARY KEY (request_id, intake_item_id)
);

CREATE TABLE accession (
  id                    TEXT PRIMARY KEY,
  accession_number      TEXT NOT NULL CHECK (accession_number GLOB 'D[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9]'), -- 'D26-04817' (from the authoritative system)
  namespace             TEXT NOT NULL,      -- numbering namespace, e.g. 'EMA-SIM DERM'
  source_case_id        TEXT NOT NULL,
  issued_at             TEXT NOT NULL,
  issued_by_system      TEXT NOT NULL,      -- 'Authoritative source simulator'
  patient_ref_id        TEXT NOT NULL REFERENCES patient_ref(id),
  office_id             TEXT NOT NULL REFERENCES office(id),
  ordering_clinician_id TEXT REFERENCES clinician(id),
  assigned_pathologist_id TEXT REFERENCES staff(id),
  routing_decision_id   TEXT REFERENCES routing_decision(id),
  case_status           TEXT NOT NULL DEFAULT 'open', -- open | delivered | canceled
  priority              TEXT NOT NULL DEFAULT 'routine', -- routine | rush
  current_owner_id      TEXT REFERENCES staff(id),
  received_day          TEXT NOT NULL,      -- local lab day 'YYYY-MM-DD' (America/New_York)
  is_prior_day          INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 1,
  updated_at            TEXT NOT NULL,
  UNIQUE (namespace, accession_number)
);

CREATE TRIGGER accession_number_immutable
BEFORE UPDATE OF accession_number, namespace, source_case_id ON accession
WHEN OLD.accession_number IS NOT NEW.accession_number
  OR OLD.namespace IS NOT NEW.namespace
  OR OLD.source_case_id IS NOT NEW.source_case_id
BEGIN
  SELECT RAISE(ABORT, 'INVARIANT: an issued accession number cannot be renumbered locally');
END;

CREATE TRIGGER accession_patient_immutable
BEFORE UPDATE OF patient_ref_id ON accession
WHEN OLD.patient_ref_id IS NOT NEW.patient_ref_id
BEGIN
  SELECT RAISE(ABORT, 'INVARIANT: a case cannot be silently moved to another patient');
END;

CREATE TABLE specimen_part (
  id                   TEXT PRIMARY KEY,
  accession_id         TEXT NOT NULL REFERENCES accession(id),
  designation          TEXT NOT NULL,      -- 'A', 'B'
  source_order_id      TEXT NOT NULL REFERENCES source_order(id),
  source_order_part_id TEXT NOT NULL REFERENCES source_order_part(id),
  original_designation TEXT NOT NULL,      -- designation as written on the source order
  site_text            TEXT NOT NULL,      -- as issued; never silently changed
  laterality           TEXT,
  procedure            TEXT,
  container_id         TEXT REFERENCES container(id),
  physical_state       TEXT NOT NULL DEFAULT 'received', -- received | grossed | canceled
  status               TEXT NOT NULL DEFAULT 'active',   -- active | canceled
  version              INTEGER NOT NULL DEFAULT 1,
  UNIQUE (accession_id, designation)
);

CREATE TRIGGER specimen_part_identity_immutable
BEFORE UPDATE OF designation, accession_id, site_text ON specimen_part
WHEN OLD.designation IS NOT NEW.designation
  OR OLD.accession_id IS NOT NEW.accession_id
  OR OLD.site_text IS NOT NEW.site_text
BEGIN
  SELECT RAISE(ABORT, 'INVARIANT: part designation, case and site cannot be silently changed; open a correction review');
END;

-- Post-accession discrepancies: a review / cross-reference record that keeps
-- the original references. The authorized correction happens in the
-- authoritative system; there is no live correction endpoint here.
CREATE TABLE correction_review (
  id                   TEXT PRIMARY KEY,
  display_id           TEXT NOT NULL UNIQUE, -- 'XR-0031'
  accession_id         TEXT NOT NULL REFERENCES accession(id),
  kind                 TEXT NOT NULL,        -- possible_duplicate_case | site_discrepancy | identity_discrepancy | part_designation | related_case
  related_accession_id TEXT REFERENCES accession(id),
  original_refs        TEXT NOT NULL,        -- JSON snapshot of identifiers at the time
  description          TEXT NOT NULL,
  requested_by         TEXT NOT NULL REFERENCES staff(id),
  requested_at         TEXT NOT NULL,
  status               TEXT NOT NULL,        -- open | referred_to_source_process | closed_no_change | closed_corrected_in_source
  outcome_note         TEXT,
  closed_by            TEXT REFERENCES staff(id),
  closed_at            TEXT,
  version              INTEGER NOT NULL DEFAULT 1
);

------------------------------------------------------------------------------
-- Physical material: blocks (cassettes) and slides, work orders
------------------------------------------------------------------------------
CREATE TABLE storage_location (
  id        TEXT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,           -- 'CAB-2/DR-4/BX-11/S-14'
  kind      TEXT NOT NULL,                  -- cabinet | drawer | box | slot | bench | outside
  parent_id TEXT REFERENCES storage_location(id),
  label     TEXT NOT NULL,
  sort_key  TEXT NOT NULL
);

-- A cassette keeps its identity as it becomes a processed block.
CREATE TABLE block (
  id                     TEXT PRIMARY KEY,
  accession_id           TEXT NOT NULL REFERENCES accession(id),
  part_id                TEXT NOT NULL REFERENCES specimen_part(id),
  block_seq              INTEGER NOT NULL,
  label_text             TEXT NOT NULL,      -- 'A1'
  identifier             TEXT NOT NULL UNIQUE, -- machine-readable demo payload
  physical_state         TEXT NOT NULL CHECK (physical_state IN ('cassette_loaded','processing','processed','embedded','sectioned','stored')),
  pieces_submitted       INTEGER,            -- NULL = unknown
  current_location_id    TEXT REFERENCES storage_location(id), -- LAST CONFIRMED location only
  location_confirmed_at  TEXT,
  location_confirmed_by  TEXT REFERENCES staff(id),
  custody_state          TEXT NOT NULL DEFAULT 'in_workflow', -- in_workflow | stored | checked_out | sent_out | missing_investigation
  checkout_holder_id     TEXT REFERENCES staff(id),
  status                 TEXT NOT NULL DEFAULT 'active', -- active | void
  version                INTEGER NOT NULL DEFAULT 1,
  UNIQUE (part_id, block_seq)
);

CREATE TABLE work_order (
  id                    TEXT PRIMARY KEY,
  display_id            TEXT NOT NULL UNIQUE, -- 'WO-2213'
  accession_id          TEXT NOT NULL REFERENCES accession(id),
  kind                  TEXT NOT NULL,        -- stain | recut | levels | other
  stain                 TEXT,                 -- 'PAS', 'GMS', ... (explicit text, never inferred)
  authorization_source  TEXT NOT NULL,        -- source_order | standing_protocol | pathologist_request
  source_reference      TEXT NOT NULL,        -- human-readable origin, e.g. 'ORD-77120 v1 · part A'
  requested_by_label    TEXT NOT NULL,
  requested_by_staff_id TEXT REFERENCES staff(id),
  source_order_id       TEXT REFERENCES source_order(id),
  source_version        INTEGER,
  target_part_id        TEXT REFERENCES specimen_part(id),
  target_block_id       TEXT REFERENCES block(id),
  quantity              INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL CHECK (status IN ('requested','in_progress','completed','cancel_review','canceled','amended_review')),
  status_reason         TEXT,
  requested_at          TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE slide (
  id             TEXT PRIMARY KEY,
  accession_id   TEXT NOT NULL REFERENCES accession(id),
  block_id       TEXT NOT NULL REFERENCES block(id),
  slide_seq      INTEGER NOT NULL,
  stain          TEXT NOT NULL,              -- 'H&E', 'PAS', ...
  level_label    TEXT,
  work_order_id  TEXT REFERENCES work_order(id),
  identifier     TEXT NOT NULL UNIQUE,
  physical_state TEXT NOT NULL CHECK (physical_state IN ('planned','sectioned','stained','coverslipped','qc_reviewed','delivered')),
  label_state    TEXT NOT NULL DEFAULT 'none' CHECK (label_state IN ('none','printed','applied','verified','retired')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled_needs_review','void')),
  version        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (block_id, slide_seq)
);

------------------------------------------------------------------------------
-- Holds, clarifications, tasks
------------------------------------------------------------------------------
-- A hold is scoped to the affected material, not the whole bench.
CREATE TABLE hold (
  id               TEXT PRIMARY KEY,
  display_id       TEXT NOT NULL UNIQUE,     -- 'H-0091'
  scope_type       TEXT NOT NULL,            -- intake_item | container | order_part | specimen_part | block | slide | work_order | accession
  scope_id         TEXT NOT NULL,
  scope_label      TEXT NOT NULL,            -- human-readable: 'Part B (ORD-77121 · B)'
  blocks           TEXT NOT NULL,            -- JSON list of blocked transitions
  reason_code      TEXT NOT NULL,
  reason_text      TEXT NOT NULL,
  clarification_id TEXT REFERENCES clarification(id),
  status           TEXT NOT NULL CHECK (status IN ('active','released')),
  placed_by        TEXT NOT NULL,
  placed_at        TEXT NOT NULL,
  released_by      TEXT,
  released_at      TEXT,
  release_reason   TEXT,
  intake_item_id   TEXT REFERENCES intake_item(id),
  accession_id     TEXT REFERENCES accession(id),
  version          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE clarification (
  id                  TEXT PRIMARY KEY,
  display_id          TEXT NOT NULL UNIQUE,  -- 'CLR-0457'
  category            TEXT NOT NULL CHECK (category IN ('site','laterality','orientation_marking','biopsy_method','identity_conflict','missing_container','related_orders','other')),
  intake_item_id      TEXT REFERENCES intake_item(id),
  source_order_id     TEXT REFERENCES source_order(id),
  order_part_id       TEXT REFERENCES source_order_part(id),
  container_id        TEXT REFERENCES container(id),
  accession_id        TEXT REFERENCES accession(id),
  specimen_part_id    TEXT REFERENCES specimen_part(id),
  subject_label       TEXT NOT NULL,         -- 'Part B · ORD-77121'
  question            TEXT NOT NULL,
  evidence            TEXT NOT NULL,         -- JSON [{field, order_value, observed_value, requisition_value, source}]
  office_id           TEXT NOT NULL REFERENCES office(id),
  contact_role        TEXT NOT NULL,
  contact_id          TEXT REFERENCES office_contact(id),
  lab_owner_id        TEXT NOT NULL REFERENCES staff(id),
  escalation_owner_id TEXT REFERENCES staff(id),
  priority            TEXT NOT NULL,         -- routine | high | urgent
  state               TEXT NOT NULL CHECK (state IN ('drafted','sent','delivery_unknown','delivery_failed','delivered','acknowledged','answered','reviewed','resolved','canceled')),
  draft_source        TEXT NOT NULL DEFAULT 'manual', -- manual | assistant_proposal (human-edited before send)
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  sent_at             TEXT,
  delivered_at        TEXT,
  acknowledged_at     TEXT,
  answered_at         TEXT,
  reviewed_at         TEXT,
  resolved_at         TEXT,
  next_follow_up_at   TEXT,
  follow_up_count     INTEGER NOT NULL DEFAULT 0,
  escalated_at        TEXT,
  answer_text         TEXT,
  answered_by_contact TEXT,
  answer_channel      TEXT,
  reviewer_id         TEXT REFERENCES staff(id),
  review_note         TEXT,
  resolution_code     TEXT,                  -- confirmed_observed | confirmed_order | source_amended | other
  resolution_note     TEXT,
  resolved_by         TEXT REFERENCES staff(id),
  dedupe_key          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX clarification_open_dedupe
  ON clarification(dedupe_key) WHERE state NOT IN ('resolved', 'canceled');

-- Simulated notification log. Bodies are generic (no patient information).
CREATE TABLE clarification_message (
  id                   TEXT PRIMARY KEY,
  clarification_id     TEXT NOT NULL REFERENCES clarification(id),
  direction            TEXT NOT NULL,        -- outbound | inbound
  kind                 TEXT NOT NULL,        -- initial | reminder | escalation | answer | acknowledgement | delivery_receipt
  channel              TEXT NOT NULL,
  recipient_contact_id TEXT REFERENCES office_contact(id),
  body                 TEXT NOT NULL,
  delivery_state       TEXT NOT NULL,        -- simulated_sent | delivery_unknown | failed | delivered | received
  is_simulated         INTEGER NOT NULL DEFAULT 1,
  idempotency_key      TEXT NOT NULL UNIQUE,
  created_at           TEXT NOT NULL,
  created_by           TEXT
);

-- Operational task ownership: "who owns the next step".
CREATE TABLE task (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,   -- routing_exception | related_order_review | container_verification | clarification_followup | gross_review | source_entry | processing_eligible | print_reconcile | tray_exception | retrieval | order_change_review | correction_review | source_conflict
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  title          TEXT NOT NULL,
  owner_id       TEXT REFERENCES staff(id),
  owner_role     TEXT,
  status         TEXT NOT NULL CHECK (status IN ('open','in_progress','done','canceled')),
  priority       TEXT NOT NULL DEFAULT 'routine',
  due_at         TEXT,
  created_at     TEXT NOT NULL,
  completed_at   TEXT,
  completed_by   TEXT,
  accession_id   TEXT REFERENCES accession(id),
  intake_item_id TEXT REFERENCES intake_item(id),
  detail         TEXT,
  version        INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX task_open_unique
  ON task(kind, entity_type, entity_id) WHERE status IN ('open', 'in_progress');

------------------------------------------------------------------------------
-- Grossing capture (draft → reviewed → approved for downstream), separate
-- from the source-system update state.
------------------------------------------------------------------------------
CREATE TABLE gross_transcript (
  id               TEXT PRIMARY KEY,
  specimen_part_id TEXT NOT NULL REFERENCES specimen_part(id),
  source           TEXT NOT NULL,            -- synthetic_dictation | typed | microphone
  text             TEXT NOT NULL,
  audio_ref        TEXT,
  captured_by      TEXT REFERENCES staff(id),
  captured_at      TEXT NOT NULL
);

CREATE TABLE gross_record (
  id                  TEXT PRIMARY KEY,
  specimen_part_id    TEXT NOT NULL REFERENCES specimen_part(id),
  record_version      INTEGER NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('draft','needs_clarification','operator_reviewed','approved_for_downstream','superseded')),
  source_update_state TEXT NOT NULL DEFAULT 'not_started' CHECK (source_update_state IN ('not_started','pending_entry','entered_attested','source_acknowledged','failed')),
  transcript_id       TEXT REFERENCES gross_transcript(id),
  narrative           TEXT NOT NULL DEFAULT '',
  fields              TEXT NOT NULL,         -- JSON structured fields; each value carries status: confirmed | proposed | missing | needs_review
  proposals           TEXT NOT NULL DEFAULT '[]', -- assistant proposals with evidence spans (never auto-confirmed)
  unresolved          TEXT NOT NULL DEFAULT '[]',
  extractor           TEXT,                  -- 'deterministic-demo-extractor v1' | NULL
  grosser_id          TEXT REFERENCES staff(id),
  reviewed_by         TEXT REFERENCES staff(id),
  reviewed_at         TEXT,
  approved_by         TEXT REFERENCES staff(id),
  approved_at         TEXT,
  source_entry_by     TEXT REFERENCES staff(id),
  source_entry_at     TEXT,
  source_ack_at       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  UNIQUE (specimen_part_id, record_version)
);

------------------------------------------------------------------------------
-- Labels and printing (SIMULATED printers)
------------------------------------------------------------------------------
CREATE TABLE printer (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL,          -- slide | cassette | label
  location           TEXT NOT NULL,
  status             TEXT NOT NULL,          -- online | offline | simulate_timeout
  reports_completion INTEGER NOT NULL DEFAULT 0,
  is_simulated       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE print_job (
  id                 TEXT PRIMARY KEY,
  display_id         TEXT NOT NULL UNIQUE,   -- 'PJ-8841'
  printer_id         TEXT NOT NULL REFERENCES printer(id),
  kind               TEXT NOT NULL,          -- slide_label | cassette_label | requisition_label
  target_type        TEXT NOT NULL,          -- slide | block | accession
  target_id          TEXT NOT NULL,
  accession_id       TEXT REFERENCES accession(id),
  payload            TEXT NOT NULL,          -- encoded identifier printed on the label
  purpose            TEXT NOT NULL,          -- initial | reprint_damaged | reprint_after_failure | reprint_after_unknown
  state              TEXT NOT NULL CHECK (state IN ('planned','queued','submitted','acknowledged','completion_confirmed','failed','unknown_outcome','canceled')),
  reprint_of_job_id  TEXT REFERENCES print_job(id),
  reprint_reason     TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  requested_by       TEXT NOT NULL REFERENCES staff(id),
  created_at         TEXT NOT NULL,
  submitted_at       TEXT,
  acknowledged_at    TEXT,
  completed_at       TEXT,
  reconciled_by      TEXT REFERENCES staff(id),
  reconciled_at      TEXT,
  reconciliation     TEXT,                   -- printed_ok | not_printed | printed_damaged
  reconciliation_note TEXT,
  failure_detail     TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  CHECK (purpose NOT LIKE 'reprint%' OR (reprint_of_job_id IS NOT NULL AND reprint_reason IS NOT NULL AND length(trim(reprint_reason)) > 0))
);
-- At most one in-flight job per target/kind: double clicks and retries cannot
-- create uncontrolled duplicates; an unknown outcome blocks a new job.
CREATE UNIQUE INDEX print_job_one_in_flight
  ON print_job(target_type, target_id, kind)
  WHERE state IN ('planned', 'queued', 'submitted', 'acknowledged', 'unknown_outcome');

-- Physical label lifecycle. Printing and application/verification are distinct.
CREATE TABLE label (
  id            TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  print_job_id  TEXT REFERENCES print_job(id),
  payload       TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('printed','applied','verified','retired')),
  applied_by    TEXT,
  applied_at    TEXT,
  verified_by   TEXT,
  verified_at   TEXT,
  retired_by    TEXT,
  retired_at    TEXT,
  retire_reason TEXT,
  created_at    TEXT NOT NULL
);

------------------------------------------------------------------------------
-- Tray assembly
------------------------------------------------------------------------------
CREATE TABLE tray (
  id             TEXT PRIMARY KEY,
  display_id     TEXT NOT NULL UNIQUE,       -- 'TRY-M-03'
  pathologist_id TEXT NOT NULL REFERENCES staff(id),
  status         TEXT NOT NULL CHECK (status IN ('open','assembling','exception','verified_complete','released_with_exceptions','delivered')),
  opened_by      TEXT REFERENCES staff(id),
  opened_at      TEXT NOT NULL,
  closed_by      TEXT REFERENCES staff(id),
  closed_at      TEXT,
  close_note     TEXT,
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tray_expected_slide (
  tray_id  TEXT NOT NULL REFERENCES tray(id),
  slide_id TEXT NOT NULL REFERENCES slide(id),
  seq      INTEGER NOT NULL,
  disposition TEXT,                          -- NULL | follows_separately | missing_investigation (controlled resolution)
  disposition_by TEXT,
  disposition_at TEXT,
  disposition_note TEXT,
  PRIMARY KEY (tray_id, slide_id)
);

CREATE TABLE tray_scan (
  id              TEXT PRIMARY KEY,
  tray_id         TEXT NOT NULL REFERENCES tray(id),
  scanned_payload TEXT NOT NULL,
  slide_id        TEXT REFERENCES slide(id),
  result          TEXT NOT NULL,             -- verified_expected | unexpected | duplicate | canceled_material | unknown_identifier | invalid_payload
  scanned_by      TEXT NOT NULL,
  scanned_at      TEXT NOT NULL,
  resolution      TEXT,                      -- removed_from_tray | added_by_authorized_change
  resolved_by     TEXT,
  resolved_at     TEXT
);

------------------------------------------------------------------------------
-- Custody and retrieval
------------------------------------------------------------------------------
CREATE TABLE custody_event (
  id            TEXT PRIMARY KEY,
  material_type TEXT NOT NULL,               -- block | slide
  material_id   TEXT NOT NULL,
  event         TEXT NOT NULL,               -- stored | location_confirmed | checked_out | returned | sent_out | received_back | missing_reported | found | scan_mismatch
  location_id   TEXT REFERENCES storage_location(id),
  holder_id     TEXT REFERENCES staff(id),
  destination   TEXT,
  actor_id      TEXT NOT NULL,
  at            TEXT NOT NULL,
  note          TEXT,
  request_id    TEXT
);

CREATE TABLE retrieval_request (
  id            TEXT PRIMARY KEY,
  display_id    TEXT NOT NULL UNIQUE,        -- 'RR-0192'
  requested_by  TEXT NOT NULL REFERENCES staff(id),
  purpose       TEXT NOT NULL,
  destination   TEXT NOT NULL,
  work_order_id TEXT REFERENCES work_order(id),
  status        TEXT NOT NULL,               -- open | picking | partially_retrieved | retrieved | delivered | canceled
  due_at        TEXT,
  created_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE retrieval_item (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES retrieval_request(id),
  block_id   TEXT NOT NULL REFERENCES block(id),
  bench_seq  INTEGER NOT NULL,               -- order the receiving bench needs
  status     TEXT NOT NULL,                  -- pending | picked | not_found | missing_investigation | delivered | returned
  picked_by  TEXT,
  picked_at  TEXT,
  note       TEXT,
  UNIQUE (request_id, block_id)
);

------------------------------------------------------------------------------
-- Integration (SIMULATED adapters)
------------------------------------------------------------------------------
CREATE TABLE integration_source (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  adapter         TEXT NOT NULL,             -- simulated_ema | simulated_other_ehr | simulated_printer | simulated_notifications | deterministic_assistant
  tenant_id       TEXT REFERENCES source_tenant(id),
  rollout_mode    TEXT NOT NULL,             -- A_local_demo
  status          TEXT NOT NULL,             -- connected | offline | degraded
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error      TEXT,
  capabilities    TEXT NOT NULL              -- JSON capability discovery result
);

-- What the simulated source would emit. Delivered to the app only while the
-- source is connected (so an outage produces a real backlog).
CREATE TABLE sim_source_outbox (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES integration_source(id),
  message_id   TEXT NOT NULL,
  message_type TEXT NOT NULL,
  available_at TEXT NOT NULL,
  payload      TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (source_id, message_id)
);

CREATE TABLE integration_event (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES integration_source(id),
  message_id        TEXT NOT NULL,
  message_type      TEXT NOT NULL,           -- order.upsert | order.cancel | accession.issued | ...
  entity_key        TEXT NOT NULL,
  source_version    INTEGER,
  source_updated_at TEXT,
  received_at       TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('applied','duplicate_ignored','stale_ignored','conflict_review','failed')),
  detail            TEXT,
  payload           TEXT NOT NULL,
  receipt_count     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source_id, message_id)
);

------------------------------------------------------------------------------
-- Worklist change feed, acknowledgements, snapshots, saved filters
------------------------------------------------------------------------------
CREATE TABLE worklist_change (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  accession_id   TEXT REFERENCES accession(id),
  intake_item_id TEXT REFERENCES intake_item(id),
  pathologist_id TEXT REFERENCES staff(id),
  change_type    TEXT NOT NULL,              -- new | changed | canceled
  summary        TEXT NOT NULL,
  at             TEXT NOT NULL
);

CREATE TABLE worklist_ack (
  staff_id  TEXT NOT NULL REFERENCES staff(id),
  view      TEXT NOT NULL,
  acked_seq INTEGER NOT NULL,
  acked_at  TEXT NOT NULL,
  PRIMARY KEY (staff_id, view)
);

CREATE TABLE worklist_snapshot (
  id           TEXT PRIMARY KEY,
  display_id   TEXT NOT NULL UNIQUE,
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL REFERENCES staff(id),
  seq          INTEGER NOT NULL,             -- worklist version at generation
  view         TEXT NOT NULL,
  filters      TEXT,
  format       TEXT NOT NULL,                -- print | csv
  row_count    INTEGER NOT NULL,
  data_as_of   TEXT                          -- last successful source sync at generation
);

CREATE TABLE saved_filter (
  id         TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL REFERENCES staff(id),
  view       TEXT NOT NULL,
  name       TEXT NOT NULL,
  filters    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (staff_id, view, name)
);

------------------------------------------------------------------------------
-- Illustrative prior-day events for example queue charts (synthetic)
------------------------------------------------------------------------------
CREATE TABLE ops_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT NOT NULL,               -- local lab day
  case_ref      TEXT NOT NULL,
  pathologist_id TEXT,
  office_id     TEXT,
  event         TEXT NOT NULL,               -- received | accessioned | clarification_sent | clarification_answered | clarification_resolved | gross_completed | gross_approved | source_entered | tray_delivered
  at            TEXT NOT NULL,
  illustrative  INTEGER NOT NULL DEFAULT 1
);

------------------------------------------------------------------------------
-- Audit (local append-only; NOT proof of production tamper resistance)
------------------------------------------------------------------------------
CREATE TABLE audit_event (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  at             TEXT NOT NULL,              -- demo-clock time
  recorded_at    TEXT NOT NULL,              -- wall-clock time
  actor_id       TEXT,
  actor_role     TEXT,
  origin         TEXT NOT NULL,              -- user | system | simulator | assistant | import | demo
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  accession_id   TEXT,
  intake_item_id TEXT,
  summary        TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  reason         TEXT,
  correlation_id TEXT
);

CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

CREATE TABLE demo_step_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  step    INTEGER NOT NULL,
  action  TEXT NOT NULL,
  ran_at  TEXT NOT NULL,
  ran_by  TEXT,
  result  TEXT NOT NULL
);


------------------------------------------------------------------------------
-- Additional database-enforced invariants
------------------------------------------------------------------------------
-- One approved gross record version per part at a time.
CREATE UNIQUE INDEX gross_record_one_approved ON gross_record(specimen_part_id) WHERE state = 'approved_for_downstream';

-- Approved (or superseded) gross content is frozen; corrections create a new version.
CREATE TRIGGER gross_record_approved_frozen
BEFORE UPDATE OF narrative, fields, transcript_id ON gross_record
WHEN OLD.state IN ('approved_for_downstream', 'superseded')
  AND (OLD.narrative IS NOT NEW.narrative OR OLD.fields IS NOT NEW.fields OR OLD.transcript_id IS NOT NEW.transcript_id)
BEGIN
  SELECT RAISE(ABORT, 'INVARIANT: an approved gross record cannot be edited; create a new version');
END;

-- One physically applied label per target at a time.
CREATE UNIQUE INDEX label_one_applied ON label(target_type, target_id) WHERE state IN ('applied', 'verified');

-- Rules inside an approved or retired rule set are frozen; changes need a new version.
CREATE TRIGGER routing_rule_frozen_update BEFORE UPDATE ON routing_rule
WHEN (SELECT status FROM routing_rule_set WHERE id = OLD.rule_set_id) IN ('approved', 'retired')
BEGIN SELECT RAISE(ABORT, 'INVARIANT: approved routing rules are frozen; draft a new rule set version'); END;
CREATE TRIGGER routing_rule_frozen_delete BEFORE DELETE ON routing_rule
WHEN (SELECT status FROM routing_rule_set WHERE id = OLD.rule_set_id) IN ('approved', 'retired')
BEGIN SELECT RAISE(ABORT, 'INVARIANT: approved routing rules are frozen; draft a new rule set version'); END;
CREATE TRIGGER routing_rule_frozen_insert BEFORE INSERT ON routing_rule
WHEN (SELECT status FROM routing_rule_set WHERE id = NEW.rule_set_id) IN ('approved', 'retired')
BEGIN SELECT RAISE(ABORT, 'INVARIANT: approved routing rules are frozen; draft a new rule set version'); END;

-- Append-only history tables.
CREATE TRIGGER custody_event_no_update BEFORE UPDATE ON custody_event BEGIN SELECT RAISE(ABORT, 'custody_event is append-only'); END;
CREATE TRIGGER custody_event_no_delete BEFORE DELETE ON custody_event BEGIN SELECT RAISE(ABORT, 'custody_event is append-only'); END;
CREATE TRIGGER worklist_change_no_update BEFORE UPDATE ON worklist_change BEGIN SELECT RAISE(ABORT, 'worklist_change is append-only'); END;
CREATE TRIGGER worklist_change_no_delete BEFORE DELETE ON worklist_change BEGIN SELECT RAISE(ABORT, 'worklist_change is append-only'); END;
CREATE TRIGGER source_order_version_no_update BEFORE UPDATE ON source_order_version BEGIN SELECT RAISE(ABORT, 'source_order_version is immutable'); END;
CREATE TRIGGER source_order_version_no_delete BEFORE DELETE ON source_order_version BEGIN SELECT RAISE(ABORT, 'source_order_version is immutable'); END;
CREATE TRIGGER gross_transcript_no_update BEFORE UPDATE ON gross_transcript BEGIN SELECT RAISE(ABORT, 'gross_transcript is immutable'); END;
CREATE TRIGGER clarification_message_no_delete BEFORE DELETE ON clarification_message BEGIN SELECT RAISE(ABORT, 'clarification_message is append-only'); END;

-- Helpful indexes
CREATE INDEX idx_order_patient ON source_order(patient_ref_id);
CREATE INDEX idx_order_encounter ON source_order(encounter_id);
CREATE INDEX idx_part_accession ON specimen_part(accession_id);
CREATE INDEX idx_block_accession ON block(accession_id);
CREATE INDEX idx_slide_block ON slide(block_id);
CREATE INDEX idx_slide_accession ON slide(accession_id);
CREATE INDEX idx_hold_scope ON hold(scope_type, scope_id, status);
CREATE INDEX idx_clar_state ON clarification(state);
CREATE INDEX idx_task_status ON task(status, kind);
CREATE INDEX idx_audit_entity ON audit_event(entity_type, entity_id);
CREATE INDEX idx_audit_accession ON audit_event(accession_id);
CREATE INDEX idx_audit_intake ON audit_event(intake_item_id);
CREATE INDEX idx_custody_material ON custody_event(material_type, material_id);
CREATE INDEX idx_ops_event_day ON ops_event(day, event);
