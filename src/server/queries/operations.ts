/**
 * Read model for /operations: what is blocked right now, who owns the next
 * step, how old it is, and the evidence. Every number is computed from the
 * synthetic demo records at the demo clock and links to those records. No
 * scores, rankings, health percentages or savings.
 */
import type { DB } from "@/server/db/db";
import { demoNow } from "@/server/core/clock";
import { fmtAge, fmtSmart, minutesBetween } from "@/lib/time";
import { CLARIFICATION_STATE, STAGE, type Stage } from "@/lib/domain";
import { AGE_BUCKET_LABELS } from "@/lib/tokens";
import { isGrossPending, loadSourceFreshness, loadWorklistRows, type FreshnessSummary } from "./worklist";
import { holdNextSteps } from "./hold-next";
import { OPEN_ROUTING_EXCEPTION_SQL, SOURCE_ENTRY_UNASSIGNED } from "./predicates";
import { correctionPart } from "@/server/domain/correction";
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
  | "review"
  | "integration";

export const BLOCKED_CATEGORY_LABEL: Record<BlockedCategory, string> = {
  holds: "Holds",
  clarifications: "Clarifications",
  print: "Print jobs",
  trays: "Trays",
  routing: "Routing exceptions",
  retrieval: "Block retrieval",
  source_entry: "Source-system entry",
  review: "Reviews",
  integration: "Integration",
};

/**
 * What kind of problem an item is (one taxonomy across the lab), independent of the screen category:
 * patient identity; sources disagree; evidence missing (a scan, a printer outcome, a delivery receipt);
 * where the material is, is uncertain; a hold stops processing steps; a person must decide; an
 * integration failed; or work is simply late.
 */
export type BlockedKind =
  | "identity_conflict"
  | "source_disagreement"
  | "missing_evidence"
  | "location_uncertain"
  | "processing_hold"
  | "pending_decision"
  | "integration_failure"
  | "delay";

/** What evidence closes an item of each category (one short sentence, shown with the item). */
export const CLOSES_WHEN: Record<BlockedCategory, string> = {
  holds: "Closed by a recorded release with a reason from a lead or supervisor; an office answer alone does not release it.",
  clarifications: "Closed by a reviewed office answer, recorded as the resolution.",
  print: "Closed by recording what the printer actually produced, after checking it.",
  trays: "Closed by a matching scan of every expected slide, or a supervisor's release with documented exceptions.",
  routing: "Closed by a lead's dermatopathologist assignment, with a reason.",
  retrieval: "Closed by a scan of each requested block against the request.",
  review: "Closed by the reviewer's recorded decision.",
  integration: "Closed by a successful retry or the source's reply (simulated).",
  source_entry: "Closed by staff attesting the entry; the source's acknowledgment confirms it.",
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
  /** Derived: stable key for "who holds the next step" (the staff id, or "unassigned-<role words>"); the page's owner filter uses it. */
  ownerKey: string;
  /** Derived: the hold or clarification is about patient identity (name, DOB or MRN disagree): the top rung of the severity ladder. */
  identity?: boolean;
  /** Derived: the problem taxonomy (identity, sources disagree, missing evidence, location, hold, decision, integration, delay). */
  kind: BlockedKind;
  /** Derived: where the material is (a block's last confirmed location, "location not confirmed", the intake bench), or that no material is involved. */
  where: string;
  /** Derived: the evidence that closes the item (one sentence per category). */
  closesWhen: string;
}

/** Where the bench path stands: intake (provisional orders), each derived worklist stage (parts), delivered (parts). */
export type PathStageKey = "intake" | Stage;

export interface PathStage {
  key: PathStageKey;
  label: string;
  /** Intake counts provisional intake items (orders); every later stage counts specimen parts. */
  unit: "order" | "part";
  count: number;
  /** How many of `count` sit under an active hold, and which holds. */
  held: number;
  holdIds: string[];
  /** The longest-waiting item at this stage: its latest recorded event (intake: received), age at the demo clock, and reference. Null for delivered or when empty. */
  oldestSince: string | null;
  oldestAge: string | null;
  oldestRef: string | null;
  /** Derived: the record that shows the longest wait (the intake item, or the case opened at that part). Null when there is no oldest item. */
  oldestHref: string | null;
  /** Items at this stage with no recorded event (age Unknown). */
  unknownAge: number;
  href: string;
}

/** Waiting work grouped by who holds the next step, by age. Sorted by name (unassigned last): not a workload or productivity ranking. */
export interface OwnerQueue {
  key: string;
  owner: string;
  ownerId: string | null;
  unassigned: boolean;
  /** Items per age bucket (under 1 h, 1 to 4 h, 4 to 8 h, over 8 h) since the item started waiting. */
  buckets: [number, number, number, number];
  unknown: number;
  total: number;
  holds: number;
  oldestSince: string | null;
  oldestAge: string;
  href: string;
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
  /** Derived: the bench path, intake to delivered, with counts, holds where they sit and the longest wait per stage. */
  path: { stages: PathStage[]; definition: string };
  /** Derived: blocked and waiting items grouped by owner and age (same records as `blocked`). */
  owners: { rows: OwnerQueue[]; bucketLabels: readonly string[]; definition: string };
}

