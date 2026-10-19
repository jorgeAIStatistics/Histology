/**
 * Read paths for the grossing slice (S4). Server-only: opens SQLite.
 * Pages call these directly; nothing here changes state.
 */
import type { DB } from "@/server/db/db";
import { demoNow } from "@/server/core/clock";
import { getSetting } from "@/server/core/settings";
import { activeHolds, blockedTransitions, holdsBlocking, scopesForBlock, scopesForPart, type HoldRow } from "@/server/domain/holds";
import { computeReadiness, STAGE_SHORT } from "@/server/domain/readiness";
import {
  approvalBlockers, currentRecordForPart, fixtureKeyForText, narrativeStaleFields, parseFields, parseJsonArray,
  type GrossFieldKey, type GrossRecordRow, type UnresolvedItem,
} from "@/server/domain/gross";
import { extractGrossFields, type ProposalRecord } from "@/server/assist/extractor";
import { TRANSCRIPTS, transcriptOptionsFor } from "@/server/seed/fixtures/transcripts";
import { decodeLabel, namespaceCode } from "@/lib/identifiers";
import { labDay } from "@/lib/time";
import type { FinalizeBlocker, GrossFields } from "@/lib/gross";
import type { GrossState, SourceUpdateState } from "@/lib/domain";

// ------------------------------------------------------------------ shared shapes

export interface PathologistRef {
  id: string;
  name: string;
  color: string | null;
}

export interface HoldSummary {
  id: string;
  displayId: string;
  scopeType: string;
  scopeLabel: string;
  reasonText: string;
  blocks: string[];
  blocksApproval: boolean;
  clarificationId: string | null;
  clarificationDisplayId: string | null;
  clarificationState: string | null;
  /** Lab owner of the linked clarification (who owns the next step), if any. */
  owner: string | null;
  nextFollowUpAt: string | null;
  placedAt: string;
  placedBy: string | null;
  version: number;
}

export type PartStateKey =
  | "awaiting"
  | "on_hold"
  | "draft"
  | "needs_clarification"
  | "operator_reviewed"
  | "approved_pending_entry"
  | "approved_entered"
  | "approved_acknowledged"
  | "canceled";

export const PART_STATE_LABEL: Record<PartStateKey, string> = {
  awaiting: "Awaiting grossing",
  on_hold: "On hold",
  draft: "Draft",
  needs_clarification: "Needs clarification",
  operator_reviewed: "Operator reviewed",
  approved_pending_entry: "Approved for downstream use",
  approved_entered: "Approved for downstream use",
  approved_acknowledged: "Approved for downstream use",
  canceled: "Canceled",
};

function holdSummaries(db: DB, holds: HoldRow[]): HoldSummary[] {
  return holds.map((h) => {
    const blocks = blockedTransitions(h);
    const clr = h.clarification_id
      ? (db
          .prepare("SELECT c.display_id, c.state, c.next_follow_up_at, s.display_name AS owner FROM clarification c LEFT JOIN staff s ON s.id = c.lab_owner_id WHERE c.id = ?")
          .get(h.clarification_id) as { display_id: string; state: string; next_follow_up_at: string | null; owner: string | null } | undefined)
      : undefined;
    const placedBy = db.prepare("SELECT display_name FROM staff WHERE id = ?").get(h.placed_by) as { display_name: string } | undefined;
    return {
      id: h.id, displayId: h.display_id, scopeType: h.scope_type, scopeLabel: h.scope_label, reasonText: h.reason_text, blocks,
      blocksApproval: blocks.includes("all") || blocks.includes("gross_approval"),
      clarificationId: h.clarification_id, clarificationDisplayId: clr?.display_id ?? null, clarificationState: clr?.state ?? null,
      owner: clr?.owner ?? null, nextFollowUpAt: clr?.next_follow_up_at ?? null,
      placedAt: h.placed_at, placedBy: placedBy?.display_name ?? h.placed_by, version: h.version,
    };
  });
}

