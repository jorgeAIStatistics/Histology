// Contract "hlos.source-message" 1.0: the guarantees the integration boundary gives (docs/release/integration-contract.md
// §7 to §10). Every message goes through the signed inbound handler in-process. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, must, one, all, STAFF, run } from "../helpers";
import { loadReconciliation } from "@/server/integration/reconciliation";
import { prepareDelayedAck } from "@/server/integration/in-process";
import { worldFromDb } from "@/server/integration/simulator";
import { at, counts, enableInbound, envelope, localSnapshot, orderPayload, post, restoreEnv, runIn } from "./support";
import type { DB } from "@/server/db/db";

beforeAll(enableInbound);
afterAll(restoreEnv);

const ordersNamed = (db: DB, id: string) => one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id = ?", id).n;

describe("a duplicate is safe: no second order, version or case", () => {
  it("the same message id three times creates one order and one stored message; later copies are ACKed as duplicate even with a different body", async () => {
    const db = testDb();
    const env = envelope({ messageId: "G-DUP#v1", payload: orderPayload({ orderId: "G-90001" }) });
    const first = await post(db, env);
    const before = counts(db);
    const second = await post(db, env);
    const third = await post(db, { ...env, payload: { ...env.payload, clinical_note: "changed body, same id" } });
    expect([first.body.status, second.body.status, third.body.status]).toEqual(["accepted", "duplicate", "duplicate"]);
    expect(new Set([first.body.receipt_id, second.body.receipt_id, third.body.receipt_id]).size).toBe(1);
    const after = counts(db);
    expect({ ...after, receipts: before.receipts, audit: before.audit }).toEqual(before); // only receipts and the duplicate audit rows grow
    expect(after.receipts).toBe(before.receipts + 2);
    expect(ordersNamed(db, "G-90001")).toBe(1);
    expect(one<{ receipt_count: number }>(db, "SELECT receipt_count FROM integration_event WHERE message_id = 'G-DUP#v1'").receipt_count).toBe(3);
    expect(one<{ clinical_note: string | null }>(db, "SELECT clinical_note FROM source_order WHERE source_order_id = 'G-90001'").clinical_note).toBeNull();
  });
});

describe("reordered events reconcile; the stale one never overwrites", () => {
  it("v1, v3, then v2: v3 is kept, v2 is ACKed stale and never stored, and the reconciliation view lists it as ignored", async () => {
    const db = testDb();
    const v1 = orderPayload({ orderId: "G-90002", updatedAt: at("10:10") });
    const v3 = { ...v1, version: 3, updated_at: at("10:30"), specimens: [{ ...v1.specimens[0], site: "Left forearm, dorsal" }] };
    const v2 = { ...v1, version: 2, updated_at: at("10:20"), specimens: [{ ...v1.specimens[0], site: "Left forearm, volar" }] };
    expect((await post(db, envelope({ messageId: "G-ORD#v1", payload: v1 }))).body.status).toBe("accepted");
    expect((await post(db, envelope({ messageId: "G-ORD#v3", type: "order.amend", payload: v3 }))).body.status).toBe("accepted");
    const late = await post(db, envelope({ messageId: "G-ORD#v2", type: "order.amend", payload: v2 }));
    expect(late.body).toMatchObject({ status: "stale", outcome: "stale_ignored" });
    const order = one<{ id: string; source_version: number }>(db, "SELECT id, source_version FROM source_order WHERE source_order_id = 'G-90002'");
    expect(order.source_version).toBe(3);
    expect(one<{ site_text: string }>(db, "SELECT site_text FROM source_order_part WHERE source_order_id = ?", order.id).site_text).toBe("Left forearm, dorsal");
    expect(all<{ source_version: number }>(db, "SELECT source_version FROM source_order_version WHERE source_order_id = ? ORDER BY source_version", order.id).map((v) => v.source_version)).toEqual([1, 3]);
    const row = loadReconciliation(db).rows.find((r) => r.kind === "stale_ignored" && r.messageId === "G-ORD#v2");
    expect(row).toMatchObject({ status: "ignored", localState: "Stored v3 kept", sourceEventTime: at("10:31") });
  });
});

