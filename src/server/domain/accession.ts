import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { displayId, newId } from "../core/ids";
import { audit } from "../core/audit";
import { recordWorklistChange } from "../core/feed";
import { attachTasksToAccession, closeTasks } from "../core/tasks";
import { updateVersioned } from "../core/versioning";
import { holdsBlocking, scopesForIntake } from "./holds";
import { currentRouting } from "./routing";
import { candidatesForIntake, intakeItemsForOrder, type CandidateRow } from "./related";
import {
  COMPARE_FIELD_LABEL,
  IDENTITY_FIELDS,
  clarificationCovering,
  comparisonForContainer,
  containersFor,
  coveringCategories,
  identityCoverage,
  intakeStaffName,
  loadIntakeItem,
  type CompareField,
  type DiscrepancyRow,
  type IntakeItemRow,
} from "./intake";
import { openSourceConflictsForOrder } from "./sourceConflict";
import { accessionSourceStatus, issueNumber, recordIssuedEvent, simulatorCtx, type IssuedNumber } from "../sim/authoritative";
import { labDay } from "@/lib/time";

/**
 * Accession request (SM-9). Preconditions are re-checked on the server inside
 * the command transaction (INV-17):
 *   - every container staff-verified (against the order version that is
 *     current now), or each recorded mismatch covered by a clarification of a
 *     matching category that is still open or was resolved after the finding;
 *   - a patient identity mismatch (name, birth date, MRN) blocks until an
 *     identity clarification is RESOLVED by a lead as "office confirmed the
 *     order is correct" (confirmed_order): an open question, a scoped hold, a
 *     clarification of another category or any other resolution code is not
 *     enough (intake.ts identityCoverage);
 *   - no open source-conflict review on a linked order or its patient
 *     reference (the source sent different patient or order-level details);
 *   - every expected container received (or its absence covered by a
 *     clarification); more containers than expected covered or accepted;
 *   - routing confirmed or overridden (an exception must be resolved by a lead);
 *   - every related-order candidate reviewed; items approved as one accession
 *     are requested together, items kept separate are not;
 *   - no hold blocking `accession_request`.
 * The official number comes from the simulated authoritative source. While it
 * is offline, the request stays `submitted` and can be retried. Repeating the
 * request for the same set of items returns the same request/accession.
 */

export interface Blocker {
  code:
    | "not_found" | "status" | "office_unknown" | "order_not_linked" | "order_canceled" | "container_unverified" | "discrepancy_uncovered"
    | "identity_unresolved" | "source_conflict_open" | "verification_stale" | "missing_container" | "extra_container" | "unmatched_container"
    | "routing_not_confirmed" | "routing_exception" | "routing_differs" | "related_pending"
    | "related_request_together" | "related_kept_separate" | "not_grouped" | "different_patients" | "hold" | "pending_request";
  intakeItemId: string | null;
  itemDisplay: string | null;
  message: string;
}

interface ItemOrders {
  item: IntakeItemRow;
  orders: { id: string; source_order_id: string; tenant_id: string; patient_ref_id: string; source_status: string; office_id: string; ordering_clinician_id: string | null }[];
}

function itemOrders(db: DB, item: IntakeItemRow): ItemOrders {
  const orders = db
    .prepare(
      `SELECT so.id, so.source_order_id, so.tenant_id, so.patient_ref_id, so.source_status, so.office_id, so.ordering_clinician_id
         FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id WHERE l.intake_item_id = ? ORDER BY so.source_order_id`,
    )
    .all(item.id) as ItemOrders["orders"];
  return { item, orders };
}

const LEGACY_FIELD = "__recorded_discrepancy";
const ALL_CATEGORIES = ["site", "laterality", "orientation_marking", "biopsy_method", "identity_conflict", "missing_container", "related_orders", "other"];

function categoryWords(cats: string[]): string {
  if (cats === ALL_CATEGORIES) return "any category";
  return cats.map((c) => c.replace(/_/g, " ")).join(" / ");
}

