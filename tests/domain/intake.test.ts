import { describe, it, expect } from "vitest";
import type { DB } from "@/server/db/db";
import { testDb, run, must, clockAt, one, all, STAFF } from "../helpers";
import { executeCommand } from "@/server/commands";
import { placeHold } from "@/server/domain/holds";
import { loadActor, makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { suggestRouting } from "@/server/domain/routing";
import { separateEncounterOrders } from "@/server/domain/related";
import { computeReadiness } from "@/server/domain/readiness";
import { compareContainer, parseSite } from "@/server/domain/intake";
import { accessionBlockers } from "@/server/domain/accession";
import { readClock } from "@/server/core/clock";
import { labLocalToIso } from "@/lib/time";

const DELIVERY = "cr_1100";

interface ReceiveRes {
  intakeItemId: string;
  displayId: string;
  duplicate: boolean;
  routingStatus: string;
  relatedCandidates: string[];
  missingParts: string[];
}
interface VerifyRes {
  state: "verified" | "discrepancy";
  discrepancies: { field: string; orderValue: string | null; observedValue: string | null }[];
  stillOpen: { field: string; reason: string }[];
  accepted: { field: string }[];
}
interface AccRes {
  outcome: string;
  status: string;
  duplicate: boolean;
  accessionId: string | null;
  accessionNumber: string | null;
  requestId: string;
}

function arrive(db: DB) {
  clockAt(db, "11:00");
  return must<{ duplicate: boolean; arrivedAt: string }>(db, STAFF.maya, "intake.receiveDelivery", { deliveryId: DELIVERY });
}
function receive(db: DB, physicalItemId: string, actor: string = STAFF.maya) {
  return must<ReceiveRes>(db, actor, "intake.receivePhysicalItem", { deliveryId: DELIVERY, physicalItemId });
}
function containersOf(db: DB, intakeItemId: string) {
  return all<{ id: string; seq: number; version: number; order_part_id: string | null; verification_state: string }>(
    db,
    "SELECT id, seq, version, order_part_id, verification_state FROM container WHERE intake_item_id = ? ORDER BY seq",
    intakeItemId,
  );
}
function verifyAll(db: DB, intakeItemId: string, actor: string = STAFF.maya): VerifyRes[] {
  return containersOf(db, intakeItemId).map((c) =>
    must<VerifyRes>(db, actor, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id }),
  );
}
/** Fixture standing in for S2's clarification.create: an open clarification that covers a part/container. */
function clarificationFixture(db: DB, refs: { intakeItemId: string; orderPartId?: string | null; containerId?: string | null; category: string }) {
  const n = one<{ n: number }>(db, "SELECT COUNT(*) n FROM clarification").n;
  const idv = `clr_fixture_${n}`;
  db.prepare(
    `INSERT INTO clarification (id, display_id, category, intake_item_id, source_order_id, order_part_id, container_id, subject_label, question, evidence,
       office_id, contact_role, lab_owner_id, priority, state, created_at, created_by, dedupe_key)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'fixture', 'fixture question', '[]', 'off_hpd', 'Biopsy coordinator', 'stf_maya', 'high', 'sent', ?, 'stf_maya', ?)`,
  ).run(idv, `CLR-9${String(n).padStart(3, "0")}`, refs.category, refs.intakeItemId, refs.orderPartId ?? null, refs.containerId ?? null, labLocalToIso("2026-10-14", "11:05"), `${refs.category}:${idv}`);
  return idv;
}
/** The current routing decision id of an intake item: what the routing dialog sends as expectedDecisionId. */
function decisionIdOf(db: DB, intakeItemId: string): string {
  return one<{ id: string }>(db, "SELECT id FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1", intakeItemId).id;
}
function heroReady(db: DB) {
  arrive(db);
  const a = receive(db, "phys_quinlanA");
  const b = receive(db, "phys_quinlanB");
  return { a, b };
}
function count(db: DB, table: string, where = "1=1", ...params: unknown[]) {
  return one<{ n: number }>(db, `SELECT COUNT(*) n FROM ${table} WHERE ${where}`, ...params).n;
}

describe("S1 intake: routing (acceptance check 1)", () => {
  it("routes a new, unreviewed office to a routing exception with no pathologist; only a lead with a reason can assign one", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_pratt"); // Seagrape Skin Studio (new_unreviewed, no rule in v3)
    expect(r.routingStatus).toBe("exception");
    const rd = one<{ status: string; suggested_pathologist_id: string | null; final_pathologist_id: string | null; explanation: string }>(
      db, "SELECT * FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded'", r.intakeItemId,
    );
    expect(rd.suggested_pathologist_id).toBeNull();
    expect(rd.final_pathologist_id).toBeNull();
    expect(rd.explanation).toMatch(/Routing exception/);
    expect(count(db, "task", "kind = 'routing_exception' AND entity_id = ? AND status = 'open' AND owner_id = ?", r.intakeItemId, STAFF.kim)).toBe(1);

    // Nothing to accept; accession is blocked; no pathologist appears anywhere.
    const confirm = run(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.error.code).toBe("BLOCKED");
    verifyAll(db, r.intakeItemId);
    const accessionsBefore = count(db, "accession");
    const blocked = run(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe("BLOCKED");
      expect((blocked.error.details as { blockers: { code: string }[] }).blockers.map((b) => b.code)).toContain("routing_exception");
    }
    expect(count(db, "accession")).toBe(accessionsBefore);

    // Accessioner cannot resolve; lead needs a reason.
    const denied = run(db, STAFF.maya, "routing.resolveException", { intakeItemId: r.intakeItemId, pathologistId: STAFF.ferreira, reason: "x" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    const noReason = run(db, STAFF.kim, "routing.resolveException", { intakeItemId: r.intakeItemId, pathologistId: STAFF.ferreira, reason: "  " });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe("VALIDATION");
    must(db, STAFF.kim, "routing.resolveException", { intakeItemId: r.intakeItemId, pathologistId: STAFF.ferreira, reason: "New office; Dr. Ferreira covers walk-in referrals until a rule is approved" });
    const rows = all<{ status: string; suggested_pathologist_id: string | null; final_pathologist_id: string | null; override_reason: string | null }>(
      db, "SELECT * FROM routing_decision WHERE intake_item_id = ? ORDER BY created_at, id", r.intakeItemId,
    );
    expect(rows.map((x) => x.status)).toEqual(["superseded", "overridden"]);
    expect(rows[1].suggested_pathologist_id).toBeNull(); // the exception had no suggestion; none is invented afterwards
    expect(rows[1].final_pathologist_id).toBe(STAFF.ferreira);
    expect(count(db, "task", "kind = 'routing_exception' AND entity_id = ? AND status = 'open'", r.intakeItemId)).toBe(0);

    const acc = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(one<{ assigned_pathologist_id: string }>(db, "SELECT assigned_pathologist_id FROM accession WHERE id = ?", acc.accessionId).assigned_pathologist_id).toBe(STAFF.ferreira);
  });

  it("an office that is not in the directory is an exception and its order id is not looked up without a tenant", () => {
    const db = testDb();
    arrive(db);
    db.prepare(
      `INSERT INTO sim_physical_item (id, delivery_id, seq, observed_office_text, requisition_order_ref, requisition_fields, containers, received_intake_item_id)
       VALUES ('phys_unknown', ?, 90, 'Pelican Dune Dermatology', 'ORD-77118', '{"order_id":"ORD-77118"}', '[{"patient_name":"Barnes, Theo","part_designation":"A","site_text":"R nasal sidewall"}]', NULL)`,
    ).run(DELIVERY);
    const r = receive(db, "phys_unknown");
    expect(r.routingStatus).toBe("exception");
    expect(count(db, "intake_order_link", "intake_item_id = ?", r.intakeItemId)).toBe(0); // ORD-77118 exists in EMA-SIM, but the office (and tenant) is unknown
    expect(count(db, "intake_discrepancy", "intake_item_id = ? AND kind = 'order_not_linked' AND status = 'open'", r.intakeItemId)).toBe(1);
    expect(one<{ office_id: string | null }>(db, "SELECT office_id FROM intake_item WHERE id = ?", r.intakeItemId).office_id).toBeNull();
  });

  it("names the rule set version effective at receipt time and applies coverage exceptions", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes"); // Harbor Point → Dr. Marsh (rule set v3)
    const rd = one<{ suggested_pathologist_id: string; rule_set_id: string; explanation: string }>(
      db, "SELECT * FROM routing_decision WHERE intake_item_id = ?", r.intakeItemId,
    );
    expect(rd.suggested_pathologist_id).toBe(STAFF.marsh);
    expect(rd.rule_set_id).toBe("rrs_v3");
    expect(rd.explanation).toMatch(/Harbor Point Dermatology → Dr\. Elena Marsh \(rule set v3, effective/);

    // Receipt in August: the (since retired) v2 rule applied then — Cypress Key went to Dr. Okafor.
    const aug = suggestRouting(db, "off_ckd", labLocalToIso("2026-08-15", "11:00"));
    expect(aug).toMatchObject({ status: "suggested", pathologistId: STAFF.okafor, ruleSetVersion: 2 });
    // Oct 16: Dr. Okafor on approved leave → covered by Dr. Marsh, and the explanation says so.
    const leave = suggestRouting(db, "off_cld", labLocalToIso("2026-10-16", "11:00"));
    expect(leave.pathologistId).toBe(STAFF.marsh);
    expect(leave.coverageExceptionId).toBe("cov_okafor_1016");
    expect(leave.explanation).toMatch(/Coverage exception/);
  });

  it("override needs a lead and a reason and keeps the rule's suggestion on record", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_castillo");
    const maya = run(db, STAFF.maya, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.okafor, reason: "workload", expectedDecisionId: decisionIdOf(db, r.intakeItemId) });
    expect(maya.ok).toBe(false);
    if (!maya.ok) expect(maya.error.code).toBe("FORBIDDEN");
    must(db, STAFF.kim, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.okafor, reason: "Dr. Marsh at capacity today (synthetic)", expectedDecisionId: decisionIdOf(db, r.intakeItemId) });
    const cur = one<{ status: string; suggested_pathologist_id: string; final_pathologist_id: string; override_reason: string }>(
      db, "SELECT * FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded'", r.intakeItemId,
    );
    expect(cur).toMatchObject({ status: "overridden", suggested_pathologist_id: STAFF.marsh, final_pathologist_id: STAFF.okafor });
    expect(cur.override_reason).toMatch(/capacity/);
  });
});

