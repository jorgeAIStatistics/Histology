/**
 * Grossing documentation domain (slice S4).
 *
 * One gross_record row per version of a part's gross documentation:
 *   draft ⇄ needs_clarification (resolved back to draft with a note), draft → operator_reviewed → approved_for_downstream → superseded (by an amendment)
 * and, separately, the source-system update state of an approved version:
 *   not_started → pending_entry → entered_attested (staff attestation) → source_acknowledged (SIMULATED)
 *
 * Rules enforced here (server-side, authoritative):
 * - proposals from the deterministic demo extractor are never confirmed automatically;
 * - numbers, units and counts need an explicit operator confirmation; a needs-review value kept as dictated needs an
 *   explicit "I checked the specimen" acknowledgment (choosing a unit does not resolve a possible missed decimal);
 * - every change requires the part and case to still be active (a canceled part cannot be drafted, approved or amended);
 * - approval requires grossFinalizeBlockers() to be empty AND no hold blocking gross_approval;
 * - approved content is frozen (also enforced by the DB trigger gross_record_approved_frozen);
 *   corrections create a new version and supersede the old one;
 * - approving a part never moves the source update beyond pending_entry, and never makes the case complete.
 */
import { z } from "zod";
import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { requirePermission } from "../core/context";
import { DomainError } from "../core/errors";
import { newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { openTask, closeTasks } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { getSetting } from "../core/settings";
import { assertNotHeld, holdsBlocking, scopesForBlock, scopesForPart, onHoldReleased } from "./holds";
import {
  emptyGrossFields, grossFinalizeBlockers, GROSS_FIELD_LABEL, GROSS_TEMPLATES,
  type CassetteAllocation, type Dimensions, type FinalizeBlocker, type GrossFields,
} from "@/lib/gross";
import { encodeLabel, namespaceCode } from "@/lib/identifiers";
import { fmtTime } from "@/lib/time";
import type { GrossState, SourceUpdateState } from "@/lib/domain";
import { EXTRACTOR_NAME, extractGrossFields, GROSS_FIELD_KEYS, sameValue, type GrossFieldKey, type ReviewReason, type StoredValue } from "../assist/extractor";
import { renderTranscript, TRANSCRIPTS } from "../seed/fixtures/transcripts";

export { GROSS_FIELD_KEYS, type GrossFieldKey, type ReviewReason, type StoredValue };

/** Director (demo) and Medical director (demo) are read-only roles in this demo. */
const READ_ONLY_ROLES: string[] = ["director", "medical_director"];

// ------------------------------------------------------------------ rows

export interface GrossRecordRow {
  id: string;
  specimen_part_id: string;
  record_version: number;
  state: GrossState;
  source_update_state: SourceUpdateState;
  transcript_id: string | null;
  narrative: string;
  fields: string;
  proposals: string;
  unresolved: string;
  extractor: string | null;
  grosser_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  source_entry_by: string | null;
  source_entry_at: string | null;
  source_ack_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface PartRow {
  id: string;
  accession_id: string;
  designation: string;
  original_designation: string;
  site_text: string;
  laterality: string | null;
  procedure: string | null;
  status: string;
  physical_state: string;
  source_order_part_id: string;
  container_id: string | null;
  accession_number: string;
  namespace: string;
  assigned_pathologist_id: string | null;
  case_status: string;
  tenant_name: string | null;
}

export interface UnresolvedItem {
  field: string;
  message: string;
  by?: string | null;
  at?: string | null;
  /** For field "clarification": how it was resolved (needs_clarification -> draft). */
  resolution?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
}

// ------------------------------------------------------------------ loading

export function loadPart(db: DB, partId: string): PartRow {
  const p = db
    .prepare(
      `SELECT sp.id, sp.accession_id, sp.designation, sp.original_designation, sp.site_text, sp.laterality, sp.procedure, sp.status,
              sp.physical_state, sp.source_order_part_id, sp.container_id,
              a.accession_number, a.namespace, a.assigned_pathologist_id, a.case_status, t.name AS tenant_name
         FROM specimen_part sp
         JOIN accession a ON a.id = sp.accession_id
         LEFT JOIN patient_ref pr ON pr.id = a.patient_ref_id
         LEFT JOIN source_tenant t ON t.id = pr.tenant_id
        WHERE sp.id = ?`,
    )
    .get(partId) as PartRow | undefined;
  if (!p) throw new DomainError("NOT_FOUND", "That specimen part was not found");
  return p;
}

export function loadRecord(db: DB, recordId: string): GrossRecordRow {
  const r = db.prepare("SELECT * FROM gross_record WHERE id = ?").get(recordId) as GrossRecordRow | undefined;
  if (!r) throw new DomainError("NOT_FOUND", "That gross record was not found");
  return r;
}

/** The working version for a part: the highest non-superseded version, or null when grossing has not started. */
export function currentRecordForPart(db: DB, partId: string): GrossRecordRow | null {
  return (
    (db
      .prepare("SELECT * FROM gross_record WHERE specimen_part_id = ? AND state <> 'superseded' ORDER BY record_version DESC LIMIT 1")
      .get(partId) as GrossRecordRow | undefined) ?? null
  );
}

export function parseFields(json: string, procedure: string | null): GrossFields {
  try {
    const f = JSON.parse(json) as Partial<GrossFields>;
    const base = emptyGrossFields(procedure);
    return { ...base, ...f } as GrossFields;
  } catch {
    return emptyGrossFields(procedure);
  }
}

export function parseJsonArray<T>(json: string | null | undefined): T[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function partLabel(p: Pick<PartRow, "accession_number" | "designation">): string {
  return `${p.accession_number} part ${p.designation}`;
}

function staffName(db: DB, id: string | null | undefined): string | null {
  if (!id) return null;
  const r = db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined;
  return r?.display_name ?? id;
}

// ------------------------------------------------------------------ validation of values

const dimsSchema = z.object({
  length: z.number().positive().max(1000).nullable(),
  width: z.number().positive().max(1000).nullable(),
  depth: z.number().positive().max(1000).nullable(),
  unit: z.enum(["cm", "mm"]).nullable(),
  raw: z.string().max(300).nullable().optional(),
});
const cassetteSchema = z.object({
  label: z.string().trim().toUpperCase().regex(/^[A-Z]\d{1,2}$/, "Cassette labels look like A1"),
  pieces: z.number().int().min(0).max(99).nullable(),
  description: z.string().trim().max(200),
});
const text = z.string().trim().min(1, "Enter a value").max(500);

/** Value shapes accepted for a typed (unconfirmed) draft value. */
export const DRAFT_VALUE_SCHEMAS: Record<GrossFieldKey, z.ZodType> = {
  specimen_type: text,
  received_in: text,
  container_label_matches: z.boolean(),
  piece_count: z.number().int().min(0).max(999),
  dimensions: dimsSchema,
  appearance: text,
  ink_orientation: text,
  sectioning: text,
  cassettes: z.array(cassetteSchema).max(30),
};

/** Value shapes accepted for an operator CONFIRMATION (stricter: units and counts explicit). */
export const CONFIRM_VALUE_SCHEMAS: Record<GrossFieldKey, z.ZodType> = {
  ...DRAFT_VALUE_SCHEMAS,
  piece_count: z.number().int("Piece count must be a whole number").min(1, "Piece count must be at least 1").max(999),
  dimensions: dimsSchema.extend({
    length: z.number().positive("Enter at least one measured dimension").max(1000),
    unit: z.enum(["cm", "mm"], "Choose the unit (cm or mm); no unit is assumed"),
  }),
  cassettes: z.array(cassetteSchema).min(1, "Allocate at least one cassette").max(30),
};

function validateValue(field: GrossFieldKey, value: unknown, mode: "draft" | "confirm"): unknown {
  const schema = (mode === "confirm" ? CONFIRM_VALUE_SCHEMAS : DRAFT_VALUE_SCHEMAS)[field];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    throw new DomainError("VALIDATION", `${GROSS_FIELD_LABEL[field]}: ${msg}`, { field, issues: parsed.error.issues });
  }
  return parsed.data;
}

function fmtValue(field: GrossFieldKey, v: unknown): string {
  if (v === null || v === undefined) return "(none)";
  if (field === "dimensions") {
    const d = v as Dimensions;
    const nums = [d.length, d.width, d.depth].filter((n) => n !== null && n !== undefined);
    return `${nums.join(" x ")} ${d.unit ?? "(unit not stated)"}`;
  }
  if (field === "cassettes") return (v as CassetteAllocation[]).map((c) => `${c.label}${c.pieces !== null ? ` (${c.pieces} pc)` : ""}`).join(", ");
  if (field === "container_label_matches") return v ? "yes" : "no";
  return String(v);
}

// ------------------------------------------------------------------ blockers

/**
 * Everything that stops "operator reviewed" / "approved for downstream use":
 * the shared field rules (src/lib/gross.ts) plus part-identity checks.
 */
export function approvalBlockers(
  fields: GrossFields,
  narrative: string,
  part: Pick<PartRow, "designation">,
  /** Fields confirmed after the narrative was last saved or checked (see narrativeStaleFields). */
  staleSince: GrossFieldKey[] = [],
): FinalizeBlocker[] {
  const out = grossFinalizeBlockers(fields, narrative);
  if (narrative.trim() && staleSince.length) {
    const names = staleSince.map((k) => GROSS_FIELD_LABEL[k]);
    out.push({
      field: "narrative",
      message: `Narrative was written before ${names.join(" and ")} ${names.length === 1 ? "was" : "were"} confirmed; check that it matches the confirmed values`,
    });
  }
  if (fields.container_label_matches.status === "confirmed" && fields.container_label_matches.value === false) {
    out.push({ field: "container_label_matches", message: "Container label does not match the part. Raise a clarification; approval stays blocked." });
  }
  const c = fields.cassettes;
  if (c.status === "confirmed" && c.value?.length) {
    const wrong = c.value.filter((x) => x.label[0] !== part.designation);
    if (wrong.length) out.push({ field: "cassettes", message: `Cassette ${wrong.map((x) => x.label).join(", ")} does not belong to part ${part.designation}` });
    const labels = c.value.map((x) => x.label);
    if (new Set(labels).size !== labels.length) out.push({ field: "cassettes", message: "A cassette label is listed twice" });
  }
  return out;
}

/**
 * Fields confirmed after the narrative was last saved, composed or explicitly checked. The narrative is free text, so a
 * value confirmed later (for example the ambiguous "point six by four" resolved to 0.6 × 0.4 cm) may contradict it; the
 * record then needs a recompose or an explicit "narrative checked" before review and approval. Ordered by the audit
 * log (seq), so it does not depend on the demo clock. A seeded narrative with no audit event counts as written first.
 */
export function narrativeStaleFields(db: DB, rec: Pick<GrossRecordRow, "id" | "narrative">): GrossFieldKey[] {
  if (!rec.narrative.trim()) return [];
  const last = db
    .prepare(
      `SELECT MAX(seq) AS s FROM audit_event
        WHERE entity_type = 'gross_record' AND entity_id = ?
          AND (action = 'gross.narrative_checked' OR (action = 'gross.fields_updated' AND json_extract(after_json, '$.narrativeUpdated') = 1))`,
    )
    .get(rec.id) as { s: number | null };
  const rows = db
    .prepare(
      `SELECT json_extract(after_json, '$.field') AS f FROM audit_event
        WHERE entity_type = 'gross_record' AND entity_id = ? AND action = 'gross.field_confirmed' AND seq > ?
        ORDER BY seq`,
    )
    .all(rec.id, last.s ?? 0) as { f: string | null }[];
  const out: GrossFieldKey[] = [];
  for (const r of rows) {
    const k = r.f as GrossFieldKey | null;
    if (k && GROSS_FIELD_KEYS.includes(k) && !out.includes(k)) out.push(k);
  }
  return GROSS_FIELD_KEYS.filter((k) => out.includes(k));
}

/**
 * Runs a gross command; on a stale-version CONFLICT, adds who last changed the record (from the audit log) to the
 * error's current row, so the conflict dialog can say "Tanya Brooks saved changes at 11:04" (gross_record has no
 * updated_by column).
 */
export function withConflictAuthor<T>(db: DB, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const d = e instanceof DomainError && e.code === "CONFLICT" ? (e.details as { table?: string; id?: string; current?: Record<string, unknown> } | undefined) : undefined;
    if (d?.table === "gross_record" && d.id && d.current && !d.current.updated_by) {
      const last = db
        .prepare("SELECT actor_id FROM audit_event WHERE entity_type = 'gross_record' AND entity_id = ? AND actor_id IS NOT NULL ORDER BY seq DESC LIMIT 1")
        .get(d.id) as { actor_id: string } | undefined;
      if (last) d.current.updated_by = last.actor_id;
    }
    throw e;
  }
}

/** The (simulated) source system a part's description is entered into, with its connection status. */
export function sourceForPart(db: DB, partId: string): { name: string; status: string; lastSuccessAt: string | null } | null {
  const r = db
    .prepare(
      `SELECT isrc.name, isrc.status, isrc.last_success_at FROM specimen_part sp
         JOIN accession a ON a.id = sp.accession_id
         JOIN patient_ref pr ON pr.id = a.patient_ref_id
         JOIN integration_source isrc ON isrc.tenant_id = pr.tenant_id
        WHERE sp.id = ? ORDER BY isrc.id LIMIT 1`,
    )
    .get(partId) as { name: string; status: string; last_success_at: string | null } | undefined;
  return r ? { name: r.name, status: r.status, lastSuccessAt: r.last_success_at } : null;
}

function assertEditable(rec: GrossRecordRow, what: string): void {
  if (rec.state === "approved_for_downstream" || rec.state === "superseded") {
    throw new DomainError(
      "INVARIANT",
      `${what}: version ${rec.record_version} is ${rec.state === "superseded" ? "superseded" : "approved for downstream use"} and its content is frozen. Use "Amend" to create a new version; the approved version stays unchanged.`,
      { state: rec.state, recordVersion: rec.record_version },
    );
  }
}

/** Every change to gross documentation needs an active part in a case that is not canceled. */
function assertPartActive(part: PartRow, what: string): void {
  if (part.status !== "active") {
    throw new DomainError("INVARIANT", `${what}: ${partLabel(part)} is ${part.status}. Gross documentation for a ${part.status} part cannot change.`, { partStatus: part.status });
  }
  if (part.case_status === "canceled") {
    throw new DomainError("INVARIANT", `${what}: case ${part.accession_number} is canceled. Gross documentation cannot change.`, { caseStatus: part.case_status });
  }
}

function assertCurrent(db: DB, rec: GrossRecordRow): void {
  const cur = currentRecordForPart(db, rec.specimen_part_id);
  if (cur && cur.id !== rec.id) {
    throw new DomainError("CONFLICT", `A newer version (v${cur.record_version}) of this gross record exists. Reload before editing.`, {
      currentId: cur.id, currentVersion: cur.version,
    });
  }
}

// ------------------------------------------------------------------ public views

export interface GrossRecordSummary {
  id: string;
  partId: string;
  recordVersion: number;
  state: GrossState;
  sourceUpdateState: SourceUpdateState;
  version: number;
  blockers: FinalizeBlocker[];
}

export function summarize(db: DB, rec: GrossRecordRow, part?: PartRow): GrossRecordSummary {
  const p = part ?? loadPart(db, rec.specimen_part_id);
  const fields = parseFields(rec.fields, p.procedure);
  return {
    id: rec.id, partId: rec.specimen_part_id, recordVersion: rec.record_version, state: rec.state,
    sourceUpdateState: rec.source_update_state, version: rec.version, blockers: approvalBlockers(fields, rec.narrative, p, narrativeStaleFields(db, rec)),
  };
}

// ------------------------------------------------------------------ commands (domain operations)

function insertRecord(ctx: Ctx, part: PartRow, versionNo: number, init: Omit<Partial<GrossRecordRow>, "fields"> & { fields: GrossFields }): GrossRecordRow {
  let id = `gr_${part.id}_v${versionNo}`;
  if (ctx.db.prepare("SELECT 1 FROM gross_record WHERE id = ?").get(id)) id = newId(ctx.db, "gr");
  ctx.db
    .prepare(
      `INSERT INTO gross_record (id, specimen_part_id, record_version, state, source_update_state, transcript_id, narrative, fields, proposals,
        unresolved, extractor, grosser_id, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      id, part.id, versionNo, init.state ?? "draft", init.source_update_state ?? "not_started", init.transcript_id ?? null, init.narrative ?? "",
      JSON.stringify(init.fields), init.proposals ?? "[]", init.unresolved ?? "[]", init.extractor ?? null, ctx.actor.id, ctx.now, ctx.now,
    );
  return loadRecord(ctx.db, id);
}

/** gross.startDraft — returns the current record, creating an empty v1 draft (template only, no values) when none exists. */
export function startDraft(ctx: Ctx, partId: string): { record: GrossRecordSummary; created: boolean } {
  const part = loadPart(ctx.db, partId);
  assertPartActive(part, "Cannot start grossing");
  const existing = currentRecordForPart(ctx.db, partId);
  if (existing) return { record: summarize(ctx.db, existing, part), created: false };
  const maxV = (ctx.db.prepare("SELECT COALESCE(MAX(record_version), 0) v FROM gross_record WHERE specimen_part_id = ?").get(partId) as { v: number }).v;
  const fields = emptyGrossFields(part.procedure);
  const rec = insertRecord(ctx, part, maxV + 1, { fields });
  const tpl = Object.values(GROSS_TEMPLATES).find((t) => t.id === fields.template_id);
  audit(ctx, {
    action: "gross.draft_started", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `Gross draft v${rec.record_version} started for ${partLabel(part)} (${tpl?.label ?? fields.template_id}). No values pre-filled; template defaults are not observations.`,
  });
  // No worklist change: an empty draft changes nothing a pathologist acts on (approval does).
  return { record: summarize(ctx.db, rec, part), created: true };
}

/** Find which fixture produced a stored transcript text for this part (display only). */
export function fixtureKeyForText(textValue: string, designation: string): string | null {
  for (const key of Object.keys(TRANSCRIPTS)) {
    const r = renderTranscript(key, designation);
    if (r && r.text === textValue) return key;
  }
  return null;
}

export interface LoadTranscriptResult {
  record: GrossRecordSummary;
  transcriptId: string;
  replayed: boolean;
  extractor: string;
  counts: { proposed: number; needsReview: number; missing: number };
  ignoredInstructions: string[];
  keptConfirmed: string[];
  keptTyped: string[];
}

/** gross.loadTranscript — attach a synthetic dictation fixture and run the deterministic extractor (proposals only). */
/**
 * `expectedVersion`: the gross record version the user saw, or null when the part had no gross record
 * when they opened it. A record started (or changed) by someone else since then is a CONFLICT.
 */
export function loadTranscript(ctx: Ctx, partId: string, transcriptKey: string, expectedVersion: number | null): LoadTranscriptResult {
  if ((getSetting(ctx.db, "assistant_mode") ?? "deterministic") === "unavailable") {
    throw new DomainError(
      "ASSISTANT_UNAVAILABLE",
      "Extraction is not available right now (assistant set to Unavailable in Settings). Enter the values manually; every field stays editable and approval works the same way.",
    );
  }
  const part = loadPart(ctx.db, partId);
  assertPartActive(part, "Cannot attach a transcript");
  const rendered = renderTranscript(transcriptKey, part.designation);
  if (!rendered) throw new DomainError("VALIDATION", `Unknown synthetic transcript "${transcriptKey}"`);
  let rec = currentRecordForPart(ctx.db, partId);
  if (rec && expectedVersion === null) {
    throw new DomainError(
      "CONFLICT",
      `A gross record for this part was started by someone else after you opened it (v${rec.record_version}, ${rec.state.replace(/_/g, " ")}). Review it before attaching a transcript.`,
      { table: "gross_record", id: rec.id, expectedVersion: null, currentVersion: rec.version, current: rec },
    );
  }
  if (!rec) {
    if (expectedVersion !== null) {
      throw new DomainError("CONFLICT", "The gross record you had open is no longer the current one for this part. Reload it before attaching a transcript.", {
        table: "gross_record", id: null, expectedVersion, currentVersion: null,
      });
    }
    startDraft(ctx, partId);
    rec = currentRecordForPart(ctx.db, partId)!;
  }
  assertEditable(rec, "Cannot attach a transcript");
  if (expectedVersion !== null && rec.version !== expectedVersion) {
    throw new DomainError("CONFLICT", `This gross record was changed by someone else (you had version ${expectedVersion}, current is ${rec.version}). Review the latest version first.`, {
      table: "gross_record", id: rec.id, expectedVersion, currentVersion: rec.version, current: rec,
    });
  }

  // Idempotent: the same transcript already attached to this version → nothing to do.
  if (rec.transcript_id) {
    const cur = ctx.db.prepare("SELECT id, text FROM gross_transcript WHERE id = ?").get(rec.transcript_id) as { id: string; text: string } | undefined;
    if (cur && cur.text === rendered.text) {
      const fields = parseFields(rec.fields, part.procedure);
      const vals = GROSS_FIELD_KEYS.map((k) => fields[k].status);
      return {
        record: summarize(ctx.db, rec, part), transcriptId: cur.id, replayed: true, extractor: rec.extractor ?? EXTRACTOR_NAME,
        counts: { proposed: vals.filter((s) => s === "proposed").length, needsReview: vals.filter((s) => s === "needs_review").length, missing: vals.filter((s) => s === "missing").length },
        ignoredInstructions: [], keptConfirmed: [], keptTyped: [],
      };
    }
  }

  const transcriptId = newId(ctx.db, "gtx");
  ctx.db
    .prepare("INSERT INTO gross_transcript (id, specimen_part_id, source, text, audio_ref, captured_by, captured_at) VALUES (?, ?, 'synthetic_dictation', ?, NULL, ?, ?)")
    .run(transcriptId, partId, rendered.text, ctx.actor.id, ctx.now);

  const extraction = extractGrossFields(rendered.text, { partDesignation: part.designation, partSite: part.site_text, orderProcedure: part.procedure });
  const current = parseFields(rec.fields, part.procedure);
  const merged: GrossFields = { ...current };
  // Keep operator notes (clarification, amendment); replace the previous extraction's notes.
  const unresolved: UnresolvedItem[] = [
    ...parseJsonArray<UnresolvedItem>(rec.unresolved).filter((u) => u.field === "clarification" || u.field === "amendment"),
    ...extraction.unresolved.map((u) => ({ field: u.field, message: u.message })),
  ];
  const keptConfirmed: string[] = [];
  const keptTyped: string[] = [];
  const replaced: string[] = [];
  for (const key of GROSS_FIELD_KEYS) {
    const existing = current[key] as StoredValue<unknown>;
    const proposed = extraction.fields[key] as StoredValue<unknown>;
    if (existing.status === "confirmed") {
      keptConfirmed.push(key);
      if (proposed.value !== null && !sameValue(existing.value, proposed.value)) {
        unresolved.push({ field: key, message: `Transcript proposes ${fmtValue(key, proposed.value)}; the operator-confirmed value (${fmtValue(key, existing.value)}) was kept.` });
      }
      continue;
    }
    // A value the operator typed (not yet confirmed) is the operator's own entry: a transcript never overwrites it.
    if (existing.origin === "typed" && existing.value !== null && existing.value !== undefined) {
      keptTyped.push(key);
      if (proposed.value !== null && !sameValue(existing.value, proposed.value)) {
        unresolved.push({ field: key, message: `Transcript proposes ${fmtValue(key, proposed.value)}; the typed value (${fmtValue(key, existing.value)}) was kept and still needs confirmation.` });
      }
      continue;
    }
    if (existing.value !== null && existing.value !== undefined && !sameValue(existing.value, proposed.value)) {
      replaced.push(`${GROSS_FIELD_LABEL[key]}: ${fmtValue(key, existing.value)} → ${fmtValue(key, proposed.value)}`);
    }
    (merged as unknown as Record<string, unknown>)[key] = proposed;
  }
  const wasReviewed = rec.state === "operator_reviewed";
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, rec.version, {
    transcript_id: transcriptId,
    fields: merged,
    proposals: extraction.proposals,
    unresolved,
    extractor: EXTRACTOR_NAME,
    state: wasReviewed ? "draft" : rec.state,
    reviewed_by: wasReviewed ? null : rec.reviewed_by,
    reviewed_at: wasReviewed ? null : rec.reviewed_at,
    updated_at: ctx.now,
  }) as unknown as GrossRecordRow;

  audit(ctx, {
    action: "gross.transcript_attached", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `Synthetic transcript "${transcriptKey}" attached to ${partLabel(part)} v${rec.record_version}${wasReviewed ? " (returned to draft for review)" : ""}${
      keptConfirmed.length || keptTyped.length ? `. Kept the operator's values for ${[...keptConfirmed, ...keptTyped].map((k) => GROSS_FIELD_LABEL[k as GrossFieldKey]).join(", ")}` : ""
    }${replaced.length ? `. Earlier unconfirmed proposals replaced: ${replaced.join("; ")}` : ""}`,
    before: replaced.length ? { replaced } : undefined,
  });
  audit({ ...ctx, origin: "assistant" }, {
    action: "assistant.extraction_proposed", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${EXTRACTOR_NAME} proposed values for ${partLabel(part)}: ${extraction.counts.proposed} proposed, ${extraction.counts.needsReview} need review, ${extraction.counts.missing} missing. Nothing was confirmed; deterministic demo output, not live AI.`,
    after: extraction.proposals,
  });
  for (const ignored of extraction.ignoredInstructions) {
    audit({ ...ctx, origin: "assistant" }, {
      action: "assistant.instruction_ignored", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
      summary: `Instruction-like text in the transcript was treated as dictation data and ignored. No state, role or approval changed.`,
      after: { text: ignored.text, start: ignored.start, end: ignored.end },
    });
  }
  return {
    record: summarize(ctx.db, updated, part), transcriptId, replayed: false, extractor: EXTRACTOR_NAME, counts: extraction.counts,
    ignoredInstructions: extraction.ignoredInstructions.map((i) => i.text), keptConfirmed, keptTyped,
  };
}