function partLabel(db: DB, orderPartId: string | null): string {
  if (!orderPartId) return "unlinked part";
  const r = db
    .prepare("SELECT so.source_order_id, sop.designation FROM source_order_part sop JOIN source_order so ON so.id = sop.source_order_id WHERE sop.id = ?")
    .get(orderPartId) as { source_order_id: string; designation: string } | undefined;
  return r ? `${r.source_order_id} part ${r.designation}` : "unknown part";
}

/** Everything that stops these intake items from being requested together right now (empty = ready). */
export function accessionBlockers(db: DB, intakeItemIds: string[], ownRequestId?: string | null): Blocker[] {
  const blockers: Blocker[] = [];
  const ids = [...new Set(intakeItemIds)];
  const groups: ItemOrders[] = [];
  for (const id of ids) {
    const it = db.prepare("SELECT * FROM intake_item WHERE id = ?").get(id) as IntakeItemRow | undefined;
    if (!it) {
      blockers.push({ code: "not_found", intakeItemId: id, itemDisplay: null, message: "Intake item was not found" });
      continue;
    }
    groups.push(itemOrders(db, it));
  }
  const requestOrderIds = new Set(groups.flatMap((g) => g.orders.map((o) => o.id)));
  const requestItemIds = new Set(groups.map((g) => g.item.id));

  for (const { item, orders } of groups) {
    const b = (code: Blocker["code"], message: string) => blockers.push({ code, intakeItemId: item.id, itemDisplay: item.display_id, message });
    if (item.status === "canceled") b("status", `${item.display_id} is canceled`);
    if (item.status === "accession_requested") {
      const pending = db
        .prepare(
          `SELECT ar.id, ar.display_id FROM accession_request ar JOIN accession_request_item ai ON ai.request_id = ar.id
            WHERE ai.intake_item_id = ? AND ar.status = 'submitted'`,
        )
        .all(item.id) as { id: string; display_id: string }[];
      const other = pending.filter((p) => p.id !== ownRequestId);
      if (other.length) b("pending_request", `${item.display_id} already has accession request ${other.map((o) => o.display_id).join(", ")} waiting for the source; retry that request instead`);
    }
    if (!item.office_id) b("office_unknown", `${item.display_id}: office "${item.observed_office_text ?? "unknown"}" is not in the office directory`);
    if (!orders.length) b("order_not_linked", `${item.display_id}: no source order is linked (order ids are looked up within the office's tenant)`);
    for (const o of orders) if (o.source_status === "canceled") b("order_canceled", `${o.source_order_id} is canceled at the source`);
    // The source sent patient (or order-level) details that differ from what is on file: a lead reviews it first.
    const seenConflicts = new Set<string>();
    for (const o of orders) {
      for (const t of openSourceConflictsForOrder(db, o)) {
        if (seenConflicts.has(t.id)) continue;
        seenConflicts.add(t.id);
        b(
          "source_conflict_open",
          t.entity_type === "patient_ref"
            ? `${o.source_order_id}: the source sent patient details that differ from the patient on file. Accession waits until an accessioning lead or supervisor reviews the source conflict; nothing is merged or changed automatically`
            : `${o.source_order_id}: a newer order version changed order-level details (patient, office or encounter) that were not applied. Accession waits until an accessioning lead or supervisor reviews the source conflict`,
        );
      }
    }

    // Containers and expected parts.
    const containers = containersFor(db, item.id);
    for (const c of containers) {
      const where = `${item.display_id} container ${c.seq} (${partLabel(db, c.order_part_id)})`;
      if (c.verification_state === "unverified") {
        b("container_unverified", `${where}: not yet staff verified against the physical container`);
        continue;
      }
      const refs = { containerId: c.id, orderPartId: c.order_part_id };
      const rows = (
        db.prepare("SELECT * FROM intake_discrepancy WHERE container_id = ? AND kind = 'field_mismatch' AND status = 'open' ORDER BY detected_at").all(c.id) as DiscrepancyRow[]
      ).filter((r) => !c.order_part_id || r.order_part_id === c.order_part_id);
      let identity = rows.filter((r) => IDENTITY_FIELDS.includes(r.field ?? "")).map((r) => ({ field: r.field ?? "", since: r.detected_at as string | null }));
      let other = rows.filter((r) => !IDENTITY_FIELDS.includes(r.field ?? "")).map((r) => ({ field: r.field ?? "", since: r.detected_at as string | null }));
      if (c.verification_state === "discrepancy" && !rows.length) {
        // A discrepancy recorded before field-level findings were kept (seeded history): use the live comparison.
        const live = comparisonForContainer(db, c).filter((r) => r.status === "differs");
        identity = live.filter((r) => IDENTITY_FIELDS.includes(r.field)).map((r) => ({ field: r.field, since: null }));
        other = live.filter((r) => !IDENTITY_FIELDS.includes(r.field)).map((r) => ({ field: r.field, since: null }));
        if (!identity.length && !other.length) other = [{ field: LEGACY_FIELD, since: null }];
      }
      if (identity.length) {
        const since = identity.map((i) => i.since).filter((x): x is string => !!x).sort()[0] ?? null;
        const cov = identityCoverage(db, { ...refs, intakeItemId: item.id }, since);
        if (!cov.covering) {
          const labels = [...new Set(identity.map((i) => COMPARE_FIELD_LABEL[i.field as CompareField]?.toLowerCase() ?? i.field))].join(", ");
          b(
            "identity_unresolved",
            cov.notCovering
              ? `${where}: patient identity differs (${labels}). ${cov.notCovering.clarification.display_id} was ${cov.notCovering.why}`
              : `${where}: patient identity differs (${labels}). Accession waits until a lead resolves an identity clarification as "office confirmed the order is correct"; an open question or a scoped hold is not enough`,
          );
        }
      }
      for (const o of other) {
        const cats = o.field === LEGACY_FIELD ? ALL_CATEGORIES : coveringCategories("field_mismatch", o.field);
        const cov = clarificationCovering(db, refs, { categories: cats, since: o.since });
        if (!cov) {
          const label = COMPARE_FIELD_LABEL[o.field as CompareField] ?? "A field";
          b(
            "discrepancy_uncovered",
            `${where}: ${label.toLowerCase()} differs and no matching clarification (${categoryWords(cats)}) is open or was resolved after it was recorded. Raise one, or ask a lead to accept it with a reason`,
          );
        }
      }
      // INV-13: a check made against an older order version must be repeated.
      if (c.verification_state === "verified" && c.order_part_id) {
        const last = db
          .prepare("SELECT source_order_version v FROM container_verification WHERE container_id = ? AND order_part_id = ? ORDER BY attested_at DESC, rowid DESC LIMIT 1")
          .get(c.id, c.order_part_id) as { v: number } | undefined;
        const cur = db
          .prepare("SELECT so.source_version v, so.source_order_id ref FROM source_order_part sop JOIN source_order so ON so.id = sop.source_order_id WHERE sop.id = ?")
          .get(c.order_part_id) as { v: number; ref: string } | undefined;
        if (last && cur && last.v < cur.v) {
          b("verification_stale", `${where}: checked against ${cur.ref} v${last.v}, but the order is now v${cur.v}. Check the container again against the current order`);
        }
      }
    }
    const openDisc = db
      .prepare(
        "SELECT * FROM intake_discrepancy WHERE intake_item_id = ? AND status = 'open' AND kind IN ('missing_container','extra_container','unmatched_container') ORDER BY detected_at",
      )
      .all(item.id) as DiscrepancyRow[];
    for (const d of openDisc) {
      if (d.kind === "missing_container" || d.kind === "extra_container") {
        const cats = coveringCategories(d.kind);
        const cov = clarificationCovering(db, { orderPartId: d.order_part_id }, { categories: cats, since: d.detected_at });
        if (cov) continue;
        if (d.kind === "missing_container") b("missing_container", `${item.display_id}: no container received for ${partLabel(db, d.order_part_id)}. Raise a missing-container clarification first`);
        else {
          const detail = (JSON.parse(d.values_json) as { detail?: string }).detail ?? partLabel(db, d.order_part_id);
          b("extra_container", `${item.display_id}: more containers than expected (${detail}). Raise a clarification, or ask a lead to accept it with a reason`);
        }
      } else {
        const c = containers.find((x) => x.id === d.container_id);
        b("unmatched_container", `${item.display_id} container ${c?.seq ?? "?"}: not matched to an order part. Verify it against the correct part`);
      }
    }

    // Routing.
    const rd = currentRouting(db, item.id);
    if (!rd) b("routing_not_confirmed", `${item.display_id}: no routing decision`);
    else if (rd.status === "exception") b("routing_exception", `${item.display_id}: routing exception — an accessioning lead or supervisor must assign a dermatopathologist`);
    else if (rd.status === "suggested") b("routing_not_confirmed", `${item.display_id}: routing suggestion not yet accepted`);

    // Related-order review.
    for (const cand of candidatesForIntake(db, item.id)) {
      const otherOrder = orders.some((o) => o.id === cand.order_a_id) ? cand.order_b_id : cand.order_a_id;
      const otherItems = intakeItemsForOrder(db, otherOrder).filter((x) => x.id !== item.id && x.status !== "accessioned");
      if (cand.status === "pending_review") b("related_pending", `${cand.display_id}: possible related orders need a lead's review first`);
      else if (cand.status === "escalated_to_office") b("related_pending", `${cand.display_id}: waiting for the office (escalated); decide before requesting`);
      else if (cand.status === "single_accession_approved") {
        const missing = otherItems.filter((x) => !requestItemIds.has(x.id));
        if (missing.length && !requestOrderIds.has(otherOrder)) {
          b("related_request_together", `${cand.display_id} was approved as one accession: request ${item.display_id} together with ${missing.map((m) => m.display_id).join(", ")}`);
        }
      } else if (requestOrderIds.has(otherOrder)) {
        b("related_kept_separate", `${cand.display_id} was decided "${cand.status === "keep_separate" ? "keep separate" : "not related"}": request these items separately`);
      }
    }

    // Holds that gate accession on this item, its containers or its order parts.
    for (const h of holdsBlocking(db, "accession_request", scopesForIntake(db, item.id))) {
      b("hold", `${h.display_id} on ${h.scope_label}: ${h.reason_text} (blocks accession request)`);
    }
  }

  // Requesting several items together: one tenant-scoped patient, approved grouping, one assigned pathologist.
  if (groups.length > 1) {
    const patients = new Set(groups.flatMap((g) => g.orders.map((o) => `${o.tenant_id}:${o.patient_ref_id}`)));
    if (patients.size > 1) {
      blockers.push({ code: "different_patients", intakeItemId: null, itemDisplay: null, message: "These items belong to different patient references; they can never be one accession in this app" });
    }
    // Union-find over approved candidates among the requested orders.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      const p = parent.get(x) ?? x;
      if (p === x) return x;
      const r = find(p);
      parent.set(x, r);
      return r;
    };
    for (const g of groups) parent.set(g.item.id, g.item.id);
    const orderToItem = new Map<string, string>();
    for (const g of groups) for (const o of g.orders) orderToItem.set(o.id, g.item.id);
    const approved = db
      .prepare("SELECT * FROM related_order_candidate WHERE status = 'single_accession_approved'")
      .all() as CandidateRow[];
    for (const c of approved) {
      const a = orderToItem.get(c.order_a_id);
      const bb = orderToItem.get(c.order_b_id);
      if (a && bb && a !== bb) parent.set(find(a), find(bb));
    }
    const roots = new Set(groups.map((g) => find(g.item.id)));
    if (roots.size > 1) {
      blockers.push({
        code: "not_grouped",
        intakeItemId: null,
        itemDisplay: null,
        message: `${groups.map((g) => g.item.display_id).join(", ")} are not approved as one accession. A lead must approve the related-order candidate first`,
      });
    }
    const finals = new Set(
      groups
        .map((g) => currentRouting(db, g.item.id))
        .filter((r) => r && (r.status === "confirmed" || r.status === "overridden"))
        .map((r) => r!.final_pathologist_id),
    );
    if (finals.size > 1) {
      blockers.push({ code: "routing_differs", intakeItemId: null, itemDisplay: null, message: "The items are routed to different dermatopathologists; resolve routing before requesting one accession" });
    }
  }
  return blockers;
}