function partState(rec: Pick<GrossRecordRow, "state" | "source_update_state"> | null, holds: HoldSummary[], partStatus: string): PartStateKey {
  if (partStatus === "canceled") return "canceled";
  const approvalHeld = holds.some((h) => h.blocksApproval);
  if (rec?.state === "approved_for_downstream") {
    return rec.source_update_state === "source_acknowledged" ? "approved_acknowledged" : rec.source_update_state === "entered_attested" ? "approved_entered" : "approved_pending_entry";
  }
  if (approvalHeld) return "on_hold";
  if (!rec) return "awaiting";
  if (rec.state === "needs_clarification") return "needs_clarification";
  if (rec.state === "operator_reviewed") return "operator_reviewed";
  return "draft";
}

export function partRef(accessionNumber: string, designation: string): string {
  return `${accessionNumber}-${designation}`;
}

// ------------------------------------------------------------------ queue

export interface QueueRow {
  partId: string;
  ref: string;
  accessionId: string;
  accessionNumber: string;
  designation: string;
  site: string;
  procedure: string | null;
  priority: string;
  issuedAt: string;
  pathologist: PathologistRef | null;
  officeName: string | null;
  state: PartStateKey;
  record: {
    id: string; recordVersion: number; state: GrossState; sourceUpdateState: SourceUpdateState; updatedAt: string; approvedAt: string | null; blockerCount: number;
    /** Derived, read-only: who started the record (display name). */
    grosser: string | null;
  } | null;
  holds: HoldSummary[];
  otherParts: { designation: string; state: PartStateKey }[];
  /** Derived, read-only: owner of the open source-entry task for this part, if any. */
  sourceEntryOwner: string | null;
}

const QUEUE_ORDER: PartStateKey[] = [
  "needs_clarification", "on_hold", "draft", "operator_reviewed", "awaiting", "approved_pending_entry", "approved_entered", "approved_acknowledged", "canceled",
];

/**
 * Parts on the grossing bench (today's accessions; prior-day cases are not grossed here):
 * exceptions first (needs clarification, held parts with their reason), then drafts, reviewed records, parts awaiting grossing, then
 * parts approved today or still waiting for source-system entry.
 */
export function grossingQueue(db: DB): QueueRow[] {
  const parts = db
    .prepare(
      `SELECT sp.id, sp.designation, sp.site_text, sp.procedure, sp.status, sp.accession_id, a.accession_number, a.priority, a.issued_at,
              a.assigned_pathologist_id, p.display_name AS path_name, p.color_token, o.name AS office_name
         FROM specimen_part sp
         JOIN accession a ON a.id = sp.accession_id
         LEFT JOIN staff p ON p.id = a.assigned_pathologist_id
         LEFT JOIN office o ON o.id = a.office_id
        WHERE a.is_prior_day = 0 AND a.case_status <> 'canceled'
        ORDER BY a.accession_number, sp.designation`,
    )
    .all() as {
    id: string; designation: string; site_text: string; procedure: string | null; status: string; accession_id: string; accession_number: string;
    priority: string; issued_at: string; assigned_pathologist_id: string | null; path_name: string | null; color_token: string | null; office_name: string | null;
  }[];
  const rows: QueueRow[] = parts.map((p) => {
    const rec = currentRecordForPart(db, p.id);
    const holds = holdSummaries(db, activeHolds(db, scopesForPart(db, p.id)));
    let blockerCount = 0;
    if (rec) blockerCount = approvalBlockers(parseFields(rec.fields, p.procedure), rec.narrative, p, narrativeStaleFields(db, rec)).length;
    return {
      partId: p.id, ref: partRef(p.accession_number, p.designation), accessionId: p.accession_id, accessionNumber: p.accession_number,
      designation: p.designation, site: p.site_text, procedure: p.procedure, priority: p.priority, issuedAt: p.issued_at,
      pathologist: p.assigned_pathologist_id ? { id: p.assigned_pathologist_id, name: p.path_name ?? p.assigned_pathologist_id, color: p.color_token } : null,
      officeName: p.office_name, state: partState(rec, holds, p.status),
      record: rec
        ? {
            id: rec.id, recordVersion: rec.record_version, state: rec.state, sourceUpdateState: rec.source_update_state, updatedAt: rec.updated_at, approvedAt: rec.approved_at, blockerCount,
            grosser: name(db, rec.grosser_id),
          }
        : null,
      holds, otherParts: [],
      sourceEntryOwner: rec?.state === "approved_for_downstream" ? sourceEntryOwnerOf(db, p.id) : null,
    };
  });
  const byAcc = new Map<string, QueueRow[]>();
  for (const r of rows) byAcc.set(r.accessionId, [...(byAcc.get(r.accessionId) ?? []), r]);
  for (const r of rows) r.otherParts = (byAcc.get(r.accessionId) ?? []).filter((x) => x.partId !== r.partId).map((x) => ({ designation: x.designation, state: x.state }));
  // Approved parts stay in the bench queue only if approved today or still waiting for source entry.
  const today = labDay(demoNow(db));
  return rows
    .filter((r) => r.state !== "canceled")
    .filter((r) => !r.state.startsWith("approved") || r.state === "approved_pending_entry" || (r.record?.approvedAt ? labDay(r.record.approvedAt) === today : false))
    .sort((a, b) => QUEUE_ORDER.indexOf(a.state) - QUEUE_ORDER.indexOf(b.state) || (a.priority === "rush" ? -1 : 0) - (b.priority === "rush" ? -1 : 0) || a.ref.localeCompare(b.ref));
}