describe("S1 intake: related orders and verification (acceptance checks 2, 3)", () => {
  it("A and B submitted as separate orders become one candidate that requires a lead's review; both source ids survive accession", () => {
    const db = testDb();
    const patientsBefore = count(db, "patient_ref");
    const { a, b } = heroReady(db);
    const cands = all<{ id: string; display_id: string; status: string; reasons: string; conflicts: string; version: number }>(db, "SELECT * FROM related_order_candidate");
    expect(cands).toHaveLength(1);
    expect(cands[0].status).toBe("pending_review");
    const reasons = (JSON.parse(cands[0].reasons) as { code: string }[]).map((x) => x.code);
    expect(reasons).toEqual(expect.arrayContaining(["same_patient_reference", "same_encounter", "same_office", "same_collection_day"]));
    expect((JSON.parse(cands[0].conflicts) as { code: string }[]).map((x) => x.code)).toContain("separate_orders");
    expect(count(db, "task", "kind = 'related_order_review' AND status = 'open' AND owner_id = ?", STAFF.kim)).toBe(1);

    // Receiving again or re-running detection adds nothing.
    expect(receive(db, "phys_quinlanB").duplicate).toBe(true);
    expect(count(db, "related_order_candidate")).toBe(1);

    verifyAll(db, a.intakeItemId);
    const vb = verifyAll(db, b.intakeItemId);
    expect(vb[0].state).toBe("discrepancy");
    const cB = containersOf(db, b.intakeItemId)[0];
    clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: a.intakeItemId });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: b.intakeItemId });

    const pending = run(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId, b.intakeItemId] });
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect((pending.error.details as { blockers: { code: string }[] }).blockers.map((x) => x.code)).toContain("related_pending");

    const denied = run(db, STAFF.maya, "related.review", { candidateId: cands[0].id, expectedVersion: cands[0].version, decision: "single_accession_approved", reason: "same encounter" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    must(db, STAFF.kim, "related.review", { candidateId: cands[0].id, expectedVersion: cands[0].version, decision: "single_accession_approved", reason: "Same encounter ENC-55031; office split A and B" });

    // Approved as one accession: requesting A alone is refused.
    const alone = run(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId] });
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect((alone.error.details as { blockers: { code: string }[] }).blockers.map((x) => x.code)).toContain("related_request_together");

    const acc = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId, b.intakeItemId], relatedCandidateId: cands[0].id });
    expect(acc.outcome).toBe("issued");
    expect(acc.accessionNumber).toBe("D26-04817");
    const parts = all<{ designation: string; original_designation: string; src: string; container_id: string | null }>(
      db,
      "SELECT sp.designation, sp.original_designation, so.source_order_id src, sp.container_id FROM specimen_part sp JOIN source_order so ON so.id = sp.source_order_id WHERE sp.accession_id = ? ORDER BY sp.designation",
      acc.accessionId,
    );
    expect(parts).toEqual([
      { designation: "A", original_designation: "A", src: "ORD-77120", container_id: containersOf(db, a.intakeItemId)[0].id },
      { designation: "B", original_designation: "B", src: "ORD-77121", container_id: cB.id },
    ]);
    // Nothing merged: both orders, both intake items and the single patient reference remain as they were.
    expect(count(db, "patient_ref")).toBe(patientsBefore);
    expect(count(db, "source_order", "source_order_id IN ('ORD-77120','ORD-77121')")).toBe(2);
    expect(all<{ status: string; accession_id: string }>(db, "SELECT status, accession_id FROM intake_item WHERE id IN (?, ?)", a.intakeItemId, b.intakeItemId)).toEqual([
      { status: "accessioned", accession_id: acc.accessionId },
      { status: "accessioned", accession_id: acc.accessionId },
    ]);
    expect(one<{ status: string }>(db, "SELECT status FROM related_order_candidate WHERE id = ?", cands[0].id).status).toBe("single_accession_approved");
  });

  it("records the part B laterality mismatch with both original values; abbreviations are normalized only for comparison", () => {
    const db = testDb();
    const { a, b } = heroReady(db);
    const [va] = verifyAll(db, a.intakeItemId);
    expect(va.state).toBe("verified"); // "L upper back" vs "Left upper back"
    const [vb] = verifyAll(db, b.intakeItemId);
    expect(vb.state).toBe("discrepancy");
    expect(vb.discrepancies.map((d) => d.field)).toEqual(["laterality"]);
    expect(vb.discrepancies[0]).toMatchObject({ orderValue: "Right", observedValue: "L" });
    const c = one<{ verification_state: string; verified_by: string; observed_label: string }>(db, "SELECT * FROM container WHERE intake_item_id = ?", b.intakeItemId);
    expect(c.verified_by).toBe(STAFF.maya);
    expect(JSON.parse(c.observed_label).site_text).toBe("L dorsal forearm"); // original kept
    const d = one<{ values_json: string; status: string }>(db, "SELECT * FROM intake_discrepancy WHERE intake_item_id = ? AND kind = 'field_mismatch'", b.intakeItemId);
    const v = JSON.parse(d.values_json);
    expect(v.order.original).toBe("Right");
    expect(v.observed.original).toBe("L");
    expect(v.requisition.original).toBe("Right");
    expect(() => db.prepare("UPDATE intake_discrepancy SET values_json = '{}' WHERE intake_item_id = ?").run(b.intakeItemId)).toThrow(/kept as found/);

    // Pure comparison: site words agree once the side is separated; the side itself differs.
    expect(parseSite("L dorsal forearm")).toEqual({ laterality: "left", lateralityText: "L", core: "dorsal forearm" });
    expect(parseSite("Right dorsal forearm")).toEqual({ laterality: "right", lateralityText: "Right", core: "dorsal forearm" });
    expect(parseSite("Upper lip, L")).toEqual({ laterality: "left", lateralityText: "L", core: "upper lip" });
    expect(parseSite("Lt. post. neck")).toEqual({ laterality: "left", lateralityText: "Lt.", core: "posterior neck" });
    expect(parseSite("Upper left arm")).toEqual({ laterality: "left", lateralityText: "left", core: "upper arm" });
  });

  it("keeps the side exactly as written when it is not the first word of the site (evidence never shows another word as the side)", () => {
    const order = {
      sourceOrderId: "ORD-1", tenantName: "T", sourceVersion: 1, patientName: "Doe, Jo", birthDate: "1970-01-01", mrn: "1",
      part: { designation: "A", siteText: "Upper lip", laterality: "right", procedure: "shave", collectedAt: null },
    };
    const lip = compareContainer(order, { site_text: "Upper lip, L", part_designation: "A" }, null).find((r) => r.field === "laterality")!;
    expect(lip).toMatchObject({ status: "differs", observed: { original: "L", normalized: "left" } });
    const arm = compareContainer({ ...order, part: { ...order.part, siteText: "Upper arm" } }, { site_text: "Upper left arm" }, null).find((r) => r.field === "laterality")!;
    expect(arm.observed.original).toBe("left");
  });

  it("a scan, rule or system process can never set 'staff verified against physical container'", () => {
    const db = testDb();
    const { a } = heroReady(db);
    const c = containersOf(db, a.intakeItemId)[0];
    const sys = executeCommand(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id }, { origin: "system" });
    expect(sys.ok).toBe(false);
    if (!sys.ok) expect(sys.error.code).toBe("INVARIANT");
    expect(containersOf(db, a.intakeItemId)[0].verification_state).toBe("unverified");
    expect(count(db, "container_verification")).toBe(0);
  });

  it("an identical MRN in two tenants gives two patient references and never a related candidate", () => {
    const db = testDb();
    arrive(db);
    const marten = receive(db, "phys_marten"); // EMA-SIM, MRN 100234
    const ruiz = receive(db, "phys_ruiz"); // OTHER-EHR-SIM, MRN 100234
    const pts = all<{ tenant_id: string }>(db, "SELECT tenant_id FROM patient_ref WHERE source_mrn = '100234' ORDER BY tenant_id");
    expect(pts.map((p) => p.tenant_id)).toEqual(["ten_ema", "ten_oth"]);
    expect(marten.relatedCandidates).toEqual([]);
    expect(ruiz.relatedCandidates).toEqual([]);
    expect(count(db, "related_order_candidate")).toBe(0);
    // Each order was found inside its own office's tenant.
    expect(one<{ t: string }>(db, "SELECT so.tenant_id t FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id WHERE l.intake_item_id = ?", ruiz.intakeItemId).t).toBe("ten_oth");
  });

  it("the same patient with a different encounter is not proposed; it is listed as a separate-encounter order", () => {
    const db = testDb();
    arrive(db);
    // A second Avery Quinlan order from a DIFFERENT encounter, same office and same collection day.
    db.prepare(
      `INSERT INTO encounter (id, tenant_id, source_encounter_id, patient_ref_id, office_id, clinician_id, encounter_at, source_updated_at, imported_at)
       VALUES ('enc_test_2', 'ten_ema', 'ENC-55102', 'pt_ema_448210', 'off_hpd', 'cln_reed', ?, ?, ?)`,
    ).run(labLocalToIso("2026-10-14", "09:40"), labLocalToIso("2026-10-14", "09:40"), labLocalToIso("2026-10-14", "09:41"));
    db.prepare(
      `INSERT INTO source_order (id, tenant_id, source_order_id, patient_ref_id, encounter_id, office_id, ordering_clinician_id, source_status, source_version, source_updated_at, imported_at)
       VALUES ('ord_test_2', 'ten_ema', 'ORD-77190', 'pt_ema_448210', 'enc_test_2', 'off_hpd', 'cln_reed', 'active', 1, ?, ?)`,
    ).run(labLocalToIso("2026-10-14", "09:50"), labLocalToIso("2026-10-14", "09:51"));
    db.prepare(
      `INSERT INTO source_order_part (id, source_order_id, designation, site_text, laterality, procedure, collected_at, expected_containers)
       VALUES ('ord_test_2_a', 'ord_test_2', 'A', 'Left shoulder', 'left', 'shave', ?, 1)`,
    ).run(labLocalToIso("2026-10-14", "09:45"));
    db.prepare(
      `INSERT INTO sim_physical_item (id, delivery_id, seq, observed_office_text, requisition_order_ref, requisition_fields, containers, received_intake_item_id)
       VALUES ('phys_test_2', ?, 91, 'Harbor Point Dermatology', 'ORD-77190', '{}', '[{"patient_name":"Quinlan, Avery","birth_date":"1961-03-22","part_designation":"A","site_text":"L shoulder","procedure":"shave"}]', NULL)`,
    ).run(DELIVERY);
    const a = receive(db, "phys_quinlanA");
    const other = receive(db, "phys_test_2");
    expect(other.relatedCandidates).toEqual([]);
    expect(count(db, "related_order_candidate", "order_a_id IN ('ord_ord_77120','ord_test_2') AND order_b_id IN ('ord_ord_77120','ord_test_2')")).toBe(0);
    const sep = separateEncounterOrders(db, "ord_ord_77120");
    expect(sep.map((s) => [s.sourceOrderId, s.encounter])).toContainEqual(["ORD-77190", "ENC-55102"]);
    // The real A/B pair (same encounter) is still proposed once B arrives.
    receive(db, "phys_quinlanB");
    expect(count(db, "related_order_candidate")).toBe(1);
    void a;
  });

  it("flags a missing container per order part and blocks accession until a missing-container clarification covers it", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_ellis"); // order ORD-77140 has parts A and B; only A's bottle arrived
    expect(r.missingParts).toEqual(["B"]);
    const miss = one<{ order_part_id: string; values_json: string }>(db, "SELECT * FROM intake_discrepancy WHERE intake_item_id = ? AND kind = 'missing_container'", r.intakeItemId);
    expect(JSON.parse(miss.values_json).received).toBe(0);
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    const blocked = run(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect((blocked.error.details as { blockers: { code: string }[] }).blockers.map((x) => x.code)).toEqual(["missing_container"]);
    clarificationFixture(db, { intakeItemId: r.intakeItemId, orderPartId: miss.order_part_id, category: "missing_container" });
    const acc = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    const parts = all<{ designation: string; container_id: string | null }>(db, "SELECT designation, container_id FROM specimen_part WHERE accession_id = ? ORDER BY designation", acc.accessionId);
    expect(parts.map((p) => [p.designation, p.container_id === null])).toEqual([["A", false], ["B", true]]);
  });
});