export interface AccessionRequestResult {
  requestId: string;
  requestDisplayId: string;
  status: "submitted" | "issued";
  outcome: "issued" | "source_offline" | "duplicate";
  duplicate: boolean;
  accessionId: string | null;
  accessionNumber: string | null;
  namespace: string | null;
  issuedBy: string | null;
  message: string;
  parts: { designation: string; originalDesignation: string; sourceOrderId: string }[];
}

interface RequestRow {
  id: string;
  display_id: string;
  status: string;
  related_candidate_id: string | null;
  requested_by: string | null;
  requested_at: string;
  idempotency_key: string;
  accession_id: string | null;
  failure_detail: string | null;
  version: number;
}

function partsOf(db: DB, accessionId: string): AccessionRequestResult["parts"] {
  return (
    db
      .prepare(
        `SELECT sp.designation, sp.original_designation, so.source_order_id FROM specimen_part sp JOIN source_order so ON so.id = sp.source_order_id
          WHERE sp.accession_id = ? ORDER BY sp.designation`,
      )
      .all(accessionId) as { designation: string; original_designation: string; source_order_id: string }[]
  ).map((p) => ({ designation: p.designation, originalDesignation: p.original_designation, sourceOrderId: p.source_order_id }));
}

function existingResult(db: DB, req: RequestRow, message: string): AccessionRequestResult {
  const acc = req.accession_id
    ? (db.prepare("SELECT accession_number, namespace, issued_by_system FROM accession WHERE id = ?").get(req.accession_id) as
        | { accession_number: string; namespace: string; issued_by_system: string }
        | undefined)
    : undefined;
  return {
    requestId: req.id, requestDisplayId: req.display_id, status: req.status === "issued" ? "issued" : "submitted", outcome: "duplicate", duplicate: true,
    accessionId: req.accession_id, accessionNumber: acc?.accession_number ?? null, namespace: acc?.namespace ?? null, issuedBy: acc?.issued_by_system ?? null,
    message, parts: req.accession_id ? partsOf(db, req.accession_id) : [],
  };
}

