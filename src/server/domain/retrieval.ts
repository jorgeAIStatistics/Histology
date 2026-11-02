import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { openTask } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { RETRIEVAL_STATUS, CUSTODY_STATE } from "@/lib/domain";
import { decodeLabel, humanLabel } from "@/lib/identifiers";
import { fmtDateTime, fmtTime, labDay } from "@/lib/time";
import { blockText, closeTasksForEntity, getBlock, getBlockByIdentifier, mustBlock, requireText, staffName, supervisorId, type BlockInfo } from "./material";

/**
 * Block retrieval. Locations are shown as LAST CONFIRMED (time and person),
 * never as live tracking. A pick succeeds only when the scanned block equals a
 * requested block; a wrong block changes nothing except the record of the
 * mismatch. Scanning a location never proves what is inside it.
 */

export const LOCATION_CAPTION = "Last confirmed location, not live tracking. The block may have moved since.";

export const ITEM_STATUS_LABEL: Record<string, string> = {
  pending: "To pick",
  picked: "Picked",
  not_found: "Not found at last location",
  missing_investigation: "Missing — investigation open",
  delivered: "Delivered",
  returned: "Returned to storage",
};

export type RetrievalScanResult = "picked" | "mismatch" | "duplicate" | "conflict" | "held_by_other" | "unknown_identifier" | "invalid_payload";

export interface RequestRow {
  id: string;
  display_id: string;
  requested_by: string;
  purpose: string;
  destination: string;
  work_order_id: string | null;
  status: string;
  due_at: string | null;
  created_at: string;
  version: number;
}

export interface ItemRow {
  id: string;
  request_id: string;
  block_id: string;
  bench_seq: number;
  status: string;
  picked_by: string | null;
  picked_at: string | null;
  note: string | null;
  mismatch_count: number;
  delivered_at: string | null;
  returned_at: string | null;
}

export function getRequest(db: DB, idOrDisplay: string): RequestRow | undefined {
  return db.prepare("SELECT * FROM retrieval_request WHERE id = ? OR display_id = ?").get(idOrDisplay, idOrDisplay) as RequestRow | undefined;
}

function mustRequest(db: DB, idOrDisplay: string): RequestRow {
  const r = getRequest(db, idOrDisplay);
  if (!r) throw new DomainError("NOT_FOUND", `Retrieval request ${idOrDisplay} was not found`);
  return r;
}

function itemsOf(db: DB, requestId: string): ItemRow[] {
  return db.prepare("SELECT * FROM retrieval_item WHERE request_id = ? ORDER BY bench_seq").all(requestId) as ItemRow[];
}

// ---------------------------------------------------------------- custody facts (derived from append-only events)

export interface CustodyEventView {
  id: string;
  event: string;
  at: string;
  actor: string | null;
  holder: string | null;
  locationCode: string | null;
  destination: string | null;
  note: string | null;
  requestDisplayId: string | null;
}

export function custodyHistory(db: DB, blockId: string): CustodyEventView[] {
  const rows = db
    .prepare(
      `SELECT ce.*, l.code AS loc_code, a.display_name AS actor_name, h.display_name AS holder_name, rr.display_id AS rr_display
         FROM custody_event ce LEFT JOIN storage_location l ON l.id = ce.location_id LEFT JOIN staff a ON a.id = ce.actor_id
         LEFT JOIN staff h ON h.id = ce.holder_id LEFT JOIN retrieval_request rr ON rr.id = ce.request_id
        WHERE ce.material_type = 'block' AND ce.material_id = ? ORDER BY ce.at DESC, ce.id DESC`,
    )
    .all(blockId) as {
    id: string; event: string; at: string; actor_id: string; actor_name: string | null; holder_name: string | null; loc_code: string | null;
    destination: string | null; note: string | null; rr_display: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    at: r.at,
    actor: r.actor_name ?? r.actor_id,
    holder: r.holder_name,
    locationCode: r.loc_code,
    destination: r.destination,
    note: r.note,
    requestDisplayId: r.rr_display,
  }));
}

