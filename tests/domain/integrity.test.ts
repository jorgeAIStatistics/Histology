// Stage 5 workflow-integrity fixes (independent review findings A-1, A-2, A-4..A-9, A-12).
// Every case runs through the command layer against the seeded synthetic day and fails
// against the code before the fix. Patient identity and relationships stay human decisions:
// nothing here is resolved, linked, merged or routed automatically.
import { describe, it, expect } from "vitest";
import type { DB } from "@/server/db/db";
import { testDb, run, must, clockAt, tick, one, all, STAFF } from "../helpers";
import { accessionBlockers } from "@/server/domain/accession";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { openTask } from "@/server/core/tasks";
import { labLocalToIso } from "@/lib/time";

const DELIVERY = "cr_1100";
const at = (hhmm: string) => labLocalToIso("2026-10-14", hhmm);
const importCtx = (db: DB) => makeCtx(db, SYSTEM_ACTOR, "import", "integrity-test");
const ver = (db: DB, table: string, id: string) => one<{ version: number }>(db, `SELECT version FROM ${table} WHERE id = ?`, id).version;
const count = (db: DB, table: string, where = "1=1", ...params: unknown[]) => one<{ n: number }>(db, `SELECT COUNT(*) n FROM ${table} WHERE ${where}`, ...params).n;
const codesFor = (db: DB, ids: string[]) => accessionBlockers(db, ids).map((b) => b.code);
type AuditRow = { action: string; entity_id: string; reason: string | null; before_json: string | null; after_json: string | null; summary: string };
const lastAudit = (db: DB, action: string, entityId?: string): AuditRow =>
  entityId
    ? one<AuditRow>(db, "SELECT * FROM audit_event WHERE action = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1", action, entityId)
    : one<AuditRow>(db, "SELECT * FROM audit_event WHERE action = ? ORDER BY seq DESC LIMIT 1", action);
const json = (s: string | null) => (s === null ? null : (JSON.parse(s) as Record<string, any>));

// ------------------------------------------------------------------ intake fixtures

function arrive(db: DB) {
  clockAt(db, "11:00");
  must(db, STAFF.maya, "intake.receiveDelivery", { deliveryId: DELIVERY });
}
function receive(db: DB, physicalItemId: string): { intakeItemId: string } {
  return must<{ intakeItemId: string }>(db, STAFF.maya, "intake.receivePhysicalItem", { deliveryId: DELIVERY, physicalItemId });
}
function containersOf(db: DB, intakeItemId: string) {
  return all<{ id: string; version: number; order_part_id: string | null; verification_state: string }>(
    db, "SELECT id, version, order_part_id, verification_state FROM container WHERE intake_item_id = ? ORDER BY seq", intakeItemId,
  );
}
function verifyAll(db: DB, intakeItemId: string) {
  for (const c of containersOf(db, intakeItemId)) must(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id });
}
function currentDecisionId(db: DB, intakeItemId: string): string {
  return one<{ id: string }>(db, "SELECT id FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1", intakeItemId).id;
}

/** Theo Barnes (ORD-77118): the bottle shows a different date of birth than the order. Verified, routed; only identity is left. */
function barnesWithIdentityMismatch(db: DB): { itemId: string; refs: { intakeItemId: string; orderPartId: string; containerId: string } } {
  arrive(db);
  const r = receive(db, "phys_barnes");
  const [c] = containersOf(db, r.intakeItemId);
  must(db, STAFF.maya, "intake.recordObservation", { containerId: c.id, expectedVersion: c.version, observed: { birth_date: "1972-04-16" } });
  verifyAll(db, r.intakeItemId);
  must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
  expect(codesFor(db, [r.intakeItemId])).toEqual(["identity_unresolved"]);
  return { itemId: r.intakeItemId, refs: { intakeItemId: r.intakeItemId, orderPartId: c.order_part_id!, containerId: c.id } };
}

/** The whole clarification loop through the real commands: raise, send (simulated), record the answer, a lead reviews and resolves. */
function answerQuestion(db: DB, category: string, refs: Record<string, string>, resolutionCode: string): { clarificationId: string; displayId: string } {
  const c = must<{ clarificationId: string; displayId: string; duplicate: boolean }>(db, STAFF.maya, "clarification.create", {
    category, refs, subjectLabel: "Part A · ORD-77118", priority: "urgent",
    question: "The bottle and the order disagree on the patient's date of birth. Please confirm.",
    evidence: [{ field: "Date of birth", order_value: "1972-06-14", observed_value: "1972-04-16", requisition_value: null, source: "bottle label" }],
  });
  expect(c.duplicate).toBe(false);
  const id = c.clarificationId;
  must(db, STAFF.maya, "clarification.send", { clarificationId: id, expectedVersion: ver(db, "clarification", id) });
  must(db, STAFF.maya, "clarification.recordAnswer", { clarificationId: id, answerText: "Synthetic office answer for the test.", answeredBy: "Office manager", channel: "phone_recorded_by_staff" });
  must(db, STAFF.kim, "clarification.review", { clarificationId: id, expectedVersion: ver(db, "clarification", id) });
  must(db, STAFF.kim, "clarification.resolve", { clarificationId: id, expectedVersion: ver(db, "clarification", id), resolutionCode, note: `Resolved as ${resolutionCode} (test)` });
  return { clarificationId: id, displayId: c.displayId };
}

function orderPayload(db: DB, srcOrderId: string, version: number): Record<string, any> {
  const row = one<{ payload: string }>(
    db, "SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = ? AND v.source_version = ?", srcOrderId, version,
  );
  return JSON.parse(row.payload);
}

// ------------------------------------------------------------------ A-1