export type FieldPatch = Partial<Record<GrossFieldKey, { value: unknown }>>;

/**
 * gross.updateFields — save typed (unconfirmed) values and/or the narrative. Typed values still need an explicit Confirm.
 * `narrativeChecked`: the operator checked an unchanged narrative against values confirmed after it was written
 * (recorded in the audit log; clears the "narrative written before ..." blocker).
 */
export function updateFields(ctx: Ctx, recordId: string, expectedVersion: number, patch: FieldPatch, narrative?: string, narrativeChecked = false): GrossRecordSummary {
  const rec = loadRecord(ctx.db, recordId);
  assertEditable(rec, "Cannot edit");
  assertCurrent(ctx.db, rec);
  const part = loadPart(ctx.db, rec.specimen_part_id);
  assertPartActive(part, "Cannot edit");
  const fields = parseFields(rec.fields, part.procedure);
  const changed: string[] = [];
  for (const key of Object.keys(patch) as GrossFieldKey[]) {
    if (!GROSS_FIELD_KEYS.includes(key)) continue;
    const entry = patch[key];
    if (!entry) continue;
    const prev = fields[key] as StoredValue<unknown>;
    let next: StoredValue<unknown>;
    if (entry.value === null || entry.value === undefined) {
      next = { value: null, status: "missing", evidence: prev.evidence ?? null, note: `Cleared by ${ctx.actor.name}`, origin: "typed", proposedValue: prev.proposedValue ?? null };
    } else {
      const value = validateValue(key, entry.value, "draft");
      if (prev.status === "confirmed" && sameValue(prev.value, value)) continue;
      const unitMissing = key === "dimensions" && !(value as Dimensions).unit;
      next = {
        value,
        status: unitMissing ? "needs_review" : "proposed",
        evidence: prev.evidence ?? null,
        note: unitMissing ? "Unit not chosen (cm or mm). No unit is assumed." : `Typed by ${ctx.actor.name}; not yet confirmed.`,
        origin: "typed",
        proposedValue: prev.proposedValue ?? null,
        ...(unitMissing ? { reviewReasons: ["unit_missing" as const] } : {}),
      };
    }
    if (sameValue(prev.value, next.value) && prev.status === next.status) continue;
    (fields as unknown as Record<string, unknown>)[key] = next;
    changed.push(`${GROSS_FIELD_LABEL[key]}: ${fmtValue(key, prev.value)} → ${fmtValue(key, next.value)}`);
  }
  const narrativeChanged = narrative !== undefined && narrative !== rec.narrative;
  const staleBefore = narrativeChecked && !narrativeChanged ? narrativeStaleFields(ctx.db, rec) : [];
  if (!changed.length && !narrativeChanged && !staleBefore.length) return summarize(ctx.db, rec, part);
  const wasReviewed = rec.state === "operator_reviewed";
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, expectedVersion, {
    fields,
    narrative: narrativeChanged ? narrative : rec.narrative,
    state: wasReviewed ? "draft" : rec.state,
    reviewed_by: wasReviewed ? null : rec.reviewed_by,
    reviewed_at: wasReviewed ? null : rec.reviewed_at,
    updated_at: ctx.now,
  }) as unknown as GrossRecordRow;
  if (changed.length || narrativeChanged) audit(ctx, {
    action: "gross.fields_updated", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${partLabel(part)} v${rec.record_version} edited${narrativeChanged ? " (narrative updated)" : ""}${changed.length ? `: ${changed.join("; ")}` : ""}${wasReviewed ? ". Returned to draft for review." : ""}`,
    after: { narrativeUpdated: narrativeChanged, fields: changed.length },
  });
  if (staleBefore.length) {
    audit(ctx, {
      action: "gross.narrative_checked", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
      summary: `${ctx.actor.name} checked the narrative of ${partLabel(part)} v${rec.record_version} against the values confirmed after it was written (${staleBefore.map((k) => GROSS_FIELD_LABEL[k]).join(", ")}) and kept it unchanged`,
      after: { fields: staleBefore },
    });
  }
  return summarize(ctx.db, updated, part);
}

function sameNumbers(a: unknown, b: unknown): boolean {
  const x = (a ?? null) as Dimensions | null;
  const y = (b ?? null) as Dimensions | null;
  if (!x || !y) return x === y;
  return (x.length ?? null) === (y.length ?? null) && (x.width ?? null) === (y.width ?? null) && (x.depth ?? null) === (y.depth ?? null);
}

/**
 * Review reasons a confirmation leaves unaddressed. Entering a different value is an explicit operator decision
 * (resolves everything); keeping the needs-review value as dictated resolves nothing except a missing unit,
 * which choosing the unit resolves. Anything left needs an explicit "I checked the specimen" acknowledgment.
 */
export function outstandingReviewReasons(field: GrossFieldKey, prev: StoredValue<unknown>, confirmed: unknown): ReviewReason[] {
  if (prev.status !== "needs_review") return [];
  if (prev.value === null || prev.value === undefined) return []; // nothing was proposed: the operator entered the value
  const changed = field === "dimensions" ? !sameNumbers(prev.value, confirmed) : !sameValue(prev.value, confirmed);
  if (changed) return [];
  const reasons: ReviewReason[] = prev.reviewReasons?.length ? prev.reviewReasons : ["unspecified"];
  return reasons.filter((r) => !(r === "unit_missing" && field === "dimensions" && (confirmed as Dimensions | null)?.unit));
}

/**
 * gross.confirmField — the operator explicitly confirms one value (the proposal as-is when `value` is omitted and the value is a clean proposal).
 * Keeping a needs-review value as dictated requires `acknowledgeReview: true` ("I checked the specimen; the dictated value is correct").
 */
export function confirmField(
  ctx: Ctx, recordId: string, expectedVersion: number, field: GrossFieldKey, value?: unknown, acknowledgeReview = false,
): GrossRecordSummary {
  if (field === "cassettes") requirePermission(ctx, "gross.confirmCassettes");
  const rec = loadRecord(ctx.db, recordId);
  assertEditable(rec, "Cannot confirm");
  assertCurrent(ctx.db, rec);
  const part = loadPart(ctx.db, rec.specimen_part_id);
  assertPartActive(part, "Cannot confirm");
  const fields = parseFields(rec.fields, part.procedure);
  const prev = fields[field] as StoredValue<unknown>;
  let raw = value;
  if (raw === undefined) {
    const hasShown = prev.value !== null && prev.value !== undefined;
    if (!hasShown || !(prev.status === "proposed" || (prev.status === "needs_review" && acknowledgeReview))) {
      throw new DomainError(
        "VALIDATION",
        prev.status === "needs_review" && hasShown
          ? `${GROSS_FIELD_LABEL[field]} needs review (${prev.note ?? "uncertain value"}). Enter the value you observed, or confirm that you checked the specimen and the dictated value is correct.`
          : `${GROSS_FIELD_LABEL[field]} has no proposed value to confirm. Enter the value you observed.`,
        { field, reviewRequired: prev.status === "needs_review" && hasShown },
      );
    }
    raw = prev.value;
  }
  const confirmed = validateValue(field, raw, "confirm");
  if (field === "cassettes") {
    const wrong = (confirmed as CassetteAllocation[]).filter((c) => c.label[0] !== part.designation);
    if (wrong.length) throw new DomainError("VALIDATION", `Cassette ${wrong.map((c) => c.label).join(", ")} does not belong to part ${part.designation}`, { field });
  }
  const outstanding = outstandingReviewReasons(field, prev, confirmed);
  if (outstanding.length && !acknowledgeReview) {
    throw new DomainError(
      "VALIDATION",
      `${GROSS_FIELD_LABEL[field]} needs review (${prev.note ?? "uncertain value"}). Enter the value you observed, or confirm that you checked the specimen and the dictated value is correct.`,
      { field, reviewRequired: true, reasons: outstanding },
    );
  }
  const acknowledged = outstanding.length > 0;
  const proposedValue = prev.proposedValue ?? (prev.origin === "transcript" ? prev.value : null);
  // Dimensions carry the dictated wording (`raw`) in the proposal; only the numbers and the unit are the value.
  const changedFromProposal =
    proposedValue !== null &&
    proposedValue !== undefined &&
    (field === "dimensions"
      ? !(sameNumbers(proposedValue, confirmed) && ((proposedValue as Dimensions).unit ?? null) === ((confirmed as Dimensions | null)?.unit ?? null))
      : !sameValue(proposedValue, confirmed));
  const next: StoredValue<unknown> = {
    value: confirmed,
    status: "confirmed",
    evidence: prev.evidence ?? null,
    note: acknowledged
      ? `Kept as dictated after ${ctx.actor.name} checked the specimen (was: ${prev.note ?? "needs review"}).`
      : changedFromProposal
        ? `Operator changed the transcript proposal (${fmtValue(field, proposedValue)} → ${fmtValue(field, confirmed)}).`
        : null,
    origin: prev.origin ?? "typed",
    proposedValue: proposedValue ?? null,
    reviewAcknowledged: acknowledged ? { reasons: outstanding, note: prev.note ?? null, by: ctx.actor.id, byName: ctx.actor.name, at: ctx.now } : null,
    confirmedBy: ctx.actor.id,
    confirmedByName: ctx.actor.name,
    confirmedAt: ctx.now,
  };
  (fields as unknown as Record<string, unknown>)[field] = next;
  const wasReviewed = rec.state === "operator_reviewed";
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, expectedVersion, {
    fields,
    state: wasReviewed ? "draft" : rec.state,
    reviewed_by: wasReviewed ? null : rec.reviewed_by,
    reviewed_at: wasReviewed ? null : rec.reviewed_at,
    updated_at: ctx.now,
  }) as unknown as GrossRecordRow;
  audit(ctx, {
    action: "gross.field_confirmed", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${ctx.actor.name} confirmed ${GROSS_FIELD_LABEL[field]} = ${fmtValue(field, confirmed)} for ${partLabel(part)} v${rec.record_version}${changedFromProposal ? ` (proposal was ${fmtValue(field, proposedValue)})` : ""}${
      acknowledged ? `; kept as dictated after checking the specimen (review note: ${prev.note ?? "uncertain value"})` : ""
    }`,
    before: { value: prev.value, status: prev.status, note: prev.note ?? null },
    after: { field, value: confirmed, status: "confirmed", ...(acknowledged ? { reviewAcknowledged: outstanding } : {}) },
  });
  return summarize(ctx.db, updated, part);
}