describe("S1 accession: idempotency, holds, source outage", () => {
  it("repeated receive, receive-all and double accession requests create no duplicate intake items, cases, tasks or numbers", () => {
    const db = testDb();
    const first = arrive(db);
    const again = must<{ duplicate: boolean; arrivedAt: string }>(db, STAFF.luis, "intake.receiveDelivery", { deliveryId: DELIVERY });
    expect(again.duplicate).toBe(true);
    expect(again.arrivedAt).toBe(first.arrivedAt);

    const itemsBefore = count(db, "intake_item");
    const r1 = receive(db, "phys_barnes");
    const r2 = receive(db, "phys_barnes", STAFF.luis);
    expect(r2).toMatchObject({ duplicate: true, intakeItemId: r1.intakeItemId });
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    const afterAll = { items: count(db, "intake_item"), containers: count(db, "container"), tasks: count(db, "task"), rel: count(db, "related_order_candidate") };
    expect(afterAll.items).toBe(itemsBefore + 11);
    const second = must<{ received: unknown[]; alreadyReceived: number }>(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    expect(second.received).toHaveLength(0);
    expect(second.alreadyReceived).toBe(11);
    expect({ items: count(db, "intake_item"), containers: count(db, "container"), tasks: count(db, "task"), rel: count(db, "related_order_candidate") }).toEqual(afterAll);

    verifyAll(db, r1.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r1.intakeItemId });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r1.intakeItemId }); // second confirm is a no-op
    const accBefore = count(db, "accession");
    const seqBefore = one<{ next_value: number }>(db, "SELECT next_value FROM id_sequence WHERE name = 'accession_number'").next_value;
    const x = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r1.intakeItemId] });
    const tasksAfter = count(db, "task");
    const y = must<AccRes>(db, STAFF.luis, "accession.request", { intakeItemIds: [r1.intakeItemId] });
    expect(y).toMatchObject({ duplicate: true, accessionId: x.accessionId, accessionNumber: x.accessionNumber, requestId: x.requestId });
    // Same idempotency key (double click) replays the stored result.
    const k1 = run<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r1.intakeItemId] }, "dbl-click-1");
    const k2 = run<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r1.intakeItemId] }, "dbl-click-1");
    expect(k2.ok && k2.replayed).toBe(true);
    expect(k1.ok && k2.ok && k1.result.accessionId === k2.result.accessionId).toBe(true);
    expect(count(db, "accession")).toBe(accBefore + 1);
    expect(count(db, "accession_request", "accession_id = ?", x.accessionId)).toBe(1);
    expect(one<{ next_value: number }>(db, "SELECT next_value FROM id_sequence WHERE name = 'accession_number'").next_value).toBe(seqBefore + 1);
    expect(count(db, "task")).toBe(tasksAfter);
    expect(count(db, "worklist_change", "accession_id = ? AND change_type = 'new'", x.accessionId)).toBe(1);
  });

  it("keeps a request submitted while the simulated source is offline and issues exactly one number on retry", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_fischer");
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    db.prepare("UPDATE integration_source SET status = 'offline' WHERE id = 'src_ema'").run();
    const accBefore = count(db, "accession");
    const off = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(off).toMatchObject({ outcome: "source_offline", status: "submitted", accessionId: null });
    expect(count(db, "accession")).toBe(accBefore);
    expect(one<{ status: string }>(db, "SELECT status FROM intake_item WHERE id = ?", r.intakeItemId).status).toBe("accession_requested");
    const offAgain = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(offAgain.requestId).toBe(off.requestId);
    db.prepare("UPDATE integration_source SET status = 'connected' WHERE id = 'src_ema'").run();
    const on = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(on).toMatchObject({ outcome: "issued", requestId: off.requestId, accessionNumber: "D26-04817" });
    expect(count(db, "accession")).toBe(accBefore + 1);
    expect(count(db, "accession_request", "id = ?", off.requestId)).toBe(1);
  });

  it("a scoped hold on part B does not block accession, follows the part onto the case, and gates only part B", () => {
    const db = testDb();
    const { a, b } = heroReady(db);
    verifyAll(db, a.intakeItemId);
    verifyAll(db, b.intakeItemId);
    const cB = containersOf(db, b.intakeItemId)[0];
    const clr = clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    const ctx = makeCtx(db, loadActor(db, STAFF.maya));
    const hold = placeHold(ctx, {
      scope: { type: "order_part", id: cB.order_part_id! }, scopeLabel: "Part B (ORD-77121 · B)", blocks: ["gross_approval", "processing", "print", "tray_delivery"],
      reasonCode: "laterality", reasonText: "Laterality differs: order Right, bottle Left", clarificationId: clr, intakeItemId: b.intakeItemId,
    });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: a.intakeItemId });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: b.intakeItemId });
    const cand = one<{ id: string; version: number }>(db, "SELECT id, version FROM related_order_candidate");
    must(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "single_accession_approved", reason: "Same encounter" });
    const acc = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [b.intakeItemId, a.intakeItemId] });
    expect(acc.outcome).toBe("issued");
    expect(one<{ accession_id: string; status: string }>(db, "SELECT accession_id, status FROM hold WHERE id = ?", hold.id)).toEqual({ accession_id: acc.accessionId, status: "active" });
    const c = one<{ accession_id: string; specimen_part_id: string }>(db, "SELECT accession_id, specimen_part_id FROM clarification WHERE id = ?", clr);
    expect(c.accession_id).toBe(acc.accessionId);
    expect(c.specimen_part_id).toBe(`${acc.accessionId}_pb`);
    const readiness = computeReadiness(db, [acc.accessionId!]).get(acc.accessionId!)!;
    const byPart = Object.fromEntries(readiness.parts.map((p) => [p.designation, p.holds.map((h) => h.displayId)]));
    expect(byPart.A).toEqual([]);
    expect(byPart.B).toEqual([hold.display_id]);
  });

  it("a hold that gates accession on an item (seeded identity conflict) blocks the request with the hold named", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const identity = one<{ value: string }>(db, "SELECT value FROM app_setting WHERE key = 'seed_identity_intake'").value;
    const res = run(db, STAFF.kim, "accession.request", { intakeItemIds: [identity] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const blockers = (res.error.details as { blockers: { code: string; message: string }[] }).blockers;
      expect(blockers.some((b2) => b2.code === "hold" && /H-0088/.test(b2.message))).toBe(true);
    }
  });
});

describe("S1 post-accession correction (acceptance check 5)", () => {
  function accessionHero(db: DB) {
    const { a, b } = heroReady(db);
    verifyAll(db, a.intakeItemId);
    verifyAll(db, b.intakeItemId);
    const cB = containersOf(db, b.intakeItemId)[0];
    clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: a.intakeItemId });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: b.intakeItemId });
    const cand = one<{ id: string; version: number }>(db, "SELECT id, version FROM related_order_candidate");
    must(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "single_accession_approved", reason: "Same encounter" });
    const acc = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId, b.intakeItemId] });
    return { a, b, acc, cand };
  }

  it("a discrepancy found after accessioning opens a correction review with original references; nothing is renumbered, merged or relabeled", () => {
    const db = testDb();
    const { a, b, acc, cand } = accessionHero(db);
    const before = one<Record<string, unknown>>(db, "SELECT accession_number, namespace, source_case_id, patient_ref_id FROM accession WHERE id = ?", acc.accessionId);
    const partsBefore = all(db, "SELECT id, designation, original_designation, source_order_id, site_text FROM specimen_part WHERE accession_id = ? ORDER BY designation", acc.accessionId);
    const accCount = count(db, "accession");

    const xr = must<{ correctionId: string; displayId: string; duplicate: boolean }>(db, STAFF.maya, "correction.open", {
      accessionId: acc.accessionId, kind: "site_discrepancy", description: "Part B: office says the order site will be amended to left after accessioning",
    });
    expect(xr.displayId).toMatch(/^XR-\d{4}$/);
    const refs = JSON.parse(one<{ original_refs: string }>(db, "SELECT original_refs FROM correction_review WHERE id = ?", xr.correctionId).original_refs);
    expect(refs.primary.accession.accession_number).toBe("D26-04817");
    expect(refs.primary.parts.map((p: { source_order_id: string; designation: string }) => `${p.designation}:${p.source_order_id}`)).toEqual(["A:ORD-77120", "B:ORD-77121"]);
    expect(count(db, "task", "kind = 'correction_review' AND entity_id = ? AND status = 'open' AND owner_id = ?", xr.correctionId, STAFF.kim)).toBe(1);

    // Database refuses renumbering and silent part changes.
    expect(() => db.prepare("UPDATE accession SET accession_number = 'D26-04818' WHERE id = ?").run(acc.accessionId)).toThrow(/renumber/);
    expect(() => db.prepare("UPDATE specimen_part SET designation = 'C' WHERE accession_id = ? AND designation = 'B'").run(acc.accessionId)).toThrow(/silently changed/);
    expect(() => db.prepare("UPDATE specimen_part SET site_text = 'Left dorsal forearm' WHERE accession_id = ? AND designation = 'B'").run(acc.accessionId)).toThrow(/silently changed/);

    // No merge path: the reviewed candidate is frozen, and re-requesting returns the same case.
    const reReview = run(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: 2, decision: "keep_separate", reason: "changed mind" });
    expect(reReview.ok).toBe(false);
    if (!reReview.ok) expect(reReview.error.code).toBe("INVARIANT");
    const again = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId, b.intakeItemId] });
    expect(again).toMatchObject({ duplicate: true, accessionNumber: "D26-04817" });
    const dupXr = must<{ correctionId: string; duplicate: boolean }>(db, STAFF.luis, "correction.open", { accessionId: acc.accessionId, kind: "site_discrepancy", description: "same issue" });
    expect(dupXr).toMatchObject({ duplicate: true, correctionId: xr.correctionId });

    // Only a lead/supervisor records the outcome; referring creates a task for the authorized source process.
    const denied = run(db, STAFF.maya, "correction.close", { correctionId: xr.correctionId, outcome: "closed_no_change", note: "x", expectedVersion: one<{ version: number }>(db, "SELECT version FROM correction_review WHERE id = ?", xr.correctionId).version });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    must(db, STAFF.kim, "correction.close", { correctionId: xr.correctionId, outcome: "referred_to_source_process", note: "Asked office to amend ORD-77121 in EMA", expectedVersion: one<{ version: number }>(db, "SELECT version FROM correction_review WHERE id = ?", xr.correctionId).version });
    expect(one<{ status: string }>(db, "SELECT status FROM correction_review WHERE id = ?", xr.correctionId).status).toBe("referred_to_source_process");
    expect(one<{ title: string }>(db, "SELECT title FROM task WHERE kind = 'correction_review' AND entity_id = ? AND status = 'open'", xr.correctionId).title).toMatch(/authorized source-system process/);

    expect(one(db, "SELECT accession_number, namespace, source_case_id, patient_ref_id FROM accession WHERE id = ?", acc.accessionId)).toEqual(before);
    expect(all(db, "SELECT id, designation, original_designation, source_order_id, site_text FROM specimen_part WHERE accession_id = ? ORDER BY designation", acc.accessionId)).toEqual(partsBefore);
    expect(count(db, "accession")).toBe(accCount);
  });

  it("intake edits after accessioning are refused (use a correction review instead)", () => {
    const db = testDb();
    const { b } = accessionHero(db);
    const c = containersOf(db, b.intakeItemId)[0];
    const res = run(db, STAFF.maya, "intake.recordObservation", { containerId: c.id, expectedVersion: c.version, observed: { site_text: "R dorsal forearm" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVARIANT");
  });
});

describe("S1 concurrency and role checks (acceptance check 12)", () => {
  it("two accessioners on one item: the stale save is rejected as a conflict and the colleague's edit is kept", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_quinlanB");
    const seen = one<{ version: number }>(db, "SELECT version FROM intake_item WHERE id = ?", r.intakeItemId).version;
    must(db, STAFF.luis, "intake.updateItem", { intakeItemId: r.intakeItemId, expectedVersion: seen, patch: { notes: "Luis: requisition re-checked" } });
    const stale = run(db, STAFF.maya, "intake.updateItem", { intakeItemId: r.intakeItemId, expectedVersion: seen, patch: { notes: "Maya: my note" } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("CONFLICT");
      expect((stale.error.details as { currentVersion: number }).currentVersion).toBe(seen + 1);
    }
    expect(one<{ notes: string }>(db, "SELECT notes FROM intake_item WHERE id = ?", r.intakeItemId).notes).toBe("Luis: requisition re-checked");

    // Demo control: a simulated colleague edit, attributed to Luis with origin 'demo'.
    const v = one<{ version: number }>(db, "SELECT version FROM intake_item WHERE id = ?", r.intakeItemId).version;
    must(db, STAFF.maya, "intake.simulateColleagueEdit", { intakeItemId: r.intakeItemId });
    expect(one<{ version: number }>(db, "SELECT version FROM intake_item WHERE id = ?", r.intakeItemId).version).toBe(v + 1);
    const ev = one<{ actor_id: string; origin: string }>(db, "SELECT actor_id, origin FROM audit_event WHERE action = 'intake.updated' AND intake_item_id = ? ORDER BY seq DESC LIMIT 1", r.intakeItemId);
    expect(ev).toEqual({ actor_id: STAFF.luis, origin: "demo" });
    const stale2 = run(db, STAFF.maya, "intake.updateItem", { intakeItemId: r.intakeItemId, expectedVersion: v, patch: { notes: "late" } });
    expect(!stale2.ok && stale2.error.code).toBe("CONFLICT");

    // Stale container observation and stale related-order decision are rejected too.
    const c = containersOf(db, r.intakeItemId)[0];
    must(db, STAFF.luis, "intake.recordObservation", { containerId: c.id, expectedVersion: c.version, observed: { condition_note: "Lid taped" } });
    const staleObs = run(db, STAFF.maya, "intake.recordObservation", { containerId: c.id, expectedVersion: c.version, observed: { site_text: "R dorsal forearm" } });
    expect(!staleObs.ok && staleObs.error.code).toBe("CONFLICT");
    const staleVerify = run(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id });
    expect(!staleVerify.ok && staleVerify.error.code).toBe("CONFLICT");
  });

  it("server-side role checks refuse unauthorized actions whatever the demo role selector shows", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const dir = run(db, STAFF.director, "intake.receiveDelivery", { deliveryId: DELIVERY });
    expect(!dir.ok && dir.error.code).toBe("FORBIDDEN");
    expect(one<{ arrived_at: string | null }>(db, "SELECT arrived_at FROM courier_delivery WHERE id = ?", DELIVERY).arrived_at).toBeNull();
    expect(count(db, "audit_event", "action = 'command.denied' AND actor_id = ?", STAFF.director)).toBe(1);
    arrive(db);
    const r = receive(db, "phys_barnes");
    const c = containersOf(db, r.intakeItemId)[0];
    const grosser = run(db, STAFF.dana, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id });
    expect(!grosser.ok && grosser.error.code).toBe("FORBIDDEN");
    const histotech = run(db, STAFF.priya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(!histotech.ok && histotech.error.code).toBe("FORBIDDEN");
    const md = run(db, STAFF.md, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.okafor, reason: "x", expectedDecisionId: decisionIdOf(db, r.intakeItemId) });
    expect(!md.ok && md.error.code).toBe("FORBIDDEN");
  });
});