/** Display name of the owner of the open source-entry task for a part (read-only). */
function sourceEntryOwnerOf(db: DB, partId: string): string | null {
  const r = db
    .prepare(
      `SELECT s.display_name AS owner FROM task tk LEFT JOIN staff s ON s.id = tk.owner_id
        WHERE tk.kind = 'source_entry' AND tk.entity_id = ? AND tk.status IN ('open','in_progress') LIMIT 1`,
    )
    .get(partId) as { owner: string | null } | undefined;
  return r?.owner ?? null;
}

// ------------------------------------------------------------------ source entry queue (Sam)

export interface SourceEntryRow {
  recordId: string;
  version: number;
  recordVersion: number;
  partId: string;
  ref: string;
  accessionNumber: string;
  designation: string;
  site: string;
  sourceUpdateState: SourceUpdateState;
  approvedAt: string | null;
  approvedBy: string | null;
  enteredAt: string | null;
  enteredBy: string | null;
  tenantName: string | null;
  /** The (simulated) source system this description is entered into, and whether it is reachable. */
  sourceName: string | null;
  sourceStatus: string | null;
  sourceLastSuccessAt: string | null;
  taskOwner: string | null;
  narrative: string;
  pathologist: PathologistRef | null;
}

/** Approved gross records whose source-system entry is pending or attested but not acknowledged (oldest first). */
export function sourceEntryQueue(db: DB): SourceEntryRow[] {
  const rows = db
    .prepare(
      `SELECT gr.id, gr.version, gr.record_version, gr.specimen_part_id, gr.source_update_state, gr.approved_at, gr.source_entry_at, gr.narrative,
              ap.display_name AS approved_by, en.display_name AS entered_by,
              sp.designation, sp.site_text, a.accession_number, t.name AS tenant_name,
              (SELECT isrc.name FROM integration_source isrc WHERE isrc.tenant_id = pr.tenant_id ORDER BY isrc.id LIMIT 1) AS source_name,
              (SELECT isrc.status FROM integration_source isrc WHERE isrc.tenant_id = pr.tenant_id ORDER BY isrc.id LIMIT 1) AS source_status,
              (SELECT isrc.last_success_at FROM integration_source isrc WHERE isrc.tenant_id = pr.tenant_id ORDER BY isrc.id LIMIT 1) AS source_last_success_at,
              a.assigned_pathologist_id, p.display_name AS path_name, p.color_token,
              (SELECT s.display_name FROM task tk LEFT JOIN staff s ON s.id = tk.owner_id
                WHERE tk.kind = 'source_entry' AND tk.entity_id = sp.id AND tk.status IN ('open','in_progress') LIMIT 1) AS task_owner
         FROM gross_record gr
         JOIN specimen_part sp ON sp.id = gr.specimen_part_id
         JOIN accession a ON a.id = sp.accession_id
         LEFT JOIN patient_ref pr ON pr.id = a.patient_ref_id
         LEFT JOIN source_tenant t ON t.id = pr.tenant_id
         LEFT JOIN staff ap ON ap.id = gr.approved_by
         LEFT JOIN staff en ON en.id = gr.source_entry_by
         LEFT JOIN staff p ON p.id = a.assigned_pathologist_id
        WHERE gr.state = 'approved_for_downstream' AND gr.source_update_state IN ('pending_entry', 'failed', 'entered_attested')
        ORDER BY CASE gr.source_update_state WHEN 'failed' THEN 0 WHEN 'pending_entry' THEN 1 ELSE 2 END, gr.approved_at`,
    )
    .all() as {
    id: string; version: number; record_version: number; specimen_part_id: string; source_update_state: SourceUpdateState; approved_at: string | null;
    source_entry_at: string | null; narrative: string; approved_by: string | null; entered_by: string | null; designation: string; site_text: string;
    accession_number: string; tenant_name: string | null; source_name: string | null; source_status: string | null; source_last_success_at: string | null; assigned_pathologist_id: string | null; path_name: string | null; color_token: string | null; task_owner: string | null;
  }[];
  return rows.map((r) => ({
    recordId: r.id, version: r.version, recordVersion: r.record_version, partId: r.specimen_part_id, ref: partRef(r.accession_number, r.designation),
    accessionNumber: r.accession_number, designation: r.designation, site: r.site_text, sourceUpdateState: r.source_update_state,
    approvedAt: r.approved_at, approvedBy: r.approved_by, enteredAt: r.source_entry_at, enteredBy: r.entered_by, tenantName: r.tenant_name,
    sourceName: r.source_name, sourceStatus: r.source_status, sourceLastSuccessAt: r.source_last_success_at,
    taskOwner: r.task_owner, narrative: r.narrative,
    pathologist: r.assigned_pathologist_id ? { id: r.assigned_pathologist_id, name: r.path_name ?? "", color: r.color_token } : null,
  }));
}