function throwBlockers(blockers: FinalizeBlocker[], what: string): never {
  const n = blockers.length;
  throw new DomainError("BLOCKED", `${what}: ${n} item${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention (${blockers.map((b) => b.message).join("; ")})`, { blockers });
}

/** gross.markReviewed — operator review gate: every required value confirmed, units explicit, counts whole numbers. */
export function markReviewed(ctx: Ctx, recordId: string, expectedVersion: number): GrossRecordSummary {
  const rec = loadRecord(ctx.db, recordId);
  assertEditable(rec, "Cannot mark reviewed");
  assertCurrent(ctx.db, rec);
  const part = loadPart(ctx.db, rec.specimen_part_id);
  assertPartActive(part, "Cannot mark reviewed");
  if (rec.state === "operator_reviewed") return summarize(ctx.db, rec, part);
  if (rec.state === "needs_clarification") {
    const open = parseJsonArray<UnresolvedItem>(rec.unresolved).filter((u) => u.field === "clarification" && !u.resolvedAt);
    throw new DomainError(
      "BLOCKED",
      `${partLabel(part)} v${rec.record_version} is flagged as needing clarification${open.length ? ` (${open.map((u) => u.message).join("; ")})` : ""}. Record how it was resolved (this returns it to draft) before marking it reviewed.`,
      { state: rec.state, blockers: open.map((u) => ({ field: "clarification", message: u.message })) },
    );
  }
  const fields = parseFields(rec.fields, part.procedure);
  const blockers = approvalBlockers(fields, rec.narrative, part, narrativeStaleFields(ctx.db, rec));
  if (blockers.length) throwBlockers(blockers, "Cannot mark operator reviewed yet");
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, expectedVersion, {
    state: "operator_reviewed", reviewed_by: ctx.actor.id, reviewed_at: ctx.now, updated_at: ctx.now,
  }) as unknown as GrossRecordRow;
  audit(ctx, {
    action: "gross.reviewed", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${ctx.actor.name} marked ${partLabel(part)} v${rec.record_version} operator reviewed`,
    before: { state: rec.state, version: rec.version },
    after: { state: "operator_reviewed", version: updated.version, recordVersion: rec.record_version, specimenPartId: part.id, transcriptId: rec.transcript_id ?? null },
  });
  return summarize(ctx.db, updated, part);
}

export interface ApproveResult {
  record: GrossRecordSummary;
  blocksCreated: string[];
  blocks: { id: string; label: string; identifier: string; eligibleForProcessing: boolean; heldBy: string[] }[];
  tasks: { id: string; kind: string; title: string; owner: string | null }[];
  otherParts: { designation: string; status: string }[];
  worklistSummary: string;
  worklistSeq: number;
}

function otherPartStatus(db: DB, partId: string): string {
  const rec = currentRecordForPart(db, partId);
  const held = holdsBlocking(db, "gross_approval", scopesForPart(db, partId));
  if (held.length) return `on hold (${held.map((h) => h.display_id).join(", ")})`;
  if (!rec) return "still awaiting grossing";
  if (rec.state === "approved_for_downstream") return "approved for downstream use";
  if (rec.state === "operator_reviewed") return "operator reviewed, not yet approved";
  if (rec.state === "needs_clarification") return "grossing documentation needs clarification";
  return "grossing documentation in draft";
}

export interface BlockEligibility {
  blockId: string;
  label: string;
  eligible: boolean;
  heldBy: string[];
  /** Open processing_eligible task (existing or opened now), if eligible. */
  taskId: string | null;
  title: string;
}

/**
 * Derive processing eligibility for a part's loaded blocks from the CURRENT approved gross record and active holds,
 * and make sure each eligible block has one open `processing_eligible` task (openTask is idempotent per block).
 * Called by gross.approve. Also safe to call after a processing hold is released (cross-slice: hold.release), so a
 * block that was held at approval time gets its task then. Never closes tasks and never moves any material.
 */
export function syncProcessingEligibility(ctx: Ctx, partId: string, onlyBlockIds?: string[]): BlockEligibility[] {
  const db = ctx.db;
  const part = loadPart(db, partId);
  const rec = currentRecordForPart(db, partId);
  const approved = rec?.state === "approved_for_downstream" && part.status === "active" && part.case_status !== "canceled";
  const rows = db
    .prepare("SELECT id, label_text, physical_state FROM block WHERE part_id = ? AND status = 'active' ORDER BY block_seq")
    .all(partId) as { id: string; label_text: string; physical_state: string }[];
  const out: BlockEligibility[] = [];
  for (const b of rows) {
    if (onlyBlockIds && !onlyBlockIds.includes(b.id)) continue;
    const held = holdsBlocking(db, "processing", scopesForBlock(db, b.id));
    const eligible = approved && b.physical_state === "cassette_loaded" && !held.length;
    const title = `${part.accession_number} ${b.label_text} eligible for the next processing run`;
    let taskId: string | null = null;
    if (eligible && rec) {
      taskId = openTask(ctx, {
        kind: "processing_eligible", entityType: "block", entityId: b.id, title, ownerRole: "histotech", accessionId: part.accession_id,
        detail: `Gross record v${rec.record_version} approved for downstream use. Eligibility is derived from the approved allocation and active holds; it does not mean processing has started.`,
      });
    }
    out.push({ blockId: b.id, label: b.label_text, eligible, heldBy: held.map((h) => h.display_id), taskId, title });
  }
  return out;
}

/** syncProcessingEligibility for every active part of a case (e.g. after an accession-scoped hold is released). */
export function syncProcessingEligibilityForAccession(ctx: Ctx, accessionId: string): BlockEligibility[] {
  const parts = ctx.db.prepare("SELECT id FROM specimen_part WHERE accession_id = ? AND status = 'active' ORDER BY designation").all(accessionId) as { id: string }[];
  return parts.flatMap((p) => syncProcessingEligibility(ctx, p.id));
}

/** gross.approve — approved for downstream use. Creates missing blocks, downstream tasks and a worklist change. */
export function approve(ctx: Ctx, recordId: string, expectedVersion: number): ApproveResult {
  const db = ctx.db;
  const rec = loadRecord(db, recordId);
  const part = loadPart(db, rec.specimen_part_id);
  if (rec.state === "approved_for_downstream") {
    throw new DomainError("VALIDATION", `${partLabel(part)} v${rec.record_version} is already approved for downstream use`);
  }
  assertEditable(rec, "Cannot approve");
  assertCurrent(db, rec);
  assertPartActive(part, "Cannot approve");
  const fields = parseFields(rec.fields, part.procedure);
  const blockers = approvalBlockers(fields, rec.narrative, part, narrativeStaleFields(ctx.db, rec));
  if (blockers.length) throwBlockers(blockers, "Cannot approve yet");
  assertNotHeld(db, "gross_approval", scopesForPart(db, part.id), `Approving the gross record for ${partLabel(part)}`);
  if (rec.state !== "operator_reviewed") {
    throw new DomainError("VALIDATION", `Mark ${partLabel(part)} operator reviewed before approving it for downstream use`, { state: rec.state });
  }
  // A voided block keeps its label (UNIQUE part + sequence) and is never reused or made eligible.
  const allocationCheck = (fields.cassettes.value ?? []) as CassetteAllocation[];
  const voided = allocationCheck.filter(
    (c) => db.prepare("SELECT 1 FROM block WHERE part_id = ? AND block_seq = ? AND status <> 'active'").get(part.id, Number(c.label.slice(1))),
  );
  if (voided.length) {
    throw new DomainError(
      "BLOCKED",
      `Cannot approve: ${voided.map((c) => `${part.accession_number} ${c.label}`).join(", ")} was voided earlier and is not reused. Allocate a different cassette label, or ask a supervisor.`,
      { blockers: voided.map((c) => ({ field: "cassettes", message: `${c.label} was voided earlier` })) },
    );
  }

  const updated = updateVersioned(db, "gross_record", rec.id, expectedVersion, {
    state: "approved_for_downstream",
    approved_by: ctx.actor.id,
    approved_at: ctx.now,
    source_update_state: "pending_entry",
    updated_at: ctx.now,
  }) as unknown as GrossRecordRow;

  // Physical: the part has been grossed (documentation approval does not move any block further).
  db.prepare("UPDATE specimen_part SET physical_state = 'grossed', version = version + 1 WHERE id = ? AND physical_state <> 'grossed'").run(part.id);

  // Blocks for the allocated cassettes (one record per cassette; identity kept as it becomes a block).
  const allocation = (fields.cassettes.value ?? []) as CassetteAllocation[];
  const ns = namespaceCode(part.namespace);
  const blocksCreated: string[] = [];
  const blockRows: { id: string; label: string; identifier: string; state: string }[] = [];
  for (const c of allocation) {
    const seq = Number(c.label.slice(1));
    const existing = db.prepare("SELECT id, label_text, identifier, physical_state FROM block WHERE part_id = ? AND block_seq = ? AND status = 'active'").get(part.id, seq) as
      | { id: string; label_text: string; identifier: string; physical_state: string }
      | undefined;
    if (existing) {
      blockRows.push({ id: existing.id, label: existing.label_text, identifier: existing.identifier, state: existing.physical_state });
      continue;
    }
    let blockId = `${part.id}_b${seq}`;
    if (db.prepare("SELECT 1 FROM block WHERE id = ?").get(blockId)) blockId = newId(db, "blk");
    const identifier = encodeLabel({ kind: "B", namespace: ns, accession: part.accession_number, part: part.designation, block: seq });
    db.prepare(
      `INSERT INTO block (id, accession_id, part_id, block_seq, label_text, identifier, physical_state, pieces_submitted, current_location_id,
         location_confirmed_at, location_confirmed_by, custody_state, checkout_holder_id, status, version)
       VALUES (?, ?, ?, ?, ?, ?, 'cassette_loaded', ?, NULL, NULL, NULL, 'in_workflow', NULL, 'active', 1)`,
    ).run(blockId, part.accession_id, part.id, seq, c.label, identifier, c.pieces ?? null);
    blocksCreated.push(c.label);
    blockRows.push({ id: blockId, label: c.label, identifier, state: "cassette_loaded" });
    audit(ctx, {
      action: "block.created", entityType: "block", entityId: blockId, accessionId: part.accession_id,
      summary: `Block ${part.accession_number} ${c.label} recorded from the approved cassette allocation (demo identifier ${identifier}). Location: unknown until confirmed.`,
    });
  }

  // Blocks that exist but are no longer in the approved allocation (e.g. after an amendment) need a person to look.
  const allocatedSeqs = new Set(allocation.map((c) => Number(c.label.slice(1))));
  const orphans = (db.prepare("SELECT id, label_text FROM block WHERE part_id = ? AND status = 'active'").all(part.id) as { id: string; label_text: string }[]).filter(
    (b) => !allocatedSeqs.has(Number(b.label_text.slice(1))),
  );

  // Downstream tasks.
  const tasks: ApproveResult["tasks"] = [];
  const sam = db.prepare("SELECT id, display_name FROM staff WHERE id = 'stf_sam' AND active = 1").get() as { id: string; display_name: string } | undefined;
  const tenant = part.tenant_name ?? "the source system";
  const srcTitle = `Enter approved gross description in source system — ${partLabel(part)}`;
  const srcTask = openTask(ctx, {
    kind: "source_entry", entityType: "specimen_part", entityId: part.id, title: srcTitle,
    ownerId: sam?.id ?? null, ownerRole: "histology_assistant", accessionId: part.accession_id,
    detail: `Version ${rec.record_version} approved ${fmtTime(ctx.now)} ET by ${ctx.actor.name}. Enter it manually in ${tenant} (simulated) and mark it entered (staff attestation). No automatic source write exists in this demo.`,
  });
  tasks.push({ id: srcTask, kind: "source_entry", title: srcTitle, owner: sam?.display_name ?? "Histology assistant" });

  // Policy "processing_requires_approved_gross" is satisfied by this approval; holds still apply per block.
  const blockEligibility = syncProcessingEligibility(ctx, part.id, blockRows.map((b) => b.id));
  const blocksOut: ApproveResult["blocks"] = [];
  for (const b of blockRows) {
    const e = blockEligibility.find((x) => x.blockId === b.id);
    if (e?.taskId) tasks.push({ id: e.taskId, kind: "processing_eligible", title: e.title, owner: "Histotechnologist on duty" });
    blocksOut.push({ id: b.id, label: b.label, identifier: b.identifier, eligibleForProcessing: Boolean(e?.eligible), heldBy: e?.heldBy ?? [] });
  }
  if (orphans.length) {
    const title = `Review blocks not in the approved allocation — ${partLabel(part)}: ${orphans.map((o) => o.label_text).join(", ")}`;
    const id = openTask(ctx, { kind: "gross_review", entityType: "specimen_part", entityId: part.id, title, ownerRole: "supervisor", accessionId: part.accession_id, priority: "high" });
    tasks.push({ id, kind: "gross_review", title, owner: "Operations supervisor" });
  }

  // Worklist change: what became eligible, and what is still not done in this case.
  const otherParts = (db.prepare("SELECT id, designation FROM specimen_part WHERE accession_id = ? AND id <> ? AND status = 'active' ORDER BY designation").all(part.accession_id, part.id) as {
    id: string; designation: string;
  }[]).map((o) => ({ designation: o.designation, status: otherPartStatus(db, o.id) }));
  const eligibleLabels = blocksOut.filter((b) => b.eligibleForProcessing).map((b) => b.label);
  const heldLabels = blocksOut.filter((b) => b.heldBy.length).map((b) => `${b.label} held from processing (${b.heldBy.join(", ")})`);
  const head = `${part.accession_number} Part ${part.designation} gross approved`;
  const eligibility = eligibleLabels.length ? `${eligibleLabels.join(", ")} eligible for processing` : heldLabels.length ? heldLabels.join(", ") : "no blocks eligible yet";
  const rest = otherParts.map((o) => `part ${o.designation} ${o.status}`).join("; ");
  const worklistSummary = `${head} — ${eligibility}${rest ? `; ${rest}` : ""}`;
  const worklistSeq = recordWorklistChange(ctx, { accessionId: part.accession_id, pathologistId: part.assigned_pathologist_id, type: "changed", summary: worklistSummary });

  audit(ctx, {
    action: "gross.approved", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${ctx.actor.name} approved ${partLabel(part)} v${rec.record_version} for downstream use. Source-system entry is pending (not entered, not acknowledged). ${worklistSummary}.`,
    before: { state: rec.state, version: rec.version, sourceUpdateState: rec.source_update_state },
    after: {
      state: "approved_for_downstream",
      version: updated.version,
      sourceUpdateState: "pending_entry",
      recordVersion: rec.record_version,
      specimenPartId: part.id,
      blockIds: blocksOut.map((b) => b.id),
      blocksCreated,
      eligibleBlockIds: blocksOut.filter((b) => b.eligibleForProcessing).map((b) => b.id),
      taskIds: tasks.map((t) => t.id),
      worklistSeq,
    },
  });
  return { record: summarize(db, updated, part), blocksCreated, blocks: blocksOut, tasks, otherParts, worklistSummary, worklistSeq };
}