describe("A-1: patient identity at accession is covered only by 'office confirmed the order is correct'", () => {
  const notCovering: [code: string, message: RegExp][] = [
    ["confirmed_observed", /container is correct.*order names a different patient.*corrected order and a new check/],
    ["source_amended", /order amended in the source.*amended order version/],
    ["other", /not a confirmation of the order's patient/],
  ];
  for (const [code, message] of notCovering) {
    it(`an identity clarification resolved as '${code}' does not cover the mismatch, and the blocker says why`, () => {
      const db = testDb();
      const { itemId, refs } = barnesWithIdentityMismatch(db);
      const clr = answerQuestion(db, "identity_conflict", refs, code);
      const blockers = accessionBlockers(db, [itemId]);
      expect(blockers.map((b) => b.code)).toEqual(["identity_unresolved"]);
      expect(blockers[0].message).toContain(clr.displayId);
      expect(blockers[0].message).toMatch(message);
      const accBefore = count(db, "accession");
      const res = run(db, STAFF.maya, "accession.request", { intakeItemIds: [itemId] });
      expect(!res.ok && res.error.code).toBe("BLOCKED");
      expect(count(db, "accession")).toBe(accBefore);
    });
  }

  it("resolved as 'confirmed_order', the same mismatch is covered and the accession is issued", () => {
    const db = testDb();
    const { itemId, refs } = barnesWithIdentityMismatch(db);
    answerQuestion(db, "identity_conflict", refs, "confirmed_order");
    expect(codesFor(db, [itemId])).toEqual([]);
    expect(must<{ outcome: string }>(db, STAFF.maya, "accession.request", { intakeItemIds: [itemId] }).outcome).toBe("issued");
  });

  it("a clarification of category 'other' never covers a patient identity mismatch, whatever its resolution code", () => {
    const db = testDb();
    const { itemId, refs } = barnesWithIdentityMismatch(db);
    answerQuestion(db, "other", refs, "confirmed_order");
    const [b] = accessionBlockers(db, [itemId]);
    expect(b.code).toBe("identity_unresolved");
    expect(b.message).toMatch(/category 'other'/);
  });

  it("a later identity decision replaces an earlier one: 'container is correct' after 'order is correct' blocks again", () => {
    const db = testDb();
    const { itemId, refs } = barnesWithIdentityMismatch(db);
    answerQuestion(db, "identity_conflict", refs, "confirmed_order");
    expect(codesFor(db, [itemId])).toEqual([]);
    tick(db, 5);
    answerQuestion(db, "identity_conflict", refs, "confirmed_observed");
    expect(codesFor(db, [itemId])).toEqual(["identity_unresolved"]);
  });
});

// ------------------------------------------------------------------ A-2

describe("A-2: a source conflict on the patient or the order gates accession until a lead reviews it", () => {
  it("a new order giving different details for an MRN on file blocks accession of that patient's items; the review closes it with an audit and changes nothing else", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(codesFor(db, [r.intakeItemId])).toEqual([]);

    const v1 = orderPayload(db, "ORD-77118", 1);
    const patientRef = one<{ id: string }>(db, "SELECT patient_ref_id id FROM source_order WHERE source_order_id = 'ORD-77118'").id;
    const patientBefore = one(db, "SELECT * FROM patient_ref WHERE id = ?", patientRef);
    const patientsBefore = count(db, "patient_ref");
    const imp = importSourceMessage(importCtx(db), "src_ema", {
      messageId: "ORD-77990#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-77990", patient: { ...v1.patient, birth_date: "1901-01-01" } },
    });
    expect(imp.outcome).toBe("applied");
    const task = one<{ id: string; version: number; status: string }>(db, "SELECT id, version, status FROM task WHERE kind = 'source_conflict' AND entity_type = 'patient_ref' AND entity_id = ?", patientRef);
    expect(task.status).toBe("open");

    // The conflict blocks the accession of the item already on file for that patient.
    const blockers = accessionBlockers(db, [r.intakeItemId]);
    expect(blockers.map((b) => b.code)).toEqual(["source_conflict_open"]);
    expect(blockers[0].message).toMatch(/patient details that differ/);
    const blocked = run(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    expect(!blocked.ok && blocked.error.code).toBe("BLOCKED");

    // Lead-only, a reason, the version the lead saw, and the one recorded decision.
    const accessioner = run(db, STAFF.maya, "sourceConflict.review", { taskId: task.id, expectedVersion: task.version, decision: "details_on_file_confirmed", reason: "Checked" });
    expect(!accessioner.ok && accessioner.error.code).toBe("FORBIDDEN");
    const noReason = run(db, STAFF.kim, "sourceConflict.review", { taskId: task.id, expectedVersion: task.version, decision: "details_on_file_confirmed", reason: "  " });
    expect(!noReason.ok && noReason.error.code).toBe("VALIDATION");
    const merge = run(db, STAFF.kim, "sourceConflict.review", { taskId: task.id, expectedVersion: task.version, decision: "merge_patients", reason: "Same person" });
    expect(!merge.ok && merge.error.code).toBe("VALIDATION");
    const stale = run(db, STAFF.kim, "sourceConflict.review", { taskId: task.id, expectedVersion: task.version + 1, decision: "details_on_file_confirmed", reason: "Checked" });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    expect(one<{ status: string }>(db, "SELECT status FROM task WHERE id = ?", task.id).status).toBe("open");

    const reviewed = must<{ status: string; version: number }>(db, STAFF.kim, "sourceConflict.review", {
      taskId: task.id, expectedVersion: task.version, decision: "details_on_file_confirmed", reason: "Called the office: the birth date on file is correct; ORD-77990 had a typo (synthetic)",
    });
    expect(reviewed.status).toBe("done");
    expect(one(db, "SELECT status, completed_by FROM task WHERE id = ?", task.id)).toEqual({ status: "done", completed_by: STAFF.kim });
    // Nothing merged, relinked or overwritten.
    expect(one(db, "SELECT * FROM patient_ref WHERE id = ?", patientRef)).toEqual(patientBefore);
    expect(count(db, "patient_ref")).toBe(patientsBefore);
    expect(one<{ p: string }>(db, "SELECT patient_ref_id p FROM source_order WHERE source_order_id = 'ORD-77990'").p).toBe(patientRef);
    const a = lastAudit(db, "source_conflict.reviewed", task.id);
    expect(a.reason).toMatch(/birth date on file is correct/);
    expect(json(a.before_json)!.task.status).toBe("open");
    expect(json(a.after_json)).toMatchObject({ task: { status: "done" }, decision: "details_on_file_confirmed", patientRefUnchanged: true });

    // A closed review cannot be reviewed again.
    const again = run(db, STAFF.kim, "sourceConflict.review", { taskId: task.id, expectedVersion: ver(db, "task", task.id), decision: "details_on_file_confirmed", reason: "Again" });
    expect(!again.ok && again.error.code).toBe("INVARIANT");
    expect(codesFor(db, [r.intakeItemId])).toEqual([]);
    expect(must<{ outcome: string }>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] }).outcome).toBe("issued");
  });

  it("a newer version of the linked order that changes the patient's details blocks accession through its order-level review", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    verifyAll(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    const v1 = orderPayload(db, "ORD-77118", 1);
    importSourceMessage(importCtx(db), "src_ema", {
      messageId: "ORD-77118#v2-dob", messageType: "order.upsert", payload: { ...v1, version: 2, updated_at: at("10:59"), patient: { ...v1.patient, birth_date: "1972-06-15" } },
    });
    const task = one<{ id: string; version: number }>(db, "SELECT id, version FROM task WHERE kind = 'source_conflict' AND entity_type = 'source_order' AND entity_id = 'ord_ord_77118' AND status = 'open'");
    verifyAll(db, r.intakeItemId); // the check against v2 (the patient on file did not change)
    expect(codesFor(db, [r.intakeItemId])).toEqual(["source_conflict_open"]);
    must(db, STAFF.tanya, "sourceConflict.review", { taskId: task.id, expectedVersion: task.version, decision: "details_on_file_confirmed", reason: "Office confirmed the birth date on file (synthetic)" });
    expect(codesFor(db, [r.intakeItemId])).toEqual([]);
  });

  it("the review is only for patient and order conflicts: a new-office review task is refused", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77991#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-77991", office_id: "OFF-NEW-77", patient: { ...v1.patient, mrn: "999001" } } });
    const t = one<{ id: string; version: number }>(db, "SELECT id, version FROM task WHERE kind = 'source_conflict' AND entity_type = 'office' AND status = 'open'");
    const res = run(db, STAFF.tanya, "sourceConflict.review", { taskId: t.id, expectedVersion: t.version, decision: "details_on_file_confirmed", reason: "x" });
    expect(!res.ok && res.error.code).toBe("VALIDATION");
    expect(one<{ status: string }>(db, "SELECT status FROM task WHERE id = ?", t.id).status).toBe("open");
  });
});