// ------------------------------------------------------------------ resolving a scan / URL to a part

export type PartResolution =
  | { ok: true; partId: string; ref: string; via: "part" | "case" | "block_label" }
  | { ok: false; reason: string; input: string };

/**
 * Resolve "D26-04817-A", "D26-04817 A", a block/slide label payload (HL1:B:...),
 * or a bare accession number (first part that still needs grossing work).
 * A scan only identifies a record; it says nothing about the tissue.
 */
export function resolvePartRef(db: DB, raw: string): PartResolution {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "Nothing to look up", input };
  let accession: string | null = null;
  let designation: string | null = null;
  let nsCode: string | null = null;
  let via: "part" | "case" | "block_label" = "part";
  if (/^HL1:/i.test(input)) {
    const d = decodeLabel(input);
    if (!d.ok) return { ok: false, reason: `Not recognized: ${d.reason}`, input };
    accession = d.identity.accession;
    designation = d.identity.part ?? null;
    nsCode = d.identity.namespace ?? null;
    via = d.identity.part ? "block_label" : "case";
  } else {
    const m = /^(D\d{2}-\d{5})(?:[\s\-_]*([A-Za-z]))?$/i.exec(input);
    if (!m) return { ok: false, reason: `Not recognized: "${input}". Type an accession and part, for example D26-04817 A.`, input };
    accession = m[1].toUpperCase();
    designation = m[2] ? m[2].toUpperCase() : null;
    via = designation ? "part" : "case";
  }
  // Accession numbers are unique per namespace (UNIQUE(namespace, accession_number)): a label carries its namespace and
  // must match it; a typed number that exists in more than one namespace is ambiguous and is not guessed.
  const candidates = (db.prepare("SELECT id, accession_number, namespace FROM accession WHERE accession_number = ?").all(accession) as {
    id: string; accession_number: string; namespace: string;
  }[]).filter((a) => !nsCode || namespaceCode(a.namespace) === nsCode);
  if (!candidates.length) return { ok: false, reason: nsCode ? `No case ${accession} in namespace ${nsCode} in this demo` : `No case ${accession} in this demo`, input };
  if (candidates.length > 1) {
    return { ok: false, reason: `${accession} exists in more than one namespace (${candidates.map((c) => namespaceCode(c.namespace)).join(", ")}). Scan the label so the namespace is known.`, input };
  }
  const acc = candidates[0];
  if (designation) {
    const p = db.prepare("SELECT id FROM specimen_part WHERE accession_id = ? AND designation = ?").get(acc.id, designation) as { id: string } | undefined;
    if (!p) return { ok: false, reason: `${accession} has no part ${designation}`, input };
    return { ok: true, partId: p.id, ref: partRef(acc.accession_number, designation), via };
  }
  const parts = db.prepare("SELECT id, designation, procedure, status FROM specimen_part WHERE accession_id = ? ORDER BY designation").all(acc.id) as {
    id: string; designation: string; procedure: string | null; status: string;
  }[];
  if (!parts.length) return { ok: false, reason: `${accession} has no parts`, input };
  const needsWork = parts.find((p) => {
    if (p.status !== "active") return false;
    const rec = currentRecordForPart(db, p.id);
    return !rec || rec.state !== "approved_for_downstream";
  });
  const chosen = needsWork ?? parts[0];
  return { ok: true, partId: chosen.id, ref: partRef(acc.accession_number, chosen.designation), via: "case" };
}

