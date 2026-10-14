/**
 * Read model for /operations: what is blocked right now, who owns the next
 * step, how old it is, and the evidence. Every number is computed from the
 * synthetic demo records at the demo clock and links to those records. No
 * scores, rankings, health percentages or savings.
 */
import type { DB } from "@/server/db/db";
import { demoNow } from "@/server/core/clock";
import { fmtAge, fmtSmart, fmtTime, minutesBetween } from "@/lib/time";
import { CLARIFICATION_STATE, STAGE, type Stage } from "@/lib/domain";
import { AGE_BUCKET_LABELS } from "@/lib/tokens";
import { isGrossPending, loadSourceFreshness, loadWorklistRows, type FreshnessSummary } from "./worklist";
import { plural } from "@/components/worklist/format";

export interface OpsTile {
  key: string;
  label: string;
  value: number | null;
  /** Shown instead of a number when the count cannot be computed. */
  unknownReason?: string;
  caveat?: string;
  href: string;
  tone: "neutral" | "warning" | "danger" | "hold" | "info";
}

export type BlockedCategory =
  | "holds"
  | "clarifications"
  | "print"
  | "trays"
  | "routing"
  | "retrieval"
  | "source_entry"
  | "review";

export const BLOCKED_CATEGORY_LABEL: Record<BlockedCategory, string> = {
  holds: "Holds",
  clarifications: "Clarifications",
  print: "Print jobs",
  trays: "Trays",
  routing: "Routing exceptions",
  retrieval: "Block retrieval",
  source_entry: "Source-system entry",
  review: "Reviews",
};

export interface BlockedItem {
  key: string;
  category: BlockedCategory;
  item: string;
  /** The identifier part of `item` (shown in monospace) and the plain-text rest. */
  ref?: string;
  subject?: string;
  itemHref: string;
  blocks: string;
  nextStep: string;
  owner: string;
  ownerId: string | null;
  since: string | null;
  age: string;
  evidenceLabel: string;
  evidenceHref: string;
  /** Clarifications only: the follow-up time has passed (what the "Clarifications overdue" tile counts). */
  overdue?: boolean;
}

export interface QueueAgeRow {
  stage: Stage;
  label: string;
  /** Parts per age bucket: under 1 h, 1 to 4 h, 4 to 8 h, over 8 h. */
  buckets: [number, number, number, number];
  total: number;
  unknown: number;
}

export interface HandoffLine {
  text: string;
  evidence: { label: string; href: string }[];
}

export interface OperationsData {
  generatedAt: string;
  note: string;
  tiles: OpsTile[];
  blocked: BlockedItem[];
  freshness: FreshnessSummary;
  queueAge: { rows: QueueAgeRow[]; bucketLabels: readonly string[]; definition: string; partsCounted: number };
  handoffs: { label: string; lines: HandoffLine[] };
}