// ------------------------------------------------------------------ A-4

describe("A-4: routing.override checks the decision the lead saw and routing holds", () => {
  it("an override based on a routing decision someone else already replaced is a conflict, and nothing is written", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_castillo");
    const seen = currentDecisionId(db, r.intakeItemId);
    must(db, STAFF.kim, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.okafor, reason: "Workload (synthetic)", expectedDecisionId: seen });
    const rows = count(db, "routing_decision", "intake_item_id = ?", r.intakeItemId);
    const stale = run(db, STAFF.tanya, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.ferreira, reason: "Other workload (synthetic)", expectedDecisionId: seen });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    expect(count(db, "routing_decision", "intake_item_id = ?", r.intakeItemId)).toBe(rows);
    expect(one<{ final_pathologist_id: string }>(db, "SELECT final_pathologist_id FROM routing_decision WHERE id = ?", currentDecisionId(db, r.intakeItemId)).final_pathologist_id).toBe(STAFF.okafor);
    // With the current decision, the supervisor's override goes through.
    must(db, STAFF.tanya, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.ferreira, reason: "Other workload (synthetic)", expectedDecisionId: currentDecisionId(db, r.intakeItemId) });
    // The decision id is required.
    const missing = run(db, STAFF.kim, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.marsh, reason: "x" });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
  });

  it("a routing_confirm hold blocks an override exactly as it blocks confirming the suggestion", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_castillo");
    must(db, STAFF.maya, "hold.place", { scope: { type: "intake_item", id: r.intakeItemId }, scopeLabel: "INT test item", blocks: ["routing_confirm"], reasonText: "Requisition under review (synthetic)" });
    const confirm = run(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    expect(!confirm.ok && confirm.error.code).toBe("BLOCKED");
    const override = run(db, STAFF.kim, "routing.override", { intakeItemId: r.intakeItemId, pathologistId: STAFF.okafor, reason: "Workload (synthetic)", expectedDecisionId: currentDecisionId(db, r.intakeItemId) });
    expect(!override.ok && override.error.code).toBe("BLOCKED");
    expect(one<{ status: string }>(db, "SELECT status FROM routing_decision WHERE id = ?", currentDecisionId(db, r.intakeItemId)).status).toBe("suggested");
  });
});

// ------------------------------------------------------------------ materials fixtures

const setPrinter = (db: DB, id: string, status: "online" | "offline") => db.prepare("UPDATE printer SET status = ? WHERE id = ?").run(status, id);
function marshBlock(db: DB): string {
  return one<{ id: string }>(
    db,
    `SELECT b.id FROM block b JOIN accession a ON a.id = b.accession_id
      WHERE a.assigned_pathologist_id = 'stf_marsh' AND b.physical_state = 'sectioned' AND b.custody_state = 'in_workflow' ORDER BY b.id LIMIT 1`,
  ).id;
}
function freshSlide(db: DB, blockId = marshBlock(db)): string {
  return must<{ slideId: string }>(db, STAFF.marsh, "slide.orderAdditional", { blockId, stain: "PAS", reason: "Rule out fungal elements (synthetic)" }).slideId;
}

// ------------------------------------------------------------------ A-5