describe("conflicting identifiers are never silently merged", () => {
  it("a new order naming an MRN on file with another name and birth date: review task, patient on file unchanged, linked by MRN only", async () => {
    const db = testDb();
    const w = worldFromDb(db);
    const onFile = one<Record<string, unknown>>(db, "SELECT * FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = ?", w.patientOnFile.mrn);
    const before = counts(db);
    const r = await post(db, envelope({ messageId: "G-CONF-1#v1", payload: orderPayload({ orderId: "G-90003", mrn: w.patientOnFile.mrn, name: "Otherly, Name", birthDate: "1901-02-03" }) }));
    expect(r.body).toMatchObject({ status: "conflict_review", review_required: true });
    expect(one(db, "SELECT * FROM patient_ref WHERE id = ?", onFile.id)).toEqual(onFile);
    expect(counts(db).patients).toBe(before.patients);
    expect(one<{ patient_ref_id: string }>(db, "SELECT patient_ref_id FROM source_order WHERE source_order_id = 'G-90003'").patient_ref_id).toBe(onFile.id);
    expect(one<{ status: string; priority: string }>(db, "SELECT status, priority FROM task WHERE kind = 'source_conflict' AND entity_type = 'patient_ref' AND entity_id = ?", onFile.id)).toEqual({ status: "open", priority: "urgent" });
  });

  it("an existing (accessioned) order id under a different MRN: the order stays with its patient, the case's patient is unchanged, a review task is open, and reconciliation shows it", async () => {
    const db = testDb();
    const w = worldFromDb(db);
    const order = one<{ id: string; patient_ref_id: string }>(db, "SELECT id, patient_ref_id FROM source_order WHERE tenant_id = 'ten_ema' AND source_order_id = ?", w.accessioned.order_id);
    const accBefore = all(db, "SELECT id, accession_number, patient_ref_id FROM accession WHERE id IN (SELECT accession_id FROM specimen_part WHERE source_order_id = ?)", order.id);
    const v2 = { ...w.accessioned, version: w.accessioned.version + 1, updated_at: at("10:40"), patient: { mrn: "990999", name: "Elsewhere, Pat", birth_date: "1960-06-06" } };
    const r = await post(db, envelope({ messageId: `G-CONF-2#v${v2.version}`, type: "order.amend", payload: v2 }));
    expect(r.body.status).toBe("conflict_review");
    expect(one<{ patient_ref_id: string }>(db, "SELECT patient_ref_id FROM source_order WHERE id = ?", order.id).patient_ref_id).toBe(order.patient_ref_id);
    expect(all(db, "SELECT id, accession_number, patient_ref_id FROM accession WHERE id IN (SELECT accession_id FROM specimen_part WHERE source_order_id = ?)", order.id)).toEqual(accBefore);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM patient_ref WHERE source_mrn = '990999'").n).toBe(0);
    const task = one<{ id: string; status: string }>(db, "SELECT id, status FROM task WHERE kind = 'source_conflict' AND entity_type = 'source_order' AND entity_id = ?", order.id);
    expect(task.status).toBe("open");
    const row = loadReconciliation(db).rows.find((x) => x.kind === "patient" && x.entity.id === order.id);
    expect(row).toMatchObject({ status: "review_open", review: { required: true, taskId: task.id } });
    expect(row!.difference).toMatch(/MRN, name, date of birth differ/);
  });
});