/** gross.recordSourceEntry — staff attest that they entered the approved description in the source system. NOT an acknowledgment. */
export function recordSourceEntry(ctx: Ctx, recordId: string, expectedVersion: number): GrossRecordSummary & { replayed: boolean } {
  const rec = loadRecord(ctx.db, recordId);
  const part = loadPart(ctx.db, rec.specimen_part_id);
  if (rec.state !== "approved_for_downstream") {
    throw new DomainError("VALIDATION", `Only an approved gross record can be entered in the source system (${partLabel(part)} v${rec.record_version} is ${rec.state.replace(/_/g, " ")})`);
  }
  if (rec.source_update_state === "entered_attested" || rec.source_update_state === "source_acknowledged") {
    return { ...summarize(ctx.db, rec, part), replayed: true };
  }
  if (rec.source_update_state !== "pending_entry" && rec.source_update_state !== "failed") {
    throw new DomainError("VALIDATION", `Source entry is not pending for ${partLabel(part)}`);
  }
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, expectedVersion, {
    source_update_state: "entered_attested", source_entry_by: ctx.actor.id, source_entry_at: ctx.now, updated_at: ctx.now,
  }) as unknown as GrossRecordRow;
  closeTasks(ctx, "source_entry", "specimen_part", part.id, "done");
  audit(ctx, {
    action: "gross.source_entry_attested", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${ctx.actor.name} attested that ${partLabel(part)} v${rec.record_version} was entered manually in ${part.tenant_name ?? "the source system"}. Staff attestation only; the source system has not acknowledged it.`,
    before: { sourceUpdateState: rec.source_update_state, version: rec.version },
    after: { sourceUpdateState: "entered_attested", version: updated.version, recordVersion: rec.record_version, specimenPartId: part.id, attestedBy: ctx.actor.id },
  });
  recordWorklistChange(ctx, {
    accessionId: part.accession_id, pathologistId: part.assigned_pathologist_id, type: "changed",
    summary: `${partLabel(part)}: gross description entered in source system (staff attested; not acknowledged)`,
  });
  return { ...summarize(ctx.db, updated, part), replayed: false };
}

/** gross.simulateSourceAck — demo simulator: the (simulated) source system acknowledges an attested entry. */
export function simulateSourceAck(ctx: Ctx, recordId: string): GrossRecordSummary & { replayed: boolean } {
  // Demo control open to any working role, but the read-only demo roles never change state (server-side, not just a disabled button).
  // Presenter controls arrive with origin "demo" (registry.ts); a person pressing one is checked either way.
  if ((ctx.origin === "user" || ctx.origin === "demo") && READ_ONLY_ROLES.includes(ctx.actor.role)) {
    throw new DomainError("FORBIDDEN", `${ctx.actor.name} has a read-only demo role and cannot change records, including demo simulator actions.`, { role: ctx.actor.role });
  }
  const rec = loadRecord(ctx.db, recordId);
  const part = loadPart(ctx.db, rec.specimen_part_id);
  if (rec.source_update_state === "source_acknowledged") return { ...summarize(ctx.db, rec, part), replayed: true };
  if (rec.state !== "approved_for_downstream" || rec.source_update_state !== "entered_attested") {
    throw new DomainError(
      "VALIDATION",
      `A simulated acknowledgment needs an approved record that staff have marked as entered (${partLabel(part)} source update: ${rec.source_update_state.replace(/_/g, " ")}).`,
    );
  }
  const src = sourceForPart(ctx.db, part.id);
  if (src && src.status === "offline") {
    throw new DomainError(
      "SOURCE_OFFLINE",
      `${src.name} is unreachable (simulated outage), so it cannot acknowledge ${partLabel(part)} yet. The entry stays "Entered (staff attested)" until the source is back.`,
      { sourceStatus: src.status },
    );
  }
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, undefined, {
    source_update_state: "source_acknowledged", source_ack_at: ctx.now, updated_at: ctx.now,
  }) as unknown as GrossRecordRow;
  audit({ ...ctx, origin: "simulator" }, {
    action: "gross.source_ack_simulated", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `Simulated source acknowledgment (demo) for ${partLabel(part)} v${rec.record_version}. Produced by the demo simulator; no real interface exists.`,
  });
  recordWorklistChange(ctx, {
    accessionId: part.accession_id, pathologistId: part.assigned_pathologist_id, type: "changed",
    summary: `${partLabel(part)}: source system acknowledged gross description (simulated)`,
  });
  return { ...summarize(ctx.db, updated, part), replayed: false };
}

/** gross.flagNeedsClarification — park the draft with a note (a clarification to the office is raised separately). */
export function flagNeedsClarification(ctx: Ctx, recordId: string, expectedVersion: number, note: string): GrossRecordSummary {
  const rec = loadRecord(ctx.db, recordId);
  assertEditable(rec, "Cannot flag");
  assertCurrent(ctx.db, rec);
  const part = loadPart(ctx.db, rec.specimen_part_id);
  assertPartActive(part, "Cannot flag");
  const unresolved = parseJsonArray<UnresolvedItem>(rec.unresolved);
  unresolved.push({ field: "clarification", message: note.trim(), by: ctx.actor.name, at: ctx.now });
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, expectedVersion, {
    state: "needs_clarification", unresolved, reviewed_by: null, reviewed_at: null, updated_at: ctx.now,
  }) as unknown as GrossRecordRow;
  audit(ctx, {
    action: "gross.needs_clarification", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${partLabel(part)} v${rec.record_version} flagged as needing clarification: ${note.trim()}`,
  });
  // Kept in the worklist feed: the part's documentation (and so its downstream work) is now waiting on a question.
  recordWorklistChange(ctx, {
    accessionId: part.accession_id, pathologistId: part.assigned_pathologist_id, type: "changed",
    summary: `${partLabel(part)}: gross documentation needs clarification`,
  });
  return summarize(ctx.db, updated, part);
}