describe("A-5: an additional slide entered by staff is attributed to them, with who asked and how", () => {
  it("a histotech must say who asked; the work order records the histotech, never a pathologist's own order", () => {
    const db = testDb();
    const blockId = marshBlock(db);
    const before = count(db, "work_order");
    const noRef = run(db, STAFF.priya, "slide.orderAdditional", { blockId, stain: "H&E", level: "deeper L2", reason: "Deeper level" });
    expect(!noRef.ok && noRef.error.code).toBe("VALIDATION");
    expect(count(db, "work_order")).toBe(before);

    const r = must<{ workOrderId: string; slideId: string; authorizationSource: string }>(db, STAFF.priya, "slide.orderAdditional", {
      blockId, stain: "H&E", level: "deeper L2", reason: "Deeper level", requestReference: "Dr. Marsh, by phone at 10:40",
    });
    const wo = one<{ authorization_source: string; requested_by_staff_id: string; requested_by_label: string; source_reference: string }>(
      db, "SELECT authorization_source, requested_by_staff_id, requested_by_label, source_reference FROM work_order WHERE id = ?", r.workOrderId,
    );
    expect(wo.authorization_source).toBe("staff_entered_request");
    expect(wo.requested_by_staff_id).toBe(STAFF.priya);
    expect(wo.requested_by_label).toMatch(/Priya Shah.*Dr\. Marsh, by phone at 10:40/);
    expect(wo.source_reference).toMatch(/Dr\. Marsh, by phone at 10:40/);
    expect(json(lastAudit(db, "work_order.created", r.workOrderId).after_json)).toMatchObject({
      authorizationSource: "staff_entered_request", requestedByStaffId: STAFF.priya, requestReference: "Dr. Marsh, by phone at 10:40",
    });
    // Its label print is recorded as additional work even if the screen does not say so.
    const job = must<{ printJobId: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: r.slideId, kind: "slide_label" });
    expect(one<{ purpose: string }>(db, "SELECT purpose FROM print_job WHERE id = ?", job.printJobId).purpose).toBe("additional_work");
  });

  it("the dermatopathologist's own order stays a pathologist request in their name", () => {
    const db = testDb();
    const r = must<{ workOrderId: string }>(db, STAFF.marsh, "slide.orderAdditional", { blockId: marshBlock(db), stain: "PAS", reason: "Rule out fungal elements (synthetic)" });
    expect(one(db, "SELECT authorization_source, requested_by_staff_id FROM work_order WHERE id = ?", r.workOrderId)).toEqual({
      authorization_source: "pathologist_request", requested_by_staff_id: STAFF.marsh,
    });
  });
});

// ------------------------------------------------------------------ A-6

describe("A-6: print.release re-checks the target and the print hold before sending a queued job", () => {
  it("a queued job is not sent once its slide is held for printing; it stays queued, then prints after the hold is released", () => {
    const db = testDb();
    const slideId = freshSlide(db);
    setPrinter(db, "prn_s1", "offline");
    const job = must<{ printJobId: string; state: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    expect(job.state).toBe("queued");
    const hold = must<{ holdId: string }>(db, STAFF.priya, "hold.place", { scope: { type: "slide", id: slideId }, scopeLabel: "PAS slide", blocks: ["print"], reasonText: "Label wording under review (synthetic)" });
    setPrinter(db, "prn_s1", "online");
    const refused = run(db, STAFF.priya, "print.release", { printJobId: job.printJobId });
    expect(!refused.ok && refused.error.code).toBe("BLOCKED");
    expect(one(db, "SELECT state, submitted_at FROM print_job WHERE id = ?", job.printJobId)).toEqual({ state: "queued", submitted_at: null });
    expect(count(db, "label", "print_job_id = ?", job.printJobId)).toBe(0);

    must(db, STAFF.kim, "hold.release", { holdId: hold.holdId, expectedVersion: ver(db, "hold", hold.holdId), reason: "Wording confirmed (synthetic)" });
    const sent = must<{ state: string }>(db, STAFF.priya, "print.release", { printJobId: job.printJobId });
    expect(sent.state).toBe("acknowledged");
    expect(json(lastAudit(db, "print.released", job.printJobId).after_json)).toMatchObject({ state: "acknowledged", holdCheck: "print" });
  });

  it("a queued job for a slide voided meanwhile is not sent", () => {
    const db = testDb();
    const slideId = freshSlide(db);
    setPrinter(db, "prn_s1", "offline");
    const job = must<{ printJobId: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    db.prepare("UPDATE slide SET status = 'void' WHERE id = ?").run(slideId);
    setPrinter(db, "prn_s1", "online");
    const refused = run(db, STAFF.priya, "print.release", { printJobId: job.printJobId });
    expect(!refused.ok && refused.error.code).toBe("BLOCKED");
    expect(one<{ state: string }>(db, "SELECT state FROM print_job WHERE id = ?", job.printJobId).state).toBe("queued");
  });

  it("releasing a printer's queue sends the other jobs and names the held one, which stays queued", () => {
    const db = testDb();
    const blockId = marshBlock(db);
    const held = freshSlide(db, blockId);
    const free = freshSlide(db, blockId);
    setPrinter(db, "prn_s1", "offline");
    const j1 = must<{ printJobId: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: held, kind: "slide_label" });
    const j2 = must<{ printJobId: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: free, kind: "slide_label" });
    must(db, STAFF.priya, "hold.place", { scope: { type: "slide", id: held }, scopeLabel: "PAS slide", blocks: ["print"], reasonText: "Label wording under review (synthetic)" });
    setPrinter(db, "prn_s1", "online");
    const res = must<{ released: { printJobId: string }[]; notReleased: { printJobId: string; reason: string }[] }>(db, STAFF.priya, "print.release", { printerId: "prn_s1" });
    expect(res.notReleased.map((n) => n.printJobId)).toEqual([j1.printJobId]);
    expect(res.notReleased[0].reason).toMatch(/blocked by H-\d+/);
    expect(res.released.map((x) => x.printJobId)).toContain(j2.printJobId);
    expect(one<{ state: string }>(db, "SELECT state FROM print_job WHERE id = ?", j1.printJobId).state).toBe("queued");
    expect(one<{ state: string }>(db, "SELECT state FROM print_job WHERE id = ?", j2.printJobId).state).toBe("acknowledged");
  });
});