describe("S1 comparison (pure)", () => {
  it("flags a sided order when the bottle states no side, but not a midline order", () => {
    const order = (lat: string, site: string) => ({
      sourceOrderId: "ORD-1", tenantName: "T", sourceVersion: 1, patientName: "Doe, Jo", birthDate: "1970-01-01", mrn: "1",
      part: { designation: "A", siteText: site, laterality: lat, procedure: "shave", collectedAt: null },
    });
    const sided = compareContainer(order("right", "Right shin"), { patient_name: "Doe, Jo", site_text: "shin", part_designation: "A" }, null);
    expect(sided.find((r) => r.field === "laterality")!.status).toBe("differs");
    const mid = compareContainer(order("midline", "Scalp, vertex"), { patient_name: "Jo Doe", site_text: "Scalp vertex", procedure: "Shave" }, null);
    expect(mid.find((r) => r.field === "laterality")!.status).toBe("not_compared");
    expect(mid.find((r) => r.field === "site")!.status).toBe("match");
    expect(mid.find((r) => r.field === "patient_name")!.status).toBe("match"); // "Doe, Jo" vs "Jo Doe"
    expect(mid.find((r) => r.field === "mrn")!.status).toBe("not_compared"); // not on the bottle: shown, never treated as a match
  });
});

describe("S1 intake bench read model", () => {
  it("reconciles the courier manifest per office: expected vs received, missing, and Unknown when no manifest exists", async () => {
    const { deliveriesForDay } = await import("@/server/queries/intake");
    const db = testDb();
    arrive(db);
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    const d = deliveriesForDay(db, "2026-10-14").find((x) => x.id === DELIVERY)!;
    const byOffice = Object.fromEntries(d.lines.map((l) => [l.officeName, l]));
    expect(byOffice["Harbor Point Dermatology"]).toMatchObject({ expected: 4, received: 4, missing: 0, extra: 0 });
    expect(byOffice["Coral Lane Dermatology"]).toMatchObject({ expected: 3, received: 2, missing: 1 });
    expect(byOffice["Coral Lane Dermatology"].missingParts).toEqual([expect.objectContaining({ orderRef: "ORD-77140", designation: "B" })]);
    // No source manifest → expected and missing are unknown (null), never 0.
    expect(byOffice["Mangrove Bay Dermatology"]).toMatchObject({ expected: null, missing: null, received: 1, manifestSource: "none" });
    expect(byOffice["Seagrape Skin Studio"]).toMatchObject({ expected: null, received: 1 });
    expect(d.totals.expected).toBeNull();
    expect(d.simRemaining).toBe(0);
  });

  it("puts routing exceptions, discrepancies, missing containers, identity conflicts and pending related reviews in the exceptions lane", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const db = testDb();
    arrive(db);
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    const b = one<{ id: string }>(db, "SELECT received_intake_item_id id FROM sim_physical_item WHERE id = 'phys_quinlanB'");
    verifyAll(db, b.id);
    const bench = intakeBench(db, loadActor(db, STAFF.maya));
    const lane = (orderRef: string) => bench.queue.find((q) => q.orderRefs.includes(orderRef))!;
    expect(lane("ORD-77170")).toMatchObject({ lane: "exceptions" });
    expect(lane("ORD-77170").reasons).toContain("Routing exception");
    expect(lane("ORD-77140").reasons).toContain("Missing container");
    expect(lane("ORD-77121").reasons).toEqual(expect.arrayContaining(["Discrepancy: laterality", "Related orders: needs review"]));
    expect(lane("ORD-77118")).toMatchObject({ lane: "to_review", reasons: [] }); // the rest of the bench continues
    const seededIdentity = bench.queue.find((q) => q.displayId === "INT-1014-022")!;
    expect(seededIdentity.lane).toBe("exceptions");
    expect(seededIdentity.reasons).toEqual(expect.arrayContaining(["Identity conflict", "Hold H-0088"]));
    expect(bench.counts.done).toBeGreaterThan(0);
    expect(bench.permissions).toMatchObject({ verify: true, reviewRelated: false, override: false });

    const detail = intakeBench(db, loadActor(db, STAFF.maya), { item: lane("ORD-77121").displayId }).selected!;
    const lat = detail.containers[0].comparison.find((r) => r.field === "laterality")!;
    expect(lat).toMatchObject({ status: "differs", order: { original: "Right" }, observed: { original: "L" }, requisition: { original: "Right" } });
    expect(detail.related[0].status).toBe("pending_review");
    expect(detail.readiness.ready).toBe(false);
  });

  it("resolves a scanned order id within its tenant, an INT id, bottle label text, or an unpacked requisition", async () => {
    const { resolveIntakeScan } = await import("@/server/queries/intake");
    const db = testDb();
    arrive(db);
    expect(resolveIntakeScan(db, "ORD-77121")).toMatchObject({ kind: "unpack", orderRef: "ORD-77121", deliveryId: DELIVERY });
    const r = receive(db, "phys_quinlanB");
    expect(resolveIntakeScan(db, "ord-77121")).toMatchObject({ kind: "item", displayId: r.displayId });
    expect(resolveIntakeScan(db, r.displayId)).toMatchObject({ kind: "item", displayId: r.displayId });
    expect(resolveIntakeScan(db, "L dorsal forearm")).toMatchObject({ kind: "item", displayId: r.displayId });
    expect(resolveIntakeScan(db, "nothing like this")).toMatchObject({ kind: "none" });
  });
});

describe("S1 intake bench read model: every item renders", () => {
  it("builds a serializable detail for every queue item before and after the hero accession, with lanes matching the queue", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const db = testDb();
    arrive(db);
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    const maya = loadActor(db, STAFF.maya);
    const check = () => {
      const bench = intakeBench(db, maya);
      expect(() => JSON.stringify(bench)).not.toThrow();
      for (const q of bench.queue) {
        const d = intakeBench(db, maya, { item: q.displayId }).selected!;
        expect(d.displayId).toBe(q.displayId);
        expect(d.lane).toBe(q.lane);
        expect(() => JSON.stringify(d)).not.toThrow();
      }
      return bench;
    };
    check();
    // Hero flow to accession, then the read model again (Done lane shows the official number).
    const a = one<{ id: string }>(db, "SELECT received_intake_item_id id FROM sim_physical_item WHERE id = 'phys_quinlanA'").id;
    const b = one<{ id: string }>(db, "SELECT received_intake_item_id id FROM sim_physical_item WHERE id = 'phys_quinlanB'").id;
    verifyAll(db, a);
    verifyAll(db, b);
    const cB = containersOf(db, b)[0];
    clarificationFixture(db, { intakeItemId: b, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: a });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: b });
    const cand = one<{ id: string; version: number }>(db, "SELECT id, version FROM related_order_candidate");
    must(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "single_accession_approved", reason: "Same encounter" });
    const before = intakeBench(db, maya, { item: one<{ display_id: string }>(db, "SELECT display_id FROM intake_item WHERE id = ?", a).display_id }).selected!;
    expect(before.readiness.group?.blockers).toEqual([]);
    expect(before.readiness.group?.ids.sort()).toEqual([a, b].sort());
    must(db, STAFF.maya, "accession.request", { intakeItemIds: [a, b] });
    const after = check();
    const done = after.queue.filter((q) => q.lane === "done" && q.accessionNumber === "D26-04817");
    expect(done).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- review fixes: discrepancies cannot be edited away

function editObservation(db: DB, actor: string, containerId: string, observed: Record<string, string | null>) {
  const v = one<{ version: number }>(db, "SELECT version FROM container WHERE id = ?", containerId).version;
  return must(db, actor, "intake.recordObservation", { containerId, expectedVersion: v, observed });
}
function codesFor(db: DB, ids: string[]) {
  return accessionBlockers(db, ids).map((b) => b.code);
}
function nowIso(db: DB) {
  return readClock(db).now;
}
function markResolved(db: DB, clarificationId: string, at = nowIso(db), code = "confirmed_observed") {
  db.prepare("UPDATE clarification SET state = 'resolved', resolved_at = ?, resolved_by = ?, resolution_code = ? WHERE id = ?").run(at, STAFF.kim, code, clarificationId);
}
/** Queue a newer version of a seeded EMA-SIM order in the simulated source outbox and import it through S6's sync. */
function amendOrder(db: DB, sourceOrderId: string, mutate: (payload: { specimens: { designation: string; site: string; laterality: string | null }[]; [k: string]: unknown }) => void) {
  const order = one<{ id: string }>(db, "SELECT id FROM source_order WHERE source_order_id = ? AND tenant_id = 'ten_ema'", sourceOrderId);
  const latest = one<{ payload: string; source_version: number }>(
    db, "SELECT payload, source_version FROM source_order_version WHERE source_order_id = ? ORDER BY source_version DESC LIMIT 1", order.id,
  );
  const payload = JSON.parse(latest.payload);
  payload.version = latest.source_version + 1;
  payload.updated_at = nowIso(db);
  mutate(payload);
  db.prepare("INSERT INTO sim_source_outbox (id, source_id, message_id, message_type, available_at, payload, delivered_at) VALUES (?, 'src_ema', ?, 'order.upsert', ?, ?, NULL)").run(
    `ob_test_${order.id}_v${payload.version}`, `${sourceOrderId}#v${payload.version}`, nowIso(db), JSON.stringify(payload),
  );
  must(db, STAFF.tanya, "integration.syncNow", {});
  return one<{ source_version: number }>(db, "SELECT source_version FROM source_order WHERE id = ?", order.id).source_version;
}
/** A synthetic Harbor Point order + its courier bag contents (fictional patient). */
function synthOrder(
  db: DB,
  o: { key: string; ref: string; mrn: string; name: [string, string]; dob: string; parts: { d: string; expected: number | null; site: string; lat: string | null }[]; bottles: Record<string, unknown>[] },
) {
  const at = labLocalToIso("2026-10-14", "09:30");
  db.prepare("INSERT OR IGNORE INTO patient_ref (id, tenant_id, source_mrn, family_name, given_name, birth_date, imported_at) VALUES (?, 'ten_ema', ?, ?, ?, ?, ?)").run(
    `pt_${o.key}`, o.mrn, o.name[0], o.name[1], o.dob, at,
  );
  db.prepare(
    `INSERT INTO source_order (id, tenant_id, source_order_id, patient_ref_id, encounter_id, office_id, ordering_clinician_id, source_status, source_version, source_updated_at, imported_at)
     VALUES (?, 'ten_ema', ?, ?, NULL, 'off_hpd', 'cln_reed', 'active', 1, ?, ?)`,
  ).run(`ord_${o.key}`, o.ref, `pt_${o.key}`, at, at);
  for (const p of o.parts) {
    db.prepare(
      `INSERT INTO source_order_part (id, source_order_id, designation, site_text, laterality, procedure, collected_at, expected_containers) VALUES (?, ?, ?, ?, ?, 'shave', ?, ?)`,
    ).run(`ord_${o.key}_${p.d.toLowerCase()}`, `ord_${o.key}`, p.d, p.site, p.lat, at, p.expected);
  }
  db.prepare(
    `INSERT INTO sim_physical_item (id, delivery_id, seq, observed_office_text, requisition_order_ref, requisition_fields, containers, received_intake_item_id)
     VALUES (?, ?, ?, 'Harbor Point Dermatology', ?, '{}', ?, NULL)`,
  ).run(`phys_${o.key}`, DELIVERY, 100 + Number(o.mrn.slice(-2)), o.ref, JSON.stringify(o.bottles));
  return `phys_${o.key}`;
}