function count(db: DB, sql: string, ...params: unknown[]): number | null {
  try {
    return (db.prepare(sql).get(...params) as { n: number }).n;
  } catch (e) {
    console.error("[operations] count failed", e);
    return null;
  }
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** What a waiting review task holds up, in plain words (the task title says what to do). */
const REVIEW_BLOCKS: Record<string, string> = {
  order_change_review: "The source order changed after material was printed or prepared. Nothing is removed until a person reviews it.",
  correction_review: "Discrepancy found after accessioning. Original references are kept; the correction happens in the source system.",
  source_conflict: "Conflicting source data waits for a person to review it.",
  related_order_review: "Possible related orders wait for a reviewer's decision. Nothing is merged.",
  gross_review: "Gross record waits for operator review.",
  container_verification: "Container not yet checked by staff against the order.",
  clarification_followup: "A clarification follow-up is due.",
  tray_exception: "Tray exception waits for a controlled resolution.",
  routing_exception: "No approved routing rule; a lead assigns a dermatopathologist with a reason.",
};

/** Display order of blocked work: exceptions before routine queues. */
const CATEGORY_ORDER: BlockedCategory[] = ["holds", "clarifications", "print", "trays", "routing", "retrieval", "review", "source_entry"];
const SOURCE_ENTRY_BLOCKS = "Approved; not yet entered in the source system (manual entry)";

const QUEUE_STAGES: Stage[] = ["awaiting_gross", "gross_in_progress", "processing", "embedding", "sectioning", "staining", "qc", "ready_for_tray"];

export function getOperations(db: DB): OperationsData {
  const now = demoNow(db);
  const freshness = loadSourceFreshness(db, now);
  const staff = new Map((db.prepare("SELECT id, display_name FROM staff").all() as { id: string; display_name: string }[]).map((s) => [s.id, s.display_name]));
  const nameOf = (id: string | null | undefined) => (id ? staff.get(id) ?? id : null);
  const sourceCaveat = freshness.stale ? "Source unreachable or out of date: acknowledgments cannot arrive until it is back." : undefined;

  // Parts on today's worklist. Tiles that link to the worklist are counted from these same rows,
  // so the number on the tile is exactly what the link opens.
  const rows = loadWorklistRows(db, Number.MAX_SAFE_INTEGER, now, { includeIntake: false });
  const activeWorklistParts = rows.flatMap((r) => r.parts).filter((p) => p.status !== "canceled");
  const awaitingApproved = activeWorklistParts.filter(isGrossPending).length;
  const pendingEntry = rows.reduce((n, r) => n + r.sourceEntry.pendingParts.length, 0);
  const attested = rows.reduce((n, r) => n + r.sourceEntry.attestedParts.length, 0);
  const attestedAll = count(db, "SELECT COUNT(*) n FROM gross_record WHERE state = 'approved_for_downstream' AND source_update_state = 'entered_attested'");
  const attestedElsewhere = attestedAll === null ? null : Math.max(0, attestedAll - attested);
  // How long the oldest attested entry on today's worklist has waited for the source's acknowledgment.
  const attestedPartIds = new Set(rows.flatMap((r) => r.parts.filter((p) => r.sourceEntry.attestedParts.includes(p.designation)).map((p) => p.partId)));
  const oldestAttested = (db.prepare("SELECT specimen_part_id, source_entry_at FROM gross_record WHERE state = 'approved_for_downstream' AND source_update_state = 'entered_attested' AND source_entry_at IS NOT NULL").all() as { specimen_part_id: string; source_entry_at: string }[])
    .filter((g) => attestedPartIds.has(g.specimen_part_id))
    .reduce<string | null>((o, g) => (!o || Date.parse(g.source_entry_at) < Date.parse(o) ? g.source_entry_at : o), null);

  // ------------------------------------------------------------ tiles
  const tiles: OpsTile[] = [
    { key: "holds", label: "Holds open", value: count(db, "SELECT COUNT(*) n FROM hold WHERE status = 'active'"), href: "/operations?category=holds#blocked", tone: "hold" },
    // Filled in below from the blocked list (same records the link opens).
    { key: "clarifications_overdue", label: "Clarifications overdue", value: null, href: "/operations?category=clarifications&overdue=1#blocked", tone: "warning" },
    {
      key: "awaiting_gross", label: "Parts awaiting an approved gross record",
      value: awaitingApproved,
      caveat: "No gross record yet, or a draft not yet approved. Per part, today's worklist.",
      href: "/worklist?view=grossing&queue=gross_pending", tone: "neutral",
    },
    {
      key: "source_pending", label: "Approved records awaiting source-system entry",
      value: pendingEntry,
      caveat: "Per part, including late entries from earlier days.",
      href: "/worklist?view=grossing&queue=source_entry", tone: "warning",
    },
    {
      key: "source_attested", label: "Entered (staff attested), awaiting source acknowledgment",
      value: attested,
      caveat: [
        sourceCaveat ?? "A local attestation is not an acknowledgment.",
        oldestAttested ? `Oldest entered ${fmtAge(oldestAttested, now)} ago.` : "",
        attestedElsewhere ? `Per part, today's worklist; ${attestedElsewhere} more on earlier delivered cases.` : "Per part, today's worklist.",
      ].filter(Boolean).join(" "),
      href: "/worklist?view=grossing&queue=source_attested", tone: "info",
    },
    { key: "print_unknown", label: "Print jobs with unknown outcome", value: count(db, "SELECT COUNT(*) n FROM print_job WHERE state = 'unknown_outcome'"), href: "/operations?category=print#blocked", tone: "warning" },
    {
      key: "trays_blocked", label: "Trays blocked or in exception",
      value: count(
        db,
        `SELECT COUNT(*) n FROM tray t WHERE t.status = 'exception'
            OR (t.status IN ('open','assembling') AND EXISTS (SELECT 1 FROM tray_scan s WHERE s.tray_id = t.id AND s.result <> 'verified_expected' AND s.resolution IS NULL))`,
      ),
      href: "/operations?category=trays#blocked", tone: "danger",
    },
    { key: "retrieval_open", label: "Block retrieval requests open", value: count(db, "SELECT COUNT(*) n FROM retrieval_request WHERE status IN ('open','picking','partially_retrieved')"), href: "/operations?category=retrieval#blocked", tone: "neutral" },
    {
      key: "routing_exceptions", label: "Routing exceptions",
      value: count(db, "SELECT COUNT(*) n FROM routing_decision rd JOIN intake_item ii ON ii.id = rd.intake_item_id WHERE rd.status = 'exception' AND ii.status NOT IN ('accessioned','canceled')"),
      href: "/operations?category=routing#blocked", tone: "warning",
    },
  ];

  // ------------------------------------------------------------ blocked work
  const openTasks = db
    .prepare("SELECT * FROM task WHERE status IN ('open','in_progress') ORDER BY created_at")
    .all() as { id: string; kind: string; entity_type: string; entity_id: string; title: string; owner_id: string | null; owner_role: string | null; created_at: string; accession_id: string | null; intake_item_id: string | null; due_at: string | null }[];
  const taskFor = (entityType: string, entityId: string, kind?: string) => openTasks.find((t) => t.entity_type === entityType && t.entity_id === entityId && (!kind || t.kind === kind));
  const ownerOf = (t: { owner_id: string | null; owner_role: string | null } | undefined, fallback: string) =>
    t ? nameOf(t.owner_id) ?? `Unassigned${t.owner_role ? ` (${t.owner_role.replace(/_/g, " ")})` : ""}` : fallback;
  const usedTasks = new Set<string>();
  const blocked: BlockedItem[] = [];
  const accNumber = new Map((db.prepare("SELECT id, accession_number FROM accession").all() as { id: string; accession_number: string }[]).map((r) => [r.id, r.accession_number]));
  const caseHref = (accId: string | null | undefined) => (accId && accNumber.get(accId) ? `/cases/${encodeURIComponent(accNumber.get(accId)!)}` : null);
  const intakeDisplay = new Map((db.prepare("SELECT id, display_id FROM intake_item").all() as { id: string; display_id: string }[]).map((r) => [r.id, r.display_id]));
  const clrDisplay = new Map((db.prepare("SELECT id, display_id FROM clarification").all() as { id: string; display_id: string }[]).map((r) => [r.id, r.display_id]));
  const taskRecordHref = (t: { accession_id: string | null; intake_item_id: string | null; entity_type: string; entity_id: string }) =>
    caseHref(t.accession_id) ??
    (t.intake_item_id ? `/intake?item=${encodeURIComponent(intakeDisplay.get(t.intake_item_id) ?? t.intake_item_id)}` : null) ??
    (t.entity_type === "clarification" ? `/clarifications?selected=${encodeURIComponent(clrDisplay.get(t.entity_id) ?? t.entity_id)}` : null);
  const push = (b: Omit<BlockedItem, "age">) => blocked.push({ ...b, age: b.since ? fmtAge(b.since, now) : "Unknown" });

  // Holds
  const holds = db
    .prepare(
      `SELECT h.*, c.display_id AS clr_display, c.state AS clr_state, c.lab_owner_id, c.next_follow_up_at, ii.display_id AS intake_display
         FROM hold h LEFT JOIN clarification c ON c.id = h.clarification_id LEFT JOIN intake_item ii ON ii.id = h.intake_item_id
        WHERE h.status = 'active' ORDER BY h.placed_at`,
    )
    .all() as { id: string; display_id: string; scope_label: string; reason_text: string; blocks: string; clarification_id: string | null; placed_at: string; accession_id: string | null; intake_item_id: string | null; clr_display: string | null; clr_state: string | null; lab_owner_id: string | null; next_follow_up_at: string | null; intake_display: string | null }[];
  for (const h of holds) {
    let blocksList: string[] = [];
    try {
      blocksList = JSON.parse(h.blocks) as string[];
    } catch {
      blocksList = ["all"];
    }
    const clrState = h.clr_state as keyof typeof CLARIFICATION_STATE | null;
    const next =
      !h.clarification_id ? "Lead or supervisor reviews the evidence and releases the hold with a reason"
      : clrState === "resolved" ? `${h.clr_display} is resolved: lead releases ${h.display_id} with a reason (not automatic)`
      : clrState === "reviewed" ? `Resolve ${h.clr_display}, then release ${h.display_id} with a reason`
      : clrState === "answered" ? `Review the office answer on ${h.clr_display}`
      : `Waiting for the office on ${h.clr_display}: ${lowerFirst(CLARIFICATION_STATE[clrState ?? "sent"] ?? clrState ?? "state Unknown")}${h.next_follow_up_at ? `; follow-up ${fmtTime(h.next_follow_up_at)} ET` : ""}`;
    const t = h.clarification_id ? taskFor("clarification", h.clarification_id) : undefined;
    if (t) usedTasks.add(t.id);
    const itemHref = caseHref(h.accession_id) ?? (h.intake_display ? `/intake?item=${encodeURIComponent(h.intake_display)}` : "/operations");
    push({
      key: `hold:${h.id}`, category: "holds", item: `${h.display_id} · ${h.scope_label}`, ref: h.display_id, subject: h.scope_label, itemHref,
      blocks: `${h.reason_text}. Blocks ${blocksList.join(", ").replace(/_/g, " ")}.`, nextStep: next,
      owner: t ? ownerOf(t, "") : nameOf(h.lab_owner_id) ?? "Accessioning lead (unassigned)", ownerId: t?.owner_id ?? h.lab_owner_id,
      since: h.placed_at,
      evidenceLabel: h.clarification_id ? `${h.clr_display}` : "Case history", evidenceHref: h.clr_display ? `/clarifications?selected=${encodeURIComponent(h.clr_display)}` : `${itemHref}${itemHref.startsWith("/cases/") ? "?tab=history" : ""}`,
    });
  }

  // Clarifications that need a person now: follow-up overdue, delivery not confirmed, or answered awaiting review.
  // Every overdue clarification is listed here (also when a hold row links to it), so the
  // "Clarifications overdue" tile and its filtered list always show the same records.
  const needClr = db
    .prepare(
      `SELECT c.*, (SELECT h.display_id FROM hold h WHERE h.clarification_id = c.id AND h.status = 'active' LIMIT 1) AS hold_display
         FROM clarification c WHERE c.state NOT IN ('resolved','canceled','drafted')
          AND ((c.next_follow_up_at IS NOT NULL AND c.next_follow_up_at < @now)
               OR (c.state IN ('delivery_failed','delivery_unknown','answered')
                   AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.clarification_id = c.id AND h.status = 'active')))
        ORDER BY c.created_at`,
    )
    .all({ now }) as { id: string; display_id: string; subject_label: string; state: string; lab_owner_id: string | null; next_follow_up_at: string | null; sent_at: string | null; created_at: string; accession_id: string | null; hold_display: string | null }[];
  for (const c of needClr) {
    const t = taskFor("clarification", c.id);
    if (t) usedTasks.add(t.id);
    const isOverdue = !!c.next_follow_up_at && Date.parse(c.next_follow_up_at) < Date.parse(now);
    push({
      key: `clr:${c.id}`, category: "clarifications", item: `${c.display_id} · ${c.subject_label}`, ref: c.display_id, subject: c.subject_label, itemHref: `/clarifications?selected=${encodeURIComponent(c.display_id)}`,
      blocks: `${CLARIFICATION_STATE[c.state as keyof typeof CLARIFICATION_STATE] ?? c.state}${c.next_follow_up_at ? `; follow-up ${isOverdue ? "was due" : "due"} ${fmtSmart(c.next_follow_up_at, now)} ET` : ""}${c.hold_display ? `. Linked to hold ${c.hold_display}` : ""}`,
      nextStep: c.state === "answered" ? "Review the office answer" : c.state === "delivery_failed" || c.state === "delivery_unknown" ? "Follow up by phone per local policy (delivery not confirmed, simulated)" : "Send a follow-up (simulated) or escalate",
      owner: t ? ownerOf(t, "") : nameOf(c.lab_owner_id) ?? "Unassigned", ownerId: t?.owner_id ?? c.lab_owner_id,
      since: c.sent_at ?? c.created_at, evidenceLabel: c.display_id, evidenceHref: `/clarifications?selected=${encodeURIComponent(c.display_id)}`,
      overdue: isOverdue,
    });
  }
  const overdueTile = tiles.find((t) => t.key === "clarifications_overdue")!;
  overdueTile.value = blocked.filter((b) => b.category === "clarifications" && b.overdue).length;
  for (const t of tiles) if (t.value === null) t.unknownReason = "Could not be computed from the local records";

  // Print jobs with unknown outcome
  const unknownJobs = db
    .prepare("SELECT * FROM print_job WHERE state = 'unknown_outcome' ORDER BY submitted_at")
    .all() as { id: string; display_id: string; kind: string; payload: string; submitted_at: string | null; created_at: string; accession_id: string | null; failure_detail: string | null }[];
  for (const j of unknownJobs) {
    const t = taskFor("print_job", j.id);
    if (t) usedTasks.add(t.id);
    push({
      key: `pj:${j.id}`, category: "print", item: `${j.display_id} · ${j.kind.replace(/_/g, " ")}${j.accession_id && accNumber.get(j.accession_id) ? ` · ${accNumber.get(j.accession_id)}` : ""}`,
      ref: j.display_id, subject: `${j.kind.replace(/_/g, " ")}${j.accession_id && accNumber.get(j.accession_id) ? ` · ${accNumber.get(j.accession_id)}` : ""}`,
      itemHref: `/materials?tab=print&selected=${encodeURIComponent(j.display_id)}`,
      blocks: j.failure_detail ?? "Printer did not confirm the outcome (simulated). No new label for this target until reconciled.",
      nextStep: "Check the printer output and record what happened; reprint only with a reason",
      owner: ownerOf(t, "Histotech (unassigned)"), ownerId: t?.owner_id ?? null, since: j.submitted_at ?? j.created_at,
      evidenceLabel: j.display_id, evidenceHref: `/materials?tab=print&selected=${encodeURIComponent(j.display_id)}`,
    });
  }

  // Trays blocked / exception
  const trays = db
    .prepare(
      `SELECT t.*, s.display_name AS path_name,
              (SELECT COUNT(*) FROM tray_expected_slide e WHERE e.tray_id = t.id) AS expected,
              (SELECT COUNT(DISTINCT s2.slide_id) FROM tray_scan s2 WHERE s2.tray_id = t.id AND s2.result = 'verified_expected') AS matched,
              (SELECT COUNT(*) FROM tray_scan s3 WHERE s3.tray_id = t.id AND s3.result <> 'verified_expected' AND s3.resolution IS NULL) AS unresolved
         FROM tray t JOIN staff s ON s.id = t.pathologist_id
        WHERE t.status = 'exception' OR (t.status IN ('open','assembling') AND EXISTS (SELECT 1 FROM tray_scan x WHERE x.tray_id = t.id AND x.result <> 'verified_expected' AND x.resolution IS NULL))`,
    )
    .all() as { id: string; display_id: string; path_name: string; opened_at: string; opened_by: string | null; expected: number; matched: number; unresolved: number }[];
  for (const t of trays) {
    const task = taskFor("tray", t.id);
    if (task) usedTasks.add(task.id);
    push({
      key: `tray:${t.id}`, category: "trays", item: `${t.display_id} · ${t.path_name}`, ref: t.display_id, subject: t.path_name, itemHref: `/materials?tab=trays&selected=${encodeURIComponent(t.display_id)}`,
      blocks: `${t.matched} of ${t.expected} expected slides scanned; ${plural(t.unresolved, "unexpected or unresolved scan")}. Cannot be verified complete.`,
      nextStep: "Find and scan the missing slide, remove unexpected material, or supervisor releases with documented exceptions",
      owner: task ? ownerOf(task, "") : nameOf(t.opened_by) ?? "Histotech (unassigned)", ownerId: task?.owner_id ?? t.opened_by, since: t.opened_at,
      evidenceLabel: t.display_id, evidenceHref: `/materials?tab=trays&selected=${encodeURIComponent(t.display_id)}`,
    });
  }

  // Routing exceptions
  const routing = db
    .prepare(
      `SELECT ii.id, ii.display_id, ii.observed_office_text, o.name AS office_name, rd.created_at, rd.explanation FROM routing_decision rd
         JOIN intake_item ii ON ii.id = rd.intake_item_id LEFT JOIN office o ON o.id = ii.office_id
        WHERE rd.status = 'exception' AND ii.status NOT IN ('accessioned','canceled') ORDER BY rd.created_at`,
    )
    .all() as { id: string; display_id: string; observed_office_text: string | null; office_name: string | null; created_at: string; explanation: string }[];
  for (const r of routing) {
    const t = openTasks.find((x) => x.intake_item_id === r.id && /routing/.test(x.kind));
    if (t) usedTasks.add(t.id);
    push({
      key: `route:${r.id}`, category: "routing", item: `${r.display_id} (provisional) · ${r.office_name ?? r.observed_office_text ?? "Unknown office"}`,
      ref: r.display_id, subject: `provisional · ${r.office_name ?? r.observed_office_text ?? "Unknown office"}`,
      itemHref: `/intake?item=${encodeURIComponent(r.display_id)}`,
      blocks: `No approved routing rule for ${r.office_name ?? r.observed_office_text ?? "this office"}; no dermatopathologist is suggested.`,
      nextStep: "Accessioning lead assigns a dermatopathologist with a reason (no default doctor)",
      owner: ownerOf(t, "Accessioning lead (unassigned)"), ownerId: t?.owner_id ?? null, since: r.created_at,
      evidenceLabel: r.display_id, evidenceHref: `/intake?item=${encodeURIComponent(r.display_id)}`,
    });
  }

  // Retrieval requests
  const retrievals = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM retrieval_item i WHERE i.request_id = r.id) AS items,
              (SELECT COUNT(*) FROM retrieval_item i WHERE i.request_id = r.id AND i.status IN ('picked','delivered','returned')) AS done,
              (SELECT COUNT(*) FROM retrieval_item i WHERE i.request_id = r.id AND i.status IN ('not_found','missing_investigation')) AS missing
         FROM retrieval_request r WHERE r.status IN ('open','picking','partially_retrieved') ORDER BY r.created_at`,
    )
    .all() as { id: string; display_id: string; requested_by: string; created_at: string; due_at: string | null; items: number; done: number; missing: number; destination: string }[];
  for (const r of retrievals) {
    const t = taskFor("retrieval_request", r.id);
    if (t) usedTasks.add(t.id);
    const overdue = r.due_at && Date.parse(r.due_at) < Date.parse(now);
    push({
      key: `rr:${r.id}`, category: "retrieval", item: `${r.display_id} · for ${nameOf(r.requested_by) ?? "Unknown"} → ${r.destination}`,
      ref: r.display_id, subject: `for ${nameOf(r.requested_by) ?? "Unknown"} → ${r.destination}`,
      itemHref: `/materials?tab=retrieval&selected=${encodeURIComponent(r.display_id)}`,
      blocks: `${r.done} of ${plural(r.items, "block")} retrieved${r.missing ? `; ${r.missing} not found at last confirmed location` : ""}${r.due_at ? `; due ${fmtSmart(r.due_at, now)} ET${overdue ? " (overdue)" : ""}` : ""}`,
      nextStep: "Pull each block from its last confirmed location and scan it against the request",
      owner: ownerOf(t, "Histotech (unassigned)"), ownerId: t?.owner_id ?? null, since: r.created_at,
      evidenceLabel: r.display_id, evidenceHref: `/materials?tab=retrieval&selected=${encodeURIComponent(r.display_id)}`,
    });
  }

  // Other open tasks that wait on a person (source entry, reviews, conflicts, follow-ups not covered above)
  const REVIEW_KINDS = new Set(["order_change_review", "correction_review", "source_conflict", "related_order_review", "gross_review", "container_verification", "clarification_followup", "tray_exception", "routing_exception"]);
  for (const t of openTasks) {
    if (usedTasks.has(t.id)) continue;
    if (t.kind !== "source_entry" && !REVIEW_KINDS.has(t.kind)) continue;
    const href = taskRecordHref(t) ?? "/operations";
    // "Enter approved gross description in source system — D26-04792 part B" → ref "D26-04792", subject "part B · ...".
    const m = /^(.*?) — (\S+)( part [A-Z])?$/.exec(t.title);
    const ref = m ? m[2] : undefined;
    const subject = m ? (t.kind === "source_entry" ? `${m[3]?.trim() ?? "case"} · gross description to enter` : `${m[3] ? `${m[3].trim()} · ` : ""}${m[1]}`) : undefined;
    push({
      key: `task:${t.id}`, category: t.kind === "source_entry" ? "source_entry" : t.kind === "clarification_followup" ? "clarifications" : "review",
      item: t.title, ref, subject, itemHref: href,
      blocks: t.kind === "source_entry" ? SOURCE_ENTRY_BLOCKS : REVIEW_BLOCKS[t.kind] ?? `Open ${t.kind.replace(/_/g, " ")} task`,
      nextStep: t.kind === "source_entry" ? "Enter it in the source system, then record the entry (staff attestation)" : t.title,
      owner: ownerOf(t, ""), ownerId: t.owner_id, since: t.created_at,
      evidenceLabel: href.startsWith("/cases/") ? `${href.replace("/cases/", "")} tasks` : "Record", evidenceHref: href.startsWith("/cases/") ? `${href}?tab=tasks` : href,
    });
  }

  // Approved parts still awaiting source-system entry that have NO open entry task: nobody owns them, which is
  // exactly what this list must show. Same parts as the "awaiting source-system entry" tile, so the counts match.
  const entryTaskParts = new Set(openTasks.filter((t) => t.kind === "source_entry" && t.entity_type === "specimen_part").map((t) => t.entity_id));
  const approvedAt = new Map(
    (db.prepare("SELECT specimen_part_id, approved_at FROM gross_record WHERE state = 'approved_for_downstream'").all() as { specimen_part_id: string; approved_at: string | null }[]).map((g) => [
      g.specimen_part_id,
      g.approved_at,
    ]),
  );
  for (const r of rows) {
    if (!r.accessionNumber) continue;
    for (const p of r.parts) {
      if (!r.sourceEntry.pendingParts.includes(p.designation) || entryTaskParts.has(p.partId)) continue;
      const href = `/cases/${encodeURIComponent(r.accessionNumber)}`;
      push({
        key: `entry:${p.partId}`, category: "source_entry", item: `${r.accessionNumber} part ${p.designation}`, ref: r.accessionNumber, subject: `part ${p.designation} · gross description to enter`, itemHref: href,
        blocks: "Approved; not entered in the source system. No entry task: nobody owns it.",
        nextStep: "Assign the entry to a histology assistant",
        owner: "Unassigned (histology assistant)", ownerId: null, since: approvedAt.get(p.partId) ?? null,
        evidenceLabel: "Source-entry queue", evidenceHref: `/worklist?view=grossing&queue=source_entry&selected=${encodeURIComponent(r.accessionNumber)}`,
      });
    }
  }

  // Exceptions first (holds, clarifications, print, trays, routing, retrieval, reviews), routine source entry last;
  // oldest first within each category. Category filters keep the same order.
  const rank = (c: BlockedCategory) => CATEGORY_ORDER.indexOf(c);
  blocked.sort(
    (a, b) =>
      rank(a.category) - rank(b.category) ||
      (a.since ? Date.parse(a.since) : Infinity) - (b.since ? Date.parse(b.since) : Infinity) ||
      a.item.localeCompare(b.item),
  );

  // ------------------------------------------------------------ queue age by stage (parts on today's worklist)
  const partSince = new Map<string, string>();
  const bump = (partId: string, at: string | null) => {
    if (!at) return;
    const cur = partSince.get(partId);
    if (!cur || Date.parse(at) > Date.parse(cur)) partSince.set(partId, at);
  };
  for (const r of db.prepare("SELECT sp.id, a.issued_at FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id").all() as { id: string; issued_at: string }[]) bump(r.id, r.issued_at);
  for (const g of db.prepare("SELECT specimen_part_id, created_at, approved_at, updated_at FROM gross_record WHERE state <> 'superseded'").all() as { specimen_part_id: string; created_at: string; approved_at: string | null; updated_at: string }[]) {
    bump(g.specimen_part_id, g.created_at);
    bump(g.specimen_part_id, g.approved_at);
  }
  for (const b of db.prepare("SELECT part_id, location_confirmed_at FROM block WHERE status = 'active'").all() as { part_id: string; location_confirmed_at: string | null }[]) bump(b.part_id, b.location_confirmed_at);
  for (const e of db
    .prepare(
      `SELECT COALESCE(sp.id, b.part_id, bs.part_id) AS part_id, ae.at FROM audit_event ae
         LEFT JOIN specimen_part sp ON sp.id = ae.entity_id LEFT JOIN block b ON b.id = ae.entity_id
         LEFT JOIN slide s ON s.id = ae.entity_id LEFT JOIN block bs ON bs.id = s.block_id
        WHERE ae.action NOT LIKE 'task.%' AND ae.action NOT LIKE 'worklist.%' AND COALESCE(sp.id, b.part_id, bs.part_id) IS NOT NULL`,
    )
    .all() as { part_id: string; at: string }[]) bump(e.part_id, e.at);

  const byStage = new Map<Stage, QueueAgeRow>(QUEUE_STAGES.map((s) => [s, { stage: s, label: STAGE[s], buckets: [0, 0, 0, 0], total: 0, unknown: 0 }]));
  let partsCounted = 0;
  for (const r of rows) {
    for (const p of r.parts) {
      const q = byStage.get(p.stage);
      if (!q) continue;
      partsCounted += 1;
      q.total += 1;
      const since = partSince.get(p.partId);
      if (!since) {
        q.unknown += 1;
        continue;
      }
      const m = Math.max(0, minutesBetween(since, now));
      q.buckets[m < 60 ? 0 : m < 240 ? 1 : m < 480 ? 2 : 3] += 1;
    }
  }

  // ------------------------------------------------------------ pending handoffs (deterministic summary)
  const lines: HandoffLine[] = [];
  const byOwner = new Map<string, typeof openTasks>();
  for (const t of openTasks) {
    const key = t.owner_id ?? `role:${t.owner_role ?? "unassigned"}`;
    byOwner.set(key, [...(byOwner.get(key) ?? []), t]);
  }
  const ownerKeys = [...byOwner.keys()].sort((a, b) => {
    const na = a.startsWith("role:") ? `~${a}` : nameOf(a) ?? a;
    const nb = b.startsWith("role:") ? `~${b}` : nameOf(b) ?? b;
    return na.localeCompare(nb);
  });
  for (const k of ownerKeys) {
    const list = byOwner.get(k)!;
    const who = k.startsWith("role:") ? `Unassigned (${k.slice(5).replace(/_/g, " ")})` : nameOf(k) ?? k;
    const kinds = new Map<string, number>();
    for (const t of list) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
    const oldest = list.reduce((o, t) => (Date.parse(t.created_at) < Date.parse(o.created_at) ? t : o));
    const kindText = [...kinds.entries()].map(([kind, n]) => `${n} ${kind.replace(/_/g, " ")}`).join(", ");
    lines.push({
      text: `${who} holds the next step on ${plural(list.length, "task")}: ${kindText}. Oldest waiting ${fmtAge(oldest.created_at, now)} ("${oldest.title}").`,
      evidence: list.slice(0, 3).map((t) => {
        const href = taskRecordHref(t) ?? "/operations#blocked";
        const label =
          (t.accession_id && accNumber.get(t.accession_id)) ||
          (t.intake_item_id && intakeDisplay.get(t.intake_item_id)) ||
          (t.entity_type === "clarification" && clrDisplay.get(t.entity_id)) ||
          t.kind.replace(/_/g, " ");
        return { label, href: href.startsWith("/cases/") ? `${href}?tab=tasks` : href };
      }),
    });
  }
  const releasable = holds.filter((h) => h.clr_state === "resolved");
  if (releasable.length) {
    lines.push({
      text: `${releasable.length === 1 ? "1 hold has" : `${releasable.length} holds have`} a resolved clarification but ${releasable.length === 1 ? "is" : "are"} still active: ${releasable.map((h) => h.display_id).join(", ")}. A lead or supervisor must release each with a reason; resolution does not release a hold automatically.`,
      evidence: releasable.map((h) => ({ label: h.display_id, href: caseHref(h.accession_id) ?? "/operations?category=holds#blocked" })),
    });
  }
  if (!lines.length) lines.push({ text: "No open tasks: nobody is holding a pending handoff right now.", evidence: [{ label: "Blocked work", href: "/operations#blocked" }] });

  return {
    generatedAt: now,
    note: `Computed from synthetic demo data at demo clock ${fmtSmart(now, now)} ET. Not observed lab performance.`,
    tiles,
    blocked,
    freshness,
    queueAge: {
      rows: QUEUE_STAGES.map((s) => byStage.get(s)!),
      bucketLabels: AGE_BUCKET_LABELS,
      definition:
        "Parts on today's worklist (not delivered) by derived stage. Age = demo clock minus the latest recorded event for the part (accession issued, gross record created or approved, block location confirmed, or a logged action on the part or its material). Synthetic demo data; a demo approximation of time in stage.",
      partsCounted,
    },
    handoffs: { label: "Who holds each open task. Computed by fixed rules from open tasks and holds (deterministic demo), not AI.", lines },
  };
}
