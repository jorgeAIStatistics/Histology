import type { DB } from "../db/db";
import { demoNow } from "../core/clock";
import { ACCESSION_SOURCE_ID } from "../sim/authoritative";
import { LATERALITY } from "@/lib/domain";
import { fmtTime } from "@/lib/time";

/**
 * Source-versus-local reconciliation: a READ MODEL (no writes, no side effects) over the records the importer
 * and the bench already keep. For every source order linked to local work (an intake item or an issued
 * specimen part), it compares the source's latest assertion (the newest stored order version) with the local
 * verified state, and it lists what the integration has left for a person:
 *
 *   kind               source assertion                         local verified state
 *   patient            the order's patient details              the patient reference on file
 *   parts              the order's specimen lines               issued specimen parts, or containers received
 *   site_laterality    site, laterality, procedure per line     the issued part (immutable), or the staff check
 *   cancellation       canceled at source                       local work still in progress
 *   accession          issue notices and acknowledgments        the accession request and the issued number
 *   failed_import      a message in the failure queue           nothing applied
 *   stale_ignored      an older version received late           the newer stored version kept
 *   source_conflict    an open source-conflict review           what is on file, unchanged until reviewed
 *   correction_review  an open correction review                 the issued part, unchanged until closed
 *
 * Every row carries the source's claimed event time and the local receipt time separately, the work it
 * touches (intake items, parts, holds, tasks), and whether a review is open (which task or correction).
 *
 * It is clinical data (patient details, accession numbers): callers must hold a clinical view permission
 * (GET /api/integration/reconciliation requires view.operations). It never reads or returns a secret, a
 * signature or a raw payload.
 */

export type ReconKind =
  | "patient"
  | "parts"
  | "site_laterality"
  | "cancellation"
  | "accession"
  | "failed_import"
  | "stale_ignored"
  | "source_conflict"
  | "correction_review";

/**
 * in_sync        the source and the local record agree
 * review_open    they differ and an open review (task or correction) covers it; nothing changes until a person decides
 * review_closed  they differ, and a person already reviewed it (the local record stands)
 * attention      they differ and no open review covers it (the bench screens' own blockers still apply)
 * waiting        waiting for the source (a number, or its acknowledgment)
 * failed         in the failure queue: nothing was applied
 * ignored        an older version that was not applied (the newer one is kept)
 */
export type ReconStatus = "in_sync" | "review_open" | "review_closed" | "attention" | "waiting" | "failed" | "ignored";

export interface WorkRef {
  id: string;
  label: string;
  status?: string;
}

export interface ReconRow {
  key: string;
  kind: ReconKind;
  sourceId: string | null;
  sourceName: string | null;
  entity: { type: string; id: string; label: string };
  /** What the source says (its latest assertion). */
  externalAssertion: string;
  /** What this laboratory recorded and verified. */
  localState: string;
  /** null when they agree. */
  difference: string | null;
  /** The source's claimed event time (integration_event.source_updated_at, or the order version's time). */
  sourceEventTime: string | null;
  /** When it was received here (local clock). */
  localReceivedTime: string | null;
  messageId: string | null;
  impactedWork: { intakeItems: WorkRef[]; parts: WorkRef[]; holds: WorkRef[]; tasks: WorkRef[] };
  review: {
    required: boolean;
    taskId: string | null;
    taskTitle: string | null;
    taskStatus: string | null;
    correctionReviewId: string | null;
    correctionDisplayId: string | null;
    /** An open clarification with the office that covers the difference (pre-accession). */
    clarificationId: string | null;
    clarificationDisplayId: string | null;
    note: string | null;
  };
  status: ReconStatus;
}

export interface ReconciliationData {
  generatedAt: string;
  rows: ReconRow[];
  summary: {
    ordersCompared: number;
    ordersInSync: number;
    ordersWithDifferences: number;
    failedImports: number;
    staleIgnored: number;
    openSourceConflicts: number;
    openCorrectionReviews: number;
    unacknowledgedAccessionRequests: number;
    byKind: Partial<Record<ReconKind, number>>;
    byStatus: Partial<Record<ReconStatus, number>>;
  };
}

// ------------------------------------------------------------------ rows from the database

interface OrderRow {
  id: string;
  tenant_id: string;
  source_order_id: string;
  patient_ref_id: string;
  source_status: string;
  source_version: number;
  source_updated_at: string;
  imported_at: string;
}

interface PayloadSpecimen {
  designation?: string;
  site?: string;
  laterality?: string | null;
  procedure?: string | null;
  expected_containers?: number | null;
}

interface OrderPayload {
  status?: string;
  patient?: { mrn?: string; name?: string; birth_date?: string };
  specimens?: PayloadSpecimen[];
}

interface TaskRow {
  id: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  title: string;
  status: string;
  detail: string | null;
  accession_id: string | null;
  intake_item_id: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  source_id: string;
  message_id: string;
  message_type: string;
  entity_key: string;
  source_version: number | null;
  source_updated_at: string | null;
  received_at: string;
  outcome: string;
  detail: string | null;
  payload: string;
  receipt_count: number;
}

const OPEN = new Set(["open", "in_progress"]);
const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const lat = (v: string | null | undefined) => (v ? (LATERALITY as Record<string, string>)[v] ?? v : "Unknown");
const show = (v: string | null | undefined) => (v && v.trim() ? v : "Unknown");

function parseJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function splitName(name: string): [string, string] {
  const [family, ...rest] = name.split(",");
  return [family.trim() || name.trim(), rest.join(",").trim() || "Unknown"];
}

function emptyReview(): ReconRow["review"] {
  return { required: false, taskId: null, taskTitle: null, taskStatus: null, correctionReviewId: null, correctionDisplayId: null, clarificationId: null, clarificationDisplayId: null, note: null };
}

function reviewFromTask(t: TaskRow | undefined, note?: string): ReconRow["review"] {
  if (!t) return { ...emptyReview(), required: true, note: note ?? null };
  return { ...emptyReview(), required: OPEN.has(t.status), taskId: t.id, taskTitle: t.title, taskStatus: t.status, note: note ?? null };
}

function statusFromReview(difference: string | null, review: ReconRow["review"]): ReconStatus {
  if (!difference) return "in_sync";
  if (review.taskStatus && OPEN.has(review.taskStatus)) return "review_open";
  if ((review.correctionReviewId || review.clarificationId) && review.required) return "review_open";
  if (review.taskStatus || review.correctionReviewId) return "review_closed";
  return "attention";
}

/** When no task covers a pre-accession difference, an open clarification with the office may (it is the review). */
function withClarification(review: ReconRow["review"], clr: { id: string; display_id: string; state: string } | undefined): ReconRow["review"] {
  if (!clr || (review.taskStatus && OPEN.has(review.taskStatus))) return review;
  return { ...review, required: true, clarificationId: clr.id, clarificationDisplayId: clr.display_id, note: `Open clarification ${clr.display_id} (${clr.state.replace(/_/g, " ")}).` };
}

/**
 * Build the reconciliation view. `includeInSync` also returns the comparisons that agree (by default only
 * differences and pending items are returned; the summary counts both).
 */
