/**
 * Shared vocabulary: states and their plain-language labels. Server and client
 * both import from here so a state is spelled the same everywhere.
 */

export const INTAKE_STATUS = {
  received: "Received",
  in_review: "In review",
  ready_for_accession: "Ready to request accession",
  accession_requested: "Accession requested",
  accessioned: "Accessioned",
  canceled: "Canceled",
} as const;
export type IntakeStatus = keyof typeof INTAKE_STATUS;

export const CONTAINER_VERIFICATION = {
  unverified: "Not yet verified",
  verified: "Staff verified against physical container",
  discrepancy: "Discrepancy recorded",
} as const;

export const RELATED_STATUS = {
  pending_review: "Needs review",
  single_accession_approved: "Approved: one accession, parts kept with original orders",
  keep_separate: "Kept as separate cases (cross-referenced)",
  not_related: "Not related",
  escalated_to_office: "Asked the office",
} as const;
export type RelatedStatus = keyof typeof RELATED_STATUS;

export const ROUTING_STATUS = {
  suggested: "Suggested by rule",
  confirmed: "Confirmed",
  overridden: "Overridden (reason recorded)",
  exception: "Routing exception — no approved rule",
  superseded: "Superseded",
} as const;
export type RoutingStatus = keyof typeof ROUTING_STATUS;

export const CLARIFICATION_CATEGORY = {
  site: "Exact site",
  laterality: "Laterality",
  orientation_marking: "Orientation / marking",
  biopsy_method: "Biopsy method (shave vs punch)",
  identity_conflict: "Identity conflict",
  missing_container: "Missing container",
  related_orders: "Possible related orders",
  other: "Other",
} as const;
export type ClarificationCategory = keyof typeof CLARIFICATION_CATEGORY;

export const CLARIFICATION_STATE = {
  drafted: "Drafted",
  sent: "Sent (simulated)",
  delivery_unknown: "Delivery unknown",
  delivery_failed: "Delivery failed",
  delivered: "Delivered",
  acknowledged: "Acknowledged by office",
  answered: "Answered — awaiting lab review",
  reviewed: "Answer reviewed",
  resolved: "Resolved",
  canceled: "Canceled",
} as const;
export type ClarificationState = keyof typeof CLARIFICATION_STATE;
export const OPEN_CLARIFICATION_STATES: ClarificationState[] = [
  "drafted", "sent", "delivery_unknown", "delivery_failed", "delivered", "acknowledged", "answered", "reviewed",
];

export const HOLD_STATUS = { active: "Active hold", released: "Released" } as const;

export const GROSS_STATE = {
  draft: "Draft",
  needs_clarification: "Needs clarification",
  operator_reviewed: "Operator reviewed",
  approved_for_downstream: "Approved for downstream use",
  superseded: "Superseded",
} as const;
export type GrossState = keyof typeof GROSS_STATE;

export const SOURCE_UPDATE_STATE = {
  not_started: "Not entered in source system",
  pending_entry: "Source-system entry pending",
  entered_attested: "Entered in source system (staff attested)",
  source_acknowledged: "Source system acknowledged (simulated)",
  failed: "Source update failed",
} as const;
export type SourceUpdateState = keyof typeof SOURCE_UPDATE_STATE;

/**
 * The ONE definition of the source-entry backlog: an approved (current) gross record on an active part whose
 * description has not been entered in the source system yet. A failed entry is still awaiting entry. Screens may
 * show a subset (the worklist's queue, Sam's entry queue) but each says which states it shows.
 */
export const AWAITING_SOURCE_ENTRY: readonly SourceUpdateState[] = ["not_started", "pending_entry", "failed"];
/** Entered by staff (attested) but not yet acknowledged by the (simulated) source. */
export const AWAITING_SOURCE_ACK: readonly SourceUpdateState[] = ["entered_attested"];

export function awaitsSourceEntry(r: { grossState: string; sourceUpdateState: string; partStatus?: string | null }): boolean {
  return (
    r.grossState === "approved_for_downstream" &&
    (r.partStatus ?? "active") !== "canceled" &&
    (AWAITING_SOURCE_ENTRY as readonly string[]).includes(r.sourceUpdateState)
  );
}

/** SQL twin of awaitsSourceEntry() for a gross_record alias `gr` joined to specimen_part `sp`. */
export const AWAITING_SOURCE_ENTRY_SQL = `gr.state = 'approved_for_downstream' AND sp.status <> 'canceled' AND gr.source_update_state IN (${AWAITING_SOURCE_ENTRY.map((s) => `'${s}'`).join(",")})`;