const AGE_BUCKET = (minutes: number) => (minutes < 60 ? 0 : minutes < 240 ? 1 : minutes < 480 ? 2 : 3);
/** Stable owner key for filtering: the staff id, or "unassigned-<role words>" for work nobody holds yet. */
export function ownerKeyFor(ownerId: string | null, owner: string): string {
  if (ownerId) return ownerId;
  const words = owner.toLowerCase().replace(/\bunassigned\b/g, " ").replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "");
  return words ? `unassigned-${words}` : "unassigned";
}

function count(db: DB, sql: string, ...params: unknown[]): number | null {
  try {
    return (db.prepare(sql).get(...params) as { n: number }).n;
  } catch (e) {
    console.error("[operations] count failed", e);
    return null;
  }
}

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
  clarification_review: "An office answer waits for a lead's review; an answer alone resolves nothing.",
  clarification_escalation: "The office has not answered after reminders; the escalation contact is the next step.",
  hold_release_decision: "A resolved clarification leaves its hold active until a lead decides, with a reason.",
  custody_conflict: "Custody records disagree about where the block is; nothing is resolved automatically.",
  missing_material: "A block was not found where it was last confirmed; an investigation is open.",
};

/** Review task kinds listed in Blocked now, and the category each one is counted under. */
const REVIEW_CATEGORY: Record<string, BlockedCategory> = {
  order_change_review: "review",
  correction_review: "review",
  source_conflict: "review",
  related_order_review: "review",
  gross_review: "review",
  container_verification: "review",
  tray_exception: "review",
  routing_exception: "review",
  hold_release_decision: "review",
  custody_conflict: "review",
  missing_material: "review",
  clarification_followup: "clarifications",
  clarification_review: "clarifications",
  clarification_escalation: "clarifications",
};

/** The taxonomy kind of a review task. */
const REVIEW_KIND: Record<string, BlockedKind> = {
  order_change_review: "source_disagreement",
  correction_review: "source_disagreement",
  source_conflict: "source_disagreement",
  related_order_review: "pending_decision",
  gross_review: "pending_decision",
  container_verification: "missing_evidence",
  tray_exception: "missing_evidence",
  routing_exception: "pending_decision",
  hold_release_decision: "pending_decision",
  custody_conflict: "location_uncertain",
  missing_material: "location_uncertain",
  clarification_followup: "delay",
  clarification_review: "pending_decision",
  clarification_escalation: "delay",
};

/** Display order of blocked work: exceptions before routine queues. */
const CATEGORY_ORDER: BlockedCategory[] = ["holds", "clarifications", "print", "trays", "routing", "retrieval", "review", "integration", "source_entry"];
const SOURCE_ENTRY_BLOCKS = "Approved; not yet entered in the source system (manual entry)";

/** Waiting stages in bench-path order (lib/domain STAGE order, without intake, delivered and canceled). */
const QUEUE_STAGES: Stage[] = (Object.keys(STAGE) as Stage[]).filter((s) => s !== "intake" && s !== "delivered" && s !== "canceled");

/** "No material" in words, for items that are about a record rather than a block, slide or container. */
const NO_MATERIAL = {
  question: "No material: a question to the office",
  sourceEntry: "No material: an entry in the source system",
  integration: "No material: a simulated integration message",
} as const;

/**
 * Where the material behind an item is, in words: a block's last confirmed location (never live tracking) or
 * "location not confirmed", its custody when it is checked out, sent out or missing, or the accessioning bench
 * for what is still an intake item. Read-only.
 */