/** gross.resolveClarification — needs_clarification → draft, recording how the question was resolved (data-model SM-15). */
export function resolveClarification(ctx: Ctx, recordId: string, expectedVersion: number, resolution: string): GrossRecordSummary {
  const rec = loadRecord(ctx.db, recordId);
  assertEditable(rec, "Cannot resolve");
  assertCurrent(ctx.db, rec);
  const part = loadPart(ctx.db, rec.specimen_part_id);
  assertPartActive(part, "Cannot resolve");
  if (rec.state !== "needs_clarification") {
    throw new DomainError("VALIDATION", `${partLabel(part)} v${rec.record_version} is not flagged as needing clarification (it is ${rec.state.replace(/_/g, " ")}).`);
  }
  const why = resolution.trim();
  const unresolved = parseJsonArray<UnresolvedItem>(rec.unresolved).map((u) =>
    u.field === "clarification" && !u.resolvedAt ? { ...u, resolution: why, resolvedBy: ctx.actor.name, resolvedAt: ctx.now } : u,
  );
  const updated = updateVersioned(ctx.db, "gross_record", rec.id, expectedVersion, { state: "draft", unresolved, updated_at: ctx.now }) as unknown as GrossRecordRow;
  audit(ctx, {
    action: "gross.clarification_resolved", entityType: "gross_record", entityId: rec.id, accessionId: part.accession_id,
    summary: `${ctx.actor.name} recorded how the grossing question for ${partLabel(part)} v${rec.record_version} was resolved; returned to draft: ${why}`,
    reason: why,
  });
  return summarize(ctx.db, updated, part);
}