export function loadReconciliation(db: DB, opts: { includeInSync?: boolean } = {}): ReconciliationData {
  const now = demoNow(db);
  const rows: ReconRow[] = [];
  const claimedTasks = new Set<string>();
  const claimedCorrections = new Set<string>();

  const sources = db.prepare("SELECT id, name, tenant_id FROM integration_source").all() as { id: string; name: string; tenant_id: string | null }[];
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));
  // Each tenant is served by one source-system adapter (the first by id, should there ever be two).
  const sourceForTenant = new Map<string, string>();
  for (const s of [...sources].sort((a, b) => a.id.localeCompare(b.id))) if (s.tenant_id && !sourceForTenant.has(s.tenant_id)) sourceForTenant.set(s.tenant_id, s.id);

  const tasksFor = db.prepare("SELECT * FROM task WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC");
  const openTasksFor = (entityType: string, entityId: string, kind?: string) =>
    (tasksFor.all(entityType, entityId) as TaskRow[]).filter((t) => OPEN.has(t.status) && (!kind || t.kind === kind));
  const latestTaskFor = (entityType: string, entityId: string, kind?: string) =>
    (tasksFor.all(entityType, entityId) as TaskRow[]).filter((t) => !kind || t.kind === kind).sort((a, b) => Number(OPEN.has(b.status)) - Number(OPEN.has(a.status)))[0];

  // ------------------------------------------------------------ source orders linked to local work
  const orders = db
    .prepare(
      `SELECT so.id, so.tenant_id, so.source_order_id, so.patient_ref_id, so.source_status, so.source_version, so.source_updated_at, so.imported_at
         FROM source_order so
        WHERE EXISTS (SELECT 1 FROM intake_order_link l WHERE l.source_order_id = so.id)
           OR EXISTS (SELECT 1 FROM specimen_part sp WHERE sp.source_order_id = so.id)
        ORDER BY so.source_order_id, so.tenant_id`,
    )
    .all() as OrderRow[];

  const latestVersion = db.prepare("SELECT source_version, source_updated_at, imported_at, payload FROM source_order_version WHERE source_order_id = ? ORDER BY source_version DESC LIMIT 1");
  const latestEvent = db.prepare(
    "SELECT * FROM integration_event WHERE source_id = ? AND entity_key = ? AND outcome = 'applied' AND source_version = ? ORDER BY received_at DESC, rowid DESC LIMIT 1",
  );
  const itemsFor = db.prepare(
    `SELECT ii.id, ii.display_id, ii.status FROM intake_order_link l JOIN intake_item ii ON ii.id = l.intake_item_id WHERE l.source_order_id = ? ORDER BY ii.display_id`,
  );
  const orderParts = db.prepare("SELECT id, designation, site_text, laterality, procedure, expected_containers, status FROM source_order_part WHERE source_order_id = ? ORDER BY designation");
  const specimenParts = db.prepare(
    `SELECT sp.id, sp.designation, sp.original_designation, sp.site_text, sp.laterality, sp.procedure, sp.status, sp.source_order_part_id, a.id accession_id, a.accession_number
       FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id WHERE sp.source_order_id = ? ORDER BY a.accession_number, sp.designation`,
  );
  const containersForPart = db.prepare("SELECT id, seq, intake_item_id, verification_state FROM container WHERE order_part_id = ? ORDER BY intake_item_id, seq");
  const latestVerification = db.prepare(
    "SELECT source_order_version, result, comparison, attested_at FROM container_verification WHERE container_id = ? ORDER BY attested_at DESC, rowid DESC LIMIT 1",
  );
  const activeHolds = db.prepare("SELECT id, display_id, scope_type, scope_id, scope_label, status FROM hold WHERE status = 'active'").all() as {
    id: string;
    display_id: string;
    scope_type: string;
    scope_id: string;
    scope_label: string;
    status: string;
  }[];
  const correctionsFor = db.prepare(
    "SELECT id, display_id, status, original_refs FROM correction_review WHERE accession_id = ? AND kind = 'site_discrepancy' ORDER BY requested_at DESC",
  );
  const openClarification = db.prepare(
    `SELECT id, display_id, state FROM clarification
      WHERE state NOT IN ('resolved','canceled') AND (source_order_id = ? OR order_part_id IN (SELECT id FROM source_order_part WHERE source_order_id = ?))
      ORDER BY created_at LIMIT 1`,
  );
  const counts = db.prepare(
    `SELECT (SELECT COUNT(*) FROM block WHERE part_id = ? AND status = 'active') blocks,
            (SELECT COUNT(*) FROM slide s JOIN block b ON b.id = s.block_id WHERE b.part_id = ? AND s.status = 'active') slides`,
  );

  let ordersInSync = 0;
  let ordersWithDifferences = 0;

  for (const o of orders) {
    const sourceId = sourceForTenant.get(o.tenant_id) ?? null;
    const name = sourceId ? sourceName.get(sourceId) ?? sourceId : null;
    const v = latestVersion.get(o.id) as { source_version: number; source_updated_at: string; imported_at: string; payload: string } | undefined;
    const p = parseJson<OrderPayload>(v?.payload) ?? {};
    const ev = sourceId ? (latestEvent.get(sourceId, `${o.tenant_id}:${o.source_order_id}`, o.source_version) as EventRow | undefined) : undefined;
    const eventTime = ev?.source_updated_at ?? v?.source_updated_at ?? o.source_updated_at;
    const receivedTime = ev?.received_at ?? v?.imported_at ?? o.imported_at;
    const label = `${o.source_order_id} v${o.source_version}`;

    // Work this order touches.
    const items = itemsFor.all(o.id) as { id: string; display_id: string; status: string }[];
    const parts = orderParts.all(o.id) as { id: string; designation: string; site_text: string; laterality: string | null; procedure: string | null; expected_containers: number | null; status: string }[];
    const sps = specimenParts.all(o.id) as {
      id: string;
      designation: string;
      original_designation: string;
      site_text: string;
      laterality: string | null;
      procedure: string | null;
      status: string;
      source_order_part_id: string;
      accession_id: string;
      accession_number: string;
    }[];
    const containers = new Map(parts.map((pt) => [pt.id, containersForPart.all(pt.id) as { id: string; seq: number; intake_item_id: string; verification_state: string }[]]));
    const containerIds = new Set([...containers.values()].flat().map((c) => c.id));
    const scopeIds = new Set<string>([...items.map((i) => i.id), ...parts.map((pt) => pt.id), ...sps.map((s) => s.id), ...sps.map((s) => s.accession_id), ...containerIds]);
    const holds = activeHolds.filter((h) => scopeIds.has(h.scope_id));
    const accessionIds = [...new Set(sps.map((s) => s.accession_id))];
    const relevantTasks = [
      ...openTasksFor("source_order", o.id),
      ...openTasksFor("patient_ref", o.patient_ref_id),
      ...parts.flatMap((pt) => openTasksFor("source_order_part", pt.id)),
      ...sps.flatMap((s) => openTasksFor("specimen_part", s.id)),
      ...holds.flatMap((h) => openTasksFor("hold", h.id)),
    ];
    const impacted: ReconRow["impactedWork"] = {
      intakeItems: items.map((i) => ({ id: i.id, label: i.display_id, status: i.status })),
      parts: sps.length
        ? sps.map((s) => ({ id: s.id, label: `${s.accession_number} part ${s.designation}${s.designation !== s.original_designation ? ` (order part ${s.original_designation})` : ""}`, status: s.status }))
        : parts.map((pt) => ({ id: pt.id, label: `${o.source_order_id} part ${pt.designation}`, status: pt.status })),
      holds: holds.map((h) => ({ id: h.id, label: `${h.display_id} · ${h.scope_label}`, status: h.status })),
      tasks: [...new Map(relevantTasks.map((t) => [t.id, { id: t.id, label: t.title, status: t.status }])).values()],
    };

    const base = {
      sourceId,
      sourceName: name,
      sourceEventTime: eventTime,
      localReceivedTime: receivedTime,
      messageId: ev?.message_id ?? null,
      impactedWork: impacted,
    };
    const orderRows: ReconRow[] = [];
    const push = (r: Omit<ReconRow, keyof typeof base> & Partial<typeof base>) => orderRows.push({ ...base, ...r } as ReconRow);

    // ---- patient
    const pr = db.prepare("SELECT id, source_mrn, family_name, given_name, birth_date FROM patient_ref WHERE id = ?").get(o.patient_ref_id) as
      | { id: string; source_mrn: string; family_name: string; given_name: string; birth_date: string }
      | undefined;
    if (pr && p.patient) {
      const [family, given] = splitName(p.patient.name ?? "");
      const diffs: string[] = [];
      if (norm(p.patient.mrn) !== norm(pr.source_mrn)) diffs.push("MRN");
      if (norm(family) !== norm(pr.family_name) || norm(given) !== norm(pr.given_name)) diffs.push("name");
      if (norm(p.patient.birth_date) !== norm(pr.birth_date)) diffs.push("date of birth");
      const difference = diffs.length ? `The source's ${diffs.join(", ")} differ${diffs.length === 1 ? "s" : ""} from the patient on file; the order stays linked to the patient on file and nothing was merged.` : null;
      const task = difference ? latestTaskFor("patient_ref", pr.id, "source_conflict") ?? latestTaskFor("source_order", o.id, "source_conflict") : undefined;
      const review = difference ? reviewFromTask(task, task ? undefined : "No review task covers this difference.") : emptyReview();
      if (task) claimedTasks.add(task.id);
      push({
        key: `patient:${o.id}`,
        kind: "patient",
        entity: { type: "source_order", id: o.id, label },
        externalAssertion: `MRN ${show(p.patient.mrn)} · ${show(p.patient.name)} · born ${show(p.patient.birth_date)}`,
        localState: `MRN ${pr.source_mrn} · ${pr.family_name}, ${pr.given_name} · born ${pr.birth_date}`,
        difference,
        review,
        status: statusFromReview(difference, review),
      });
    }

    // ---- parts (lines on the order vs issued parts / containers received)
    const canceledAtSource = o.source_status === "canceled" || p.status === "canceled";
    const sourceLines = canceledAtSource ? [] : (p.specimens ?? []).filter((s) => s.designation);
    const sourceSet = new Set(sourceLines.map((s) => (s.designation ?? "").toUpperCase()));
    const activeSps = sps.filter((s) => s.status !== "canceled");
    if (sps.length) {
      const issued = new Set(activeSps.map((s) => s.original_designation.toUpperCase()));
      const added = [...sourceSet].filter((d) => !issued.has(d));
      const removed = canceledAtSource ? [] : activeSps.filter((s) => !sourceSet.has(s.original_designation.toUpperCase()));
      const accessions = [...new Set(sps.map((s) => s.accession_number))].join(", ");
      const diffs = [
        ...added.map((d) => `part ${d} is on the order but not on ${accessions} (added at source after accession; no part was created)`),
        ...removed.map((s) => `${s.accession_number} part ${s.designation} was removed at source (the issued part and its material are kept)`),
      ];
      const difference = diffs.length ? `${diffs.join("; ")}.` : null;
      const task = difference
        ? (added.length ? latestTaskFor("source_order", o.id, "order_change_review") : undefined) ??
          removed.map((s) => latestTaskFor("specimen_part", s.id, "order_change_review")).find(Boolean)
        : undefined;
      if (task) claimedTasks.add(task.id);
      const review = difference ? reviewFromTask(task, task ? undefined : "No review task covers this difference.") : emptyReview();
      push({
        key: `parts:${o.id}`,
        kind: "parts",
        entity: { type: "source_order", id: o.id, label },
        externalAssertion: sourceLines.length ? `Parts ${[...sourceSet].sort().join(", ")}` : canceledAtSource ? "Order canceled (no active parts)" : "No parts",
        localState: `Issued on ${accessions}: parts ${activeSps.map((s) => (s.designation === s.original_designation ? s.designation : `${s.designation} (order part ${s.original_designation})`)).join(", ") || "none active"}`,
        difference,
        review,
        status: statusFromReview(difference, review),
      });
    } else if (items.length) {
      const diffs: string[] = [];
      const local: string[] = [];
      for (const line of sourceLines) {
        const part = parts.find((pt) => pt.designation.toUpperCase() === (line.designation ?? "").toUpperCase());
        const received = part ? containers.get(part.id)?.length ?? 0 : 0;
        local.push(`part ${line.designation}: ${received} container${received === 1 ? "" : "s"} received`);
        if (typeof line.expected_containers === "number" && received < line.expected_containers) {
          diffs.push(`part ${line.designation}: ${line.expected_containers} expected, ${received} received`);
        }
      }
      for (const pt of parts.filter((x) => x.status === "canceled")) {
        const n = containers.get(pt.id)?.length ?? 0;
        if (n) diffs.push(`part ${pt.designation} was removed at source but ${n} container${n === 1 ? " is" : "s are"} linked to it`);
      }
      const difference = diffs.length ? `${diffs.join("; ")}.` : null;
      const task = difference ? parts.map((pt) => latestTaskFor("source_order_part", pt.id, "order_change_review")).find(Boolean) : undefined;
      if (task) claimedTasks.add(task.id);
      const review = difference
        ? withClarification(
            reviewFromTask(task, task ? undefined : "Accession stays blocked until every expected container is received or its absence is covered by a clarification."),
            openClarification.get(o.id, o.id) as { id: string; display_id: string; state: string } | undefined,
          )
        : emptyReview();
      push({
        key: `parts:${o.id}`,
        kind: "parts",
        entity: { type: "source_order", id: o.id, label },
        externalAssertion: sourceLines.length
          ? sourceLines.map((s) => `part ${s.designation}${typeof s.expected_containers === "number" ? ` (${s.expected_containers} container${s.expected_containers === 1 ? "" : "s"})` : ""}`).join(", ")
          : canceledAtSource ? "Order canceled (no active parts)" : "No parts",
        localState: local.join("; ") || "No containers linked",
        difference,
        review,
        status: statusFromReview(difference, review),
      });
    }

    // ---- site / laterality / procedure per part
    for (const line of sourceLines) {
      const d = (line.designation ?? "").toUpperCase();
      const sp = activeSps.find((s) => s.original_designation.toUpperCase() === d);
      const external = `Part ${line.designation}: ${show(line.site)} · ${lat(line.laterality)} · ${show(line.procedure)}`;
      if (sp) {
        const fields: string[] = [];
        if (norm(line.site) !== norm(sp.site_text)) fields.push("site");
        if (norm(line.laterality) !== norm(sp.laterality)) fields.push("laterality");
        if (norm(line.procedure) !== norm(sp.procedure)) fields.push("procedure");
        const difference = fields.length ? `The source's ${fields.join(", ")} differ${fields.length === 1 ? "s" : ""} from issued part ${sp.accession_number} ${sp.designation}; the issued part is never changed by a message.` : null;
        let review = emptyReview();
        if (difference) {
          const reviews = (correctionsFor.all(sp.accession_id) as { id: string; display_id: string; status: string; original_refs: string }[]).filter(
            (c) => parseJson<{ part_designation?: string }>(c.original_refs)?.part_designation === sp.designation,
          );
          const open = reviews.find((c) => c.status === "open" || c.status === "referred_to_source_process");
          const chosen = open ?? reviews[0];
          if (chosen) {
            claimedCorrections.add(chosen.id);
            review = { ...emptyReview(), required: !!open, correctionReviewId: chosen.id, correctionDisplayId: chosen.display_id, note: open ? null : `Correction review closed (${chosen.status.replace(/_/g, " ")}).` };
          } else review = { ...emptyReview(), required: true, note: "No correction review covers this difference." };
        }
        const status: ReconStatus = !difference ? "in_sync" : review.correctionReviewId ? (review.required ? "review_open" : "review_closed") : "attention";
        push({
          key: `site:${o.id}:${d}`,
          kind: "site_laterality",
          entity: { type: "specimen_part", id: sp.id, label: `${sp.accession_number} part ${sp.designation}` },
          externalAssertion: external,
          localState: `Issued part ${sp.designation}: ${sp.site_text} · ${lat(sp.laterality)} · ${show(sp.procedure)}`,
          difference,
          review,
          status,
          impactedWork: { ...impacted, parts: impacted.parts.filter((x) => x.id === sp.id) },
        });
        continue;
      }
      // Pre-accession: the staff check of each container linked to this order part.
      const part = parts.find((pt) => pt.designation.toUpperCase() === d);
      const linked = part ? containers.get(part.id) ?? [] : [];
      if (!part || !linked.length) continue;
      const checks = linked.map((c) => ({ c, v: latestVerification.get(c.id) as { source_order_version: number; result: string; comparison: string; attested_at: string } | undefined }));
      const diffs: string[] = [];
      const local: string[] = [];
      for (const { c, v: ver } of checks) {
        if (!ver) {
          local.push(`container ${c.seq}: not yet checked`);
          continue;
        }
        const differs = (parseJson<{ field: string; label?: string; status: string }[]>(ver.comparison) ?? [])
          .filter((r) => r.status === "differs" && ["site", "laterality", "procedure"].includes(r.field))
          .map((r) => (r.label ?? r.field).toLowerCase());
        local.push(`container ${c.seq}: ${ver.result === "verified" ? "verified" : "discrepancy recorded"} against v${ver.source_order_version}`);
        if (ver.source_order_version < o.source_version) diffs.push(`container ${c.seq} was checked against v${ver.source_order_version}; the source is now at v${o.source_version}`);
        else if (differs.length) diffs.push(`container ${c.seq}: the staff check found ${differs.join(", ")} different from the order`);
      }
      const difference = diffs.length ? `${diffs.join("; ")}.` : null;
      const holdTask = holds.map((h) => latestTaskFor("hold", h.id, "order_change_review")).find(Boolean);
      const task = difference ? latestTaskFor("source_order_part", part.id, "order_change_review") ?? holdTask : undefined;
      if (task) claimedTasks.add(task.id);
      const review = difference
        ? withClarification(
            reviewFromTask(task, task ? undefined : "Accession stays blocked until the container is checked against the current version or the difference is covered by a clarification."),
            openClarification.get(o.id, o.id) as { id: string; display_id: string; state: string } | undefined,
          )
        : emptyReview();
      push({
        key: `site:${o.id}:${d}`,
        kind: "site_laterality",
        entity: { type: "source_order_part", id: part.id, label: `${o.source_order_id} part ${part.designation}` },
        externalAssertion: external,
        localState: local.join("; "),
        difference,
        review,
        status: statusFromReview(difference, review),
      });
    }

    // ---- canceled at source while local work is in progress
    if (canceledAtSource) {
      const inProgress: string[] = [];
      for (const s of activeSps) {
        const c = counts.get(s.id, s.id) as { blocks: number; slides: number };
        inProgress.push(`${s.accession_number} part ${s.designation} (${c.blocks} block${c.blocks === 1 ? "" : "s"}, ${c.slides} slide${c.slides === 1 ? "" : "s"})`);
      }
      for (const i of items.filter((x) => x.status !== "canceled" && x.status !== "accessioned")) inProgress.push(`${i.display_id} (${i.status.replace(/_/g, " ")})`);
      const difference = inProgress.length ? `Canceled at source while local work is in progress: ${inProgress.join(", ")}. Nothing was discarded.` : null;
      const task = difference
        ? activeSps.map((s) => latestTaskFor("specimen_part", s.id, "order_change_review")).find(Boolean) ??
          holds.map((h) => latestTaskFor("hold", h.id, "order_change_review")).find(Boolean) ??
          parts.map((pt) => latestTaskFor("source_order_part", pt.id, "order_change_review")).find(Boolean)
        : undefined;
      if (task) claimedTasks.add(task.id);
      const review = difference ? reviewFromTask(task, task ? undefined : "No review task covers the work in progress.") : emptyReview();
      push({
        key: `cancel:${o.id}`,
        kind: "cancellation",
        entity: { type: "source_order", id: o.id, label },
        externalAssertion: `${o.source_order_id} canceled at source (v${o.source_version})`,
        localState: inProgress.length ? `In progress: ${inProgress.join(", ")}` : "No local work in progress",
        difference,
        review,
        status: statusFromReview(difference, review),
      });
    }

    const differing = orderRows.some((r) => r.difference);
    if (differing) ordersWithDifferences += 1;
    else ordersInSync += 1;
    rows.push(...(opts.includeInSync ? orderRows : orderRows.filter((r) => r.status !== "in_sync")));
  }

  // ------------------------------------------------------------ accession requests: requested vs issued vs acknowledged
  const requests = db.prepare("SELECT * FROM accession_request ORDER BY requested_at, display_id").all() as {
    id: string;
    display_id: string;
    status: string;
    requested_at: string;
    requested_by: string | null;
    accession_id: string | null;
    failure_detail: string | null;
  }[];
  const accTenant = (db.prepare("SELECT tenant_id FROM integration_source WHERE id = ?").get(ACCESSION_SOURCE_ID) as { tenant_id: string | null } | undefined)?.tenant_id ?? ACCESSION_SOURCE_ID;
  let unacknowledged = 0;
  for (const r of requests) {
    const acc = r.accession_id
      ? (db.prepare("SELECT id, accession_number, namespace, issued_at FROM accession WHERE id = ?").get(r.accession_id) as
          | { id: string; accession_number: string; namespace: string; issued_at: string }
          | undefined)
      : undefined;
    const reqItems = db
      .prepare("SELECT ii.id, ii.display_id, ii.status FROM accession_request_item ai JOIN intake_item ii ON ii.id = ai.intake_item_id WHERE ai.request_id = ? ORDER BY ii.display_id")
      .all(r.id) as { id: string; display_id: string; status: string }[];
    const inProcess = db
      .prepare("SELECT * FROM integration_event WHERE source_id = ? AND message_id = ? AND message_type = 'accession.issued'")
      .get(ACCESSION_SOURCE_ID, `accession.issued:${r.display_id}`) as EventRow | undefined;
    const inbound = db
      .prepare("SELECT * FROM integration_event WHERE entity_key = ? AND message_type IN ('accession.issued','accession.acknowledged') AND outcome = 'applied' ORDER BY received_at, rowid")
      .all(`${accTenant}:accession_request:${r.display_id}`) as EventRow[];
    const acks = inbound.filter((e) => e.message_type === "accession.acknowledged");
    const lastAck = acks[acks.length - 1];
    const ackPayload = parseJson<{ accession_number?: string | null; namespace?: string | null }>(lastAck?.payload);
    const mismatchTasks = inbound.flatMap((e) => (tasksFor.all("integration_event", e.id) as TaskRow[]).filter((t) => t.kind === "source_conflict"));
    const openMismatch = mismatchTasks.find((t) => OPEN.has(t.status));
    for (const t of mismatchTasks) claimedTasks.add(t.id);

    const ackMatches = !!lastAck && (!ackPayload?.accession_number || (!!acc && ackPayload.accession_number === acc.accession_number && (ackPayload.namespace ?? acc.namespace) === acc.namespace));
    const issuedAck = !!acc && !!lastAck && !!ackPayload?.accession_number && ackMatches;
    let status: ReconStatus;
    let difference: string | null;
    let external: string;
    if (openMismatch) {
      status = "review_open";
      difference = "The source's accession notice does not match this laboratory's record; nothing was changed.";
    } else if (r.status === "submitted") {
      status = "waiting";
      difference = lastAck ? "Acknowledged by the source; no number issued yet." : "Waiting for the source: no number issued and no acknowledgment yet.";
    } else if (r.status === "issued" && acc) {
      if (issuedAck) {
        status = "in_sync";
        difference = null;
      } else {
        status = "waiting";
        difference = `Issued ${acc.accession_number}; waiting for the source's acknowledgment.`;
      }
    } else {
      status = "attention";
      difference = `Request is ${r.status.replace(/_/g, " ")}${r.failure_detail ? `: ${r.failure_detail}` : ""}.`;
    }
    if (status === "waiting") unacknowledged += 1;
    if (lastAck) external = ackPayload?.accession_number ? `Acknowledged ${ackPayload.accession_number} at ${fmtTime(lastAck.source_updated_at)} ET` : `Acknowledged the request at ${fmtTime(lastAck.source_updated_at)} ET (no number)`;
    else if (inProcess) external = `Issued ${acc?.accession_number ?? "a number"} (simulated issuer); no acknowledgment yet`;
    else external = "No reply from the source yet";
    // Provenance shown: the source's latest acknowledgment, else its latest notice, else the in-process issue event.
    const latest = lastAck ?? inbound[inbound.length - 1] ?? inProcess;
    const row: ReconRow = {
      key: `accession:${r.id}`,
      kind: "accession",
      sourceId: ACCESSION_SOURCE_ID,
      sourceName: sourceName.get(ACCESSION_SOURCE_ID) ?? ACCESSION_SOURCE_ID,
      entity: { type: "accession_request", id: r.id, label: r.display_id },
      externalAssertion: external,
      localState:
        r.status === "issued" && acc
          ? `Issued ${acc.accession_number} (${acc.namespace}) at ${fmtTime(acc.issued_at)} ET for ${reqItems.map((i) => i.display_id).join(" + ")}`
          : `Requested at ${fmtTime(r.requested_at)} ET for ${reqItems.map((i) => i.display_id).join(" + ")}; ${r.status === "submitted" ? "no number issued (waiting for the source)" : r.status.replace(/_/g, " ")}`,
      difference,
      sourceEventTime: latest?.source_updated_at ?? null,
      localReceivedTime: latest?.received_at ?? r.requested_at,
      messageId: latest?.message_id ?? null,
      impactedWork: {
        intakeItems: reqItems.map((i) => ({ id: i.id, label: i.display_id, status: i.status })),
        parts: acc
          ? (db.prepare("SELECT id, designation, status FROM specimen_part WHERE accession_id = ? ORDER BY designation").all(acc.id) as { id: string; designation: string; status: string }[]).map((s) => ({
              id: s.id,
              label: `${acc.accession_number} part ${s.designation}`,
              status: s.status,
            }))
          : [],
        holds: [],
        tasks: mismatchTasks.filter((t) => OPEN.has(t.status)).map((t) => ({ id: t.id, label: t.title, status: t.status })),
      },
      review: openMismatch
        ? { ...emptyReview(), required: true, taskId: openMismatch.id, taskTitle: openMismatch.title, taskStatus: openMismatch.status }
        : { ...emptyReview(), note: status === "waiting" ? "Nothing to do here: the source's reply is awaited. A request still waiting for a number can be retried on the Intake screen." : null },
      status,
    };
    if (opts.includeInSync || status !== "in_sync") rows.push(row);
  }

  // ------------------------------------------------------------ failure queue and stale messages
  const eventLabel = (e: EventRow) => {
    const key = e.entity_key.includes(":") ? e.entity_key.slice(e.entity_key.indexOf(":") + 1) : e.entity_key;
    return `${e.message_type} ${key.replace(/^accession_request:/, "")}${e.source_version !== null ? ` v${e.source_version}` : ""}`;
  };
  const failed = db.prepare("SELECT * FROM integration_event WHERE outcome = 'failed' ORDER BY received_at DESC, rowid DESC").all() as EventRow[];
  for (const e of failed) {
    rows.push({
      key: `failed:${e.id}`,
      kind: "failed_import",
      sourceId: e.source_id,
      sourceName: sourceName.get(e.source_id) ?? e.source_id,
      entity: { type: "integration_event", id: e.id, label: e.message_id },
      externalAssertion: eventLabel(e),
      localState: `Not applied; kept in the failure queue (${e.receipt_count} deliver${e.receipt_count === 1 ? "y" : "ies"})`,
      difference: e.detail ?? "Could not be applied.",
      sourceEventTime: e.source_updated_at,
      localReceivedTime: e.received_at,
      messageId: e.message_id,
      impactedWork: { intakeItems: [], parts: [], holds: [], tasks: [] },
      review: { ...emptyReview(), required: true, note: "Retry it from the failure queue (supervisor), or have the source re-send the same message id with corrected data." },
      status: "failed",
    });
  }
  const stale = db.prepare("SELECT * FROM integration_event WHERE outcome = 'stale_ignored' ORDER BY received_at DESC, rowid DESC").all() as EventRow[];
  const storedVersion = db.prepare("SELECT source_version FROM source_order WHERE tenant_id || ':' || source_order_id = ?");
  for (const e of stale) {
    const task = latestTaskFor("integration_event", e.id, "source_conflict");
    if (task) claimedTasks.add(task.id);
    const stored = storedVersion.get(e.entity_key) as { source_version: number } | undefined;
    const open = !!task && OPEN.has(task.status);
    rows.push({
      key: `stale:${e.id}`,
      kind: "stale_ignored",
      sourceId: e.source_id,
      sourceName: sourceName.get(e.source_id) ?? e.source_id,
      entity: { type: "integration_event", id: e.id, label: e.message_id },
      externalAssertion: eventLabel(e),
      localState: stored ? `Stored v${stored.source_version} kept` : "Stored version kept",
      difference: task ? "Same version number with different content: the stored version was kept and a review task was opened." : "An older version arrived after a newer one; it was not applied.",
      sourceEventTime: e.source_updated_at,
      localReceivedTime: e.received_at,
      messageId: e.message_id,
      impactedWork: { intakeItems: [], parts: [], holds: [], tasks: task && open ? [{ id: task.id, label: task.title, status: task.status }] : [] },
      review: task ? reviewFromTask(task) : emptyReview(),
      status: open ? "review_open" : "ignored",
    });
  }

  // ------------------------------------------------------------ open reviews not already shown on a row above
  const openConflicts = db.prepare("SELECT * FROM task WHERE kind = 'source_conflict' AND status IN ('open','in_progress') ORDER BY created_at, id").all() as TaskRow[];
  const describeEntity = (type: string, id: string): { label: string; sourceId: string | null } => {
    const tenantSource = (tenant: string | null | undefined) => (tenant ? sourceForTenant.get(tenant) ?? null : null);
    if (type === "source_order") {
      const so = db.prepare("SELECT source_order_id, tenant_id, source_version FROM source_order WHERE id = ?").get(id) as { source_order_id: string; tenant_id: string; source_version: number } | undefined;
      return so ? { label: `${so.source_order_id} v${so.source_version}`, sourceId: tenantSource(so.tenant_id) } : { label: "Source order", sourceId: null };
    }
    if (type === "patient_ref") {
      const pr = db.prepare("SELECT tenant_id FROM patient_ref WHERE id = ?").get(id) as { tenant_id: string } | undefined;
      return { label: "Patient reference on file", sourceId: tenantSource(pr?.tenant_id) };
    }
    if (type === "integration_event") {
      const e = db.prepare("SELECT message_id, source_id FROM integration_event WHERE id = ?").get(id) as { message_id: string; source_id: string } | undefined;
      return e ? { label: e.message_id, sourceId: e.source_id } : { label: "Source message", sourceId: null };
    }
    if (type === "office") {
      const off = db.prepare("SELECT code, tenant_id FROM office WHERE id = ?").get(id) as { code: string; tenant_id: string | null } | undefined;
      return off ? { label: `Office ${off.code}`, sourceId: tenantSource(off.tenant_id) } : { label: "Office", sourceId: null };
    }
    return { label: type.replace(/_/g, " "), sourceId: null };
  };
  for (const t of openConflicts) {
    if (claimedTasks.has(t.id)) continue;
    const ent = describeEntity(t.entity_type, t.entity_id);
    rows.push({
      key: `conflict:${t.id}`,
      kind: "source_conflict",
      sourceId: ent.sourceId,
      sourceName: ent.sourceId ? sourceName.get(ent.sourceId) ?? ent.sourceId : null,
      entity: { type: t.entity_type, id: t.entity_id, label: ent.label },
      externalAssertion: t.title,
      localState: "What is on file stays in effect until the review is done.",
      difference: t.detail,
      sourceEventTime: null,
      localReceivedTime: t.created_at,
      messageId: null,
      impactedWork: { intakeItems: [], parts: [], holds: [], tasks: [{ id: t.id, label: t.title, status: t.status }] },
      review: reviewFromTask(t),
      status: "review_open",
    });
  }
  const openCorrections = db
    .prepare(
      `SELECT cr.id, cr.display_id, cr.status, cr.description, cr.original_refs, cr.requested_at, cr.accession_id, a.accession_number
         FROM correction_review cr JOIN accession a ON a.id = cr.accession_id
        WHERE cr.status IN ('open','referred_to_source_process') ORDER BY cr.requested_at, cr.id`,
    )
    .all() as { id: string; display_id: string; status: string; description: string; original_refs: string; requested_at: string; accession_id: string; accession_number: string }[];
  for (const c of openCorrections) {
    if (claimedCorrections.has(c.id)) continue;
    const refs = parseJson<{ part_designation?: string; amended_order_version?: string; specimen_part?: { site_text?: string; laterality?: string | null } }>(c.original_refs);
    rows.push({
      key: `correction:${c.id}`,
      kind: "correction_review",
      sourceId: null,
      sourceName: null,
      entity: { type: "correction_review", id: c.id, label: `${c.display_id} · ${c.accession_number}${refs?.part_designation ? ` part ${refs.part_designation}` : ""}` },
      externalAssertion: refs?.amended_order_version ? `Source ${refs.amended_order_version}` : "Correction requested",
      localState: refs?.specimen_part ? `Issued: ${show(refs.specimen_part.site_text)} · ${lat(refs.specimen_part.laterality)}` : `Accession ${c.accession_number} unchanged`,
      difference: c.description,
      sourceEventTime: null,
      localReceivedTime: c.requested_at,
      messageId: null,
      impactedWork: { intakeItems: [], parts: [], holds: [], tasks: [] },
      review: { ...emptyReview(), required: true, correctionReviewId: c.id, correctionDisplayId: c.display_id },
      status: "review_open",
    });
  }

  const byKind: ReconciliationData["summary"]["byKind"] = {};
  const byStatus: ReconciliationData["summary"]["byStatus"] = {};
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  return {
    generatedAt: now,
    rows,
    summary: {
      ordersCompared: orders.length,
      ordersInSync,
      ordersWithDifferences,
      failedImports: failed.length,
      staleIgnored: stale.length,
      openSourceConflicts: openConflicts.length,
      openCorrectionReviews: openCorrections.length,
      unacknowledgedAccessionRequests: unacknowledged,
      byKind,
      byStatus,
    },
  };
}
