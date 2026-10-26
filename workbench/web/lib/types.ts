// Response shapes for the /api/v1 contract (core API: dermpath/routers/*.py; ML: docs/ml-api-contract.md).
// Only the fields the UI reads are listed; the API may return more.

export type Role = "histology_assistant" | "pathologist" | "research_lead" | "medical_director" | "admin";
export type Provenance = "demo_synthetic" | "public_cc0" | "real_authorized";
export type ReviewState = "imported" | "pending_review" | "approved" | "disputed" | "excluded";
export type ImageKind = "wsi" | "field_image" | "synthetic_tiles";
export type LabelValue = "bcc_present" | "bcc_absent_not_benign" | "indeterminate" | "inadequate" | "out_of_scope";
export type LabelScope = "case" | "slide" | "region";

export interface DemoUser {
  id: string;
  display_name: string;
  role: Role;
  active: boolean;
  demo_user: boolean;
}

export interface Membership {
  project_id: string;
  project_name: string;
  independent_review: boolean | null;
}

export interface Me {
  user: DemoUser;
  mode: string;
  notice: string;
  authentication: string;
  memberships: Membership[];
  permissions: Record<string, string[]>;
}

export interface Meta {
  roles: Role[];
  label_values: { value: LabelValue; display: string }[];
  label_scopes: LabelScope[];
  review_states: ReviewState[];
  review_transitions: { from: ReviewState; to: ReviewState; roles: Role[] }[];
  provenance: Record<Provenance, string>;
  qc: {
    categories: string[];
    manual_categories: string[];
    heuristic_categories: string[];
    suggested_actions: string[];
    eligibility_effects: string[];
  };
  partitions: string[];
  upload: { allowed_extensions: string[]; tested_wsi_formats: string[]; chunk_size: number; max_upload_bytes: number };
  research_use_only: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  task_template: Record<string, unknown>;
  settings: { independent_review?: boolean } | null;
  demo_seeded: boolean;
  my_role?: Role;
  independent_review_effective?: boolean;
}

export interface WorklistItem {
  slide_id: string;
  patient_code: string | null;
  accession_code: string | null;
  part: string | null;
  block: string | null;
  level_index: number | null;
  stain: string | null;
  scanner_id: string | null;
  site_id: string | null;
  image_kind: ImageKind;
  provenance: Provenance;
  provenance_display: string;
  review_state: ReviewState;
  ingest_status: "pending" | "running" | "succeeded" | "failed";
  ingest_error: string | null;
  open_qc_issues: number;
  expert_readers: number;
  my_label: LabelValue | null;
  slide_label_status: "unlabeled" | "single_reader" | "agreed" | "disputed" | "adjudicated";
  model_suggestions: number | null;
  suggestions_hidden: boolean;
  identifier_risk_flags: number;
  has_thumbnail: boolean;
  /** False for metadata-only records (pipeline-test cohort); the viewer is never opened for them. */
  image_available?: boolean;
  image_unavailable_reason?: string | null;
  case_id?: string | null;
  unassigned: boolean;
}

export interface Worklist {
  items: WorklistItem[];
  sort: string;
  counts_by_review_state: Record<ReviewState, number>;
}

export interface CaseSummary {
  id: string;
  coded_patient_id: string;
  patient_code: string;
  accession_code: string;
  collected_on: string | null;
  site_id: string | null;
  provenance: Provenance;
  note: string | null;
  parts: string[];
  slide_count: number;
  incomplete: boolean;
}

export interface Lineage {
  block_id: string | null;
  block: string | null;
  part_id: string | null;
  part: string | null;
  case_id: string | null;
  accession_code: string | null;
  coded_patient_id: string | null;
  patient_code: string | null;
  collected_on: string | null;
  site_id: string | null;
  anatomic_site_text: string | null;
  case_provenance: Provenance | null;
}

export interface IdentifierFlag {
  code: string;
  source: string;
  detail: string;
  message: string;
  property_keys?: string[];
}

export interface QcSummary {
  issue_counts_by_status: Record<string, number>;
  open_suggestions: number;
  open_issues: number;
  categories_open: string[];
  excluded_by_issue_ids: string[];
  region_exclusion_issue_ids: string[];
  latest_screen: null | {
    id: string;
    at: string;
    tissue_fraction: number | null;
    focus_median_variance: number | null;
    calibration: string | null;
    experimental: boolean;
  };
}