// ------------------------------------------------------------------ part workspace

export interface WorkspaceTask {
  id: string;
  kind: string;
  title: string;
  owner: string | null;
  ownerRole: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  detail: string | null;
}

export interface PartWorkspace {
  now: string;
  assistantMode: "deterministic" | "unavailable";
  identity: {
    partId: string;
    ref: string;
    accessionId: string;
    accessionNumber: string;
    namespace: string;
    designation: string;
    originalDesignation: string;
    site: string;
    laterality: string | null;
    procedure: string | null;
    sourceOrderRef: string | null;
    patientName: string | null;
    mrn: string | null;
    tenantName: string | null;
    officeName: string | null;
    orderingClinician: string | null;
    pathologist: PathologistRef | null;
    physicalState: string;
    partStatus: string;
    caseStatus: string;
  };
  parts: { partId: string; ref: string; designation: string; site: string; procedure: string | null; state: PartStateKey; holdIds: string[] }[];
  state: PartStateKey;
  record: null | {
    id: string;
    version: number;
    recordVersion: number;
    state: GrossState;
    sourceUpdateState: SourceUpdateState;
    narrative: string;
    fields: GrossFields;
    extractor: string | null;
    proposals: ProposalRecord[];
    unresolved: UnresolvedItem[];
    grosser: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    sourceEntryBy: string | null;
    sourceEntryAt: string | null;
    sourceAckAt: string | null;
    createdAt: string;
    updatedAt: string;
    /** Fields confirmed after the narrative was last saved or checked (the narrative needs a check). */
    narrativeStale: GrossFieldKey[];
  };
  transcript: null | {
    id: string;
    text: string;
    fixtureKey: string | null;
    title: string | null;
    capturedBy: string | null;
    capturedAt: string;
    source: string;
    /** Instruction-like sentences that were treated as data and ignored (display only). */
    ignored: { text: string; start: number; end: number }[];
  };
  /** The (simulated) source system this part's description must be entered into. */
  sourceSystem: { name: string; status: string; lastSuccessAt: string | null } | null;
  blockers: FinalizeBlocker[];
  holds: HoldSummary[];
  versions: { id: string; recordVersion: number; state: GrossState; sourceUpdateState: SourceUpdateState; createdAt: string; approvedAt: string | null; approvedBy: string | null }[];
  tasks: WorkspaceTask[];
  /** eligibleForProcessing is derived (approved current record + loaded + no processing hold), like readiness; hasEligibilityTask says whether the to-do exists. */
  blocks: { id: string; label: string; identifier: string; state: string; piecesSubmitted: number | null; eligibleForProcessing: boolean; heldBy: string[]; hasEligibilityTask: boolean }[];
  readiness: { eligible: string[]; blockedBy: string[]; caseComplete: boolean; caseSummary: string } | null;
  transcriptOptions: { key: string; title: string; purpose: string }[];
  history: { seq: number; at: string; actor: string | null; origin: string; action: string; summary: string }[];
}