describe("a partial failure leaves the other messages applied and the bad one queued and retryable", () => {
  it("one invalid and one transiently failing message in a batch of four", async () => {
    const db = testDb();
    const good1 = envelope({ messageId: "G-BATCH-1#v1", payload: orderPayload({ orderId: "G-90010", mrn: "990910" }) });
    const badPayload = orderPayload({ orderId: "G-90011", mrn: "990911" }) as Record<string, any>;
    delete badPayload.patient;
    const bad = envelope({ messageId: "G-BATCH-2#v1", payload: badPayload });
    const flaky = envelope({ messageId: "G-BATCH-3#v1", payload: orderPayload({ orderId: "G-90012", mrn: "990912" }) });
    const good2 = envelope({ messageId: "G-BATCH-4#v1", payload: orderPayload({ orderId: "G-90013", mrn: "990913" }) });

    const r1 = await post(db, good1);
    const r2 = await post(db, bad);
    must(db, STAFF.tanya, "integration.injectImportFailure", { sourceId: "src_ema" });
    const r3 = await post(db, flaky);
    const r4 = await post(db, good2);
    expect([r1.status, r2.status, r3.status, r4.status]).toEqual([200, 400, 500, 200]);
    expect([ordersNamed(db, "G-90010"), ordersNamed(db, "G-90011"), ordersNamed(db, "G-90012"), ordersNamed(db, "G-90013")]).toEqual([1, 0, 0, 1]);
    const failed = all<{ message_id: string }>(db, "SELECT message_id FROM integration_event WHERE outcome = 'failed' ORDER BY message_id").map((e) => e.message_id);
    expect(failed).toEqual(["G-BATCH-2#v1", "G-BATCH-3#v1"]);
    expect(loadReconciliation(db).rows.filter((r) => r.kind === "failed_import").map((r) => r.messageId).sort()).toEqual(failed);

    // Staff retry from the failure queue: the transient one applies; invalid data never applies by retrying.
    const flakyEvent = one<{ id: string }>(db, "SELECT id FROM integration_event WHERE message_id = 'G-BATCH-3#v1'").id;
    const badEvent = one<{ id: string }>(db, "SELECT id FROM integration_event WHERE message_id = 'G-BATCH-2#v1'").id;
    expect(must<{ outcome: string }>(db, STAFF.tanya, "integration.retryEvent", { eventId: flakyEvent }).outcome).toBe("applied");
    expect(must<{ outcome: string }>(db, STAFF.tanya, "integration.retryEvent", { eventId: badEvent }).outcome).toBe("failed");
    // The source re-sends the corrected message under the same id: applied once, the same stored message.
    const fixed = await post(db, envelope({ messageId: "G-BATCH-2#v1", payload: orderPayload({ orderId: "G-90011", mrn: "990911" }) }));
    expect(fixed.body).toMatchObject({ status: "accepted", receipt_id: r2.body.receipt_id });
    expect([ordersNamed(db, "G-90011"), ordersNamed(db, "G-90012")]).toEqual([1, 1]);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM integration_event WHERE message_id LIKE 'G-BATCH-%' AND outcome = 'applied'").n).toBe(4);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM integration_event WHERE outcome = 'failed'").n).toBe(0);
  });
});

describe("downtime corrupts nothing; recovery creates no duplicate cases", () => {
  it("while the source is offline every delivery is refused with 503 and existing work is unchanged", async () => {
    const db = testDb();
    must(db, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });
    const snap = localSnapshot(db);
    const before = counts(db);
    const report = await runIn(db, "source-outage", { outage: { description: "already offline", begin: async () => {}, end: async () => {} } });
    expect(report.ok).toBe(true);
    expect(report.steps.every((s) => s.result === "unavailable" && s.attempts.length === 5 && s.attempts.every((a) => a.httpStatus === 503))).toBe(true);
    // Backoff waited at least the server's Retry-After (capped at the policy's maximum delay) between attempts.
    expect(report.steps[0].attempts.slice(0, 4).every((a) => (a.waitMs ?? 0) >= 8000)).toBe(true);
    expect(report.backlog).toEqual(["sim/outage/SIM-91001#v1", "sim/outage/SIM-91002#v1"]);
    expect(localSnapshot(db)).toEqual(snap);
    expect(counts(db)).toEqual(before);
  });

  it("after the outage the backlog is delivered exactly once; re-sending it again changes nothing", async () => {
    const db = testDb();
    const before = counts(db);
    const report = await runIn(db, "recovery");
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.result)).toEqual(["unavailable", "unavailable", "accepted", "accepted", "duplicate", "duplicate"]);
    expect(report.backlog).toEqual([]);
    expect([ordersNamed(db, "SIM-91001"), ordersNamed(db, "SIM-91002")]).toEqual([1, 1]);
    const after = counts(db);
    expect(after.orders).toBe(before.orders + 2);
    expect(after.accessions).toBe(before.accessions);
    expect(after.specimenParts).toBe(before.specimenParts);
    expect(all<{ receipt_count: number }>(db, "SELECT receipt_count FROM integration_event WHERE message_id LIKE 'sim/outage/%' ORDER BY message_id").map((e) => e.receipt_count)).toEqual([2, 2]);
  });
});