// ------------------------------------------------------------------ A-7

describe("A-7: decision commands need the version the person saw", () => {
  it("correction.close", () => {
    const db = testDb();
    const accessionId = one<{ id: string }>(db, "SELECT id FROM accession WHERE case_status = 'open' AND is_prior_day = 0 ORDER BY accession_number LIMIT 1").id;
    const xr = must<{ correctionId: string }>(db, STAFF.maya, "correction.open", { accessionId, kind: "site_discrepancy", description: "Site on the slide label differs (synthetic)" });
    const missing = run(db, STAFF.kim, "correction.close", { correctionId: xr.correctionId, outcome: "closed_no_change", note: "Checked" });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    const v = ver(db, "correction_review", xr.correctionId);
    const stale = run(db, STAFF.kim, "correction.close", { correctionId: xr.correctionId, outcome: "closed_no_change", note: "Checked", expectedVersion: v + 1 });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    expect(one<{ status: string }>(db, "SELECT status FROM correction_review WHERE id = ?", xr.correctionId).status).toBe("open");
    must(db, STAFF.kim, "correction.close", { correctionId: xr.correctionId, outcome: "closed_no_change", note: "Checked", expectedVersion: v });
  });

  it("clarification.cancel", () => {
    const db = testDb();
    const c = must<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", {
      category: "laterality", refs: { sourceOrderId: "ord_ord_77121", orderPartId: "ord_ord_77121_b" }, subjectLabel: "Part B · ORD-77121", question: "Which side?",
      evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", requisition_value: null, source: "bottle label (staff entry)" }], priority: "high",
    });
    const missing = run(db, STAFF.kim, "clarification.cancel", { clarificationId: c.clarificationId, reason: "Raised on the wrong part" });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    const v = ver(db, "clarification", c.clarificationId);
    const stale = run(db, STAFF.kim, "clarification.cancel", { clarificationId: c.clarificationId, reason: "Raised on the wrong part", expectedVersion: v + 1 });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    expect(one<{ state: string }>(db, "SELECT state FROM clarification WHERE id = ?", c.clarificationId).state).not.toBe("canceled");
    must(db, STAFF.kim, "clarification.cancel", { clarificationId: c.clarificationId, reason: "Raised on the wrong part", expectedVersion: v });
  });

  it("gross.loadTranscript (null = the part had no gross record when the screen opened)", () => {
    const db = testDb();
    const partId = one<{ id: string }>(
      db,
      `SELECT sp.id FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id
        WHERE a.is_prior_day = 0 AND a.case_status = 'open' AND sp.status = 'active' AND sp.procedure = 'shave'
          AND NOT EXISTS (SELECT 1 FROM gross_record g WHERE g.specimen_part_id = sp.id)
          AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.status = 'active' AND h.accession_id = a.id) ORDER BY a.accession_number LIMIT 1`,
    ).id;
    const missing = run(db, STAFF.dana, "gross.loadTranscript", { specimenPartId: partId, transcriptKey: "generic-shave" });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    expect(count(db, "gross_record", "specimen_part_id = ?", partId)).toBe(0);
    // Someone else starts the record while this screen still shows "no record": a conflict, not a silent attach.
    must(db, STAFF.sam, "gross.startDraft", { specimenPartId: partId });
    const startedMeanwhile = run(db, STAFF.dana, "gross.loadTranscript", { specimenPartId: partId, transcriptKey: "generic-shave", expectedVersion: null });
    expect(!startedMeanwhile.ok && startedMeanwhile.error.code).toBe("CONFLICT");
    expect(count(db, "gross_transcript", "specimen_part_id = ?", partId)).toBe(0);
    const recV = one<{ version: number }>(db, "SELECT version FROM gross_record WHERE specimen_part_id = ?", partId).version;
    const stale = run(db, STAFF.dana, "gross.loadTranscript", { specimenPartId: partId, transcriptKey: "generic-shave", expectedVersion: recV + 1 });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    must(db, STAFF.dana, "gross.loadTranscript", { specimenPartId: partId, transcriptKey: "generic-shave", expectedVersion: recV });
    expect(count(db, "gross_transcript", "specimen_part_id = ?", partId)).toBe(1);
  });

  it("office.updateContact", () => {
    const db = testDb();
    const missing = run(db, STAFF.tanya, "office.updateContact", { contactId: "oc_cld_1", patch: { out_until: null } });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    const stale = run(db, STAFF.tanya, "office.updateContact", { contactId: "oc_cld_1", expectedVersion: 7, patch: { is_escalation: true } });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    expect(one<{ is_escalation: number }>(db, "SELECT is_escalation FROM office_contact WHERE id = 'oc_cld_1'").is_escalation).toBe(0);
  });

  it("task.release", () => {
    const db = testDb();
    const part = one<{ id: string; accession_id: string }>(db, "SELECT id, accession_id FROM specimen_part WHERE status = 'active' ORDER BY id LIMIT 1");
    const taskId = openTask(importCtx(db), { kind: "processing_eligible", entityType: "specimen_part", entityId: part.id, title: "Integrity test task", ownerRole: "histotech", accessionId: part.accession_id });
    const claimed = must<{ version: number }>(db, STAFF.priya, "task.claim", { taskId, expectedVersion: ver(db, "task", taskId) });
    const missing = run(db, STAFF.priya, "task.release", { taskId });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    const stale = run(db, STAFF.priya, "task.release", { taskId, expectedVersion: claimed.version - 1 });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    expect(one(db, "SELECT owner_id, status FROM task WHERE id = ?", taskId)).toEqual({ owner_id: STAFF.priya, status: "in_progress" });
    must(db, STAFF.priya, "task.release", { taskId, expectedVersion: claimed.version });
    expect(one(db, "SELECT owner_id, status FROM task WHERE id = ?", taskId)).toEqual({ owner_id: null, status: "open" });
  });
});

// ------------------------------------------------------------------ trays