export function requestKey(intakeItemIds: string[]): string {
  return `accession:${[...new Set(intakeItemIds)].sort().join("+")}`;
}

/** Request the official accession for one item, or for items approved as one accession. Idempotent per set of items. */
export function requestAccession(ctx: Ctx, intakeItemIds: string[], relatedCandidateId?: string | null): AccessionRequestResult {
  const db = ctx.db;
  const ids = [...new Set(intakeItemIds)].sort();
  if (!ids.length) throw new DomainError("VALIDATION", "Choose at least one intake item");
  const key = requestKey(ids);
  let req = db.prepare("SELECT * FROM accession_request WHERE idempotency_key = ?").get(key) as RequestRow | undefined;
  if (req?.status === "issued") {
    const acc = db.prepare("SELECT accession_number FROM accession WHERE id = ?").get(req.accession_id) as { accession_number: string };
    return existingResult(db, req, `Already issued: ${acc.accession_number} (request ${req.display_id}). No second request was created.`);
  }

  const items = ids.map((id) => loadIntakeItem(db, id));
  const accessioned = items.filter((i) => i.status === "accessioned");
  if (accessioned.length) {
    const accIds = new Set(accessioned.map((i) => i.accession_id));
    if (accessioned.length === items.length && accIds.size === 1) {
      const other = db
        .prepare("SELECT ar.* FROM accession_request ar WHERE ar.accession_id = ? ORDER BY ar.requested_at LIMIT 1")
        .get([...accIds][0]) as RequestRow | undefined;
      const acc = db.prepare("SELECT accession_number FROM accession WHERE id = ?").get([...accIds][0]) as { accession_number: string } | undefined;
      if (other) return existingResult(db, other, `Already accessioned as ${acc?.accession_number ?? "an issued case"}. No second request was created.`);
    }
    const list = accessioned
      .map((i) => `${i.display_id} → ${(db.prepare("SELECT accession_number n FROM accession WHERE id = ?").get(i.accession_id) as { n: string } | undefined)?.n ?? "issued case"}`)
      .join(", ");
    throw new DomainError(
      "INVARIANT",
      `Already accessioned: ${list}. An issued accession is never renumbered or merged; open a correction review on the case for a post-accession discrepancy.`,
    );
  }

  if (relatedCandidateId) {
    const c = db.prepare("SELECT * FROM related_order_candidate WHERE id = ?").get(relatedCandidateId) as CandidateRow | undefined;
    if (!c) throw new DomainError("NOT_FOUND", "Related-order candidate was not found");
    if (c.status !== "single_accession_approved") throw new DomainError("BLOCKED", `${c.display_id} is not approved as one accession (status: ${c.status})`);
  }

  const blockers = accessionBlockers(db, ids, req?.id ?? null);
  if (blockers.length) {
    throw new DomainError(
      "BLOCKED",
      `Cannot request accession yet: ${blockers[0].message}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ""}`,
      { blockers },
    );
  }

  const label = items.map((i) => i.display_id).join(" + ");
  if (!req) {
    const id = newId(db, "ar");
    const disp = displayId(db, "AR", 4);
    db.prepare(
      `INSERT INTO accession_request (id, display_id, status, related_candidate_id, requested_by, requested_at, idempotency_key, accession_id, failure_detail, version)
       VALUES (?, ?, 'submitted', ?, ?, ?, ?, NULL, NULL, 1)`,
    ).run(id, disp, relatedCandidateId ?? null, ctx.actor.id, ctx.now, key);
    const refs = {
      request: { id, displayId: disp, idempotencyKey: key },
      intakeItems: items.map((i) => ({ id: i.id, displayId: i.display_id })),
      relatedCandidateId: relatedCandidateId ?? null,
      sourceOrders: [...new Set(items.flatMap((i) => itemOrders(db, i).orders.map((o) => `${o.tenant_id}:${o.source_order_id}`)))],
      routingDecisionIds: items.map((i) => currentRouting(db, i.id)?.id ?? null),
    };
    for (const it of items) {
      db.prepare("INSERT INTO accession_request_item (request_id, intake_item_id) VALUES (?, ?)").run(id, it.id);
      const next = updateVersioned(db, "intake_item", it.id, undefined, { status: "accession_requested", updated_at: ctx.now, updated_by: ctx.actor.id });
      audit(ctx, {
        action: "accession.requested",
        entityType: "accession_request",
        entityId: id,
        intakeItemId: it.id,
        summary: `${ctx.actor.name} requested an accession from the simulated source for ${label} (request ${disp})`,
        before: { intakeItem: { id: it.id, status: it.status, version: it.version }, request: null },
        after: { intakeItem: { id: it.id, status: "accession_requested", version: next.version }, ...refs, request: { ...refs.request, status: "submitted" } },
      });
    }
    req = db.prepare("SELECT * FROM accession_request WHERE id = ?").get(id) as RequestRow;
  } else {
    audit(ctx, {
      action: "accession.retried",
      entityType: "accession_request",
      entityId: req.id,
      intakeItemId: items[0].id,
      summary: `${ctx.actor.name} retried accession request ${req.display_id} for ${label}`,
    });
  }

  const source = accessionSourceStatus(db);
  if (!source.available) {
    db.prepare("UPDATE accession_request SET failure_detail = ?, version = version + 1 WHERE id = ?").run(
      `Simulated source unreachable at ${ctx.now}; request kept as submitted`,
      req.id,
    );
    for (const it of items) {
      audit(ctx, {
        action: "accession.source_unavailable",
        entityType: "accession_request",
        entityId: req.id,
        intakeItemId: it.id,
        summary: `Request ${req.display_id} could not reach the source system (simulated outage). Nothing was issued; verification is saved locally. Retry when the source is back.`,
      });
    }
    return {
      requestId: req.id, requestDisplayId: req.display_id, status: "submitted", outcome: "source_offline", duplicate: false, accessionId: null,
      accessionNumber: null, namespace: null, issuedBy: null,
      message: `Source system unreachable (simulated outage). Request ${req.display_id} is saved as submitted; nothing was issued. Retry when the source is back.`,
      parts: [],
    };
  }

  const issued = issueNumber(db, ctx.now);
  const accessionId = createAccessionFromRequest(ctx, req, items, issued);
  return {
    requestId: req.id, requestDisplayId: req.display_id, status: "issued", outcome: "issued", duplicate: false, accessionId,
    accessionNumber: issued.accessionNumber, namespace: issued.namespace, issuedBy: issued.issuedBy,
    message: `Accession ${issued.accessionNumber} issued by EMA-SIM (simulated) for ${label}.`,
    parts: partsOf(db, accessionId),
  };
}

