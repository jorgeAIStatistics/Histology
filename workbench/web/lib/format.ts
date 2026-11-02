import type { LabelValue, Provenance, ReviewState, Role } from "./types";

export const ROLE_LABEL: Record<Role, string> = {
  histology_assistant: "Histology assistant",
  pathologist: "Pathologist",
  research_lead: "Research lead",
  medical_director: "Medical director",
  admin: "Admin",
};

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  imported: "Imported",
  pending_review: "Pending review",
  approved: "Approved",
  disputed: "Disputed",
  excluded: "Excluded",
};

export const PROVENANCE_SHORT: Record<Provenance, string> = {
  demo_synthetic: "DEMO",
  public_cc0: "PUBLIC CC0",
  public_licensed: "PUBLIC LICENSED",
  real_authorized: "REAL DATA",
};

export const PROVENANCE_LONG: Record<Provenance, string> = {
  demo_synthetic: "Demo synthetic: procedural tiles, no histology",
  public_cc0: "Public CC0: OpenSlide test data, unlabeled",
  public_licensed: "Public licensed dataset: third-party research data; licence terms recorded with the project (e.g. non-commercial)",
  real_authorized: "Real data (authorized): attestation recorded, not proof of de-identification",
};

// Short display for compact places; the full API display text is shown wherever a label is chosen or explained.
export const LABEL_SHORT: Record<LabelValue, string> = {
  bcc_present: "BCC present",
  bcc_absent_not_benign: "BCC absent (not benign)",
  indeterminate: "Indeterminate",
  inadequate: "Inadequate",
  out_of_scope: "Out of scope",
};

export const LABEL_STATUS_TEXT: Record<string, string> = {
  unlabeled: "Unlabeled",
  single_reader: "One reader",
  agreed: "Readers agree",
  disputed: "Readers disagree",
  adjudicated: "Adjudicated",
  no_case: "No case",
};

export const QC_CATEGORY_LABEL: Record<string, string> = {
  fold: "Fold",
  chatter: "Chatter",
  stain_variation: "Staining variation",
  contamination_concern: "Contamination concern",
  incomplete_tissue: "Incomplete tissue",
  scan_focus: "Scan focus problem",
  low_tissue_heuristic: "Low tissue (heuristic)",
  blur_heuristic: "Possible blur (heuristic)",
  unreadable_region: "Unreadable region",
  missing_calibration: "Missing calibration",
};

export const QC_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  reviewed: "Reviewed",
  action_suggested: "Action suggested",
  resolved: "Resolved",
};

export const QC_ACTION_LABEL: Record<string, string> = {
  consider_rescan: "Consider rescan",
  consider_recut: "Consider recut",
  consider_restain: "Consider restain",
  review_region: "Review the region",
  exclude_region_from_training: "Exclude the region from training",
  exclude_slide_from_training: "Exclude the slide from training",
  record_calibration: "Record calibration",
  no_action: "No action",
  other: "Other",
};

export const ELIGIBILITY_LABEL: Record<string, string> = {
  none: "No effect on dataset eligibility",
  exclude_slide: "Exclude the slide from datasets",
  exclude_region: "Exclude the region from training",
};

export const EXCLUSION_REASON_LABEL: Record<string, string> = {
  field_image_not_wsi: "Field image, not a whole slide",
  ingest_failed: "Ingest failed",
  ingest_pending: "Ingest pending",
  ingest_running: "Ingest running",
  no_reference_label_slide: "No slide-level expert label",
  no_reference_label_case: "No case-level expert label",
  open_disagreement: "Open reader disagreement",
  label_disputed: "Readers disagree",
  qc_excluded: "Excluded by a resolved QC issue",
  review_state_disputed: "Review state: disputed",
  review_state_excluded: "Review state: excluded",
  review_state_imported: "Review state: imported (not yet routed)",
  review_state_pending_review: "Review state: pending review",
  review_state_approved: "Review state: approved",
  label_value_not_in_task: "Label is not a task class (e.g. indeterminate)",
  provenance_not_included: "Provenance not included",
  no_hierarchy: "Not assigned to a case",
};

export function humanize(code: string | null | undefined): string {
  if (!code) return "";
  return code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function shortHash(h: string | null | undefined, n = 12): string {
  if (!h) return "none";
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return `${(v * 100).toFixed(digits)}%`;
}

export function slideTitle(s: { part?: string | null; block?: string | null; level_index?: number | null; stain?: string | null }): string {
  const parts: string[] = [];
  if (s.block) parts.push(`Block ${s.block}`);
  else if (s.part) parts.push(`Part ${s.part}`);
  parts.push(s.level_index === null || s.level_index === undefined ? "no level" : `Level ${s.level_index}`);
  if (s.stain) parts.push(s.stain);
  return parts.join(", ");
}

export function userName(id: string | null | undefined, users: { id: string; display_name: string }[]): string {
  if (!id) return "system";
  if (id.startsWith("system")) return id.replace("system:", "system ");
  return users.find((u) => u.id === id)?.display_name ?? id;
}

/**
 * Pipeline-test cohort records (project proj-synthetic-cohort) are generator specs only: never ingested,
 * no thumbnail, no image. The API says so explicitly with image_available=false; the UI never opens a viewer
 * for them. (The older inference from has_thumbnail and processing_version remains only as a fallback for
 * payloads without the flag.)
 */
export function isSpecOnlySlide(s: { image_kind: string; has_thumbnail?: boolean; ingest_status: string; processing_version?: string | null; image_available?: boolean }): boolean {
  if (s.image_available !== undefined) return s.ingest_status === "succeeded" && !s.image_available;
  if (s.image_kind !== "synthetic_tiles" || s.has_thumbnail) return false;
  if (s.processing_version !== undefined) return /not ingested/i.test(s.processing_version ?? "");
  return s.ingest_status === "succeeded";
}