describe("imported records keep their provenance", () => {
  it("message id, source version, the source's event time (sent_at) and the local receipt time, the stored version, and source_ref in the audit trail", async () => {
    const db = testDb();
    const p = orderPayload({ orderId: "G-90020", updatedAt: at("09:58") });
    const r = await post(db, envelope({ messageId: "G-PROV#v1", payload: p, sentAt: at("10:01"), correlationId: "ema-tx-000000042" }));
    expect(r.status).toBe(200);
    const ev = one<{ id: string; message_id: string; source_version: number; source_updated_at: string; received_at: string; entity_key: string }>(
      db,
      "SELECT * FROM integration_event WHERE message_id = 'G-PROV#v1'",
    );
    expect(ev).toMatchObject({ message_id: "G-PROV#v1", source_version: 1, source_updated_at: at("10:01"), received_at: at("10:52"), entity_key: "ten_ema:G-90020" });
    const order = one<{ id: string; source_updated_at: string; import_event_id: string }>(db, "SELECT id, source_updated_at, import_event_id FROM source_order WHERE source_order_id = 'G-90020'");
    expect(order).toMatchObject({ source_updated_at: at("09:58"), import_event_id: ev.id }); // the order's own time stays the payload's
    expect(JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = ?", order.id).payload).order_id).toBe("G-90020");
    const auditRow = one<{ origin: string; source_ref: string; correlation_id: string; actor_id: string }>(db, "SELECT * FROM audit_event WHERE action = 'integration.order_imported' AND entity_id = ?", order.id);
    expect(auditRow).toEqual(expect.objectContaining({ origin: "import", source_ref: "src_ema:G-PROV#v1:v1", correlation_id: "ema-tx-000000042", actor_id: "system" }));
    expect(one<{ via: string; outcome: string }>(db, "SELECT via, outcome FROM integration_receipt WHERE event_id = ?", ev.id)).toEqual({ via: "inbound", outcome: "applied" });
  });
});

describe("an accessioned identity is never changed by a later message", () => {
  it("a site and laterality change on an issued part opens a correction review; the issued part is untouched", async () => {
    const db = testDb();
    const w = worldFromDb(db);
    const so = one<{ id: string }>(db, "SELECT id FROM source_order WHERE tenant_id = 'ten_ema' AND source_order_id = ?", w.accessioned.order_id);
    const partsBefore = all(db, "SELECT * FROM specimen_part WHERE source_order_id = ?", so.id);
    const first = w.accessioned.specimens[0];
    const v2 = {
      ...w.accessioned,
      version: w.accessioned.version + 1,
      updated_at: at("10:41"),
      specimens: [{ ...first, site: "Opposite site entirely", laterality: first.laterality === "left" ? "right" : "left" }, ...w.accessioned.specimens.slice(1)],
    };
    const r = await post(db, envelope({ messageId: "G-ID#v2", type: "order.amend", payload: v2 }));
    expect(r.body).toMatchObject({ status: "conflict_review", review_required: true });
    expect(all(db, "SELECT * FROM specimen_part WHERE source_order_id = ?", so.id)).toEqual(partsBefore);
    const xr = one<{ id: string; status: string }>(db, "SELECT id, status FROM correction_review WHERE accession_id = ?", (partsBefore[0] as { accession_id: string }).accession_id);
    expect(xr.status).toBe("open");
    const row = loadReconciliation(db).rows.find((x) => x.kind === "site_laterality" && x.entity.id === (partsBefore[0] as { id: string }).id);
    expect(row).toMatchObject({ status: "review_open", review: { correctionReviewId: xr.id } });
  });

  it("an accession notice or acknowledgment naming another number is recorded, never applied, and opens a review; a matching one is accepted", async () => {
    const db = testDb();
    const issued = prepareDelayedAck(db);
    const acc = one<Record<string, unknown>>(db, "SELECT * FROM accession WHERE accession_number = ?", issued.accessionNumber);
    const wrong = await post(db, envelope({ messageId: "G-ACC-WRONG", type: "accession.issued", payload: { request_id: issued.requestId, accession_number: "D26-09999", namespace: issued.namespace, issued_at: at("10:45") } }));
    expect(wrong.body).toMatchObject({ status: "conflict_review", review_required: true });
    const ackWrong = await post(db, envelope({ messageId: "G-ACK-WRONG", type: "accession.acknowledged", payload: { request_id: issued.requestId, accession_number: "D26-09998", namespace: issued.namespace, acknowledged_at: at("10:46") } }));
    expect(ackWrong.body.status).toBe("conflict_review");
    expect(one(db, "SELECT * FROM accession WHERE id = ?", acc.id)).toEqual(acc);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM accession WHERE accession_number IN ('D26-09999','D26-09998')").n).toBe(0);
    const tasks = all<{ status: string; priority: string; accession_id: string }>(db, "SELECT status, priority, accession_id FROM task WHERE kind = 'source_conflict' AND entity_type = 'integration_event'");
    expect(tasks).toEqual([
      { status: "open", priority: "urgent", accession_id: acc.id },
      { status: "open", priority: "urgent", accession_id: acc.id },
    ]);
    const right = await post(db, envelope({ messageId: "G-ACC-RIGHT", type: "accession.issued", payload: { request_id: issued.requestId, accession_number: issued.accessionNumber, namespace: issued.namespace, issued_at: at("10:47") } }));
    expect(right.body).toMatchObject({ status: "accepted", review_required: false });
    expect(one<{ source_ref: string }>(db, "SELECT source_ref FROM audit_event WHERE action = 'integration.accession_issue_confirmed'").source_ref).toBe("src_ema:G-ACC-RIGHT:v?");
    const row = loadReconciliation(db).rows.find((x) => x.kind === "accession");
    expect(row).toMatchObject({ status: "review_open" });
  });
});

describe("accession requested versus issued versus acknowledged (scenario 9 with an outage first)", () => {
  it("waiting for the number while the source is offline, then waiting for the acknowledgment, then in sync when it arrives late", async () => {
    const db = testDb();
    for (const step of [1, 2, 3]) must(db, STAFF.tanya, "demo.runStep", { step, autoStaffActions: true });
    must(db, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });
    must(db, STAFF.tanya, "demo.runStep", { step: 4, autoStaffActions: true });
    const req = one<{ id: string; display_id: string; status: string; related_candidate_id: string | null }>(db, "SELECT * FROM accession_request");
    expect(req.status).toBe("submitted");
    const accRow = () => loadReconciliation(db, { includeInSync: true }).rows.find((r) => r.kind === "accession" && r.entity.id === req.id)!;
    expect(accRow()).toMatchObject({ status: "waiting", difference: "Waiting for the source: no number issued and no acknowledgment yet." });
    expect(loadReconciliation(db).summary.unacknowledgedAccessionRequests).toBe(1);

    // The source acknowledges the request while it cannot issue yet (no number): still waiting for the number.
    must(db, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "connected" });
    const early = await post(db, envelope({ messageId: "G-ACK-EARLY", type: "accession.acknowledged", payload: { request_id: req.display_id, acknowledged_at: at("10:48") } }));
    expect(early.body.status).toBe("accepted");
    expect(accRow()).toMatchObject({ status: "waiting", difference: "Acknowledged by the source; no number issued yet." });

    // Retry on the Intake screen: issued by the simulated authoritative source.
    const items = all<{ intake_item_id: string }>(db, "SELECT intake_item_id FROM accession_request_item WHERE request_id = ?", req.id).map((i) => i.intake_item_id);
    const issued = must<{ accessionNumber: string; status: string }>(db, STAFF.maya, "accession.request", { intakeItemIds: items, relatedCandidateId: req.related_candidate_id });
    expect(issued.status).toBe("issued");
    expect(accRow()).toMatchObject({ status: "waiting", difference: `Issued ${issued.accessionNumber}; waiting for the source's acknowledgment.` });

    // The acknowledgment of the number arrives late: in sync, nothing changed.
    const before = localSnapshot(db);
    const late = await post(db, envelope({ messageId: "G-ACK-LATE", type: "accession.acknowledged", payload: { request_id: req.display_id, accession_number: issued.accessionNumber, namespace: "EMA-SIM DERM", acknowledged_at: at("10:50") }, sentAt: at("10:51") }));
    expect(late.body).toMatchObject({ status: "accepted", review_required: false });
    expect(localSnapshot(db)).toEqual(before);
    expect(accRow()).toMatchObject({ status: "in_sync", difference: null, sourceEventTime: at("10:51"), messageId: "G-ACK-LATE" });
    expect(loadReconciliation(db).summary.unacknowledgedAccessionRequests).toBe(0);
    expect(loadReconciliation(db).rows.some((r) => r.kind === "accession")).toBe(false);
  });

  it("a failed accession message stays in the failure queue; a staff retry re-runs the same checks (never issues)", async () => {
    const db = testDb();
    const r = await post(db, envelope({ messageId: "G-ACK-NOREQ", type: "accession.acknowledged", payload: { request_id: "AR-0777", acknowledged_at: at("10:40") } }));
    expect(r.status).toBe(400);
    const ev = one<{ id: string }>(db, "SELECT id FROM integration_event WHERE message_id = 'G-ACK-NOREQ'");
    const retried = run<{ outcome: string; detail: string }>(db, STAFF.tanya, "integration.retryEvent", { eventId: ev.id });
    expect(retried.ok && retried.result.outcome).toBe("failed");
    expect(retried.ok && retried.result.detail).toMatch(/payload\.request_id: No accession request with this id/);
  });
});