describe("S1 recorded discrepancies: identity, edits, coverage, amendments (review fixes)", () => {
  it("a patient identity mismatch blocks accession with no hold at all, until an identity clarification is resolved; a lead cannot accept it locally", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    const [c] = containersOf(db, r.intakeItemId);
    editObservation(db, STAFF.maya, c.id, { birth_date: "1972-04-16" }); // what the bottle actually says
    const [v] = verifyAll(db, r.intakeItemId);
    expect(v.state).toBe("discrepancy");
    expect(v.discrepancies.map((d) => d.field)).toEqual(["birth_date"]);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(count(db, "hold", "status = 'active' AND intake_item_id = ?", r.intakeItemId)).toBe(0);

    const accBefore = count(db, "accession");
    const blocked = run(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(!blocked.ok && blocked.error.code).toBe("BLOCKED");
    if (!blocked.ok) expect((blocked.error.details as { blockers: { code: string }[] }).blockers.map((b) => b.code)).toEqual(["identity_unresolved"]);

    // An open identity question (raised without a hold) is not enough.
    const clr = clarificationFixture(db, { intakeItemId: r.intakeItemId, orderPartId: c.order_part_id, containerId: c.id, category: "identity_conflict" });
    expect(codesFor(db, [r.intakeItemId])).toEqual(["identity_unresolved"]);
    // A lead cannot accept a patient identity difference locally.
    const d = one<{ id: string; version: number }>(db, "SELECT id, version FROM intake_discrepancy WHERE container_id = ? AND field = 'birth_date' AND status = 'open'", c.id);
    const lead = run(db, STAFF.kim, "intake.acceptDiscrepancy", { discrepancyId: d.id, expectedVersion: d.version, reason: "Looks like a transposition" });
    expect(!lead.ok && lead.error.code).toBe("INVARIANT");
    expect(count(db, "accession")).toBe(accBefore);

    // Once a lead resolved the identity clarification as "office confirmed the order is correct" (review and resolution happen
    // in the clarifications slice), the request proceeds. Any other resolution code does not cover identity (integrity.test.ts).
    markResolved(db, clr, nowIso(db), "confirmed_order");
    expect(codesFor(db, [r.intakeItemId])).toEqual([]);
    const acc = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(acc.outcome).toBe("issued");
  });

  it("retyping the bottle observation never closes a recorded mismatch; only a lead's acceptance with a reason does, and the values stay as found", () => {
    const db = testDb();
    const { b } = heroReady(db);
    expect(verifyAll(db, b.intakeItemId)[0].state).toBe("discrepancy");
    const cB = containersOf(db, b.intakeItemId)[0];
    const rec = one<{ id: string; values_json: string }>(db, "SELECT id, values_json FROM intake_discrepancy WHERE container_id = ? AND field = 'laterality'", cB.id);

    editObservation(db, STAFF.maya, cB.id, { site_text: "R dorsal forearm" });
    expect(containersOf(db, b.intakeItemId)[0].verification_state).toBe("unverified");
    const [again] = verifyAll(db, b.intakeItemId);
    expect(again.state).toBe("discrepancy");
    expect(again.discrepancies).toEqual([]); // the retyped values agree...
    expect(again.stillOpen.map((x) => x.field)).toEqual(["laterality"]); // ...but the finding stays open
    expect(again.stillOpen[0].reason).toMatch(/edited after this mismatch was recorded/);
    const d = one<{ status: string; values_json: string; version: number }>(db, "SELECT status, values_json, version FROM intake_discrepancy WHERE id = ?", rec.id);
    expect(d).toMatchObject({ status: "open", values_json: rec.values_json });
    expect(codesFor(db, [b.intakeItemId])).toContain("discrepancy_uncovered");

    const accessioner = run(db, STAFF.maya, "intake.acceptDiscrepancy", { discrepancyId: rec.id, expectedVersion: d.version, reason: "typo" });
    expect(!accessioner.ok && accessioner.error.code).toBe("FORBIDDEN");
    const noReason = run(db, STAFF.kim, "intake.acceptDiscrepancy", { discrepancyId: rec.id, expectedVersion: d.version, reason: "   " });
    expect(!noReason.ok && noReason.error.code).toBe("VALIDATION");
    const accepted = must<{ containerState: string }>(db, STAFF.kim, "intake.acceptDiscrepancy", {
      discrepancyId: rec.id, expectedVersion: d.version, reason: "Bench typing error: re-read the physical label, it says R",
    });
    expect(accepted.containerState).toBe("verified");
    expect(one(db, "SELECT status, resolution_kind, resolved_by, values_json FROM intake_discrepancy WHERE id = ?", rec.id)).toEqual({
      status: "resolved", resolution_kind: "lead_accepted", resolved_by: STAFF.kim, values_json: rec.values_json,
    });
    expect(codesFor(db, [b.intakeItemId])).not.toContain("discrepancy_uncovered");
    expect(one<{ reason: string }>(db, "SELECT reason FROM audit_event WHERE action = 'intake.discrepancy_accepted' AND actor_id = ?", STAFF.kim).reason).toMatch(/typing error/);
    // A closed finding is final: the database refuses to reopen or rewrite it.
    expect(() => db.prepare("UPDATE intake_discrepancy SET status = 'open' WHERE id = ?").run(rec.id)).toThrow(/final/);
  });

  it("while a clarification is open, a re-check after an edit leaves the mismatch with that clarification and a lead cannot short-cut it", () => {
    const db = testDb();
    const { b } = heroReady(db);
    verifyAll(db, b.intakeItemId);
    const cB = containersOf(db, b.intakeItemId)[0];
    const clr = clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    editObservation(db, STAFF.maya, cB.id, { site_text: "R dorsal forearm" });
    const [again] = verifyAll(db, b.intakeItemId);
    expect(again.stillOpen[0].reason).toMatch(/CLR-9\d{3} is still open/);
    expect(codesFor(db, [b.intakeItemId])).not.toContain("discrepancy_uncovered"); // still covered by the open question
    const d = one<{ id: string; version: number }>(db, "SELECT id, version FROM intake_discrepancy WHERE container_id = ? AND field = 'laterality' AND status = 'open'", cB.id);
    const lead = run(db, STAFF.kim, "intake.acceptDiscrepancy", { discrepancyId: d.id, expectedVersion: d.version, reason: "typo" });
    expect(!lead.ok && lead.error.code).toBe("BLOCKED");
    void clr;
  });

  it("an uncovered discrepancy blocks accession; another category or a clarification resolved before the finding does not cover it; canceling the covering one blocks again", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_castillo");
    const [c] = containersOf(db, r.intakeItemId);
    editObservation(db, STAFF.maya, c.id, { procedure: "Excision" });
    const [v] = verifyAll(db, r.intakeItemId);
    expect(v.discrepancies.map((d) => d.field)).toEqual(["procedure"]);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(codesFor(db, [r.intakeItemId])).toEqual(["discrepancy_uncovered"]);

    const old = clarificationFixture(db, { intakeItemId: r.intakeItemId, orderPartId: c.order_part_id, containerId: c.id, category: "biopsy_method" });
    markResolved(db, old, labLocalToIso("2026-10-14", "10:30")); // closed before this finding existed
    expect(codesFor(db, [r.intakeItemId])).toEqual(["discrepancy_uncovered"]);
    clarificationFixture(db, { intakeItemId: r.intakeItemId, orderPartId: c.order_part_id, containerId: c.id, category: "laterality" }); // unrelated question
    expect(codesFor(db, [r.intakeItemId])).toEqual(["discrepancy_uncovered"]);
    const ok = clarificationFixture(db, { intakeItemId: r.intakeItemId, orderPartId: c.order_part_id, containerId: c.id, category: "biopsy_method" });
    expect(codesFor(db, [r.intakeItemId])).toEqual([]);
    db.prepare("UPDATE clarification SET state = 'canceled' WHERE id = ?").run(ok);
    const blocked = run(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(!blocked.ok && blocked.error.code).toBe("BLOCKED");
    if (!blocked.ok) expect((blocked.error.details as { blockers: { code: string }[] }).blockers.map((b) => b.code)).toEqual(["discrepancy_uncovered"]);
  });

  it("a container checked against an older order version must be checked again before accession (INV-13)", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(codesFor(db, [r.intakeItemId])).toEqual([]);
    expect(amendOrder(db, "ORD-77118", (p) => void (p.amendment_note = "Clinician note corrected (synthetic)"))).toBe(2);
    const blocked = run(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(!blocked.ok && blocked.error.code).toBe("BLOCKED");
    if (!blocked.ok) {
      const bl = (blocked.error.details as { blockers: { code: string; message: string }[] }).blockers;
      expect(bl.map((b) => b.code)).toEqual(["verification_stale"]);
      expect(bl[0].message).toMatch(/ORD-77118 v1, but the order is now v2/);
    }
    expect(verifyAll(db, r.intakeItemId)[0].state).toBe("verified");
    expect(codesFor(db, [r.intakeItemId])).toEqual([]);
  });

  it("an amended order that matches the bottle closes the recorded mismatch on a re-check (not while the clarification is open); original values are kept", () => {
    const db = testDb();
    arrive(db);
    // Variant of part B whose paper requisition does not state a side, so only the order and the bottle disagree.
    db.prepare("UPDATE sim_physical_item SET requisition_fields = json_set(requisition_fields, '$.specimens[0].site', 'Dorsal forearm') WHERE id = 'phys_quinlanB'").run();
    const b = receive(db, "phys_quinlanB");
    expect(verifyAll(db, b.intakeItemId)[0].state).toBe("discrepancy");
    const cB = containersOf(db, b.intakeItemId)[0];
    const rec = one<{ id: string; values_json: string }>(db, "SELECT id, values_json FROM intake_discrepancy WHERE container_id = ? AND field = 'laterality'", cB.id);
    const clr = clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    const v2 = amendOrder(db, "ORD-77121", (p) => {
      p.specimens = p.specimens.map((s) => (s.designation === "B" ? { ...s, laterality: "left", site: "Left dorsal forearm" } : s));
    });
    expect(v2).toBe(2);
    const [open] = verifyAll(db, b.intakeItemId);
    expect(open.state).toBe("discrepancy");
    expect(open.discrepancies).toEqual([]);
    expect(open.stillOpen[0].reason).toMatch(/still open/);
    markResolved(db, clr);
    const [closed] = verifyAll(db, b.intakeItemId);
    expect(closed).toMatchObject({ state: "verified", stillOpen: [], discrepancies: [] });
    expect(one(db, "SELECT status, resolution_kind, values_json FROM intake_discrepancy WHERE id = ?", rec.id)).toEqual({
      status: "resolved", resolution_kind: "order_amended", values_json: rec.values_json,
    });
    expect(JSON.parse(rec.values_json)).toMatchObject({ order: { original: "Right" }, observed: { original: "L" }, orderVersion: 1 });
  });

  it("when the paper requisition still disagrees after the amendment, the finding stays open (covered by the resolved clarification)", () => {
    const db = testDb();
    const { b } = heroReady(db);
    verifyAll(db, b.intakeItemId);
    const cB = containersOf(db, b.intakeItemId)[0];
    const clr = clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    markResolved(db, clr);
    amendOrder(db, "ORD-77121", (p) => {
      p.specimens = p.specimens.map((s) => (s.designation === "B" ? { ...s, laterality: "left", site: "Left dorsal forearm" } : s));
    });
    const [again] = verifyAll(db, b.intakeItemId);
    expect(again.state).toBe("discrepancy");
    expect(again.discrepancies[0]).toMatchObject({ field: "laterality", orderValue: "Left", observedValue: "L", requisitionValue: "Right" });
    expect(codesFor(db, [b.intakeItemId])).not.toContain("discrepancy_uncovered");
  });
});