export interface LabelVersion {
  id: string;
  label_id: string;
  version: number;
  scope: LabelScope;
  target_id: string;
  slide_id: string | null;
  case_id: string | null;
  annotation_id: string | null;
  value: LabelValue | null;
  display: string | null;
  source: "expert" | "model_suggestion";
  suggestion_origin: string | null;
  suggestion_notice: string | null;
  model_ref: string | null;
  score: number | null;
  author_id: string | null;
  created_at: string;
  reason: string | null;
  review_action: "accepted" | "corrected" | "rejected" | "hidden" | null;
  review_of_suggestion_id: string | null;
  supersedes: string | null;
  is_adjudication: boolean;
  disagreement_id: string | null;
}

export interface Disagreement {
  id: string;
  scope: LabelScope;
  target_id: string;
  slide_id: string | null;
  case_id: string | null;
  label_version_ids: string[];
  values: LabelValue[];
  status: "open" | "adjudicated" | "resolved_by_agreement";
  adjudication_label_version_id: string | null;
  adjudicated_by: string | null;
  adjudicated_at: string | null;
  reason: string | null;
  created_at: string;
  labels?: LabelVersion[];
}

export interface Slide {
  id: string;
  project_id: string;
  block_id: string | null;
  level_index: number | null;
  stain: string | null;
  scanner_id: string | null;
  image_kind: ImageKind;
  is_whole_slide_image: boolean;
  provenance: Provenance;
  provenance_display: string;
  synthetic_notice: string | null;
  review_state: ReviewState;
  review_state_reason: string | null;
  review_state_by: string | null;
  review_state_at: string | null;
  ingest_status: string;
  ingest_error: string | null;
  processing_version: string | null;
  sha256: string;
  sha256_note: string;
  bytes: number | null;
  format: string | null;
  vendor: string | null;
  width: number | null;
  height: number | null;
  levels: number | null;
  mpp_x: number | null;
  mpp_y: number | null;
  objective_power: number | null;
  scale_bar_allowed: boolean;
  calibration_note: string | null;
  original_filename: string | null;
  identifier_risk: IdentifierFlag[];
  identifier_notice: string;
  associated_images_present_not_served: string[];
  lineage: Lineage;
  created_at: string;
  ingested_at: string | null;
  has_thumbnail: boolean;
  image_available?: boolean;
  image_unavailable_reason?: string | null;
  qc_summary?: QcSummary;
  labels?: {
    reference: LabelsView["reference"];
    suggestions_hidden: boolean;
    independent_review: boolean;
    disagreements: Disagreement[];
    expert_label_count: number;
    model_suggestion_count: number | null;
  };
}

export interface CaseDetail {
  id: string;
  coded_patient_id: string;
  patient_code: string;
  accession_code: string;
  collected_on: string | null;
  site_id: string | null;
  provenance: Provenance;
  note: string | null;
  parts: {
    id: string;
    designation: string;
    anatomic_site_text: string | null;
    blocks: { id: string; designation: string; slides: Slide[] }[];
  }[];
  case_label: { status: string; value: LabelValue | null; label_version_id: string | null; expert_label_versions: number; note: string };
}

export interface ViewerToken {
  token: string;
  dzi_url: string;
  tile_url_template: string;
  thumbnail_url: string;
  expires_at: string;
  ttl_seconds: number;
  image_kind: ImageKind;
  provenance: Provenance;
  mpp_x: number | null;
  mpp_y: number | null;
  scale_bar_allowed: boolean;
  width: number | null;
  height: number | null;
  bounds_offset_level0: [number, number];
}

export interface Assessment {
  id: string;
  slide_id: string;
  reviewer_id: string;
  value: LabelValue;
  confidence: string | null;
  comment: string | null;
  time_spent_seconds: number | null;
  suggestions_were_hidden: boolean;
  label_version_id: string | null;
  created_at: string;
}

export interface LabelsView {
  slide_id: string;
  review_state: ReviewState;
  independent_review: boolean;
  suggestions_hidden: boolean;
  hidden_reason: string | null;
  my_assessment: Assessment | null;
  expert_labels: LabelVersion[];
  model_suggestions: LabelVersion[];
  reference: {
    slide: { status: string; label: LabelVersion | null };
    case: { status: string; label: LabelVersion | null; case_id: string | null; note: string };
  };
  readers: { slide: string[] };
  disagreements: Disagreement[];
  notice: string;
}