export const BLOCK_STATE = {
  cassette_loaded: "Cassette loaded (grossed)",
  processing: "Processing",
  processed: "Processed",
  embedded: "Embedded",
  sectioned: "Sectioned",
  stored: "Stored",
} as const;
export type BlockState = keyof typeof BLOCK_STATE;
export const BLOCK_STATE_ORDER: BlockState[] = ["cassette_loaded", "processing", "processed", "embedded", "sectioned", "stored"];

export const SLIDE_STATE = {
  planned: "Planned",
  sectioned: "Sectioned",
  stained: "Stained",
  coverslipped: "Coverslipped",
  qc_reviewed: "QC reviewed",
  // Tray delivery is recorded digitally; no receipt by the pathologist is recorded (stored state stays "delivered").
  delivered: "Sent on tray (receipt not recorded)",
} as const;
export type SlideState = keyof typeof SLIDE_STATE;
export const SLIDE_STATE_ORDER: SlideState[] = ["planned", "sectioned", "stained", "coverslipped", "qc_reviewed", "delivered"];

export const LABEL_STATE = {
  none: "No label yet",
  printed: "Label printed",
  applied: "Label applied",
  verified: "Label verified",
  retired: "Label retired",
} as const;

export const WORK_ORDER_STATUS = {
  requested: "Requested",
  in_progress: "In progress",
  completed: "Completed",
  cancel_review: "Canceled at source — review prepared material",
  canceled: "Canceled",
  amended_review: "Amended at source — review",
} as const;
export type WorkOrderStatus = keyof typeof WORK_ORDER_STATUS;

export const AUTHORIZATION_SOURCE = {
  source_order: "Source order",
  standing_protocol: "Standing protocol (synthetic)",
  pathologist_request: "Pathologist request",
  staff_entered_request: "Entered by staff on request (reference recorded)",
} as const;

export const PRINT_STATE = {
  planned: "Planned",
  queued: "Queued",
  submitted: "Submitted to printer",
  acknowledged: "Printer acknowledged",
  completion_confirmed: "Completion confirmed",
  failed: "Failed",
  unknown_outcome: "Unknown outcome — reconcile before retry",
  canceled: "Canceled",
} as const;
export type PrintState = keyof typeof PRINT_STATE;

export const TRAY_STATUS = {
  open: "Open",
  assembling: "Assembling",
  exception: "Exception — cannot verify",
  verified_complete: "Verified complete",
  released_with_exceptions: "Released with documented exceptions",
  // The tray left the lab; no pathologist receipt is recorded (same wording as the slide stage "Sent on tray").
  delivered: "Sent (receipt not recorded)",
} as const;
export type TrayStatus = keyof typeof TRAY_STATUS;

export const RETRIEVAL_STATUS = {
  open: "Open",
  picking: "Picking",
  partially_retrieved: "Partially retrieved",
  retrieved: "Retrieved",
  delivered: "Delivered",
  canceled: "Canceled",
} as const;

export const CUSTODY_STATE = {
  in_workflow: "In histology workflow",
  stored: "In storage (last confirmed)",
  checked_out: "Checked out",
  sent_out: "Sent outside the lab",
  missing_investigation: "Missing — investigation open",
} as const;

export const SOURCE_STATUS = {
  connected: "Connected (simulated)",
  degraded: "Degraded (simulated)",
  offline: "Unavailable (simulated outage)",
} as const;

export const PATHOLOGIST_COLORS = ["teal", "violet", "amber"] as const;
export type PathologistColor = (typeof PATHOLOGIST_COLORS)[number];

export const LATERALITY = {
  left: "Left",
  right: "Right",
  midline: "Midline",
  bilateral: "Bilateral",
  not_stated: "Not stated",
} as const;

export const PROCEDURE = {
  shave: "Shave",
  punch: "Punch",
  excision: "Excision",
  curettage: "Curettage",
  nail_clipping: "Nail clipping",
  other: "Other",
  not_stated: "Not stated",
} as const;

/** Stage shown on the worklist (derived; see server/domain/readiness.ts), in bench-path order. */
export const STAGE = {
  intake: "Intake",
  awaiting_gross: "Awaiting grossing",
  gross_in_progress: "Grossing documentation",
  /** Cassettes loaded, gross record approved: eligible for the next processing run, not yet on the processor. */
  awaiting_processing: "Ready for processing",
  processing: "Processing",
  embedding: "Embedding",
  sectioning: "Sectioning",
  staining: "Staining",
  qc: "QC",
  ready_for_tray: "Ready for tray",
  /** Every active slide recorded as delivered on a tray. No pathologist receipt is recorded. */
  delivered: "Sent on tray",
  canceled: "Canceled",
} as const;
export type Stage = keyof typeof STAGE;