function name(db: DB, id: string | null | undefined): string | null {
  if (!id) return null;
  const r = db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined;
  return r?.display_name ?? id;
}

/**
 * Dictations offered in the picker. A fixture written for one specific part (the hero case's "quinlan-A"/"quinlan-B")
 * is offered only when its text names this part's site (laterality ignored, since the hero's Part B laterality is
 * the point of its clarification); other parts get the generic fixtures, matching procedure first.
 */
function transcriptPicker(procedure: string | null, designation: string, site: string | null): { key: string; title: string; purpose: string }[] {
  const place = (site ?? "").toLowerCase().replace(/\b(left|right|bilateral)\b/g, "").replace(/\s+/g, " ").trim();
  return transcriptOptionsFor(procedure, designation)
    .filter((t) => t.forPart === null || (place.length > 0 && t.text.toLowerCase().includes(place)))
    .map((t) => ({ key: t.key, title: t.title, purpose: t.purpose }));
}

export function partWorkspace(db: DB, partId: string): PartWorkspace | null {
  const p = db
    .prepare(
      `SELECT sp.*, a.accession_number, a.namespace, a.case_status, a.assigned_pathologist_id, a.ordering_clinician_id,
              so.source_order_id AS src_order, pr.tenant_id, pr.family_name, pr.given_name, pr.source_mrn, t.name AS tenant_name, o.name AS office_name,
              c.display_name AS clinician_name, c.credential, ps.display_name AS path_name, ps.color_token
         FROM specimen_part sp
         JOIN accession a ON a.id = sp.accession_id
         LEFT JOIN source_order so ON so.id = sp.source_order_id
         LEFT JOIN patient_ref pr ON pr.id = a.patient_ref_id
         LEFT JOIN source_tenant t ON t.id = pr.tenant_id
         LEFT JOIN office o ON o.id = a.office_id
         LEFT JOIN clinician c ON c.id = so.ordering_clinician_id
         LEFT JOIN staff ps ON ps.id = a.assigned_pathologist_id
        WHERE sp.id = ?`,
    )
    .get(partId) as
    | {
        id: string; accession_id: string; designation: string; original_designation: string; site_text: string; laterality: string | null; procedure: string | null;
        status: string; physical_state: string; accession_number: string; namespace: string; case_status: string; assigned_pathologist_id: string | null;
        src_order: string | null; tenant_id: string | null; family_name: string | null; given_name: string | null; source_mrn: string | null; tenant_name: string | null; office_name: string | null;
        clinician_name: string | null; credential: string | null; path_name: string | null; color_token: string | null;
      }
    | undefined;
  if (!p) return null;
  const now = demoNow(db);
  const rec = currentRecordForPart(db, partId);
  const holds = holdSummaries(db, activeHolds(db, scopesForPart(db, partId)));
  const state = partState(rec, holds, p.status);

  const siblings = db.prepare("SELECT id, designation, site_text, procedure, status FROM specimen_part WHERE accession_id = ? ORDER BY designation").all(p.accession_id) as {
    id: string; designation: string; site_text: string; procedure: string | null; status: string;
  }[];
  const parts = siblings.map((s) => {
    const sr = s.id === partId ? rec : currentRecordForPart(db, s.id);
    const sh = s.id === partId ? holds : holdSummaries(db, activeHolds(db, scopesForPart(db, s.id)));
    return { partId: s.id, ref: partRef(p.accession_number, s.designation), designation: s.designation, site: s.site_text, procedure: s.procedure, state: partState(sr, sh, s.status), holdIds: sh.map((h) => h.displayId) };
  });

  let record: PartWorkspace["record"] = null;
  let blockers: FinalizeBlocker[] = [];
  let narrativeStale: GrossFieldKey[] = [];
  let transcript: PartWorkspace["transcript"] = null;
  if (rec) {
    const fields = parseFields(rec.fields, p.procedure);
    narrativeStale = narrativeStaleFields(db, rec);
    blockers = approvalBlockers(fields, rec.narrative, p, narrativeStale);
    record = {
      id: rec.id, version: rec.version, recordVersion: rec.record_version, state: rec.state, sourceUpdateState: rec.source_update_state,
      narrative: rec.narrative, fields, extractor: rec.extractor, proposals: parseJsonArray<ProposalRecord>(rec.proposals),
      unresolved: parseJsonArray<UnresolvedItem>(rec.unresolved), grosser: name(db, rec.grosser_id), reviewedBy: name(db, rec.reviewed_by),
      reviewedAt: rec.reviewed_at, approvedBy: name(db, rec.approved_by), approvedAt: rec.approved_at, sourceEntryBy: name(db, rec.source_entry_by),
      sourceEntryAt: rec.source_entry_at, sourceAckAt: rec.source_ack_at, createdAt: rec.created_at, updatedAt: rec.updated_at, narrativeStale,
    };
    if (rec.transcript_id) {
      const t = db.prepare("SELECT * FROM gross_transcript WHERE id = ?").get(rec.transcript_id) as
        | { id: string; text: string; source: string; captured_by: string | null; captured_at: string }
        | undefined;
      if (t) {
        const key = fixtureKeyForText(t.text, p.designation);
        const ignored = extractGrossFields(t.text, { partDesignation: p.designation }).ignoredInstructions.map((i) => ({ text: i.text, start: i.start, end: i.end }));
        transcript = {
          id: t.id, text: t.text, fixtureKey: key, title: key ? TRANSCRIPTS[key]?.title ?? null : null, capturedBy: name(db, t.captured_by),
          capturedAt: t.captured_at, source: t.source, ignored,
        };
      }
    }
  }

  const versions = (db.prepare("SELECT * FROM gross_record WHERE specimen_part_id = ? ORDER BY record_version DESC").all(partId) as GrossRecordRow[]).map((v) => ({
    id: v.id, recordVersion: v.record_version, state: v.state, sourceUpdateState: v.source_update_state, createdAt: v.created_at, approvedAt: v.approved_at, approvedBy: name(db, v.approved_by),
  }));

  const blockRows = db.prepare("SELECT id, label_text, identifier, physical_state, pieces_submitted FROM block WHERE part_id = ? AND status = 'active' ORDER BY block_seq").all(partId) as {
    id: string; label_text: string; identifier: string; physical_state: string; pieces_submitted: number | null;
  }[];
  const blockIds = blockRows.map((b) => b.id);
  const ph = blockIds.map(() => "?").join(",");
  const taskRows = db
    .prepare(
      `SELECT tk.*, s.display_name AS owner_name FROM task tk LEFT JOIN staff s ON s.id = tk.owner_id
        WHERE (tk.entity_type = 'specimen_part' AND tk.entity_id = ?)
           ${blockIds.length ? `OR (tk.entity_type = 'block' AND tk.entity_id IN (${ph}))` : ""}
        ORDER BY CASE WHEN tk.status IN ('open','in_progress') THEN 0 ELSE 1 END, tk.created_at DESC`,
    )
    .all(partId, ...blockIds) as {
    id: string; kind: string; title: string; owner_name: string | null; owner_role: string | null; status: string; created_at: string; completed_at: string | null; detail: string | null; entity_id: string;
  }[];
  const tasks: WorkspaceTask[] = taskRows.map((t) => ({
    id: t.id, kind: t.kind, title: t.title, owner: t.owner_name, ownerRole: t.owner_role, status: t.status, createdAt: t.created_at, completedAt: t.completed_at, detail: t.detail,
  }));
  const taskBlocks = new Set(taskRows.filter((t) => t.kind === "processing_eligible" && (t.status === "open" || t.status === "in_progress")).map((t) => t.entity_id));
  const approvedNow = rec?.state === "approved_for_downstream" && p.status === "active" && p.case_status !== "canceled";
  const blocks = blockRows.map((b) => {
    const heldBy = holdsBlocking(db, "processing", scopesForBlock(db, b.id)).map((h) => h.display_id);
    return {
      id: b.id, label: b.label_text, identifier: b.identifier, state: b.physical_state, piecesSubmitted: b.pieces_submitted,
      eligibleForProcessing: approvedNow && b.physical_state === "cassette_loaded" && heldBy.length === 0, heldBy, hasEligibilityTask: taskBlocks.has(b.id),
    };
  });

  let readiness: PartWorkspace["readiness"] = null;
  const r = computeReadiness(db, [p.accession_id]).get(p.accession_id);
  if (r) {
    const pr = r.parts.find((x) => x.partId === partId);
    // Worded locally: the shared stage "Processing" is also used for a loaded cassette that is only eligible for the
    // next processing run, which would overstate physical progress right after approval.
    const caseSummary = r.parts
      .map((x) => {
        const what =
          x.status === "canceled"
            ? "canceled"
            : x.holds.length
              ? `on hold (${[...new Set(x.holds.map((h) => h.displayId))].join(", ")})`
              : x.stage === "processing" && x.blocks.length > 0 && x.blocks.every((b) => b.state === "cassette_loaded")
                ? "approved, ready for processing"
                : x.stage === "gross_in_progress"
                  ? x.grossState === "not_started" ? "grossed, no gross record" : `gross record ${x.grossState.replace(/_/g, " ")}`
                  : STAGE_SHORT[x.stage].toLowerCase();
        return `Part ${x.designation}: ${what}`;
      })
      .join(" · ");
    readiness = { eligible: pr?.eligible ?? [], blockedBy: pr?.blockedBy ?? [], caseComplete: r.isComplete, caseSummary };
  }

  const recordIds = versions.map((v) => v.id);
  const entityIds = [...recordIds, ...blockIds];
  const history = entityIds.length
    ? (db
        .prepare(
          `SELECT e.seq, e.at, e.origin, e.action, e.summary, s.display_name AS actor FROM audit_event e LEFT JOIN staff s ON s.id = e.actor_id
            WHERE e.entity_id IN (${entityIds.map(() => "?").join(",")}) ORDER BY e.seq DESC LIMIT 60`,
        )
        .all(...entityIds) as { seq: number; at: string; origin: string; action: string; summary: string; actor: string | null }[])
    : [];

  const src = p.tenant_id
    ? (db.prepare("SELECT name, status, last_success_at FROM integration_source WHERE tenant_id = ? ORDER BY id LIMIT 1").get(p.tenant_id) as
        | { name: string; status: string; last_success_at: string | null }
        | undefined)
    : undefined;
  const sourceSystem = src ? { name: src.name, status: src.status, lastSuccessAt: src.last_success_at } : null;

  return {
    now,
    sourceSystem,
    assistantMode: getSetting(db, "assistant_mode") === "unavailable" ? "unavailable" : "deterministic",
    identity: {
      partId, ref: partRef(p.accession_number, p.designation), accessionId: p.accession_id, accessionNumber: p.accession_number, namespace: p.namespace,
      designation: p.designation, originalDesignation: p.original_designation, site: p.site_text, laterality: p.laterality, procedure: p.procedure,
      sourceOrderRef: p.src_order, patientName: p.family_name ? `${p.family_name}, ${p.given_name ?? ""}`.trim() : null, mrn: p.source_mrn,
      tenantName: p.tenant_name, officeName: p.office_name, orderingClinician: p.clinician_name ? `${p.clinician_name}${p.credential && !p.clinician_name.startsWith("Dr.") ? `, ${p.credential}` : ""}` : null,
      pathologist: p.assigned_pathologist_id ? { id: p.assigned_pathologist_id, name: p.path_name ?? p.assigned_pathologist_id, color: p.color_token } : null,
      physicalState: p.physical_state, partStatus: p.status, caseStatus: p.case_status,
    },
    parts, state, record, transcript, blockers, holds, versions, tasks, blocks, readiness,
    transcriptOptions: transcriptPicker(p.procedure, p.designation, p.site_text),
    history,
  };
}