/** gross.amend — create a new draft version from an approved one; the approved version is superseded and stays unchanged. */
export function amend(ctx: Ctx, recordId: string, reason: string): { record: GrossRecordSummary; supersededId: string; replayed: boolean } {
  const db = ctx.db;
  const rec = loadRecord(db, recordId);
  const part = loadPart(db, rec.specimen_part_id);
  const why = reason.trim();
  if (rec.state === "superseded") {
    const newer = currentRecordForPart(db, part.id);
    if (newer && newer.record_version > rec.record_version) {
      // Same amendment repeated (double click / retry) → the same new version. A different reason means someone
      // else already amended it: say so instead of silently dropping this reason.
      const prior = parseJsonArray<UnresolvedItem>(newer.unresolved).find((u) => u.field === "amendment");
      const priorReason = prior?.message.replace(/^Amendment of v\d+:\s*/, "") ?? null;
      if (newer.record_version === rec.record_version + 1 && priorReason === why) {
        return { record: summarize(db, newer, part), supersededId: rec.id, replayed: true };
      }
      throw new DomainError(
        "CONFLICT",
        `v${rec.record_version} was already amended${prior?.by ? ` by ${prior.by}` : ""} (v${newer.record_version} is ${newer.state.replace(/_/g, " ")}${priorReason ? `; reason: ${priorReason}` : ""}). Open the current version instead; your reason was not recorded.`,
        { table: "gross_record", id: rec.id, currentId: newer.id, currentRecordVersion: newer.record_version, priorReason },
      );
    }
    throw new DomainError("VALIDATION", `v${rec.record_version} is already superseded`);
  }
  assertPartActive(part, "Cannot amend");
  if (rec.state !== "approved_for_downstream") {
    throw new DomainError("VALIDATION", `Only an approved version can be amended. ${partLabel(part)} v${rec.record_version} is still editable as a ${rec.state.replace(/_/g, " ")}.`);
  }
  updateVersioned(db, "gross_record", rec.id, undefined, { state: "superseded", updated_at: ctx.now });
  const unresolved: UnresolvedItem[] = [{ field: "amendment", message: `Amendment of v${rec.record_version}: ${why}`, by: ctx.actor.name, at: ctx.now }];
  const next = insertRecord(ctx, part, rec.record_version + 1, {
    fields: parseFields(rec.fields, part.procedure),
    narrative: rec.narrative,
    transcript_id: rec.transcript_id,
    proposals: rec.proposals,
    unresolved: JSON.stringify(unresolved),
    extractor: rec.extractor,
    state: "draft",
    source_update_state: "not_started",
  });
  const notes: string[] = [];
  if (rec.source_update_state === "pending_entry" || rec.source_update_state === "failed") {
    const n = closeTasks(ctx, "source_entry", "specimen_part", part.id, "canceled");
    if (n) notes.push(`source entry for v${rec.record_version} canceled before entry`);
  } else if (rec.source_update_state === "entered_attested" || rec.source_update_state === "source_acknowledged") {
    notes.push(`v${rec.record_version} was already entered in the source system; the amended text must be entered there after approval`);
  }
  const loaded = db.prepare("SELECT id, label_text FROM block WHERE part_id = ? AND status = 'active' AND physical_state = 'cassette_loaded'").all(part.id) as { id: string; label_text: string }[];
  const withdrawn = loaded.filter((b) => closeTasks(ctx, "processing_eligible", "block", b.id, "canceled") > 0).map((b) => b.label_text);
  if (withdrawn.length) notes.push(`processing eligibility for ${withdrawn.join(", ")} withdrawn until the amended version is approved`);
  audit(ctx, {
    action: "gross.amended", entityType: "gross_record", entityId: next.id, accessionId: part.accession_id,
    summary: `${ctx.actor.name} amended ${partLabel(part)}: v${rec.record_version} superseded (content unchanged), v${next.record_version} created as a draft${notes.length ? `; ${notes.join("; ")}` : ""}`,
    reason: why,
    before: { recordId: rec.id, recordVersion: rec.record_version, state: rec.state, sourceUpdateState: rec.source_update_state },
    after: {
      supersededRecordId: rec.id,
      supersededState: "superseded",
      recordId: next.id,
      recordVersion: next.record_version,
      state: "draft",
      specimenPartId: part.id,
      processingEligibilityWithdrawn: withdrawn,
    },
  });
  recordWorklistChange(ctx, {
    accessionId: part.accession_id, pathologistId: part.assigned_pathologist_id, type: "changed",
    summary: `${partLabel(part)}: gross record amended (v${next.record_version} draft, v${rec.record_version} superseded)`,
  });
  return { record: summarize(db, next, part), supersededId: rec.id, replayed: false };
}

/** Readable name for audit/UI helpers in other modules of this slice. */
export function staffDisplayName(db: DB, id: string | null | undefined): string | null {
  return staffName(db, id);
}


// When a hold is released, re-derive processing eligibility for the parts it
// covered so a cassette that just became eligible gets its task immediately.
onHoldReleased((ctx, hold) => {
  const db = ctx.db;
  let partIds: string[] = [];
  if (hold.scope_type === "specimen_part") partIds = [hold.scope_id];
  else if (hold.scope_type === "order_part") {
    partIds = (db.prepare("SELECT id FROM specimen_part WHERE source_order_part_id = ? AND status = 'active'").all(hold.scope_id) as { id: string }[]).map((r) => r.id);
  } else if (hold.scope_type === "block") {
    partIds = (db.prepare("SELECT part_id AS id FROM block WHERE id = ?").all(hold.scope_id) as { id: string }[]).map((r) => r.id);
  } else if (hold.accession_id) {
    syncProcessingEligibilityForAccession(ctx, hold.accession_id);
    return;
  }
  for (const id of partIds) syncProcessingEligibility(ctx, id);
});