export interface CustodyFacts {
  state: string;
  stateLabel: string;
  holder: string | null;
  since: string | null;
  destination: string | null;
  overdue: boolean;
  sentOutTo: string | null;
  note: string | null;
  summary: string;
}

/** Overdue rule (demo default, labeled in the UI): a checkout is expected back the same lab day. */
export function custodyFacts(db: DB, b: BlockInfo, now: string): CustodyFacts {
  // A hand-over at the request's destination is logged as a checked_out event too (custody unchanged); the checkout
  // still started when the block was picked, so hand-overs never move "since".
  const last = db
    .prepare(
      `SELECT event, at, destination, note FROM custody_event WHERE material_type = 'block' AND material_id = ?
         AND event IN ('checked_out','sent_out','missing_reported') AND COALESCE(note, '') NOT LIKE '${HANDOVER_NOTE_PREFIX}%'
       ORDER BY at DESC, id DESC LIMIT 1`,
    )
    .get(b.id) as { event: string; at: string; destination: string | null; note: string | null } | undefined;
  const stateLabel = CUSTODY_STATE[b.custody_state as keyof typeof CUSTODY_STATE] ?? b.custody_state;
  if (b.custody_state === "checked_out") {
    const since = last?.event === "checked_out" ? last.at : null;
    const overdue = !!since && labDay(since) < labDay(now);
    return {
      state: b.custody_state, stateLabel, holder: b.checkout_holder_name, since, destination: last?.destination ?? null, overdue, sentOutTo: null, note: last?.note ?? null,
      summary: `Checked out to ${b.checkout_holder_name ?? "Unknown holder"}${since ? ` since ${fmtDateTime(since)} ET` : " (time unknown)"}${last?.destination ? ` → ${last.destination}` : ""}${overdue ? " (overdue: expected back the same lab day)" : ""}`,
    };
  }
  if (b.custody_state === "sent_out") {
    const since = last?.event === "sent_out" ? last.at : null;
    return {
      state: b.custody_state, stateLabel, holder: null, since, destination: last?.destination ?? null, overdue: false, sentOutTo: last?.destination ?? "Unknown recipient",
      note: last?.note ?? null,
      summary: `Sent outside the lab${since ? ` on ${fmtDateTime(since)} ET` : ""}: ${last?.destination ?? "recipient unknown"}${last?.note ? ` (${last.note})` : ""}`,
    };
  }
  if (b.custody_state === "missing_investigation") {
    return {
      state: b.custody_state, stateLabel, holder: null, since: last?.at ?? null, destination: null, overdue: false, sentOutTo: null, note: last?.note ?? null,
      summary: `Not found at its last confirmed location${last ? ` (reported ${fmtDateTime(last.at)} ET)` : ""}. Investigation open.`,
    };
  }
  return { state: b.custody_state, stateLabel, holder: null, since: null, destination: null, overdue: false, sentOutTo: null, note: null, summary: stateLabel };
}

export interface LocationCard {
  code: string | null;
  label: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** "Last confirmed: CAB-2/DR-4/BX-11/S-14 · confirmed Oct 9, 3:20 PM ET by Marcus Lee" */
  text: string;
  caption: string;
}

export function locationCard(b: BlockInfo): LocationCard {
  const code = b.location_code;
  const text = code
    ? `Last confirmed: ${code} · confirmed ${b.location_confirmed_at ? `${fmtDateTime(b.location_confirmed_at)} ET` : "at an unknown time"} by ${b.location_confirmed_by_name ?? "Unknown"}`
    : "Last confirmed location: Unknown (no location has been recorded for this block)";
  return { code, label: b.location_label, confirmedAt: b.location_confirmed_at, confirmedBy: b.location_confirmed_by_name, text, caption: LOCATION_CAPTION };
}