describe("S1 container counts per order part and links (review fixes)", () => {
  it("a single-part order does not swallow a bottle labeled for another part; extra containers are flagged per part and a lead may accept them", () => {
    const db = testDb();
    arrive(db);
    synthOrder(db, {
      key: "holloway", ref: "ORD-77301", mrn: "900101", name: ["Holloway", "Brin"], dob: "1958-07-04",
      parts: [{ d: "A", expected: 1, site: "Left cheek", lat: "left" }],
      bottles: [
        { patient_name: "Holloway, Brin", birth_date: "1958-07-04", part_designation: "A", site_text: "L cheek", procedure: "shave" },
        { patient_name: "Holloway, Brin", birth_date: "1958-07-04", part_designation: "B", site_text: "L cheek", procedure: "shave" },
      ],
    });
    const r = receive(db, "phys_holloway");
    const cs = containersOf(db, r.intakeItemId);
    expect(cs.map((c) => c.order_part_id === null)).toEqual([false, true]); // bottle B is not silently linked to part A
    expect(one<{ link_basis: string }>(db, "SELECT link_basis FROM container WHERE id = ?", cs[0].id).link_basis).toBe("suggested_by_designation");
    expect(count(db, "intake_discrepancy", "intake_item_id = ? AND kind = 'unmatched_container' AND status = 'open'", r.intakeItemId)).toBe(1);
    // Container 2 has no part yet: verify container 1 only.
    must(db, STAFF.maya, "intake.verifyContainer", { containerId: cs[0].id, expectedVersion: cs[0].version, orderPartId: cs[0].order_part_id });
    const partA = "ord_holloway_a";
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(codesFor(db, [r.intakeItemId])).toEqual(["container_unverified", "unmatched_container"]);

    // Staff link bottle 2 to part A: its designation is recorded as differing, and part A now has more containers than expected.
    const c2 = containersOf(db, r.intakeItemId)[1];
    const v = must<VerifyRes>(db, STAFF.maya, "intake.verifyContainer", { containerId: c2.id, expectedVersion: c2.version, orderPartId: partA });
    expect(v.discrepancies.map((d) => d.field)).toEqual(["part_designation"]);
    const extra = one<{ id: string; version: number; values_json: string }>(db, "SELECT * FROM intake_discrepancy WHERE intake_item_id = ? AND kind = 'extra_container' AND status = 'open'", r.intakeItemId);
    expect(JSON.parse(extra.values_json)).toMatchObject({ received: 2, order: { expected_containers: 1 } });
    expect(codesFor(db, [r.intakeItemId])).toEqual(expect.arrayContaining(["discrepancy_uncovered", "extra_container"]));
    must(db, STAFF.kim, "intake.acceptDiscrepancy", { discrepancyId: extra.id, expectedVersion: extra.version, reason: "Office confirmed by phone: part A was sent in two bottles (synthetic)" });
    expect(codesFor(db, [r.intakeItemId])).not.toContain("extra_container");
  });

  it("a missing-container flag closes only when as many containers as expected are linked to the part", () => {
    const db = testDb();
    arrive(db);
    synthOrder(db, {
      key: "varga", ref: "ORD-77302", mrn: "900102", name: ["Varga", "Tomas"], dob: "1966-02-11",
      parts: [{ d: "A", expected: 2, site: "Scalp, vertex", lat: "midline" }],
      bottles: [{ patient_name: "Varga, Tomas", birth_date: "1966-02-11", part_designation: "A", site_text: "Scalp vertex", procedure: "shave" }],
    });
    const r = receive(db, "phys_varga");
    expect(r.missingParts).toEqual(["A"]);
    verifyAll(db, r.intakeItemId);
    const miss = one<{ status: string; values_json: string }>(db, "SELECT status, values_json FROM intake_discrepancy WHERE intake_item_id = ? AND kind = 'missing_container'", r.intakeItemId);
    expect(miss.status).toBe("open"); // 1 of 2 received: still missing after the check
    expect(JSON.parse(miss.values_json)).toMatchObject({ received: 1, order: { expected_containers: 2 } });
  });

  it("verifying against an order part that is not on the item's linked order is refused", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    const [c] = containersOf(db, r.intakeItemId);
    const res = run(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: "ord_ord_77119_a" });
    expect(!res.ok && res.error.code).toBe("VALIDATION");
    expect(containersOf(db, r.intakeItemId)[0].verification_state).toBe("unverified");
  });

  it("receives a requisition by its order id within the delivery, idempotently", () => {
    const db = testDb();
    arrive(db);
    const first = must<ReceiveRes & { orderLinked: boolean }>(db, STAFF.maya, "intake.receivePhysicalItem", { deliveryId: DELIVERY, orderRef: "ord-77118" });
    const again = must<ReceiveRes & { orderLinked: boolean }>(db, STAFF.luis, "intake.receivePhysicalItem", { deliveryId: DELIVERY, orderRef: "ORD-77118" });
    expect(again).toMatchObject({ duplicate: true, intakeItemId: first.intakeItemId, orderLinked: true });
    const unknown = run(db, STAFF.maya, "intake.receivePhysicalItem", { deliveryId: DELIVERY, orderRef: "ORD-99999" });
    expect(!unknown.ok && unknown.error.code).toBe("NOT_FOUND");
  });

  it("a delivery is reconciled once every requisition is unpacked, not before", async () => {
    const { deliveriesForDay } = await import("@/server/queries/intake");
    const db = testDb();
    arrive(db);
    receive(db, "phys_barnes");
    expect(one<{ status: string }>(db, "SELECT status FROM courier_delivery WHERE id = ?", DELIVERY).status).toBe("reconciling");
    expect(deliveriesForDay(db, "2026-10-14").find((d) => d.id === DELIVERY)!.unpackingComplete).toBe(false);
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    expect(one<{ status: string }>(db, "SELECT status FROM courier_delivery WHERE id = ?", DELIVERY).status).toBe("reconciled");
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    expect(count(db, "audit_event", "action = 'courier.reconciled' AND entity_id = ?", DELIVERY)).toBe(1);
  });
});

describe("S1 grouping, related-order review and scan (review fixes)", () => {
  it("requesting items together is refused for different patients, for items not approved as one accession, and when routing differs", () => {
    const db = testDb();
    const { a, b } = heroReady(db);
    const barnes = receive(db, "phys_barnes");
    verifyAll(db, barnes.intakeItemId);
    verifyAll(db, a.intakeItemId);
    verifyAll(db, b.intakeItemId);
    for (const id of [a.intakeItemId, b.intakeItemId, barnes.intakeItemId]) must(db, STAFF.maya, "routing.confirm", { intakeItemId: id });
    expect(codesFor(db, [a.intakeItemId, barnes.intakeItemId])).toEqual(expect.arrayContaining(["different_patients", "not_grouped"]));

    const cB = containersOf(db, b.intakeItemId)[0];
    clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    const cand = one<{ id: string; version: number }>(db, "SELECT id, version FROM related_order_candidate");
    must(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "single_accession_approved", reason: "Same encounter" });
    expect(codesFor(db, [a.intakeItemId, b.intakeItemId])).toEqual([]);
    must(db, STAFF.kim, "routing.override", { intakeItemId: b.intakeItemId, pathologistId: STAFF.okafor, reason: "Workload (synthetic)", expectedDecisionId: decisionIdOf(db, b.intakeItemId) });
    expect(codesFor(db, [a.intakeItemId, b.intakeItemId])).toEqual(["routing_differs"]);
  });

  it("a possible duplicate patient record (different MRNs, same name and birth date) is proposed for review but can never be approved as one accession", () => {
    const db = testDb();
    arrive(db);
    const bottle = { patient_name: "Lindqvist, Mara", birth_date: "1970-05-05", part_designation: "A", site_text: "R shoulder", procedure: "shave" };
    synthOrder(db, { key: "lindq1", ref: "ORD-77311", mrn: "900111", name: ["Lindqvist", "Mara"], dob: "1970-05-05", parts: [{ d: "A", expected: 1, site: "Right shoulder", lat: "right" }], bottles: [bottle] });
    synthOrder(db, { key: "lindq2", ref: "ORD-77312", mrn: "900112", name: ["Lindqvist", "Mara"], dob: "1970-05-05", parts: [{ d: "A", expected: 1, site: "Right shoulder", lat: "right" }], bottles: [bottle] });
    receive(db, "phys_lindq1");
    const second = receive(db, "phys_lindq2");
    expect(second.relatedCandidates).toHaveLength(1);
    const cand = one<{ id: string; version: number; detection_rule: string }>(db, "SELECT * FROM related_order_candidate WHERE order_a_id IN ('ord_lindq1','ord_lindq2')");
    expect(cand.detection_rule).toMatch(/possible_duplicate_patient_record/);
    const approve = run(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "single_accession_approved", reason: "Same person?" });
    expect(!approve.ok && approve.error.code).toBe("INVARIANT");
    must(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "escalated_to_office", reason: "Ask the office whether these are one patient" });
    expect(count(db, "patient_ref", "id IN ('pt_lindq1','pt_lindq2')")).toBe(2); // nothing merged
  });

  it("a related-order decision cannot change while an accession request for its items waits for the offline source", () => {
    const db = testDb();
    const { a, b } = heroReady(db);
    verifyAll(db, a.intakeItemId);
    verifyAll(db, b.intakeItemId);
    const cB = containersOf(db, b.intakeItemId)[0];
    clarificationFixture(db, { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id, category: "laterality" });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: a.intakeItemId });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: b.intakeItemId });
    const cand = one<{ id: string; version: number }>(db, "SELECT id, version FROM related_order_candidate");
    must(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "single_accession_approved", reason: "Same encounter" });
    db.prepare("UPDATE integration_source SET status = 'offline' WHERE id = 'src_ema'").run();
    const off = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId, b.intakeItemId] });
    expect(off.outcome).toBe("source_offline");
    const v = one<{ version: number }>(db, "SELECT version FROM related_order_candidate WHERE id = ?", cand.id).version;
    const change = run(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: v, decision: "keep_separate", reason: "changed mind" });
    expect(!change.ok && change.error.code).toBe("BLOCKED");
    db.prepare("UPDATE integration_source SET status = 'connected' WHERE id = 'src_ema'").run();
    expect(must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId, b.intakeItemId] }).outcome).toBe("issued");
  });

  it("scan lookup matches label values (never stored field names) and opens only accessions that exist", async () => {
    const { resolveIntakeScan } = await import("@/server/queries/intake");
    const db = testDb();
    arrive(db);
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    expect(resolveIntakeScan(db, "patient_name")).toMatchObject({ kind: "none" });
    expect(resolveIntakeScan(db, "site_text")).toMatchObject({ kind: "none" });
    expect(resolveIntakeScan(db, "D26-09999")).toMatchObject({ kind: "none" });
    const existing = one<{ accession_number: string }>(db, "SELECT accession_number FROM accession ORDER BY accession_number LIMIT 1").accession_number;
    expect(resolveIntakeScan(db, existing)).toMatchObject({ kind: "case", accession: existing });
  });

  it("the colleague-edit demo control is refused for the read-only role and records who pressed it", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    const dir = run(db, STAFF.director, "intake.simulateColleagueEdit", { intakeItemId: r.intakeItemId });
    expect(!dir.ok && dir.error.code).toBe("FORBIDDEN");
    must(db, STAFF.maya, "intake.simulateColleagueEdit", { intakeItemId: r.intakeItemId });
    expect(one<{ actor_id: string }>(db, "SELECT actor_id FROM audit_event WHERE action = 'demo.colleague_edit_requested' AND intake_item_id = ?", r.intakeItemId).actor_id).toBe(STAFF.maya);
  });
});