function materialLocator(db: DB, now: string) {
  type B = { id: string; part_id: string; label_text: string; accession_number: string; custody_state: string; location_confirmed_at: string | null; loc: string | null; holder: string | null };
  const blocks = db
    .prepare(
      `SELECT b.id, b.part_id, b.label_text, a.accession_number, b.custody_state, b.location_confirmed_at, l.code AS loc, s.display_name AS holder
         FROM block b JOIN accession a ON a.id = b.accession_id LEFT JOIN storage_location l ON l.id = b.current_location_id LEFT JOIN staff s ON s.id = b.checkout_holder_id
        WHERE b.status = 'active' ORDER BY b.block_seq`,
    )
    .all() as B[];
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const blocksOfPart = new Map<string, B[]>();
  for (const b of blocks) blocksOfPart.set(b.part_id, [...(blocksOfPart.get(b.part_id) ?? []), b]);
  const parts = db
    .prepare("SELECT sp.id, sp.designation, sp.source_order_part_id, sp.container_id, c.intake_item_id FROM specimen_part sp LEFT JOIN container c ON c.id = sp.container_id")
    .all() as { id: string; designation: string; source_order_part_id: string; container_id: string | null; intake_item_id: string | null }[];
  const partById = new Map(parts.map((p) => [p.id, p]));
  const intake = new Map((db.prepare("SELECT id, display_id FROM intake_item").all() as { id: string; display_id: string }[]).map((r) => [r.id, r.display_id]));
  const containers = new Map(
    (db.prepare("SELECT id, intake_item_id, order_part_id FROM container").all() as { id: string; intake_item_id: string; order_part_id: string | null }[]).map((c) => [c.id, c]),
  );

  /** One block's place in words; `withCase` names the case too (lists that span cases, such as a retrieval request). */
  const blockText = (b: B, withCase = false) => {
    const label = withCase ? `${b.accession_number} ${b.label_text}` : b.label_text;
    const last = b.loc ? `last confirmed at ${b.loc}${b.location_confirmed_at ? `, ${fmtSmart(b.location_confirmed_at, now)} ET` : ""}` : "location not confirmed";
    if (b.custody_state === "checked_out") return `${label} checked out to ${b.holder ?? "an unknown holder"} (${last})`;
    if (b.custody_state === "sent_out") return `${label} sent outside the lab`;
    if (b.custody_state === "missing_investigation") return `${label} missing, investigation open (${last})`;
    return `${label} ${last}`;
  };
  const list = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 2).join("; ")}; +${xs.length - 2} more` : xs.join("; "));
  const intakeText = (id: string | null | undefined) => (id ? `Accessioning bench (${intake.get(id) ?? "intake item"}, as received)` : "Location not confirmed");
  const partText = (partId: string) => {
    const p = partById.get(partId);
    if (!p) return "Location not confirmed";
    const bs = blocksOfPart.get(partId) ?? [];
    if (bs.length) return list(bs.map((b) => blockText(b)));
    const ii = p.intake_item_id ? intake.get(p.intake_item_id) : null;
    return `Part ${p.designation} container: location not confirmed${ii ? ` (received as ${ii})` : ""}`;
  };
  const orderPartText = (orderPartId: string) => {
    const issued = parts.find((p) => p.source_order_part_id === orderPartId);
    if (issued) return partText(issued.id);
    const c = [...containers.values()].find((x) => x.order_part_id === orderPartId);
    return c ? intakeText(c.intake_item_id) : "Location not confirmed";
  };
  const scope = (type: string, id: string): string => {
    switch (type) {
      case "intake_item":
        return intakeText(id);
      case "container": {
        const issued = parts.find((p) => p.container_id === id);
        return issued ? partText(issued.id) : intakeText(containers.get(id)?.intake_item_id);
      }
      case "order_part":
        return orderPartText(id);
      case "specimen_part":
        return partText(id);
      case "block": {
        const b = blockById.get(id);
        return b ? blockText(b, true) : "Location not confirmed";
      }
      case "slide": {
        const s = db.prepare("SELECT s.slide_seq, b.label_text FROM slide s JOIN block b ON b.id = s.block_id WHERE s.id = ?").get(id) as { slide_seq: number; label_text: string } | undefined;
        return s ? `Slide ${s.label_text}-${s.slide_seq}: location not confirmed` : "Location not confirmed";
      }
      case "work_order": {
        const w = db.prepare("SELECT target_block_id, target_part_id FROM work_order WHERE id = ?").get(id) as { target_block_id: string | null; target_part_id: string | null } | undefined;
        if (w?.target_block_id && blockById.get(w.target_block_id)) return blockText(blockById.get(w.target_block_id)!);
        return w?.target_part_id ? partText(w.target_part_id) : "Location not confirmed";
      }
      case "accession":
        return "Whole case: each part's location is on the case page";
      default:
        return "Location not confirmed";
    }
  };
  const entity = (entityType: string, entityId: string, intakeItemId: string | null): string => {
    switch (entityType) {
      case "hold": {
        const h = db.prepare("SELECT scope_type, scope_id FROM hold WHERE id = ?").get(entityId) as { scope_type: string; scope_id: string } | undefined;
        return h ? scope(h.scope_type, h.scope_id) : "Location not confirmed";
      }
      case "clarification": {
        const c = db.prepare("SELECT specimen_part_id, intake_item_id FROM clarification WHERE id = ?").get(entityId) as { specimen_part_id: string | null; intake_item_id: string | null } | undefined;
        return c?.specimen_part_id ? partText(c.specimen_part_id) : c?.intake_item_id ? intakeText(c.intake_item_id) : NO_MATERIAL.question;
      }
      case "gross_record": {
        const g = db.prepare("SELECT specimen_part_id FROM gross_record WHERE id = ?").get(entityId) as { specimen_part_id: string } | undefined;
        return g ? partText(g.specimen_part_id) : "Location not confirmed";
      }
      case "source_order_part":
        return orderPartText(entityId);
      case "correction_review": {
        const c = db.prepare("SELECT accession_id, original_refs FROM correction_review WHERE id = ?").get(entityId) as { accession_id: string; original_refs: string } | undefined;
        const part = c ? correctionPart(db, c) : null;
        return part ? partText(part.id) : "Whole case: each part's location is on the case page";
      }
      case "tray":
        return "Tray: location not recorded";
      case "block":
      case "specimen_part":
      case "container":
      case "intake_item":
        return scope(entityType, entityId);
      default:
        return intakeItemId ? intakeText(intakeItemId) : "Location not confirmed";
    }
  };
  const retrieval = (requestId: string): string => {
    const items = db
      .prepare("SELECT block_id FROM retrieval_item WHERE request_id = ? AND status IN ('pending','picked','not_found','missing_investigation') ORDER BY bench_seq")
      .all(requestId) as { block_id: string }[];
    const texts = items.map((i) => blockById.get(i.block_id)).filter((b): b is B => !!b).map((b) => blockText(b, true));
    return texts.length ? list(texts) : "Location not confirmed";
  };
  return { scope, part: partText, intake: intakeText, entity, retrieval };
}

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
      caveat: "Per part: not entered yet, pending or failed (one shared definition), including late entries from earlier days.",
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
      value: count(db, `SELECT COUNT(*) n FROM routing_decision rd JOIN intake_item ii ON ii.id = rd.intake_item_id WHERE ${OPEN_ROUTING_EXCEPTION_SQL}`),
      href: "/operations?category=routing#blocked", tone: "warning",
    },
  ];

  // ------------------------------------------------------------ blocked work
  const openTasks = db
    .prepare("SELECT * FROM task WHERE status IN ('open','in_progress') ORDER BY created_at")
    .all() as { id: string; kind: string; entity_type: string; entity_id: string; title: string; owner_id: string | null; owner_role: string | null; created_at: string; accession_id: string | null; intake_item_id: string | null; due_at: string | null }[];
  /** Same preference as the shared hold helper: a lead's review, then an escalation, then the follow-up. */
  const CLR_TASK_RANK = (k: string) => (k === "clarification_review" ? 0 : k === "clarification_escalation" ? 1 : 2);
  const taskFor = (entityType: string, entityId: string, kind?: string) =>
    openTasks
      .filter((t) => t.entity_type === entityType && t.entity_id === entityId && (!kind || t.kind === kind))
      .sort((a, b) => (entityType === "clarification" ? CLR_TASK_RANK(a.kind) - CLR_TASK_RANK(b.kind) : 0))[0];
  const ownerOf = (t: { owner_id: string | null; owner_role: string | null } | undefined, fallback: string) =>
    t ? nameOf(t.owner_id) ?? `Unassigned${t.owner_role ? ` (${t.owner_role.replace(/_/g, " ")})` : ""}` : fallback;
  const usedTasks = new Set<string>();
  /** Every open task on these entities is said by the row that lists them, so it is not listed again as a review. */
  const useTasksOf = (entityType: string, entityId: string | null | undefined) => {
    if (!entityId) return;
    for (const t of openTasks) if (t.entity_type === entityType && t.entity_id === entityId) usedTasks.add(t.id);
  };
  const blocked: BlockedItem[] = [];
  const accNumber = new Map((db.prepare("SELECT id, accession_number FROM accession").all() as { id: string; accession_number: string }[]).map((r) => [r.id, r.accession_number]));
  const caseHref = (accId: string | null | undefined) => (accId && accNumber.get(accId) ? `/cases/${encodeURIComponent(accNumber.get(accId)!)}` : null);
  const intakeDisplay = new Map((db.prepare("SELECT id, display_id FROM intake_item").all() as { id: string; display_id: string }[]).map((r) => [r.id, r.display_id]));
  const clrRows = db.prepare("SELECT id, display_id, category FROM clarification").all() as { id: string; display_id: string; category: string }[];
  const clrDisplay = new Map(clrRows.map((r) => [r.id, r.display_id]));
  const clrCategory = new Map(clrRows.map((r) => [r.id, r.category]));
  const taskRecordHref = (t: { accession_id: string | null; intake_item_id: string | null; entity_type: string; entity_id: string }) =>
    caseHref(t.accession_id) ??
    (t.intake_item_id ? `/intake?item=${encodeURIComponent(intakeDisplay.get(t.intake_item_id) ?? t.intake_item_id)}` : null) ??
    (t.entity_type === "clarification" ? `/clarifications?selected=${encodeURIComponent(clrDisplay.get(t.entity_id) ?? t.entity_id)}` : null);
  const push = (b: Omit<BlockedItem, "age" | "ownerKey" | "closesWhen">) =>
    blocked.push({ ...b, closesWhen: CLOSES_WHEN[b.category], age: b.since ? fmtAge(b.since, now) : "Unknown", ownerKey: ownerKeyFor(b.ownerId, b.owner) });
  const where = materialLocator(db, now);

  // Holds: owner and next step from the shared helper (the same answer the case page and grossing bench give).
  const holds = db
    .prepare(
      `SELECT h.*, c.display_id AS clr_display, c.state AS clr_state, c.category AS clr_category, ii.display_id AS intake_display
         FROM hold h LEFT JOIN clarification c ON c.id = h.clarification_id LEFT JOIN intake_item ii ON ii.id = h.intake_item_id
        WHERE h.status = 'active' ORDER BY h.placed_at`,
    )
    .all() as { id: string; display_id: string; scope_type: string; scope_id: string; scope_label: string; reason_text: string; blocks: string; clarification_id: string | null; placed_at: string; accession_id: string | null; intake_item_id: string | null; clr_display: string | null; clr_state: string | null; clr_category: string | null; reason_code: string; intake_display: string | null }[];
  const holdNext = holdNextSteps(db);
  for (const h of holds) {
    let blocksList: string[] = [];
    try {
      blocksList = JSON.parse(h.blocks) as string[];
    } catch {
      blocksList = ["all"];
    }
    const next = holdNext.get(h.id)!;
    useTasksOf("hold", h.id);
    useTasksOf("clarification", h.clarification_id);
    if (next.correction) useTasksOf("correction_review", next.correction.id);
    const itemHref = caseHref(h.accession_id) ?? (h.intake_display ? `/intake?item=${encodeURIComponent(h.intake_display)}` : "/operations");
    const identity = h.reason_code === "identity_conflict" || h.clr_category === "identity_conflict";
    push({
      key: `hold:${h.id}`, category: "holds", item: `${h.display_id} · ${h.scope_label}`, ref: h.display_id, subject: h.scope_label, itemHref,
      blocks: `${h.reason_text}. Blocks ${blocksList.join(", ").replace(/_/g, " ")}.`, nextStep: next.nextStep,
      owner: next.owner, ownerId: next.ownerId,
      since: h.placed_at, identity, kind: identity ? "identity_conflict" : "processing_hold", where: where.scope(h.scope_type, h.scope_id),
      evidenceLabel: h.clarification_id ? `${h.clr_display}` : next.correction ? next.correction.displayId : "Case history",
      evidenceHref: h.clr_display
        ? `/clarifications?selected=${encodeURIComponent(h.clr_display)}`
        : next.correction && itemHref.startsWith("/cases/")
          ? `${itemHref}?tab=source#corrections`
          : `${itemHref}${itemHref.startsWith("/cases/") ? "?tab=history" : ""}`,
    });
  }

  // Clarifications that need a person now: follow-up overdue, delivery not confirmed, or an answer waiting for a
  // lead's review or resolution. Every overdue clarification and every unconfirmed delivery is listed here (also when a
  // hold row links to it), so the "Clarifications overdue" tile and the Clarifications filter always show the same
  // records. An answered or reviewed question with an active hold is said once, on its hold row.
  const needClr = db
    .prepare(
      `SELECT c.*, (SELECT h.display_id FROM hold h WHERE h.clarification_id = c.id AND h.status = 'active' LIMIT 1) AS hold_display
         FROM clarification c WHERE c.state NOT IN ('resolved','canceled','drafted')
          AND ((c.next_follow_up_at IS NOT NULL AND c.next_follow_up_at < @now)
               OR c.state IN ('delivery_failed','delivery_unknown')
               OR (c.state IN ('answered','reviewed')
                   AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.clarification_id = c.id AND h.status = 'active')))
        ORDER BY c.created_at`,
    )
    .all({ now }) as { id: string; display_id: string; subject_label: string; state: string; category: string; lab_owner_id: string | null; escalation_owner_id: string | null; next_follow_up_at: string | null; sent_at: string | null; created_at: string; accession_id: string | null; intake_item_id: string | null; specimen_part_id: string | null; hold_display: string | null }[];
  for (const c of needClr) {
    const t = taskFor("clarification", c.id);
    useTasksOf("clarification", c.id);
    const isOverdue = !!c.next_follow_up_at && Date.parse(c.next_follow_up_at) < Date.parse(now);
    const delivery = c.state === "delivery_failed" || c.state === "delivery_unknown";
    const decision = c.state === "answered" || c.state === "reviewed";
    // A lead decision falls to the escalation owner when no task names anyone; the office follow-up to the lab owner.
    const fallbackId = decision ? c.escalation_owner_id ?? c.lab_owner_id : c.lab_owner_id;
    const identity = c.category === "identity_conflict";
    push({
      key: `clr:${c.id}`, category: "clarifications", item: `${c.display_id} · ${c.subject_label}`, ref: c.display_id, subject: c.subject_label, itemHref: `/clarifications?selected=${encodeURIComponent(c.display_id)}`,
      blocks: `${CLARIFICATION_STATE[c.state as keyof typeof CLARIFICATION_STATE] ?? c.state}${c.next_follow_up_at ? `; follow-up ${isOverdue ? "was due" : "due"} ${fmtSmart(c.next_follow_up_at, now)} ET` : ""}${c.hold_display ? `. Linked to hold ${c.hold_display}` : ""}`,
      nextStep:
        c.state === "answered" ? "Lead reviews the office answer"
        : c.state === "reviewed" ? "Lead resolves it, recording how the answer settles the question"
        : delivery ? "Delivery not confirmed: follow up by phone per local policy (simulated)"
        : "Send a follow-up (simulated) or escalate",
      owner: t ? ownerOf(t, "") : nameOf(fallbackId) ?? "Unassigned", ownerId: t ? t.owner_id : fallbackId,
      since: c.sent_at ?? c.created_at, evidenceLabel: c.display_id, evidenceHref: `/clarifications?selected=${encodeURIComponent(c.display_id)}`,
      overdue: isOverdue, identity,
      kind: identity ? "identity_conflict" : decision ? "pending_decision" : delivery ? "missing_evidence" : isOverdue ? "delay" : "source_disagreement",
      where: c.specimen_part_id ? where.part(c.specimen_part_id) : c.intake_item_id ? where.intake(c.intake_item_id) : NO_MATERIAL.question,
    });
  }
  const overdueTile = tiles.find((t) => t.key === "clarifications_overdue")!;
  overdueTile.value = blocked.filter((b) => b.category === "clarifications" && b.overdue).length;
  for (const t of tiles) if (t.value === null) t.unknownReason = "Could not be computed from the local records";

  // Print jobs with unknown outcome
  const unknownJobs = db
    .prepare("SELECT pj.*, p.name AS printer_name, p.location AS printer_location FROM print_job pj JOIN printer p ON p.id = pj.printer_id WHERE pj.state = 'unknown_outcome' ORDER BY pj.submitted_at")
    .all() as { id: string; display_id: string; kind: string; payload: string; submitted_at: string | null; created_at: string; accession_id: string | null; failure_detail: string | null; printer_name: string; printer_location: string }[];
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
      kind: "missing_evidence", where: `${j.printer_name}, ${j.printer_location} (printer output not checked yet)`,
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
      kind: "missing_evidence", where: `Tray ${t.display_id}: location not recorded`,
    });
  }

  // Routing exceptions (the same predicate as the tile, the worklist group and Insights)
  const routing = db
    .prepare(
      `SELECT ii.id, ii.display_id, ii.observed_office_text, o.name AS office_name, rd.created_at, rd.explanation FROM routing_decision rd
         JOIN intake_item ii ON ii.id = rd.intake_item_id LEFT JOIN office o ON o.id = ii.office_id
        WHERE ${OPEN_ROUTING_EXCEPTION_SQL} ORDER BY rd.created_at`,
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
      kind: "pending_decision", where: where.intake(r.id),
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
      kind: r.missing ? "location_uncertain" : "delay", where: where.retrieval(r.id),
    });
  }

  // Integration: accession requests stuck at "submitted", print jobs queued because the printer is unavailable, failed source messages.
  const stuckRequests = db
    .prepare(
      `SELECT ar.id, ar.display_id, ar.requested_by, ar.requested_at, ar.failure_detail,
              (SELECT ai.intake_item_id FROM accession_request_item ai WHERE ai.request_id = ar.id ORDER BY ai.intake_item_id LIMIT 1) AS intake_item_id
         FROM accession_request ar WHERE ar.status = 'submitted' ORDER BY ar.requested_at`,
    )
    .all() as { id: string; display_id: string; requested_by: string | null; requested_at: string; failure_detail: string | null; intake_item_id: string | null }[];
  for (const r of stuckRequests) {
    const intake = r.intake_item_id ? intakeDisplay.get(r.intake_item_id) ?? null : null;
    const href = intake ? `/intake?item=${encodeURIComponent(intake)}` : "/intake";
    push({
      key: `ar:${r.id}`, category: "integration", item: `${r.display_id} · accession request${intake ? ` for ${intake}` : ""}`, ref: r.display_id,
      subject: `accession request${intake ? ` for ${intake}` : ""}`, itemHref: href,
      blocks: `Submitted to the source system (simulated); no accession number issued yet. Nothing is issued locally.${r.failure_detail ? ` ${r.failure_detail}.` : ""}`,
      nextStep: "Retry the request from Intake once the source is reachable",
      owner: nameOf(r.requested_by) ?? "Accessioning lead (unassigned)", ownerId: r.requested_by, since: r.requested_at,
      evidenceLabel: intake ?? r.display_id, evidenceHref: href,
      kind: "integration_failure", where: r.intake_item_id ? where.intake(r.intake_item_id) : NO_MATERIAL.integration,
    });
  }
  const queuedJobs = db
    .prepare(
      `SELECT pj.id, pj.display_id, pj.kind, pj.accession_id, pj.created_at, pj.requested_by, pj.failure_detail, p.name AS printer_name, p.location AS printer_location, p.status AS printer_status
         FROM print_job pj JOIN printer p ON p.id = pj.printer_id
        WHERE pj.state = 'queued' AND (p.status <> 'online' OR pj.failure_detail IS NOT NULL) ORDER BY pj.created_at`,
    )
    .all() as { id: string; display_id: string; kind: string; accession_id: string | null; created_at: string; requested_by: string; failure_detail: string | null; printer_name: string; printer_location: string; printer_status: string }[];
  for (const j of queuedJobs) {
    const acc = j.accession_id ? accNumber.get(j.accession_id) : undefined;
    push({
      key: `pjq:${j.id}`, category: "integration", item: `${j.display_id} · ${j.kind.replace(/_/g, " ")}${acc ? ` · ${acc}` : ""}`, ref: j.display_id,
      subject: `${j.kind.replace(/_/g, " ")} queued${acc ? ` · ${acc}` : ""}`, itemHref: `/materials?tab=print&selected=${encodeURIComponent(j.display_id)}`,
      blocks: `${j.failure_detail ?? `${j.printer_name} unavailable (simulated)`}. Queued; nothing printed yet.`,
      nextStep: `Release the queued jobs once ${j.printer_name} is back`,
      owner: nameOf(j.requested_by) ?? "Histotech (unassigned)", ownerId: j.requested_by, since: j.created_at,
      evidenceLabel: j.display_id, evidenceHref: `/materials?tab=print&selected=${encodeURIComponent(j.display_id)}`,
      kind: "integration_failure", where: `${j.printer_name}, ${j.printer_location} (printer ${j.printer_status === "online" ? "did not take the job" : "unavailable"})`,
    });
  }
  const failedEvents = db
    .prepare(
      `SELECT e.id, e.message_id, e.message_type, e.received_at, e.detail, s.name AS source_name FROM integration_event e JOIN integration_source s ON s.id = e.source_id
        WHERE e.outcome = 'failed' ORDER BY e.received_at`,
    )
    .all() as { id: string; message_id: string; message_type: string; received_at: string; detail: string | null; source_name: string }[];
  for (const e of failedEvents) {
    push({
      key: `ie:${e.id}`, category: "integration", item: `${e.message_id} · ${e.message_type} from ${e.source_name}`,
      itemHref: "/settings?tab=integration",
      blocks: `Message from ${e.source_name} could not be applied${e.detail ? `: ${e.detail}` : ""}. Kept in the failure queue; nothing was changed.`,
      nextStep: "Fix the cause, then retry the message (Settings, Integration)",
      owner: "Unassigned (supervisor)", ownerId: null, since: e.received_at,
      evidenceLabel: "Integration settings", evidenceHref: "/settings?tab=integration",
      kind: "integration_failure", where: NO_MATERIAL.integration,
    });
  }

  // Other open tasks that wait on a person (source entry, reviews, conflicts, decisions, follow-ups not covered above)
  for (const t of openTasks) {
    if (usedTasks.has(t.id)) continue;
    if (t.kind !== "source_entry" && !REVIEW_CATEGORY[t.kind]) continue;
    const href = taskRecordHref(t) ?? "/operations";
    // "Enter approved gross description in source system — D26-04792 part B" → ref "D26-04792", subject "part B · ...".
    const m = /^(.*?) — (\S+)( part [A-Z])?$/.exec(t.title);
    // Derived, display only: "Review possible related orders REL-0112: ORD-77120 + ORD-77121" → ref "REL-0112", subject "ORD-77120 + ORD-77121".
    const idm = m ? null : /^(.*?)\s*\b([A-Z][A-Z0-9]{0,4}(?:-[A-Z0-9]+)+)\b:?\s*(.*)$/.exec(t.title);
    const ref = m ? m[2] : idm ? idm[2] : undefined;
    const subject = m
      ? t.kind === "source_entry" ? `${m[3]?.trim() ?? "case"} · gross description to enter` : `${m[3] ? `${m[3].trim()} · ` : ""}${m[1]}`
      : idm ? idm[3] || idm[1] || undefined : undefined;
    const identity = t.entity_type === "clarification" && clrCategory.get(t.entity_id) === "identity_conflict";
    push({
      key: `task:${t.id}`, category: t.kind === "source_entry" ? "source_entry" : REVIEW_CATEGORY[t.kind],
      item: t.title, ref, subject, itemHref: href,
      blocks: t.kind === "source_entry" ? SOURCE_ENTRY_BLOCKS : REVIEW_BLOCKS[t.kind] ?? `Open ${t.kind.replace(/_/g, " ")} task`,
      nextStep: t.kind === "source_entry" ? "Enter it in the source system, then record the entry (staff attestation)" : t.title,
      owner: ownerOf(t, ""), ownerId: t.owner_id, since: t.created_at, identity: identity || undefined,
      evidenceLabel: href.startsWith("/cases/") ? `${href.replace("/cases/", "")} tasks` : "Record", evidenceHref: href.startsWith("/cases/") ? `${href}?tab=tasks` : href,
      kind: identity ? "identity_conflict" : t.kind === "source_entry" ? "delay" : REVIEW_KIND[t.kind] ?? "pending_decision",
      where: t.kind === "source_entry" ? NO_MATERIAL.sourceEntry : where.entity(t.entity_type, t.entity_id, t.intake_item_id),
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
        owner: SOURCE_ENTRY_UNASSIGNED, ownerId: null, since: approvedAt.get(p.partId) ?? null,
        evidenceLabel: "Source-entry queue", evidenceHref: `/worklist?view=grossing&queue=source_entry&selected=${encodeURIComponent(r.accessionNumber)}`,
        kind: "delay", where: NO_MATERIAL.sourceEntry,
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
      q.buckets[AGE_BUCKET(m)] += 1;
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
  // Holds whose clarification is resolved and nothing else is awaited (not an amended order from the source).
  const releasable = holds.filter((h) => holdNext.get(h.id)?.waiting === "lab_release");
  if (releasable.length) {
    lines.push({
      text: `${releasable.length === 1 ? "1 hold has" : `${releasable.length} holds have`} a resolved clarification but ${releasable.length === 1 ? "is" : "are"} still active: ${releasable.map((h) => h.display_id).join(", ")}. A lead or supervisor must release each with a reason; resolution does not release a hold automatically.`,
      evidence: releasable.map((h) => ({ label: h.display_id, href: caseHref(h.accession_id) ?? "/operations?category=holds#blocked" })),
    });
  }
  if (!lines.length) lines.push({ text: "No open tasks: nobody is holding a pending handoff right now.", evidence: [{ label: "Blocked work", href: "/operations#blocked" }] });

  // ------------------------------------------------------------ bench path (derived, read-only)
  // Intake: provisional intake items not yet accessioned (orders). Later stages: parts on today's worklist by derived stage.
  const intakeItems = db
    .prepare("SELECT id, display_id, received_at FROM intake_item WHERE status NOT IN ('accessioned','canceled') ORDER BY received_at, display_id")
    .all() as { id: string; display_id: string; received_at: string | null }[];
  const intakeHolds = new Map<string, string[]>();
  for (const h of holds) {
    if (h.accession_id || !h.intake_item_id) continue;
    intakeHolds.set(h.intake_item_id, [...(intakeHolds.get(h.intake_item_id) ?? []), h.display_id]);
  }
  const oldestIntake = intakeItems.find((i) => i.received_at) ?? null;
  const pathStages: PathStage[] = [
    {
      key: "intake", label: STAGE.intake, unit: "order", count: intakeItems.length,
      held: intakeItems.filter((i) => intakeHolds.has(i.id)).length,
      holdIds: intakeItems.flatMap((i) => intakeHolds.get(i.id) ?? []),
      oldestSince: oldestIntake?.received_at ?? null, oldestAge: oldestIntake?.received_at ? fmtAge(oldestIntake.received_at, now) : null,
      oldestRef: oldestIntake?.display_id ?? null, oldestHref: oldestIntake ? `/intake?item=${encodeURIComponent(oldestIntake.display_id)}` : null, unknownAge: intakeItems.filter((i) => !i.received_at).length, href: "/intake",
    },
  ];
  for (const stage of [...QUEUE_STAGES, "delivered"] as Stage[]) {
    const parts = rows.flatMap((r) =>
      r.parts
        .filter((p) => p.stage === stage)
        .map((p) => ({
          p,
          ref: `${r.accessionNumber ?? r.provisionalId ?? "Unknown"} part ${p.designation}`,
          href: r.accessionNumber ? `/cases/${encodeURIComponent(r.accessionNumber)}?part=${encodeURIComponent(p.designation)}` : r.provisionalId ? `/intake?item=${encodeURIComponent(r.provisionalId)}` : null,
        })),
    );
    const waiting = stage === "delivered" ? [] : parts.filter(({ p }) => partSince.has(p.partId));
    const oldest = waiting.reduce<(typeof waiting)[number] | null>((o, x) => (!o || Date.parse(partSince.get(x.p.partId)!) < Date.parse(partSince.get(o.p.partId)!) ? x : o), null);
    const oldestSince = oldest ? partSince.get(oldest.p.partId)! : null;
    const heldParts = parts.filter(({ p }) => p.holds.length > 0);
    pathStages.push({
      key: stage, label: STAGE[stage], unit: "part", count: parts.length,
      held: heldParts.length, holdIds: [...new Set(heldParts.flatMap(({ p }) => p.holds.map((h) => h.displayId)))],
      oldestSince, oldestAge: oldestSince ? fmtAge(oldestSince, now) : null, oldestRef: oldest?.ref ?? null, oldestHref: oldest?.href ?? null,
      unknownAge: stage === "delivered" ? 0 : parts.length - waiting.length,
      href: `/worklist?view=operations&stage=${encodeURIComponent(stage)}`,
    });
  }

  // ------------------------------------------------------------ waiting work by owner and age (same records as `blocked`)
  const ownerMap = new Map<string, OwnerQueue>();
  for (const b of blocked) {
    const unassigned = !b.ownerId;
    const q =
      ownerMap.get(b.ownerKey) ??
      ownerMap
        .set(b.ownerKey, {
          key: b.ownerKey, owner: b.owner || "Unassigned", ownerId: b.ownerId, unassigned, buckets: [0, 0, 0, 0], unknown: 0, total: 0, holds: 0,
          oldestSince: null, oldestAge: "Unknown", href: `/operations?owner=${encodeURIComponent(b.ownerKey)}#blocked`,
        })
        .get(b.ownerKey)!;
    q.total += 1;
    if (b.category === "holds") q.holds += 1;
    if (!b.since) {
      q.unknown += 1;
      continue;
    }
    q.buckets[AGE_BUCKET(Math.max(0, minutesBetween(b.since, now)))] += 1;
    if (!q.oldestSince || Date.parse(b.since) < Date.parse(q.oldestSince)) {
      q.oldestSince = b.since;
      q.oldestAge = fmtAge(b.since, now);
    }
  }
  const ownerRows = [...ownerMap.values()].sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || a.owner.localeCompare(b.owner));

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
        "Parts on today's worklist (not yet sent on a tray) by derived stage. Age = demo clock minus the latest recorded event for the part (accession issued, gross record created or approved, block location confirmed, or a logged action on the part or its material). Synthetic demo data; a demo approximation of time in stage.",
      partsCounted,
    },
    handoffs: { label: "Who holds each open task. Computed by fixed rules from open tasks and holds (deterministic demo), not AI.", lines },
    path: {
      stages: pathStages,
      definition:
        "Orders at intake (wait since received), parts on today's worklist after it (wait since the part's latest recorded event).",
    },
    owners: {
      rows: ownerRows,
      bucketLabels: AGE_BUCKET_LABELS,
      definition: "Every blocked or waiting item below, by who holds its next step and how long it has waited. Sorted by name, unassigned last; not a workload or productivity measure.",
    },
  };
}