/** "CAB-2/DR-4/BX-11/S-14" → group "CAB-2/DR-4/BX-11", slot "S-14". */
export function splitLocation(code: string | null): { group: string; groupLabel: string; slot: string | null } {
  if (!code) return { group: "~unknown", groupLabel: "Location unknown", slot: null };
  const parts = code.split("/");
  if (parts[0] === "OUTSIDE") return { group: "~outside", groupLabel: "Outside the lab", slot: null };
  if (parts[0] === "BENCH" || parts[0] === "PROCESSOR") return { group: `~${code}`, groupLabel: code, slot: null };
  const slot = parts.length >= 4 ? parts[3] : null;
  const group = parts.slice(0, 3).join("/");
  const label = parts
    .slice(0, 3)
    .map((p) => p.replace(/^CAB-/, "Cabinet ").replace(/^DR-/, "Drawer ").replace(/^BX-/, "Box "))
    .join(" · ");
  return { group, groupLabel: label, slot };
}

// ---------------------------------------------------------------- request status (derived from items)

function refreshRequestStatus(ctx: Ctx, requestId: string): string {
  const req = mustRequest(ctx.db, requestId);
  if (req.status === "canceled") return req.status;
  const items = itemsOf(ctx.db, requestId);
  const pending = items.filter((i) => i.status === "pending").length;
  const got = items.filter((i) => ["picked", "delivered", "returned"].includes(i.status)).length;
  const missing = items.filter((i) => i.status === "not_found" || i.status === "missing_investigation").length;
  const delivered = items.filter((i) => i.status === "delivered" || i.status === "returned").length;
  let next: string;
  if (pending === 0 && missing === 0 && delivered === items.length) next = "delivered";
  else if (pending === 0 && missing === 0) next = "retrieved";
  else if (pending === 0 && missing > 0) next = "partially_retrieved";
  else if (got > 0 || missing > 0) next = "picking";
  else next = "open";
  if (next !== req.status) updateVersioned(ctx.db, "retrieval_request", req.id, undefined, { status: next });
  if (pending === 0) closeTasksForEntity(ctx, "retrieval", req.id);
  return next;
}

// ---------------------------------------------------------------- commands

export function createRequest(
  ctx: Ctx,
  input: { blockIds: string[]; purpose: string; destination: string; workOrderId?: string | null },
): { requestId: string; displayId: string; message: string } {
  const purpose = requireText(input.purpose, "Say why the blocks are needed");
  const destination = requireText(input.destination, "Say where the blocks should go");
  const ids = input.blockIds.filter(Boolean);
  if (!ids.length) throw new DomainError("VALIDATION", "Choose at least one block");
  if (new Set(ids).size !== ids.length) throw new DomainError("VALIDATION", "The same block is listed twice");
  const blocks = ids.map((id) => mustBlock(ctx.db, id));
  if (input.workOrderId) {
    const wo = ctx.db.prepare("SELECT id FROM work_order WHERE id = ?").get(input.workOrderId);
    if (!wo) throw new DomainError("NOT_FOUND", "Work order not found");
  }
  const id = newId(ctx.db, "rr");
  const display = displayId(ctx.db, "RR", 4);
  ctx.db
    .prepare(
      `INSERT INTO retrieval_request (id, display_id, requested_by, purpose, destination, work_order_id, status, due_at, created_at, version)
       VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, 1)`,
    )
    .run(id, display, ctx.actor.id, purpose, destination, input.workOrderId ?? null, ctx.now);
  const ins = ctx.db.prepare("INSERT INTO retrieval_item (id, request_id, block_id, bench_seq, status) VALUES (?, ?, ?, ?, 'pending')");
  blocks.forEach((b, i) => ins.run(newId(ctx.db, "ri"), id, b.id, i + 1));
  openTask(ctx, {
    kind: "retrieval",
    entityType: "retrieval_request",
    entityId: id,
    title: `Pull ${blocks.length} block(s) for ${display} → ${destination}`,
    ownerRole: "histotech",
    priority: "routine",
    accessionId: blocks[0].accession_id,
  });
  audit(ctx, {
    action: "retrieval.created",
    entityType: "retrieval_request",
    entityId: id,
    accessionId: blocks[0].accession_id,
    summary: `${display} requested by ${ctx.actor.name}: ${blocks.map((b) => blockText(b)).join(", ")} → ${destination} (${purpose})`,
  });
  return { requestId: id, displayId: display, message: `${display} created with ${blocks.length} block(s) in bench order.` };
}