const trayVersion = (db: DB) => ver(db, "tray", "tray_m03");
const ident = (db: DB, slideId: string) => one<{ identifier: string }>(db, "SELECT identifier FROM slide WHERE id = ?", slideId).identifier;
const trayScenario = (db: DB) =>
  JSON.parse(one<{ value: string }>(db, "SELECT value FROM app_setting WHERE key = 'scenario_tray_present'").value) as { expectedUnscanned: string; missing: string; unexpected: string };

describe("A-8: tray.releaseWithExceptions needs the tray version the supervisor reviewed", () => {
  it("a release based on an older view of the tray is a conflict; the current version releases it", () => {
    const db = testDb();
    const sc = trayScenario(db);
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.expectedUnscanned) });
    must(db, STAFF.priya, "tray.setDisposition", { trayId: "tray_m03", slideId: sc.missing, disposition: "follows_separately", note: "Still at the coverslipper" });
    const missing = run(db, STAFF.tanya, "tray.releaseWithExceptions", { trayId: "tray_m03", note: "Dr. Marsh agreed to start" });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    const before = one<{ status: string; version: number }>(db, "SELECT status, version FROM tray WHERE id = 'tray_m03'");
    const stale = run(db, STAFF.tanya, "tray.releaseWithExceptions", { trayId: "tray_m03", note: "Dr. Marsh agreed to start", expectedVersion: before.version - 1 });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    expect(one(db, "SELECT status, version FROM tray WHERE id = 'tray_m03'")).toEqual(before);
    const rel = must<{ status: string }>(db, STAFF.tanya, "tray.releaseWithExceptions", { trayId: "tray_m03", note: "Dr. Marsh agreed to start", expectedVersion: trayVersion(db) });
    expect(rel.status).toBe("released_with_exceptions");
    const a = lastAudit(db, "tray.released_with_exceptions", "tray_m03");
    expect(json(a.before_json)).toMatchObject({ status: before.status, version: before.version });
    expect(json(a.after_json)!.outstanding.map((o: { slideId: string }) => o.slideId)).toEqual([sc.missing]);
  });
});

// ------------------------------------------------------------------ A-9

describe("A-9: bench progress moves one stage at a time", () => {
  it("a block cannot jump past processing stages; each stage is recorded in order", () => {
    const db = testDb();
    const blockId = one<{ id: string }>(
      db,
      `SELECT b.id FROM block b WHERE b.status = 'active' AND b.physical_state = 'cassette_loaded' AND b.custody_state = 'in_workflow'
          AND EXISTS (SELECT 1 FROM gross_record g WHERE g.specimen_part_id = b.part_id AND g.state = 'approved_for_downstream')
          AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.status = 'active' AND h.accession_id = b.accession_id) ORDER BY b.id LIMIT 1`,
    ).id;
    const skip = run(db, STAFF.priya, "block.advance", { blockIds: [blockId], toState: "processed" });
    expect(!skip.ok && skip.error.code).toBe("VALIDATION");
    if (!skip.ok) expect(skip.error.message).toMatch(/next stage is Processing/);
    expect(one<{ s: string }>(db, "SELECT physical_state s FROM block WHERE id = ?", blockId).s).toBe("cassette_loaded");
    for (const s of ["processing", "processed", "embedded"]) must(db, STAFF.priya, "block.advance", { blockIds: [blockId], toState: s });
    expect(all<{ after_json: string }>(db, "SELECT after_json FROM audit_event WHERE action = 'block.advanced' AND entity_id = ? ORDER BY seq", blockId).map((r) => JSON.parse(r.after_json).physical_state)).toEqual([
      "processing", "processed", "embedded",
    ]);
  });

  it("a slide cannot skip sectioning or coverslipping", () => {
    const db = testDb();
    const slideId = one<{ id: string }>(
      db,
      `SELECT s.id FROM slide s JOIN block b ON b.id = s.block_id WHERE s.status = 'active' AND s.physical_state = 'planned' AND b.physical_state = 'embedded'
          AND (s.work_order_id IS NULL OR EXISTS (SELECT 1 FROM work_order w WHERE w.id = s.work_order_id AND w.status IN ('requested','in_progress','completed')))
          AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.status = 'active' AND h.accession_id = s.accession_id) ORDER BY s.id LIMIT 1`,
    ).id;
    const skip = run(db, STAFF.priya, "slide.advance", { slideIds: [slideId], toState: "stained" });
    expect(!skip.ok && skip.error.code).toBe("VALIDATION");
    expect(one<{ s: string }>(db, "SELECT physical_state s FROM slide WHERE id = ?", slideId).s).toBe("planned");
    must(db, STAFF.priya, "slide.advance", { slideIds: [slideId], toState: "sectioned" });
    must(db, STAFF.priya, "slide.advance", { slideIds: [slideId], toState: "stained" });
    const skip2 = run(db, STAFF.priya, "slide.advance", { slideIds: [slideId], toState: "qc_reviewed" });
    expect(!skip2.ok && skip2.error.code).toBe("VALIDATION");
    must(db, STAFF.priya, "slide.advance", { slideIds: [slideId], toState: "coverslipped" });
    must(db, STAFF.priya, "slide.advance", { slideIds: [slideId], toState: "qc_reviewed" });
  });
});

// ------------------------------------------------------------------ A-12