describe("S1 hero path with the clarifications slice (cross-slice, skipped if clarification.create is not registered)", async () => {
  const { listCommands } = await import("@/server/commands");
  const hasClarify = listCommands().some((c) => c.name === "clarification.create");
  it.skipIf(!hasClarify)("part B laterality clarification with a part-scoped hold lets the A/B accession proceed and keeps the hold on part B only", () => {
    const db = testDb();
    const { a, b } = heroReady(db);
    verifyAll(db, a.intakeItemId);
    const [vb] = verifyAll(db, b.intakeItemId);
    expect(vb.state).toBe("discrepancy");
    const cB = containersOf(db, b.intakeItemId)[0];
    const clr = must<{ clarificationId: string; displayId: string }>(db, STAFF.maya, "clarification.create", {
      category: "laterality",
      refs: { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id },
      subjectLabel: "Part B · ORD-77121",
      question: "Bottle says L dorsal forearm; order ORD-77121 says Right dorsal forearm. Which is correct?",
      evidence: [{ field: "Laterality", order_value: "Right", observed_value: "L", requisition_value: "Right", source: "bottle label" }],
      priority: "high",
      hold: { scope: { type: "order_part", id: cB.order_part_id }, scopeLabel: "Part B (ORD-77121 · B)", blocks: ["gross_approval", "processing", "print", "tray_delivery"] },
    });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: a.intakeItemId });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: b.intakeItemId });
    const cand = one<{ id: string; version: number }>(db, "SELECT id, version FROM related_order_candidate");
    must(db, STAFF.kim, "related.review", { candidateId: cand.id, expectedVersion: cand.version, decision: "single_accession_approved", reason: "Same encounter ENC-55031" });
    const acc = must<AccRes>(db, STAFF.maya, "accession.request", { intakeItemIds: [a.intakeItemId, b.intakeItemId], relatedCandidateId: cand.id });
    expect(acc.accessionNumber).toBe("D26-04817");
    expect(one<{ accession_id: string }>(db, "SELECT accession_id FROM clarification WHERE id = ?", clr.clarificationId).accession_id).toBe(acc.accessionId);
    const r = computeReadiness(db, [acc.accessionId!]).get(acc.accessionId!)!;
    const holdsByPart = Object.fromEntries(r.parts.map((p) => [p.designation, p.holds.length]));
    expect(holdsByPart).toEqual({ A: 0, B: 1 });
  });

  it.skipIf(!hasClarify)("an identity question raised through clarification.create without a hold still blocks accession; canceling a covering question blocks again", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    const [c] = containersOf(db, r.intakeItemId);
    editObservation(db, STAFF.maya, c.id, { birth_date: "1972-04-16", procedure: "Excision" });
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(codesFor(db, [r.intakeItemId]).sort()).toEqual(["discrepancy_uncovered", "identity_unresolved"]);
    const refs = { intakeItemId: r.intakeItemId, orderPartId: c.order_part_id, containerId: c.id };
    must(db, STAFF.maya, "clarification.create", {
      category: "identity_conflict", refs, subjectLabel: "Part A · ORD-77118", priority: "urgent",
      question: "The bottle shows date of birth 1972-04-16 but the order says 1972-06-14. Please confirm the patient identity.",
      evidence: [{ field: "Date of birth", order_value: "1972-06-14", observed_value: "1972-04-16", requisition_value: null, source: "bottle label" }],
    });
    const method = must<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", {
      category: "biopsy_method", refs, subjectLabel: "Part A · ORD-77118 (procedure)", priority: "high",
      question: "The bottle says excision but the order says shave. Which is correct?",
      evidence: [{ field: "Procedure", order_value: "Shave", observed_value: "Excision", requisition_value: null, source: "bottle label" }],
    });
    // The identity question is open and has no hold: accession is still blocked on identity; the procedure question covers its finding.
    expect(codesFor(db, [r.intakeItemId])).toEqual(["identity_unresolved"]);
    must(db, STAFF.kim, "clarification.cancel", { clarificationId: method.clarificationId, reason: "Raised by mistake (test)", expectedVersion: one<{ version: number }>(db, "SELECT version FROM clarification WHERE id = ?", method.clarificationId).version });
    expect(codesFor(db, [r.intakeItemId]).sort()).toEqual(["discrepancy_uncovered", "identity_unresolved"]);
    expect(run(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- intake workstation plan (derived read model)

describe("S1 intake workstation: severity ladder, lanes and the per-actor plan", () => {
  it("ranks queue reasons by the severity ladder: patient identity, then a differing field or count, then holds, then waiting on a named owner", async () => {
    const { queueFlags } = await import("@/components/intake/plan");
    const flags = queueFlags(["Related orders: needs review", "Hold H-0090", "Discrepancy: laterality", "Identity conflict"], { displayId: "REL-0112", ownerName: "Kim Nguyen" });
    expect(flags.map((f) => [f.severity, f.text])).toEqual([
      ["danger", "Patient identity differs"],
      ["warning", "Laterality differs"],
      ["hold", "Hold"],
      ["waiting", "Waits for Kim Nguyen"],
    ]);
    expect(flags[2].id).toBe("H-0090");
    expect(flags[3].id).toBe("REL-0112");
    // Several fields: plural verb; unknown reasons stay visible as neutral.
    expect(queueFlags(["Discrepancy: site, laterality"])[0].text).toBe("Site, laterality differ");
    expect(queueFlags(["Something new"])[0]).toMatchObject({ severity: "neutral", text: "Something new" });
    // A routing exception is not a disagreement between sources: it waits for a named person (neutral rung), never amber.
    const routing = queueFlags(["Routing exception", "Missing container"], null, "Kim Nguyen");
    expect(routing.map((f) => [f.severity, f.text])).toEqual([
      ["warning", "Missing container"],
      ["waiting", "Needs routing · Kim Nguyen"],
    ]);
    expect(queueFlags(["Routing exception"])[0]).toMatchObject({ kind: "routing", severity: "waiting", text: "Needs routing" });
  });

  it("keeps the members of one related-order review together in a lane, exceptions first, and counts checked containers per delivery", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const { laneGroups, openOrder } = await import("@/components/intake/plan");
    const db = testDb();
    arrive(db);
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    const a = one<{ id: string }>(db, "SELECT received_intake_item_id id FROM sim_physical_item WHERE id = 'phys_quinlanA'").id;
    verifyAll(db, a);
    const bench = intakeBench(db, loadActor(db, STAFF.maya));
    const g = laneGroups(bench.queue);
    const rel = g.exceptions.filter((q) => q.related?.displayId);
    expect(rel.length).toBe(2);
    const at = g.exceptions.findIndex((q) => q.id === rel[0].id);
    expect(g.exceptions[at + 1].id).toBe(rel[1].id);
    expect(rel[0].related).toMatchObject({ status: "pending_review", ownerName: "Kim Nguyen" });
    expect(openOrder(bench.queue).map((q) => q.lane)).toEqual([...g.exceptions.map(() => "exceptions"), ...g.to_review.map(() => "to_review")]);
    expect(bench.firstOpen?.displayId).toBe(g.exceptions[0].displayId);
    const d = bench.deliveries.find((x) => x.id === DELIVERY)!;
    expect(d.totals.checked).toBe(1);
    expect(d.totals.received).toBeGreaterThan(1);
  });

  it("an unchecked bottle is the next step and is never a Ctrl+Enter target; the finding says it is not checked", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const { segText } = await import("@/components/intake/plan");
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    const plan = intakeBench(db, loadActor(db, STAFF.maya), { item: r.displayId }).plan!;
    expect(plan.next?.action?.kind).toBe("verify");
    expect(plan.next?.ctrlEnter).toBe(false);
    expect(plan.also.map((w) => w.action?.kind)).toContain("accept_routing");
    expect(plan.also.every((w) => w.action?.kind !== "verify")).toBe(true);
    expect(segText(plan.finding.lead)).toMatch(/has not been checked against the physical bottle/);
    expect(plan.steps.map((s) => s.key)).toEqual(["check", "differences", "related", "routing", "accession"]);
    expect(plan.steps[0]).toMatchObject({ state: "mine", stale: false });
    expect(plan.accession.state).toBe("blocked");
    expect(segText(plan.accession.reason)).toMatch(/^Cannot request yet: waits for a check of the bottle against the order and routing to be accepted\.$/);
  });

  it("hero part B after the laterality question: each person's next step, who is waited on, the hold scope for both parts and the accession reason", async () => {
    const { listCommands } = await import("@/server/commands");
    expect(listCommands().some((c) => c.name === "clarification.create")).toBe(true);
    const { intakeBench } = await import("@/server/queries/intake");
    const { segText } = await import("@/components/intake/plan");
    const db = testDb();
    const { a, b } = heroReady(db);
    verifyAll(db, a.intakeItemId);
    verifyAll(db, b.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: a.intakeItemId });
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: b.intakeItemId });
    // Before anyone asks: the next step is to raise the question about the side (not to send anything).
    const before = intakeBench(db, loadActor(db, STAFF.maya), { item: b.displayId }).plan!;
    expect(before.next?.action).toMatchObject({ kind: "raise", field: "laterality" });
    expect(before.finding.tone).toBe("warning");
    expect(segText(before.finding.lead)).toBe("Laterality differs: the bottle says left; the order and the requisition say right.");
    const cB = containersOf(db, b.intakeItemId)[0];
    const clr = must<{ displayId: string }>(db, STAFF.maya, "clarification.create", {
      category: "laterality",
      refs: { intakeItemId: b.intakeItemId, orderPartId: cB.order_part_id, containerId: cB.id },
      subjectLabel: "Part B · ORD-77121",
      question: "Bottle says L dorsal forearm; order ORD-77121 says Right dorsal forearm. Which is correct?",
      evidence: [],
      priority: "high",
      hold: { scope: { type: "order_part", id: cB.order_part_id }, scopeLabel: "Part B (ORD-77121 · B)", blocks: ["gross_approval", "processing", "print", "tray_delivery"] },
    });
    const hold = one<{ display_id: string }>(db, "SELECT display_id FROM hold WHERE status = 'active' AND scope_id = ?", cB.order_part_id).display_id;
    const rel = one<{ display_id: string }>(db, "SELECT display_id FROM related_order_candidate").display_id;

    // Maya (accessioner, owner of the drafted question): send it. Drafted is said as "not sent".
    const maya = intakeBench(db, loadActor(db, STAFF.maya), { item: b.displayId }).plan!;
    expect(maya.next?.action).toMatchObject({ kind: "send", displayId: clr.displayId });
    expect(maya.next?.ctrlEnter).toBe(true);
    expect(maya.next?.action && "notice" in maya.next.action ? maya.next.action.notice : "").toMatch(new RegExp(`specimen question \\(${clr.displayId}\\)\\. Please open the secure case view`));
    expect(maya.next?.action && "notice" in maya.next.action ? maya.next.action.notice : "").not.toMatch(/Quinlan|1961|dorsal|Right/);
    expect(maya.steps[1]).toMatchObject({ key: "differences", state: "mine", tone: "warning" });
    expect(segText(maya.steps[1].status)).toBe(`${clr.displayId} drafted, not sent`);
    // The rail shows the same in a few words; the full status stays the accessible name. One step is current.
    expect(segText(maya.steps[1].short)).toBe(`${clr.displayId} · not sent`);
    expect(maya.current).toBe("differences");
    expect(maya.steps.map((st) => segText(st.short))).toEqual([
      expect.stringMatching(/^Maya Torres · \d{1,2}:\d{2} [AP]M$/),
      `${clr.displayId} · not sent`,
      `${rel} · Kim Nguyen`,
      "Dr. Marsh · rule v3",
      `Waits for ${rel}`,
    ]);
    expect(maya.waitingOn.map((w) => w.who)).toEqual(["Kim Nguyen"]);
    expect(segText(maya.finding.then)).toBe(`Accession waits for Kim Nguyen's review of ${rel}.`);
    // The hold scope names both parts: B held for the listed steps, A free, accession not held.
    expect(segText(maya.holdLine.text)).toBe(`Hold ${hold} applies to Part B only: gross approval, processing, label printing, tray delivery. Accession is not held. Part A can continue.`);
    // On screen each hold leads as a hatched chip naming its scope, then what it stops; the free parts follow.
    expect(maya.holdLine.holds.map((h) => ({ ...h, effect: segText(h.effect) }))).toEqual([
      { id: hold, scope: "Part B", effect: "Stops gross approval, processing, label printing and tray delivery. Accession is not held." },
    ]);
    expect(segText(maya.holdLine.tail)).toBe("Part A can continue.");
    expect(maya.accession.state).toBe("blocked");
    expect(segText(maya.accession.reason)).toBe(`Cannot request yet: waits for Kim Nguyen's review of ${rel}.`);
    expect(segText(maya.accession.holdNote!)).toBe(`Hold ${hold} does not block it.`);

    // Part A's screen states the same hold scope (from its related item) and that it waits only for the lead.
    const mayaA = intakeBench(db, loadActor(db, STAFF.maya), { item: a.displayId });
    expect(mayaA.siblings.map((s) => s.displayId)).toEqual([b.displayId]);
    expect(segText(mayaA.plan!.holdLine.text)).toContain(`Hold ${hold} applies to Part B only`);
    expect(segText(mayaA.plan!.holdLine.text)).toContain("Part A can continue.");
    expect(mayaA.plan!.next).toBeNull();
    expect(segText(mayaA.plan!.idle!.title)).toBe("Nothing for you on this item right now");
    expect(mayaA.plan!.waitingOn.map((w) => w.who)).toEqual(["Kim Nguyen"]);

    // Kim (accessioning lead, owner of the related review): decide it; Maya's unsent question is someone else's.
    const kim = intakeBench(db, loadActor(db, STAFF.kim), { item: b.displayId }).plan!;
    expect(kim.next?.action).toMatchObject({ kind: "review_related" });
    expect(segText(kim.finding.then)).toBe(`Accession waits for your review of ${rel}.`);
    expect(kim.waitingOn.map((w) => w.who)).toEqual(["Maya Torres"]);
    expect(kim.steps[2]).toMatchObject({ key: "related", state: "mine" });
    expect(kim.current).toBe("related");
    expect(segText(kim.steps[2].short)).toBe(`${rel} · yours`);
    expect(segText(kim.steps[1].status)).toBe(`${clr.displayId} drafted; Maya Torres to send`);
    expect(segText(kim.steps[1].short)).toBe(`${clr.displayId} · Maya Torres`);

    // Read-only director: nothing to act on, every owner named, the request explains who can.
    const director = intakeBench(db, loadActor(db, STAFF.director), { item: b.displayId });
    expect(director.readOnly).toBe(true);
    expect(director.plan!.next).toBeNull();
    expect(segText(director.plan!.idle!.title)).toBe("Read only");
    expect(director.plan!.waitingOn.map((w) => w.who).sort()).toEqual(["Kim Nguyen", "Maya Torres"]);
    expect(director.plan!.accession.state).toBe("not_allowed");
    expect(director.plan!.current).toBeNull();
  });

  it("a patient identity difference is danger in the finding and the steps; a check against an older order version is flagged stale", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const { segText, identityFacts } = await import("@/components/intake/plan");
    const db = testDb();
    // Seeded identity conflict: date of birth differs on both containers, no requisition on file.
    const seeded = intakeBench(db, loadActor(db, STAFF.maya), { item: "INT-1014-022" });
    const p = seeded.plan!;
    expect(p.finding.tone).toBe("danger");
    expect(segText(p.finding.lead)).toMatch(/^Date of birth differs on both containers:/);
    expect(p.steps[1]).toMatchObject({ key: "differences", tone: "danger" });
    expect(segText(p.accession.reason)).toContain("a lead to resolve the patient identity question");
    expect(segText(p.holdLine.text)).toMatch(/^Hold H-0088 applies to all containers of INT-1014-022: accession request\.$/);
    expect(p.holdLine.holds.map((h) => [h.id, h.scope, segText(h.effect)])).toEqual([["H-0088", "all containers", "Stops the accession request."]]);
    expect(segText(p.steps[1].short)).toMatch(/^CLR-\d+ · /);
    const facts = identityFacts(seeded.selected!);
    expect(facts.dob).toMatchObject({ differs: true, from: "bottle" });
    expect(facts.dob.value).not.toBe(facts.dob.orderValue);

    // Stale check: verified against v1, then the order is amended to v2.
    arrive(db);
    const r = receive(db, "phys_barnes");
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(intakeBench(db, loadActor(db, STAFF.maya), { item: r.displayId }).plan!.accession.state).toBe("ready");
    amendOrder(db, "ORD-77118", (pl) => void (pl.amendment_note = "Clinician note corrected (synthetic)"));
    const stale = intakeBench(db, loadActor(db, STAFF.maya), { item: r.displayId }).plan!;
    expect(stale.steps[0]).toMatchObject({ key: "check", stale: true, tone: "warning" });
    expect(segText(stale.steps[0].status)).toBe("Order changed (v1 → v2): check again");
    expect(segText(stale.steps[0].short)).toBe("Order changed · check again");
    expect(stale.current).toBe("check");
    expect(stale.next?.action).toMatchObject({ kind: "verify", stale: true });
    expect(stale.next?.ctrlEnter).toBe(false);
    expect(segText(stale.finding.lead)).toMatch(/changed after container 1 was checked \(v1 → v2\); the check must be repeated/);
    expect(segText(stale.accession.reason)).toContain("a new check of the bottle");
  });

  it("with the accession source offline the request is unavailable with its reason, and the source is named as the one waited on", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const { segText } = await import("@/components/intake/plan");
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    must(db, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });
    const bench = intakeBench(db, loadActor(db, STAFF.maya), { item: r.displayId });
    expect(bench.source.available).toBe(false);
    expect(bench.plan!.accession.state).toBe("offline");
    expect(segText(bench.plan!.accession.reason)).toMatch(/^Source system unreachable \(simulated outage\)/);
    expect(bench.plan!.next).toBeNull();
    expect(bench.plan!.waitingOn.map((w) => w.who)).toEqual(["EMA-SIM (simulated source)"]);
    expect(bench.plan!.steps[4]).toMatchObject({ key: "accession", state: "blocked" });
  });
});