export interface QcIssue {
  id: string;
  slide_id: string;
  category: string;
  region: Record<string, unknown> | null;
  source: "heuristic" | "human";
  is_suggestion: boolean;
  experimental: boolean;
  status: "open" | "reviewed" | "action_suggested" | "resolved";
  human_confirmed: boolean | null;
  suggested_action: string | null;
  resolution: string | null;
  dataset_eligibility_effect: "none" | "exclude_slide" | "exclude_region" | null;
  reason: string | null;
  note: string | null;
  override_of: string | null;
  overridden: boolean;
  created_by: string;
  created_at: string;
  history?: { action: string; from_status: string | null; to_status: string; actor_id: string | null; reason: string | null; detail: Record<string, unknown>; at: string }[];
}

export interface QcReview {
  id: string;
  kind: "automated_screen" | "manual";
  method_version: string;
  metrics: Record<string, unknown>;
  has_mask: boolean;
  experimental: boolean;
  override_of: string | null;
  reason: string | null;
  job_id: string | null;
  created_by: string;
  created_at: string;
}

export interface QcView {
  slide_id: string;
  summary: QcSummary;
  reviews: QcReview[];
  issues: QcIssue[];
  experimental_notice: string;
  policy: string;
}

export interface Annotation {
  id: string;
  annotation_id: string;
  version: number;
  slide_id: string;
  geometry_type: "polygon" | "rectangle";
  geometry: { type: "Polygon"; coordinates: number[][][]; rect?: { x: number; y: number; width: number; height: number } };
  transform_meta: Record<string, unknown> | null;
  label: string | null;
  comment: string | null;
  author_id: string;
  created_at: string;
  reason: string | null;
  superseded_by: string | null;
  deleted: boolean;
}

export interface Comment {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
}

export interface Job {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  attempts: number;
  max_attempts: number;
  progress: number;
  progress_message?: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  cancel_requested: boolean;
  created_at?: string;
  finished_at?: string | null;
}

export interface DatasetVersion {
  id: string;
  project_id: string;
  lineage_id: string;
  name: string;
  version: number;
  status: "draft" | "frozen";
  config: {
    label_scope: "slide" | "case";
    eligible_review_states: string[];
    label_values: LabelValue[];
    include_provenance: Provenance[];
    split: null | { partition: string; seed: number; ratios: Record<string, number>; test_cutoff?: string; val_cutoff?: string; test_sites?: string[] };
    task_template?: Record<string, unknown>;
  };
  manifest_sha256: string | null;
  created_by: string;
  created_at: string;
  frozen_at: string | null;
  frozen_by: string | null;
  parent_version_id: string | null;
  reason: string | null;
  materialized_at: string | null;
  item_count: number | null;
  excluded_count: number;
  manifest_verified?: boolean | null;
}

export interface DatasetSummary {
  dataset_version_id: string;
  name: string;
  version: number;
  status: "draft" | "frozen";
  label_scope: string;
  counts: { patients: number; cases: number; blocks: number; slides: number; patches: number | null; patches_note: string };
  label_balance: Record<string, { slides: number; cases: number; patients: number; display: string }>;
  splits: {
    assigned: boolean;
    partition: string | null;
    per_split: Record<string, { patients: number; slides: number; label_balance: Record<string, number> }>;
    unassigned_slide_ids: string[];
  };
  batches: {
    site: Record<string, number>;
    scanner: Record<string, number>;
    stain: Record<string, number>;
    label_by_site: Record<string, Record<string, number>>;
    label_by_scanner: Record<string, Record<string, number>>;
    label_by_stain: Record<string, Record<string, number>>;
  };
  missing_metadata: Record<string, { count: number; slide_ids: string[] }>;
  exclusions: {
    count: number;
    by_reason: Record<string, number>;
    slides: { slide_id: string; patient_code: string | null; accession_code: string | null; reasons: { code: string; detail?: string }[] }[];
  };
  reviewer_agreement: {
    scope: string;
    targets_considered: number;
    targets_with_2plus_readers: number;
    reader_pairs: number;
    agreeing_pairs: number;
    observed_agreement: number | string;
    cohen_kappa: number | string;
    kappa_reader_pair?: string[];
  };
  duplicates: {
    exact_within_dataset: { sha256: string; slide_ids: string[] }[];
    exact_rejected_at_upload: number;
    exact_note: string;
    near_duplicate_candidates: {
      slide_a: string;
      slide_b: string;
      dhash_distance: number;
      same_patient: boolean;
      cross_split: boolean;
      status: string;
      human_decision: null | { decision: string; reason: string | null; reviewer_id: string };
    }[];
    near_duplicate_method: string;
    near_duplicate_note: string;
  };
  qc_warnings: { slide_id: string; open_issues: { id: string; category: string; is_suggestion: boolean }[] }[];
  provenance_mix: Record<string, number>;
  synthetic_only: boolean;
  notice: string | null;
  workflow_metadata_note: string;
  manifest_sha256?: string;
  manifest_verified?: boolean;
}