function nextFreeLetter(used: Set<string>, preferred: string): string {
  const p = preferred.trim().toUpperCase();
  if (p && !used.has(p)) return p;
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i);
    if (!used.has(l)) return l;
  }
  throw new DomainError("INVARIANT", "Too many parts for one accession");
}

function createAccessionFromRequest(ctx: Ctx, req: RequestRow, items: IntakeItemRow[], issued: IssuedNumber): string {
  const db = ctx.db;
  const sim = simulatorCtx(ctx);
  const ordered = [...items].sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : a.display_id.localeCompare(b.display_id)));
  const groups = ordered.map((it) => itemOrders(db, it));
  const firstOrder = groups.flatMap((g) => g.orders)[0];
  if (!firstOrder) throw new DomainError("BLOCKED", "No linked source order");
  const routing = currentRouting(db, ordered[0].id)!;
  const accessionId = `acc_${issued.accessionNumber.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const receivedDay = labDay(ordered[0].received_at);
  db.prepare(
    `INSERT INTO accession (id, accession_number, namespace, source_case_id, issued_at, issued_by_system, patient_ref_id, office_id, ordering_clinician_id,
       assigned_pathologist_id, routing_decision_id, case_status, priority, current_owner_id, received_day, is_prior_day, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'routine', NULL, ?, 0, 1, ?)`,
  ).run(
    accessionId, issued.accessionNumber, issued.namespace, issued.sourceCaseId, issued.issuedAt, issued.issuedBy, firstOrder.patient_ref_id,
    ordered[0].office_id ?? firstOrder.office_id, firstOrder.ordering_clinician_id, routing.final_pathologist_id, routing.id, receivedDay, ctx.now,
  );

  // Parts keep their source order and the office's original designation. A collision gets the next free letter; the original stays recorded.
  const used = new Set<string>();
  const partLines: string[] = [];
  const partByOrderPart = new Map<string, string>();
  const containerIds: string[] = [];
  for (const g of groups) {
    const containers = containersFor(db, g.item.id);
    containerIds.push(...containers.map((c) => c.id));
    for (const o of g.orders) {
      const parts = db
        .prepare("SELECT * FROM source_order_part WHERE source_order_id = ? AND status = 'active' ORDER BY designation")
        .all(o.id) as { id: string; designation: string; site_text: string; laterality: string | null; procedure: string | null }[];
      for (const p of parts) {
        const designation = nextFreeLetter(used, p.designation);
        used.add(designation);
        const container =
          containers.find((c) => c.order_part_id === p.id && c.verification_state === "verified") ?? containers.find((c) => c.order_part_id === p.id) ?? null;
        const partId = `${accessionId}_p${designation.toLowerCase()}`;
        db.prepare(
          `INSERT INTO specimen_part (id, accession_id, designation, source_order_id, source_order_part_id, original_designation, site_text, laterality, procedure,
             container_id, physical_state, status, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 'active', 1)`,
        ).run(partId, accessionId, designation, o.id, p.id, p.designation, p.site_text, p.laterality, p.procedure, container?.id ?? null);
        partByOrderPart.set(p.id, partId);
        partLines.push(
          `${designation} (${o.source_order_id} part ${p.designation}${designation !== p.designation ? `, original designation ${p.designation} kept` : ""}${container ? "" : ", no container received"})`,
        );
      }
    }
  }

  // Intake items → accessioned.
  for (const it of ordered) {
    updateVersioned(db, "intake_item", it.id, undefined, { status: "accessioned", accession_id: accessionId, updated_at: ctx.now, updated_by: ctx.actor.id });
  }
  db.prepare("UPDATE accession_request SET status = 'issued', accession_id = ?, failure_detail = NULL, version = version + 1 WHERE id = ?").run(accessionId, req.id);

  // Re-point holds, tasks and clarifications to the case. Scopes stay as placed (order part / container), so they keep applying to the part.
  const itemIds = ordered.map((i) => i.id);
  const orderPartIds = [...partByOrderPart.keys()];
  const orderIds = groups.flatMap((g) => g.orders.map((o) => o.id));
  const ph = (n: number) => Array.from({ length: n }, () => "?").join(",") || "''";
  db.prepare(
    `UPDATE hold SET accession_id = ? WHERE accession_id IS NULL AND (
       intake_item_id IN (${ph(itemIds.length)})
       OR (scope_type = 'intake_item' AND scope_id IN (${ph(itemIds.length)}))
       OR (scope_type = 'order_part' AND scope_id IN (${ph(orderPartIds.length)}))
       OR (scope_type = 'container' AND scope_id IN (${ph(containerIds.length)})))`,
  ).run(accessionId, ...itemIds, ...itemIds, ...orderPartIds, ...containerIds);
  for (const id of itemIds) attachTasksToAccession(ctx, id, accessionId);
  db.prepare(
    `UPDATE clarification SET accession_id = ? WHERE accession_id IS NULL AND (
       intake_item_id IN (${ph(itemIds.length)}) OR source_order_id IN (${ph(orderIds.length)})
       OR order_part_id IN (${ph(orderPartIds.length)}) OR container_id IN (${ph(containerIds.length)}))`,
  ).run(accessionId, ...itemIds, ...orderIds, ...orderPartIds, ...containerIds);
  for (const [orderPartId, partId] of partByOrderPart) {
    db.prepare("UPDATE clarification SET specimen_part_id = ? WHERE order_part_id = ? AND specimen_part_id IS NULL").run(partId, orderPartId);
  }
  for (const id of itemIds) closeTasks(ctx, "routing_exception", "intake_item", id);

  recordIssuedEvent(sim, req.display_id, issued, {
    request: req.display_id,
    accession_number: issued.accessionNumber,
    namespace: issued.namespace,
    source_case_id: issued.sourceCaseId,
    source_orders: orderIds.map((id) => (db.prepare("SELECT source_order_id s FROM source_order WHERE id = ?").get(id) as { s: string }).s),
  });

  const pathName = intakeStaffName(db, routing.final_pathologist_id);
  audit(sim, {
    action: "accession.issued",
    entityType: "accession",
    entityId: accessionId,
    accessionId,
    summary: `Accession ${issued.accessionNumber} (${issued.namespace}) issued by EMA-SIM (simulated) for request ${req.display_id}. Parts: ${partLines.join("; ")}. Assigned dermatopathologist: ${pathName}. Source orders kept separate; nothing merged.`,
    after: { accession_number: issued.accessionNumber, namespace: issued.namespace, parts: partLines },
  });
  for (const it of ordered) {
    audit(sim, {
      action: "accession.issued",
      entityType: "intake_item",
      entityId: it.id,
      accessionId,
      intakeItemId: it.id,
      summary: `${it.display_id} accessioned as ${issued.accessionNumber} (issued by EMA-SIM, simulated). The provisional id ${it.display_id} stays on record.`,
    });
  }
  recordWorklistChange(ctx, {
    accessionId,
    pathologistId: routing.final_pathologist_id,
    type: "new",
    summary: `${issued.accessionNumber} accessioned: ${partLines.length} part(s), ${pathName}`,
  });
  return accessionId;
}

/** Latest accession request touching an intake item. */
export function latestRequestFor(db: DB, intakeItemId: string): RequestRow | null {
  return (
    (db
      .prepare(
        `SELECT ar.* FROM accession_request ar JOIN accession_request_item ai ON ai.request_id = ar.id WHERE ai.intake_item_id = ?
          ORDER BY ar.requested_at DESC LIMIT 1`,
      )
      .get(intakeItemId) as RequestRow | undefined) ?? null
  );
}