export interface RetrievalScanOutcome {
  requestId: string;
  requestDisplayId: string;
  result: RetrievalScanResult;
  accepted: boolean;
  scannedLabel: string | null;
  itemId: string | null;
  message: string;
  requestStatus: string;
}

export function scanForRequest(ctx: Ctx, requestIdOrDisplay: string, payload: string): RetrievalScanOutcome {
  const req = mustRequest(ctx.db, requestIdOrDisplay);
  if (req.status === "delivered" || req.status === "canceled") {
    throw new DomainError("BLOCKED", `${req.display_id} is ${RETRIEVAL_STATUS[req.status as keyof typeof RETRIEVAL_STATUS]?.toLowerCase() ?? req.status}; it no longer accepts scans`);
  }
  const raw = requireText(payload, "Scan or type a block label").toUpperCase();
  const items = itemsOf(ctx.db, req.id);
  const n = items.length;
  const out = (result: RetrievalScanResult, message: string, extra: Partial<RetrievalScanOutcome> = {}): RetrievalScanOutcome => ({
    requestId: req.id,
    requestDisplayId: req.display_id,
    result,
    accepted: result === "picked",
    scannedLabel: null,
    itemId: null,
    message,
    requestStatus: mustRequest(ctx.db, req.id).status,
    ...extra,
  });
  const pendingLabels = () =>
    itemsOf(ctx.db, req.id)
      .filter((i) => i.status === "pending")
      .map((i) => {
        const b = getBlock(ctx.db, i.block_id);
        return b ? blockText(b) : i.block_id;
      });

  const decoded = decodeLabel(raw);
  if (!decoded.ok || decoded.identity.kind !== "B") {
    const message = !decoded.ok
      ? `Not accepted: ${decoded.reason}. Rescan, or type the full block label code.`
      : `Scanned ${humanLabel(decoded.identity)}, which is not a block (cassette) label. Scan the block.`;
    audit(ctx, { action: "retrieval.scan_rejected", entityType: "retrieval_request", entityId: req.id, summary: `${req.display_id}: scan not accepted ("${raw}")`, reason: message });
    return out("invalid_payload", message);
  }
  const block = getBlockByIdentifier(ctx.db, decoded.payload);
  if (!block) {
    const message = `Label reads ${humanLabel(decoded.identity)}, but no such block exists in this lab's records. Not accepted.`;
    audit(ctx, { action: "retrieval.scan_rejected", entityType: "retrieval_request", entityId: req.id, summary: `${req.display_id}: unknown block label "${raw}"` });
    return out("unknown_identifier", message);
  }
  const label = blockText(block);
  const item = items.find((i) => i.block_id === block.id);

  if (!item) {
    const needs = pendingLabels();
    const message = `Mismatch. Scanned ${label}. ${req.display_id} needs ${needs.length ? needs.join(", ") : "no more blocks"}. Not accepted.`;
    ctx.db
      .prepare(
        `INSERT INTO custody_event (id, material_type, material_id, event, location_id, holder_id, destination, actor_id, at, note, request_id)
         VALUES (?, 'block', ?, 'scan_mismatch', ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(newId(ctx.db, "ce"), block.id, block.current_location_id, ctx.actor.id, ctx.now, `Wrong block scanned for ${req.display_id}; needed ${needs.join(", ") || "none"}. Nothing changed.`, req.id);
    audit(ctx, {
      action: "retrieval.scan_mismatch",
      entityType: "retrieval_request",
      entityId: req.id,
      accessionId: block.accession_id,
      summary: `${req.display_id}: wrong block scanned (${label}); not accepted, nothing changed`,
    });
    return out("mismatch", message, { scannedLabel: label });
  }

  if (["picked", "delivered", "returned"].includes(item.status)) {
    const message = `${label} was already picked for ${req.display_id}${item.picked_at ? ` at ${fmtTime(item.picked_at)} ET by ${staffName(ctx.db, item.picked_by)}` : ""}. Nothing changed.`;
    return out("duplicate", message, { scannedLabel: label, itemId: item.id });
  }

  if (block.custody_state === "sent_out") {
    const facts = custodyFacts(ctx.db, block, ctx.now);
    const message = `${label} was scanned here, but the record shows it ${facts.summary.toLowerCase()}. Conflicting records: not picked. A supervisor will review the custody record.`;
    ctx.db
      .prepare(
        `INSERT INTO custody_event (id, material_type, material_id, event, location_id, holder_id, destination, actor_id, at, note, request_id)
         VALUES (?, 'block', ?, 'found', NULL, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(newId(ctx.db, "ce"), block.id, ctx.actor.id, ctx.now, `Scanned at the lab for ${req.display_id} while recorded as sent out. Conflicting records; nothing auto-resolved.`, req.id);
    openTask(ctx, {
      kind: "custody_conflict",
      entityType: "block",
      entityId: block.id,
      title: `Conflicting custody records for ${label}: scanned in the lab, recorded as sent out`,
      ownerId: supervisorId(ctx.db),
      ownerRole: "supervisor",
      priority: "high",
      accessionId: block.accession_id,
    });
    audit(ctx, { action: "retrieval.scan_conflict", entityType: "retrieval_request", entityId: req.id, accessionId: block.accession_id, summary: `${req.display_id}: ${label} scanned while recorded as sent out (conflict, not picked)` });
    return out("conflict", message, { scannedLabel: label, itemId: item.id });
  }

  // Recorded as checked out to someone else: the record and the scan disagree about who holds it.
  // Not resolved automatically; the recorded holder scans it, or a supervisor records the hand-off.
  const heldByOther = block.custody_state === "checked_out" && !!block.checkout_holder_id && block.checkout_holder_id !== ctx.actor.id;
  if (heldByOther && ctx.actor.role !== "supervisor") {
    const facts = custodyFacts(ctx.db, block, ctx.now);
    const message = `${label} is recorded as ${facts.summary.charAt(0).toLowerCase()}${facts.summary.slice(1)}. Not picked: ${block.checkout_holder_name ?? "the recorded holder"} scans it for ${req.display_id}, or a supervisor records the hand-off. Nothing changed.`;
    audit(ctx, {
      action: "retrieval.scan_held_by_other",
      entityType: "retrieval_request",
      entityId: req.id,
      accessionId: block.accession_id,
      summary: `${req.display_id}: ${label} scanned by ${ctx.actor.name} while recorded as checked out to ${block.checkout_holder_name ?? "Unknown"}; not picked`,
    });
    return out("held_by_other", message, { scannedLabel: label, itemId: item.id });
  }

  // Correct block: pick it and record custody to the person holding it.
  const wasMissing = item.status !== "pending" || block.custody_state === "missing_investigation";
  const previousHolder = heldByOther ? block.checkout_holder_name : null;
  ctx.db.prepare("UPDATE retrieval_item SET status = 'picked', picked_by = ?, picked_at = ? WHERE id = ?").run(ctx.actor.id, ctx.now, item.id);
  updateVersioned(ctx.db, "block", block.id, undefined, { custody_state: "checked_out", checkout_holder_id: ctx.actor.id });
  const insCe = ctx.db.prepare(
    `INSERT INTO custody_event (id, material_type, material_id, event, location_id, holder_id, destination, actor_id, at, note, request_id)
     VALUES (?, 'block', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  if (wasMissing) {
    insCe.run(newId(ctx.db, "ce"), block.id, "found", block.current_location_id, null, null, ctx.actor.id, ctx.now, `Found and scanned for ${req.display_id}`, req.id);
    closeTasksForEntity(ctx, "missing_material", block.id);
  }
  insCe.run(
    newId(ctx.db, "ce"), block.id, "checked_out", block.current_location_id, ctx.actor.id, req.destination, ctx.actor.id, ctx.now,
    `Picked for ${req.display_id} (pick ${item.bench_seq} of ${n})${previousHolder ? `; hand-off from recorded holder ${previousHolder} recorded by supervisor ${ctx.actor.name}` : ""}`, req.id,
  );
  const status = refreshRequestStatus(ctx, req.id);
  audit(ctx, {
    action: "retrieval.picked",
    entityType: "retrieval_request",
    entityId: req.id,
    accessionId: block.accession_id,
    summary: `${req.display_id}: ${label} scanned and picked by ${ctx.actor.name} (pick ${item.bench_seq} of ${n}) → ${req.destination}${previousHolder ? ` (custody handed off from ${previousHolder}, recorded by a supervisor)` : ""}`,
  });
  return out(
    "picked",
    `Scanned ${label}. Matches ${req.display_id} (pick ${item.bench_seq} of ${n}). Checked out to ${ctx.actor.name} → ${req.destination}.${wasMissing ? " It had been reported missing; that investigation is closed." : ""}`,
    { scannedLabel: label, itemId: item.id, requestStatus: status },
  );
}

export function markNotFound(ctx: Ctx, itemId: string, note: string): { itemId: string; taskId: string; message: string } {
  const why = requireText(note, "Describe what was checked (slot, neighbouring slots, box)");
  const item = ctx.db.prepare("SELECT * FROM retrieval_item WHERE id = ?").get(itemId) as ItemRow | undefined;
  if (!item) throw new DomainError("NOT_FOUND", "Retrieval item not found");
  const req = mustRequest(ctx.db, item.request_id);
  if (item.status !== "pending") throw new DomainError("VALIDATION", `This item is ${ITEM_STATUS_LABEL[item.status]?.toLowerCase() ?? item.status}; only an item still to pick can be reported not found`);
  const block = mustBlock(ctx.db, item.block_id);
  const label = blockText(block);
  const card = locationCard(block);
  if (block.custody_state === "sent_out") {
    throw new DomainError(
      "BLOCKED",
      `${label} is recorded as sent outside the lab (${custodyFacts(ctx.db, block, ctx.now).summary}). Request it back from the recipient; it is not expected in storage.`,
    );
  }
  // Where it should have been: the recorded holder for a checkout, otherwise the last confirmed slot.
  const holderName = block.custody_state === "checked_out" ? block.checkout_holder_name ?? "the recorded holder" : null;
  const where = holderName ? `with recorded holder ${holderName}` : `at ${card.code ?? "its last confirmed location"}`;
  ctx.db.prepare("UPDATE retrieval_item SET status = 'missing_investigation', note = ? WHERE id = ?").run(why, item.id);
  updateVersioned(ctx.db, "block", block.id, undefined, { custody_state: "missing_investigation", checkout_holder_id: null });
  ctx.db
    .prepare(
      `INSERT INTO custody_event (id, material_type, material_id, event, location_id, holder_id, destination, actor_id, at, note, request_id)
       VALUES (?, 'block', ?, 'missing_reported', ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(newId(ctx.db, "ce"), block.id, block.current_location_id, block.checkout_holder_id, ctx.actor.id, ctx.now, `Not found ${where} for ${req.display_id}: ${why}`, req.id);
  const taskId = openTask(ctx, {
    kind: "missing_material",
    entityType: "block",
    entityId: block.id,
    title: `Missing-material investigation: ${label} not found ${where}`,
    ownerId: ctx.actor.id,
    ownerRole: "histotech",
    priority: "high",
    accessionId: block.accession_id,
    detail: `${card.text}. ${why}`,
  });
  const status = refreshRequestStatus(ctx, req.id);
  audit(ctx, {
    action: "retrieval.not_found",
    entityType: "retrieval_request",
    entityId: req.id,
    accessionId: block.accession_id,
    summary: `${req.display_id}: ${label} not found ${where}; missing-material investigation opened`,
    reason: why,
  });
  return { itemId, taskId, message: `${label} recorded as not found. Investigation task opened. Request is ${RETRIEVAL_STATUS[status as keyof typeof RETRIEVAL_STATUS]?.toLowerCase() ?? status}.` };
}

/** Note prefix of the custody event that records a hand-over at a request's destination. */
const HANDOVER_NOTE_PREFIX = "Delivered to ";

/**
 * Hand picked blocks over at the request's destination. The hand-over is a custody record ("delivered to <destination>",
 * logged as a checked_out event with the destination: the block stays in the picker's custody). It is NOT a location
 * confirmation: the last confirmed location and its time and person change only when the destination itself is scanned
 * (`opts.scannedLocationCode`, a storage location whose code or label is the destination).
 */
export function deliverRequest(
  ctx: Ctx,
  requestIdOrDisplay: string,
  opts: { scannedLocationCode?: string | null } = {},
): { requestId: string; delivered: number; status: string; message: string } {
  const req = mustRequest(ctx.db, requestIdOrDisplay);
  const picked = itemsOf(ctx.db, req.id).filter((i) => i.status === "picked");
  if (!picked.length) throw new DomainError("VALIDATION", `Nothing picked for ${req.display_id} yet. Scan each block first.`);
  let scanned: { id: string; code: string } | undefined;
  if (opts.scannedLocationCode?.trim()) {
    const code = opts.scannedLocationCode.trim().toUpperCase();
    scanned = ctx.db.prepare("SELECT id, code FROM storage_location WHERE upper(code) = ? AND (lower(label) = lower(?) OR upper(code) = upper(?))").get(code, req.destination, req.destination) as
      | { id: string; code: string }
      | undefined;
    if (!scanned) throw new DomainError("VALIDATION", `${code} is not the destination of ${req.display_id} (${req.destination}). Nothing was delivered.`);
  }
  for (const i of picked) {
    const b = mustBlock(ctx.db, i.block_id);
    ctx.db.prepare("UPDATE retrieval_item SET status = 'delivered', delivered_at = ? WHERE id = ?").run(ctx.now, i.id);
    if (scanned) updateVersioned(ctx.db, "block", b.id, undefined, { current_location_id: scanned.id, location_confirmed_at: ctx.now, location_confirmed_by: ctx.actor.id });
    ctx.db
      .prepare(
        `INSERT INTO custody_event (id, material_type, material_id, event, location_id, holder_id, destination, actor_id, at, note, request_id)
         VALUES (?, 'block', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(ctx.db, "ce"), b.id, scanned ? "location_confirmed" : "checked_out", scanned?.id ?? null, b.checkout_holder_id, req.destination, ctx.actor.id, ctx.now,
        `${HANDOVER_NOTE_PREFIX}${req.destination} for ${req.display_id}${scanned ? ` (destination ${scanned.code} scanned)` : " (hand-over recorded; destination not scanned, last confirmed location unchanged)"}`,
        req.id,
      );
  }
  const status = refreshRequestStatus(ctx, req.id);
  audit(ctx, {
    action: "retrieval.delivered",
    entityType: "retrieval_request",
    entityId: req.id,
    summary: `${req.display_id}: ${picked.length} block(s) delivered to ${req.destination} by ${ctx.actor.name}`,
  });
  const remaining = itemsOf(ctx.db, req.id).filter((i) => i.status === "pending" || i.status === "missing_investigation" || i.status === "not_found").length;
  return {
    requestId: req.id,
    delivered: picked.length,
    status,
    message: `${picked.length} block(s) delivered to ${req.destination}.${remaining ? ` ${remaining} still outstanding (partial retrieval).` : ""}`,
  };
}

/**
 * Return a block to a storage slot. Only a block that is checked out or missing (investigation open) can be
 * returned; a block that was missing also needs a note saying where it was found (A-11).
 */
export function returnBlock(ctx: Ctx, blockId: string, locationCode: string, note?: string | null): { blockId: string; message: string } {
  const code = requireText(locationCode, "Scan or type the storage slot, e.g. CAB-2/DR-4/BX-11/S-14").toUpperCase();
  const block = getBlock(ctx.db, blockId) ?? getBlockByIdentifier(ctx.db, blockId);
  if (!block) throw new DomainError("NOT_FOUND", "Block not found");
  const loc = ctx.db.prepare("SELECT id, code, kind FROM storage_location WHERE upper(code) = ?").get(code) as { id: string; code: string; kind: string } | undefined;
  if (!loc) throw new DomainError("VALIDATION", `Unknown location "${code}". Use the full slot address, for example CAB-2/DR-4/BX-11/S-14.`);
  if (loc.kind !== "slot") throw new DomainError("VALIDATION", `${loc.code} is a ${loc.kind}, not a storage slot. Return blocks to a specific slot.`);
  const label = blockText(block);
  if (block.custody_state === "stored" && block.current_location_id === loc.id) {
    return { blockId: block.id, message: `${label} is already recorded in ${loc.code}. Nothing changed.` };
  }
  if (block.custody_state === "sent_out") {
    throw new DomainError("BLOCKED", `${label} is recorded as sent outside the lab. Record it as received back before filing it.`);
  }
  if (block.custody_state !== "checked_out" && block.custody_state !== "missing_investigation") {
    const state = CUSTODY_STATE[block.custody_state as keyof typeof CUSTODY_STATE] ?? block.custody_state;
    throw new DomainError(
      "BLOCKED",
      `${label} is recorded as "${state}"${block.location_code ? ` at ${block.location_code}` : ""}. Only a checked-out or missing block can be returned to storage. Nothing changed.`,
    );
  }
  const wasMissing = block.custody_state === "missing_investigation";
  const foundNote = (note ?? "").trim();
  if (wasMissing && !foundNote) {
    throw new DomainError("VALIDATION", `${label} was reported missing. Say where it was found before filing it in ${loc.code}. Nothing changed.`);
  }
  updateVersioned(ctx.db, "block", block.id, undefined, {
    custody_state: "stored",
    checkout_holder_id: null,
    current_location_id: loc.id,
    location_confirmed_at: ctx.now,
    location_confirmed_by: ctx.actor.id,
  });
  ctx.db
    .prepare(
      `INSERT INTO custody_event (id, material_type, material_id, event, location_id, holder_id, destination, actor_id, at, note, request_id)
       VALUES (?, 'block', ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
    )
    .run(
      newId(ctx.db, "ce"), block.id, wasMissing ? "found" : "returned", loc.id, ctx.actor.id, ctx.now,
      `${wasMissing ? `Found (${foundNote}); ` : ""}Returned and filed in ${loc.code} (this block's scan only; other contents of the slot are not confirmed)`,
    );
  const items = ctx.db
    .prepare("SELECT id, request_id, status FROM retrieval_item WHERE block_id = ? AND status IN ('picked','delivered','missing_investigation','not_found')")
    .all(block.id) as { id: string; request_id: string; status: string }[];
  for (const i of items) {
    if (i.status === "picked" || i.status === "delivered") {
      ctx.db.prepare("UPDATE retrieval_item SET status = 'returned', returned_at = ? WHERE id = ?").run(ctx.now, i.id);
    } else {
      // Found again: the request can pick it now.
      ctx.db.prepare("UPDATE retrieval_item SET status = 'pending', note = ? WHERE id = ?").run(`Found and filed in ${loc.code}`, i.id);
    }
    refreshRequestStatus(ctx, i.request_id);
  }
  if (wasMissing) closeTasksForEntity(ctx, "missing_material", block.id);
  audit(ctx, {
    action: "retrieval.returned",
    entityType: "block",
    entityId: block.id,
    accessionId: block.accession_id,
    summary: `${label} returned to ${loc.code} by ${ctx.actor.name}${wasMissing ? ` (was missing; investigation closed: ${foundNote})` : ""}`,
    reason: wasMissing ? foundNote : undefined,
  });
  return { blockId: block.id, message: `${label} filed in ${loc.code}. Location confirmed now by ${ctx.actor.name}.` };
}