export interface ManifestItem {
  slide_id: string;
  slide_sha256: string;
  label_version_id: string;
  label_value: LabelValue;
  label_scope: string;
  case_id: string;
  coded_patient_id: string;
  patient_code: string;
  accession_code: string;
  part: string;
  block: string;
  level_index: number | null;
  stain: string | null;
  scanner_id: string | null;
  site_id: string | null;
  collected_on: string | null;
  split: "train" | "val" | "test" | null;
  partition: string | null;
}

export interface Manifest {
  manifest: {
    schema: string;
    dataset_version_id: string;
    name: string;
    version: number;
    parent_version_id: string | null;
    config: Record<string, unknown>;
    frozen_at: string;
    frozen_by: string;
    counts: { patients: number; cases: number; blocks: number; slides: number };
    provenance_mix: Record<string, number>;
    synthetic_only: boolean;
    notice: string | null;
    items: ManifestItem[];
    splits: { coded_patient_id: string; patient_code: string; split: string; partition: string }[];
    exclusions: unknown[];
  };
  manifest_sha256: string;
  verified: boolean;
  hash_method: string;
}

// ---------------------------------------------------------------- ML (docs/ml-api-contract.md)

export interface Encoder {
  id: string;
  name: string;
  kind: "synthetic" | "pathology_foundation" | "generic_imagenet";
  license: { name: string; url: string | null; commercial_use: "no" | "yes" | "unknown"; notes: string | null };
  status: "available" | "missing_weights" | "missing_dependency";
  status_detail: string | null;
  weights_sha256: string | null;
  embedding_dim: number | null;
  preprocessing_version: string | null;
  synthetic: boolean;
  notice: string | null;
}

export interface MetricValue {
  value: number | null;
  numerator?: number;
  denominator?: number;
  ci: [number, number] | null;
  undefined_reason: string | null;
  defined?: boolean;
}

export interface Run {
  id: string;
  name: string | null;
  project_id: string;
  dataset_version_id: string;
  dataset_name: string | null;
  dataset_manifest_sha256: string | null;
  encoder_id: string;
  head: "meanpool_logreg" | "abmil";
  params: Record<string, unknown> | null;
  seed: number;
  status: Job["status"];
  job_id: string | null;
  progress: number | null;
  progress_message: string | null;
  synthetic: boolean;
  banner: string | null;
  code_revision: string | null;
  deps: Record<string, string> | null;
  weights_sha256: string | null;
  checkpoint: { object_key: string; sha256: string; bytes: number } | null;
  threshold: { value: number; selected_on: string; rule: string; frozen_at: string } | null;
  split_counts: Record<string, { patients?: number; items?: number } | number> | null;
  created_by: string;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  registered_model_id: string | null;
}

export interface Evaluation {
  split: "val" | "test";
  n_items: number;
  n_patients: number;
  positives: number;
  negatives: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  metrics: Record<string, MetricValue>;
  calibration: { bins: { lo: number; hi: number; mean_score: number | null; fraction_positive: number | null; n: number }[]; brier: number | null; ece: number | null; note: string };
  coverage_curve: { coverage: number; error_rate: number | null; n_kept: number }[];
  subgroups: { key: string; value: string; n: number; status: "ok" | "insufficient_evidence"; metrics: Record<string, MetricValue> | null }[];
  bootstrap: { method: string; n_boot: number; seed: number } | null;
  synthetic: boolean;
  banner: string | null;
  threshold: Run["threshold"] | number | null;
}

export interface ErrorItem {
  slide_id: string;
  patient_code: string | null;
  label: string;
  score: number;
  predicted: string;
  error_type: "false_negative" | "false_positive";
  attention_available: boolean;
  failure_reason: string | null;
}

export interface ModelVersion {
  id: string;
  run_id: string;
  status: string;
  created_by: string;
  created_at: string;
  synthetic: boolean;
  banner: string | null;
}