describe("S1 intake workstation: a source conflict on the plan (lead reviews; others wait with the reason)", () => {
  /** Theo Barnes (ORD-77118): checked and routed, so only the source conflict can hold the accession back. */
  function barnesReady(db: DB) {
    arrive(db);
    const r = receive(db, "phys_barnes");
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    return r;
  }
  function v1Payload(db: DB) {
    return JSON.parse(
      one<{ payload: string }>(db, "SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = 'ORD-77118' AND v.source_version = 1").payload,
    ) as Record<string, any>;
  }

  it("a new order with other details for the patient on file: the lead's next step is 'Review source conflict'; it reads as a source conflict, never as an order link", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const { segText, waitNoun } = await import("@/components/intake/plan");
    const db = testDb();
    const r = barnesReady(db);
    expect(intakeBench(db, loadActor(db, STAFF.maya), { item: r.displayId }).plan!.accession.state).toBe("ready");
    const v1 = v1Payload(db);
    importSourceMessage(makeCtx(db, SYSTEM_ACTOR, "import", "plan-test"), "src_ema", {
      messageId: "ORD-77990#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-77990", patient: { ...v1.patient, birth_date: "1901-01-01" } },
    });
    const task = one<{ id: string; version: number; title: string }>(db, "SELECT id, version, title FROM task WHERE kind = 'source_conflict' AND entity_type = 'patient_ref' AND status = 'open'");
    expect(accessionBlockers(db, [r.intakeItemId]).map((b) => b.code)).toEqual(["source_conflict_open"]);

    // Read model: the open review on the item, with the task version the command needs; the item goes to the exceptions lane.
    const kimBench = intakeBench(db, loadActor(db, STAFF.kim), { item: r.displayId });
    const item = kimBench.selected!;
    expect(item.sourceConflicts).toEqual([
      expect.objectContaining({ id: task.id, version: task.version, about: "patient", title: task.title, ownerName: "Kim Nguyen", orderRefs: ["ORD-77118"] }),
    ]);
    expect(item.lane).toBe("exceptions");
    expect(kimBench.queue.find((q) => q.id === item.id)!.flags.map((f) => [f.kind, f.severity, f.text])).toContainEqual(["source", "warning", "Source conflict"]);
    expect(kimBench.permissions.reviewSourceConflict).toBe(true);

    // Kim (accessioning lead, the task owner): her next step, with the conflict in words and the task's id and version.
    const kim = kimBench.plan!;
    expect(segText(kim.next!.title)).toBe("Review source conflict");
    expect(kim.next!.action).toEqual({
      kind: "review_source_conflict",
      taskId: task.id,
      version: task.version,
      about: "patient",
      conflict: "New order ORD-77990 gives different details for MRN 447902 (date of birth 1972-06-14 → 1901-01-01).",
      detail: expect.stringMatching(/details on file were kept/),
      orderRefs: ["ORD-77118"],
    });
    expect(kim.next!.ctrlEnter).toBe(true);
    expect(segText(kim.next!.detail)).toMatch(/Accession waits for this review; nothing is merged or changed\.$/);
    expect(kim.current).toBe("differences");
    expect(kim.steps[1]).toMatchObject({ key: "differences", state: "mine", tone: "warning" });
    expect(segText(kim.steps[1].short)).toBe("Source conflict · yours");
    // The blocker code reads as what it is, not as "order link".
    expect(segText(kim.steps[4].status)).toBe("Waits for source conflict");
    expect(segText(kim.steps[4].short)).toBe("Waits for source conflict");
    expect(waitNoun({ code: "source_conflict_open", message: "" })).toBe("source conflict");
    expect(waitNoun({ code: "order_not_linked", message: "" })).toBe("order link");
    expect(segText(kim.accession.reason)).toBe("Cannot request yet: waits for your review of the source conflict.");
    expect(kim.finding.tone).toBe("warning");
    expect(segText(kim.finding.lead)).toBe(
      "New order ORD-77990 gives different details for MRN 447902 (date of birth 1972-06-14 → 1901-01-01). The patient details on file were kept; nothing was merged.",
    );
    expect(segText(kim.finding.then)).toBe("Accession waits for your review of the source conflict.");

    // Maya (accessioner, no clarification.resolve): never her step; she waits on Kim, with the reason.
    const maya = intakeBench(db, loadActor(db, STAFF.maya), { item: r.displayId });
    expect(maya.permissions.reviewSourceConflict).toBe(false);
    expect(maya.plan!.next).toBeNull();
    expect(maya.plan!.also.some((w) => w.action?.kind === "review_source_conflict")).toBe(false);
    expect(maya.plan!.waitingOn.map((w) => [w.who, segText(w.what)])).toEqual([
      ["Kim Nguyen", "review the source conflict: new order ORD-77990 gives different details for MRN 447902 (date of birth 1972-06-14 → 1901-01-01)."],
    ]);
    expect(maya.plan!.steps[1]).toMatchObject({ key: "differences", state: "waiting", owner: "Kim Nguyen" });
    expect(segText(maya.plan!.steps[1].short)).toBe("Source conflict · Kim Nguyen");
    expect(segText(maya.plan!.accession.reason)).toBe("Cannot request yet: waits for Kim Nguyen's review of the source conflict.");

    // Tanya (supervisor) may review it but it is Kim's task: she sees who it waits on. The read-only director only reads.
    const tanya = intakeBench(db, loadActor(db, STAFF.tanya), { item: r.displayId });
    expect(tanya.permissions.reviewSourceConflict).toBe(true);
    expect(tanya.plan!.waitingOn.map((w) => w.who)).toEqual(["Kim Nguyen"]);
    const director = intakeBench(db, loadActor(db, STAFF.director), { item: r.displayId }).plan!;
    expect(director.next).toBeNull();
    expect(director.waitingOn.map((w) => w.who)).toEqual(["Kim Nguyen"]);

    // The review (the command the dialog calls) closes it: no step, nothing waits, accession ready, patient unchanged.
    must(db, STAFF.kim, "sourceConflict.review", { taskId: task.id, expectedVersion: task.version, decision: "details_on_file_confirmed", reason: "Office confirmed the birth date on file (synthetic)" });
    const after = intakeBench(db, loadActor(db, STAFF.kim), { item: r.displayId });
    expect(after.selected!.sourceConflicts).toEqual([]);
    expect(after.selected!.lane).toBe("to_review");
    expect(after.plan!.next?.action?.kind).toBe("request");
    expect(after.plan!.accession.state).toBe("ready");
    expect(segText(after.plan!.steps[1].status)).toBe("None found");
  });

  it("a newer order version that changed order-level details is reviewed the same way (about the order)", async () => {
    const { intakeBench } = await import("@/server/queries/intake");
    const { segText } = await import("@/components/intake/plan");
    const db = testDb();
    const r = barnesReady(db);
    amendOrder(db, "ORD-77118", (pl) => void ((pl.patient as { birth_date: string }).birth_date = "1972-06-15"));
    verifyAll(db, r.intakeItemId); // a fresh check against v2: only the source conflict is left
    const kim = intakeBench(db, loadActor(db, STAFF.kim), { item: r.displayId });
    expect(kim.selected!.sourceConflicts.map((c) => [c.about, c.orderRefs])).toEqual([["order", ["ORD-77118"]]]);
    expect(kim.plan!.next!.action).toMatchObject({ kind: "review_source_conflict", about: "order" });
    expect((kim.plan!.next!.action as { conflict: string }).conflict).toMatch(/^ORD-77118 v2 changed the patient .*\.$/);
    expect(segText(kim.plan!.steps[4].status)).toBe("Waits for source conflict");
    expect(segText(kim.plan!.accession.reason)).toBe("Cannot request yet: waits for your review of the source conflict.");
  });
});