describe("A-12: audit rows carry before/after and structured references", () => {
  it("accession request and routing confirmation", () => {
    const db = testDb();
    arrive(db);
    const r = receive(db, "phys_barnes");
    verifyAll(db, r.intakeItemId);
    const decisionId = currentDecisionId(db, r.intakeItemId);
    must(db, STAFF.maya, "routing.confirm", { intakeItemId: r.intakeItemId });
    const rc = lastAudit(db, "routing.confirmed", decisionId);
    expect(json(rc.before_json)).toMatchObject({ status: "suggested", pathologist: null });
    expect(json(rc.after_json)).toMatchObject({ status: "confirmed", pathologist: STAFF.marsh, decisionId });
    expect(json(rc.after_json)!.ruleSetId).toBeTruthy();

    const statusBefore = one<{ status: string }>(db, "SELECT status FROM intake_item WHERE id = ?", r.intakeItemId).status;
    const acc = must<{ requestId: string; requestDisplayId: string }>(db, STAFF.maya, "accession.request", { intakeItemIds: [r.intakeItemId] });
    const ar = lastAudit(db, "accession.requested", acc.requestId);
    expect(json(ar.before_json)).toMatchObject({ intakeItem: { id: r.intakeItemId, status: statusBefore }, request: null });
    expect(json(ar.after_json)).toMatchObject({
      intakeItem: { id: r.intakeItemId, status: "accession_requested" },
      request: { id: acc.requestId, displayId: acc.requestDisplayId, status: "submitted" },
      intakeItems: [{ id: r.intakeItemId }],
      sourceOrders: ["ten_ema:ORD-77118"],
      routingDecisionIds: [decisionId],
    });
  });

  it("gross review, approval, source entry and amendment", () => {
    const db = testDb();
    const partId = one<{ id: string }>(
      db,
      `SELECT sp.id FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id
        WHERE a.is_prior_day = 0 AND a.case_status = 'open' AND sp.status = 'active' AND sp.designation = 'A' AND sp.procedure = 'shave'
          AND NOT EXISTS (SELECT 1 FROM gross_record g WHERE g.specimen_part_id = sp.id)
          AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.status = 'active' AND h.accession_id = a.id) ORDER BY a.accession_number LIMIT 1`,
    ).id;
    const started = must<{ record: { version: number } }>(db, STAFF.dana, "gross.startDraft", { specimenPartId: partId });
    must(db, STAFF.dana, "gross.loadTranscript", { specimenPartId: partId, transcriptKey: "quinlan-A", expectedVersion: started.record.version });
    const rec = one<{ id: string; version: number; fields: string }>(db, "SELECT id, version, fields FROM gross_record WHERE specimen_part_id = ?", partId);
    let v = rec.version;
    const fields = JSON.parse(rec.fields) as Record<string, { status: string }>;
    for (const k of ["specimen_type", "received_in", "container_label_matches", "piece_count", "dimensions", "appearance", "ink_orientation", "sectioning", "cassettes"]) {
      if (k === "container_label_matches") v = must<{ version: number }>(db, STAFF.dana, "gross.confirmField", { grossRecordId: rec.id, expectedVersion: v, field: k, value: true }).version;
      else if (fields[k]?.status === "proposed") v = must<{ version: number }>(db, STAFF.dana, "gross.confirmField", { grossRecordId: rec.id, expectedVersion: v, field: k }).version;
    }
    v = must<{ version: number }>(db, STAFF.dana, "gross.updateFields", { grossRecordId: rec.id, expectedVersion: v, patch: {}, narrative: "Synthetic narrative from confirmed values." }).version;
    v = must<{ version: number }>(db, STAFF.dana, "gross.markReviewed", { grossRecordId: rec.id, expectedVersion: v }).version;
    expect(json(lastAudit(db, "gross.reviewed", rec.id).after_json)).toMatchObject({ state: "operator_reviewed", version: v, specimenPartId: partId });
    expect(json(lastAudit(db, "gross.reviewed", rec.id).before_json)).toMatchObject({ state: "draft" });

    const approved = must<{ record: { version: number }; blocks: { id: string }[] }>(db, STAFF.dana, "gross.approve", { grossRecordId: rec.id, expectedVersion: v });
    const ap = lastAudit(db, "gross.approved", rec.id);
    expect(json(ap.before_json)).toMatchObject({ state: "operator_reviewed" });
    expect(json(ap.after_json)).toMatchObject({ state: "approved_for_downstream", sourceUpdateState: "pending_entry", blockIds: approved.blocks.map((b) => b.id) });

    must(db, STAFF.sam, "gross.recordSourceEntry", { grossRecordId: rec.id, expectedVersion: approved.record.version });
    const se = lastAudit(db, "gross.source_entry_attested", rec.id);
    expect(json(se.before_json)).toMatchObject({ sourceUpdateState: "pending_entry" });
    expect(json(se.after_json)).toMatchObject({ sourceUpdateState: "entered_attested", attestedBy: STAFF.sam });

    const am = must<{ record: { id: string } }>(db, STAFF.dana, "gross.amend", { grossRecordId: rec.id, reason: "Piece count corrected (synthetic)" });
    const amA = lastAudit(db, "gross.amended", am.record.id);
    expect(json(amA.before_json)).toMatchObject({ recordId: rec.id, state: "approved_for_downstream" });
    expect(json(amA.after_json)).toMatchObject({ supersededRecordId: rec.id, recordId: am.record.id, state: "draft" });
  });

  it("tray completion and delivery, with one delivered row per slide", () => {
    const db = testDb();
    const sc = trayScenario(db);
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.expectedUnscanned) });
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.missing) });
    const vBefore = trayVersion(db);
    must(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: vBefore });
    const comp = lastAudit(db, "tray.completed", "tray_m03");
    expect(json(comp.before_json)).toMatchObject({ version: vBefore });
    expect(json(comp.after_json)).toMatchObject({ status: "verified_complete" });
    expect(json(comp.after_json)!.scannedSlideIds).toHaveLength(10);

    const expected = all<{ slide_id: string }>(db, "SELECT slide_id FROM tray_expected_slide WHERE tray_id = 'tray_m03'").map((r) => r.slide_id).sort();
    const notYetDelivered = all<{ id: string }>(db, `SELECT id FROM slide WHERE id IN (${expected.map(() => "?").join(",")}) AND physical_state <> 'delivered'`, ...expected).map((r) => r.id).sort();
    must(db, STAFF.priya, "tray.deliver", { trayId: "tray_m03" });
    const del = lastAudit(db, "tray.delivered", "tray_m03");
    expect(json(del.before_json)).toMatchObject({ status: "verified_complete" });
    expect([...json(del.after_json)!.deliveredSlideIds].sort()).toEqual(expected);
    const perSlide = all<{ entity_id: string; before_json: string; after_json: string }>(db, "SELECT entity_id, before_json, after_json FROM audit_event WHERE action = 'slide.delivered' ORDER BY entity_id");
    expect(perSlide.map((r) => r.entity_id)).toEqual(notYetDelivered);
    for (const r of perSlide) expect(JSON.parse(r.after_json)).toMatchObject({ physical_state: "delivered", trayId: "tray_m03" });
  });

  it("a routing rule-set approval records the rules and what it replaced", () => {
    const db = testDb();
    const draft = must<{ ruleSetId: string }>(db, STAFF.tanya, "routing.draftRuleSet", { reason: "Seagrape reviewed (synthetic)", changes: [{ officeId: "off_sss", pathologistId: STAFF.ferreira }] });
    const res = must<{ retired: number[] }>(db, STAFF.md, "routing.approveRuleSet", { ruleSetId: draft.ruleSetId });
    const a = lastAudit(db, "routing.rule_set_approved", draft.ruleSetId);
    expect(json(a.before_json)).toMatchObject({ status: "draft" });
    expect(json(a.after_json)).toMatchObject({ status: "approved", approvedBy: STAFF.md, retiredVersions: res.retired });
    expect(json(a.after_json)!.rules).toContainEqual(expect.objectContaining({ officeId: "off_sss", pathologistId: STAFF.ferreira }));
  });

  it("import audits name the integration message and event", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    const created = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77992#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-77992", patient: { ...v1.patient, mrn: "999002" } } });
    expect(json(lastAudit(db, "integration.order_imported", created.orderId!).after_json)).toMatchObject({ messageId: "ORD-77992#v1", eventId: created.eventId, sourceOrderId: "ORD-77992" });
    const amended = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77118#v2-note", messageType: "order.upsert", payload: { ...v1, version: 2, updated_at: at("10:59"), amendment_note: "Note corrected (synthetic)" } });
    expect(json(lastAudit(db, "integration.order_amended", "ord_ord_77118").after_json)).toMatchObject({ messageId: "ORD-77118#v2-note", eventId: amended.eventId });
    const dup = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77118#v2-note", messageType: "order.upsert", payload: v1 });
    expect(json(lastAudit(db, "integration.duplicate_ignored", dup.eventId).after_json)).toMatchObject({ messageId: "ORD-77118#v2-note", eventId: amended.eventId });
  });

  it("clarification review and resolution reference the office answer message", () => {
    const db = testDb();
    const { refs } = barnesWithIdentityMismatch(db);
    const clr = answerQuestion(db, "identity_conflict", refs, "confirmed_order");
    const answerId = one<{ id: string }>(db, "SELECT id FROM clarification_message WHERE clarification_id = ? AND kind = 'answer'", clr.clarificationId).id;
    const rv = lastAudit(db, "clarification.reviewed", clr.clarificationId);
    expect(json(rv.before_json)).toMatchObject({ state: "answered" });
    expect(json(rv.after_json)).toMatchObject({ state: "reviewed", answerMessageId: answerId });
    const rs = lastAudit(db, "clarification.resolved", clr.clarificationId);
    expect(json(rs.before_json)).toMatchObject({ state: "reviewed" });
    expect(json(rs.after_json)).toMatchObject({ state: "resolved", resolutionCode: "confirmed_order", answerMessageId: answerId });
  });

  it("closing a recorded intake discrepancy writes its own audit row", () => {
    const db = testDb();
    arrive(db);
    // A single-part order whose bag holds a second bottle labeled part B: unmatched until a person links it.
    const t = labLocalToIso("2026-10-14", "09:30");
    db.prepare("INSERT INTO patient_ref (id, tenant_id, source_mrn, family_name, given_name, birth_date, imported_at) VALUES ('pt_itest', 'ten_ema', '900199', 'Integrity', 'Ines', '1958-07-04', ?)").run(t);
    db.prepare(
      `INSERT INTO source_order (id, tenant_id, source_order_id, patient_ref_id, encounter_id, office_id, ordering_clinician_id, source_status, source_version, source_updated_at, imported_at)
       VALUES ('ord_itest', 'ten_ema', 'ORD-77399', 'pt_itest', NULL, 'off_hpd', 'cln_reed', 'active', 1, ?, ?)`,
    ).run(t, t);
    db.prepare(
      "INSERT INTO source_order_part (id, source_order_id, designation, site_text, laterality, procedure, collected_at, expected_containers) VALUES ('ord_itest_a', 'ord_itest', 'A', 'Left cheek', 'left', 'shave', ?, 1)",
    ).run(t);
    const bottle = (d: string) => ({ patient_name: "Integrity, Ines", birth_date: "1958-07-04", part_designation: d, site_text: "L cheek", procedure: "shave" });
    db.prepare(
      `INSERT INTO sim_physical_item (id, delivery_id, seq, observed_office_text, requisition_order_ref, requisition_fields, containers, received_intake_item_id)
       VALUES ('phys_itest', ?, 199, 'Harbor Point Dermatology', 'ORD-77399', '{}', ?, NULL)`,
    ).run(DELIVERY, JSON.stringify([bottle("A"), bottle("B")]));
    const r = receive(db, "phys_itest");
    const flag = one<{ id: string }>(db, "SELECT id FROM intake_discrepancy WHERE intake_item_id = ? AND kind = 'unmatched_container' AND status = 'open'", r.intakeItemId);
    const c2 = containersOf(db, r.intakeItemId)[1];
    must(db, STAFF.maya, "intake.verifyContainer", { containerId: c2.id, expectedVersion: c2.version, orderPartId: "ord_itest_a" });
    const a = lastAudit(db, "intake.discrepancy_closed", flag.id);
    expect(a.summary).toMatch(/unmatched-container flag closed \(staff linked\)/);
    expect(json(a.before_json)).toMatchObject({ status: "open" });
    expect(json(a.after_json)).toMatchObject({ status: "resolved", resolutionKind: "staff_linked", kind: "unmatched_container", containerId: c2.id });
  });
});
