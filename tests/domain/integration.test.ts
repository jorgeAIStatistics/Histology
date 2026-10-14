import { describe, it, expect } from "vitest";
import { testDb, run, must, clockAt, one, all, STAFF } from "../helpers";
import { listCommands } from "@/server/commands";
import { pumpSources } from "@/server/sim/pump";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { loadRoutingSettings, sourceFreshness } from "@/server/queries/settings";
import { labLocalToIso } from "@/lib/time";
import type { DB } from "@/server/db/db";

const at = (hhmm: string) => labLocalToIso("2026-10-14", hhmm);
const importCtx = (db: DB) => makeCtx(db, SYSTEM_ACTOR, "import", "test");

function counts(db: DB) {
  const n = (sql: string) => one<{ n: number }>(db, sql).n;
  return {
    orders: n("SELECT COUNT(*) n FROM source_order"),
    versions: n("SELECT COUNT(*) n FROM source_order_version"),
    parts: n("SELECT COUNT(*) n FROM source_order_part"),
    events: n("SELECT COUNT(*) n FROM integration_event"),
    tasks: n("SELECT COUNT(*) n FROM task"),
    workOrders: n("SELECT COUNT(*) n FROM work_order"),
    worklist: n("SELECT COUNT(*) n FROM worklist_change"),
    corrections: n("SELECT COUNT(*) n FROM correction_review"),
  };
}

function orderPayload(db: DB, srcOrderId: string, version: number): Record<string, any> {
  const row = one<{ payload: string }>(
    db,
    "SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = ? AND v.source_version = ?",
    srcOrderId,
    version,
  );
  return JSON.parse(row.payload);
}

const PAS_WO = "wo_wo_2142"; // seed: PAS on ORD-75061 part A, slide already stained + label verified
const PAS_SLIDE = "acc_d26_04749_pa_b1_s2";

/**
 * An accessioned EMA part whose order requests PAS, with a PAS work order whose only slide ('sl_test_pas') is
 * planned and unlabeled — the state S5 leaves before any label is printed.
 */
function setupUnpreparedPas(db: DB) {
  const part = one<{ id: string; accession_id: string; source_order_id: string; source_order_part_id: string; order: string; designation: string; block_id: string; acc: string }>(
    db,
    `SELECT sp.id, sp.accession_id, sp.source_order_id, sp.source_order_part_id, so.source_order_id "order", sp.designation, b.id block_id, a.accession_number acc
       FROM specimen_part sp JOIN source_order so ON so.id = sp.source_order_id JOIN accession a ON a.id = sp.accession_id JOIN block b ON b.part_id = sp.id
      WHERE so.tenant_id = 'ten_ema' AND a.is_prior_day = 0 AND so.source_version = 1
        AND NOT EXISTS (SELECT 1 FROM work_order w WHERE w.source_order_id = so.id)
        AND (SELECT COUNT(*) FROM source_order_part x WHERE x.source_order_id = so.id) = 1
      ORDER BY a.accession_number LIMIT 1`,
  );
  db.prepare("UPDATE source_order_part SET requested_stains = '[{\"stain\":\"PAS\",\"source\":\"order\"}]' WHERE id = ?").run(part.source_order_part_id);
  db.prepare(
    `INSERT INTO work_order (id, display_id, accession_id, kind, stain, authorization_source, source_reference, requested_by_label, source_order_id, source_version, target_part_id, quantity, status, requested_at)
     VALUES ('wo_test_pas', 'WO-9001', ?, 'stain', 'PAS', 'source_order', ?, 'Ordering clinician (on order)', ?, 1, ?, 1, 'requested', ?)`,
  ).run(part.accession_id, `${part.order} v1 · part ${part.designation}`, part.source_order_id, part.id, at("10:00"));
  db.prepare(
    `INSERT INTO slide (id, accession_id, block_id, slide_seq, stain, work_order_id, identifier, physical_state, label_state, status)
     VALUES ('sl_test_pas', ?, ?, 99, 'PAS', 'wo_test_pas', 'TEST-PAS-99', 'planned', 'none', 'active')`,
  ).run(part.accession_id, part.block_id);
  return part;
}

/** v2 of `order` with every requested stain removed. */
function pasRemoved(db: DB, order: string) {
  const p = orderPayload(db, order, 1);
  return { ...p, version: 2, updated_at: at("10:55"), specimens: p.specimens.map((s: { requested_stains: string[] }) => ({ ...s, requested_stains: [] })) };
}

// ---------------------------------------------------------------------------- acceptance 11

describe("acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one", () => {
  it("the 11:04 duplicate delivery of ORD-77118 v1 is ignored and changes nothing", () => {
    const db = testDb();
    const before = counts(db);
    clockAt(db, "11:04");
    expect(pumpSources(db).delivered).toBe(1);

    const ev = one<{ outcome: string; receipt_count: number }>(db, "SELECT outcome, receipt_count FROM integration_event WHERE message_id = 'ORD-77118#v1'");
    expect(ev.outcome).toBe("applied"); // the original outcome is kept
    expect(ev.receipt_count).toBe(2);
    const receipt = one<{ outcome: string }>(db, "SELECT outcome FROM integration_receipt WHERE message_id = 'ORD-77118#v1' ORDER BY received_at DESC LIMIT 1");
    expect(receipt.outcome).toBe("duplicate_ignored");
    expect(counts(db)).toEqual(before);
  });

  it("replaying the same message again and again keeps every count unchanged", () => {
    const db = testDb();
    clockAt(db, "11:04");
    pumpSources(db);
    const before = counts(db);
    const r1 = must<{ outcome: string; receiptCount: number }>(db, STAFF.maya, "integration.replayDuplicate", { sourceId: "src_ema" });
    const r2 = must<{ outcome: string; receiptCount: number }>(db, STAFF.maya, "integration.replayDuplicate", { sourceId: "src_ema" });
    expect(r1.outcome).toBe("duplicate_ignored");
    expect(r2.outcome).toBe("duplicate_ignored");
    expect(r2.receiptCount).toBe(r1.receiptCount + 1);
    expect(counts(db)).toEqual(before);
  });

  it("the seeded 11:25 replay of ORD-75347 v1 is stale_ignored and the newer v2 stays", () => {
    const db = testDb();
    const orderBefore = one<{ source_version: number; clinical_note: string }>(db, "SELECT source_version, clinical_note FROM source_order WHERE source_order_id = 'ORD-75347'");
    expect(orderBefore.source_version).toBe(2);
    clockAt(db, "11:25");
    pumpSources(db);

    const ev = one<{ outcome: string; detail: string }>(db, "SELECT outcome, detail FROM integration_event WHERE message_id = 'ORD-75347#v1-replay'");
    expect(ev.outcome).toBe("stale_ignored");
    expect(ev.detail).toMatch(/not newer/);
    const after = one<{ source_version: number; clinical_note: string }>(db, "SELECT source_version, clinical_note FROM source_order WHERE source_order_id = 'ORD-75347'");
    expect(after).toEqual(orderBefore); // the clarified v2 note was not overwritten by v1
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = 'ORD-75347'").n).toBe(2);
  });

  it("an older version arriving after a newer one (out of order) is ignored and does not overwrite", () => {
    const db = testDb();
    clockAt(db, "11:02");
    const v1 = orderPayload(db, "ORD-77118", 1);
    const v3 = { ...v1, version: 3, updated_at: at("10:58"), specimens: [{ ...v1.specimens[0], site: "Right nasal ala" }] };
    const v2 = { ...v1, version: 2, updated_at: at("10:40"), specimens: [{ ...v1.specimens[0], site: "Right cheek" }] };

    const a = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77118#v3", messageType: "order.upsert", payload: v3 });
    expect(a.outcome).toBe("applied");
    const b = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77118#v2", messageType: "order.upsert", payload: v2 });
    expect(b.outcome).toBe("stale_ignored");

    const order = one<{ source_version: number }>(db, "SELECT source_version FROM source_order WHERE source_order_id = 'ORD-77118'");
    expect(order.source_version).toBe(3);
    const part = one<{ site_text: string }>(db, "SELECT site_text FROM source_order_part WHERE id = 'ord_ord_77118_a'");
    expect(part.site_text).toBe("Right nasal ala");
    // v2 was never stored as a version: only v1 (original, kept) and v3.
    const versions = all<{ source_version: number }>(db, "SELECT source_version FROM source_order_version WHERE source_order_id = 'ord_ord_77118' ORDER BY source_version");
    expect(versions.map((v) => v.source_version)).toEqual([1, 3]);
    expect(JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = 'ord_ord_77118' AND source_version = 1").payload).specimens[0].site).toBe("Right nasal sidewall");
  });

  it("an unprocessable message is kept in the failure queue (never thrown) and a supervisor can retry it", () => {
    const db = testDb();
    must(db, STAFF.maya, "integration.injectImportFailure", { sourceId: "src_ema" });
    clockAt(db, "11:20");
    pumpSources(db); // delivers 11:04 duplicate (not consumed by the fault) and the 11:20 PAS amendment (fails)
    const ev = one<{ id: string; outcome: string; detail: string }>(db, "SELECT id, outcome, detail FROM integration_event WHERE message_id = 'ORD-75061#v2'");
    expect(ev.outcome).toBe("failed");
    expect(ev.detail).toMatch(/Simulated processing error/);
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = ?", PAS_WO).status).toBe("completed"); // nothing partially applied

    const denied = run(db, STAFF.maya, "integration.retryEvent", { eventId: ev.id });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");

    const retried = must<{ outcome: string }>(db, STAFF.tanya, "integration.retryEvent", { eventId: ev.id });
    expect(retried.outcome).toBe("applied");
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = ?", PAS_WO).status).toBe("cancel_review");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM integration_event WHERE message_id = 'ORD-75061#v2'").n).toBe(1);
  });

  it("a malformed payload fails validation with a reason and changes nothing", () => {
    const db = testDb();
    const before = counts(db);
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "BAD-1", messageType: "order.upsert", payload: "{not json" });
    expect(r.outcome).toBe("failed");
    expect(r.detail).toMatch(/not valid JSON/);
    const r2 = importSourceMessage(importCtx(db), "src_ema", { messageId: "BAD-2", messageType: "order.upsert", payload: { order_id: "ORD-1", version: 1 } });
    expect(r2.outcome).toBe("failed");
    expect(r2.detail).toMatch(/validation/);
    expect({ ...counts(db), events: before.events }).toEqual(before);
    expect(counts(db).events).toBe(before.events + 2);
  });

  it("an unknown order for a known tenant is imported as a new order in that tenant's namespace", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    const fresh = { ...v1, order_id: "ORD-77999", patient: { mrn: "990001", name: "Lark, Rowan", birth_date: "1988-02-02" }, encounter_id: "ENC-59999" };
    const r = importSourceMessage(importCtx(db), "src_oth", { messageId: "ORD-77999#v1", messageType: "order.upsert", payload: { ...fresh, office_id: "SITE-7" } });
    expect(r.outcome).toBe("applied");
    const order = one<{ tenant_id: string; source_version: number }>(db, "SELECT tenant_id, source_version FROM source_order WHERE source_order_id = 'ORD-77999'");
    expect(order.tenant_id).toBe("ten_oth");
  });

  it("an office id the tenant never sent before becomes a NEW, unreviewed office in that tenant (never matched to another tenant's office) and goes to the unknown-offices queue", async () => {
    const { loadRoutingSettings } = await import("@/server/queries/settings");
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    const emaOffice = v1.office_id as string; // an EMA office id, unknown inside the other tenant
    const emaOfficeRow = one<{ id: string }>(db, "SELECT id FROM office WHERE tenant_id = 'ten_ema' AND source_office_id = ?", emaOffice);
    const payload = { ...v1, order_id: "ORD-78000", patient: { mrn: "990002", name: "Fenn, Iris", birth_date: "1979-05-05" }, encounter_id: "ENC-59998" };
    const r = importSourceMessage(importCtx(db), "src_oth", { messageId: "ORD-78000#v1", messageType: "order.upsert", payload });
    expect(r.outcome).toBe("applied");
    expect(r.reconciliation.map((n) => n.kind)).toContain("new_office_review");

    const created = one<{ id: string; tenant_id: string; status: string; working_hours: string; name: string }>(
      db,
      "SELECT o.* FROM source_order so JOIN office o ON o.id = so.office_id WHERE so.source_order_id = 'ORD-78000'",
    );
    expect(created.id).not.toBe(emaOfficeRow.id); // not guessed across tenants
    expect(created.tenant_id).toBe("ten_oth");
    expect(created.status).toBe("new_unreviewed");
    expect(created.working_hours).toBe("null"); // Unknown, not "closed"
    expect(one<{ status: string; owner_role: string }>(db, "SELECT status, owner_role FROM task WHERE kind = 'source_conflict' AND entity_type = 'office' AND entity_id = ?", created.id)).toEqual({
      status: "open",
      owner_role: "supervisor",
    });
    const queue = loadRoutingSettings(db).unknownOffices;
    expect(queue.find((o) => o.officeId === created.id)?.reason).toMatch(/not yet reviewed/i);

    // A second order from the same office reuses it; no duplicate office or task.
    const again = importSourceMessage(importCtx(db), "src_oth", { messageId: "ORD-78001#v1", messageType: "order.upsert", payload: { ...payload, order_id: "ORD-78001" } });
    expect(again.outcome).toBe("applied");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM office WHERE tenant_id = 'ten_oth' AND source_office_id = ?", emaOffice).n).toBe(1);
  });

  it("a new order whose MRN is on file with a different name or birth date is linked by MRN only and flagged for review, never merged", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    const before = one<{ family_name: string; given_name: string; birth_date: string }>(
      db,
      "SELECT family_name, given_name, birth_date FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = ?",
      v1.patient.mrn,
    );
    const r = importSourceMessage(importCtx(db), "src_ema", {
      messageId: "ORD-77990#v1",
      messageType: "order.upsert",
      payload: { ...v1, order_id: "ORD-77990", patient: { ...v1.patient, birth_date: "1901-01-01" } },
    });
    expect(r.outcome).toBe("applied");
    expect(r.detail).toMatch(/different details/);
    const task = one<{ status: string; priority: string; title: string }>(db, "SELECT status, priority, title FROM task WHERE kind = 'source_conflict' AND entity_type = 'patient_ref'");
    expect(task).toMatchObject({ status: "open", priority: "urgent" });
    expect(task.title).toMatch(/date of birth/);
    expect(one(db, "SELECT family_name, given_name, birth_date FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = ?", v1.patient.mrn)).toEqual(before);
  });

  it("the same version number re-sent with different content is stale_ignored (contract) and opens a review task; the stored version is kept", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    const r = importSourceMessage(importCtx(db), "src_ema", {
      messageId: "ORD-77118#v1-other",
      messageType: "order.upsert",
      payload: { ...v1, specimens: [{ ...v1.specimens[0], site: "Left nasal sidewall" }] },
    });
    expect(r.outcome).toBe("stale_ignored");
    expect(r.detail).toMatch(/review task was opened/);
    expect(one<{ status: string }>(db, "SELECT status FROM task WHERE kind = 'source_conflict' AND entity_type = 'integration_event' AND entity_id = ?", r.eventId).status).toBe("open");
    expect(one<{ site_text: string }>(db, "SELECT site_text FROM source_order_part WHERE id = 'ord_ord_77118_a'").site_text).toBe("Right nasal sidewall");
  });

  it("a message that failed and turns out stale on retry says it was processed (not applied) on retry", () => {
    const db = testDb();
    clockAt(db, "11:00");
    must(db, STAFF.maya, "integration.injectImportFailure", { sourceId: "src_ema" });
    const sent = must<{ outcome: string; messageId: string }>(db, STAFF.maya, "integration.deliverOlderVersion", { sourceId: "src_ema" });
    expect(sent.outcome).toBe("failed");
    const ev = one<{ id: string }>(db, "SELECT id FROM integration_event WHERE message_id = ?", sent.messageId);
    const retried = must<{ outcome: string }>(db, STAFF.tanya, "integration.retryEvent", { eventId: ev.id });
    expect(retried.outcome).toBe("stale_ignored");
    expect(one<{ detail: string }>(db, "SELECT detail FROM integration_event WHERE id = ?", ev.id).detail).toMatch(/processed on retry/);
  });

  it("if the receipt log cannot be written, the import is still applied and recorded once (logging never fails an import)", () => {
    const db = testDb();
    db.exec("DROP TABLE integration_receipt"); // e.g. a local database created before the receipt log existed
    clockAt(db, "11:20");
    expect(pumpSources(db).delivered).toBe(2); // 11:04 duplicate + 11:20 PAS amendment
    expect(one<{ outcome: string }>(db, "SELECT outcome FROM integration_event WHERE message_id = 'ORD-75061#v2'").outcome).toBe("applied");
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = ?", PAS_WO).status).toBe("cancel_review");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM sim_source_outbox WHERE delivered_at IS NULL AND available_at <= ?", at("11:20")).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------- acceptance 13

describe("acceptance 13: a source outage marks data stale; restored events reconcile once; no source writes are implied", () => {
  it("while offline nothing is delivered, data is stale and last success is frozen; restore delivers the backlog exactly once", () => {
    const db = testDb();
    clockAt(db, "11:00");
    expect(sourceFreshness(db).find((s) => s.sourceId === "src_ema")!.stale).toBe(false);
    must(db, STAFF.maya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });

    clockAt(db, "11:30");
    expect(pumpSources(db).delivered).toBe(0);
    const src = one<{ last_success_at: string; last_attempt_at: string; last_error: string }>(db, "SELECT * FROM integration_source WHERE id = 'src_ema'");
    expect(src.last_success_at).toBe(at("10:51"));
    expect(src.last_attempt_at).toBe(at("11:30"));
    expect(src.last_error).toBe("Simulated outage");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM sim_source_outbox WHERE delivered_at IS NULL").n).toBe(3);
    const fresh = sourceFreshness(db).find((s) => s.sourceId === "src_ema")!;
    expect(fresh.stale).toBe(true);
    expect(fresh.status).toBe("offline");
    expect(fresh.label).toMatch(/unreachable since 11:00 AM ET/i);
    expect(fresh.ageMinutes).toBe(39);
    // The other tenant is unaffected and current.
    expect(sourceFreshness(db).find((s) => s.sourceId === "src_oth")!.stale).toBe(false);
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = ?", PAS_WO).status).toBe("completed");

    const restored = must<{ delivered: number }>(db, STAFF.maya, "integration.setSourceStatus", { sourceId: "src_ema", status: "connected" });
    expect(restored.delivered).toBe(3);
    const outcomes = Object.fromEntries(
      all<{ message_id: string; outcome: string }>(db, "SELECT message_id, outcome FROM integration_receipt WHERE via = 'sync'").map((r) => [r.message_id, r.outcome]),
    );
    expect(outcomes).toEqual({ "ORD-77118#v1": "duplicate_ignored", "ORD-75061#v2": "applied", "ORD-75347#v1-replay": "stale_ignored" });
    expect(sourceFreshness(db).find((s) => s.sourceId === "src_ema")!.stale).toBe(false);

    const afterRestore = counts(db);
    expect(pumpSources(db).delivered).toBe(0);
    must(db, STAFF.maya, "integration.syncNow", {});
    expect(counts(db)).toEqual(afterRestore);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM task WHERE kind = 'order_change_review' AND entity_id = ?", PAS_WO).n).toBe(1);
  });

  it("a connected source whose last successful sync is older than 15 minutes is shown as stale until it syncs", () => {
    const db = testDb();
    clockAt(db, "11:10"); // seed heartbeat 10:51 → 19 minutes old, no poll yet
    const f = sourceFreshness(db).find((s) => s.sourceId === "src_ema")!;
    expect(f.ageMinutes).toBe(19);
    expect(f.stale).toBe(true);
    pumpSources(db);
    const g = sourceFreshness(db).find((s) => s.sourceId === "src_ema")!;
    expect(g.stale).toBe(false);
    expect(g.ageMinutes).toBe(0);
  });

  it("approving, attesting or completing local work never creates a source write", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const snapshot = () => ({
      events: one<{ n: number }>(db, "SELECT COUNT(*) n FROM integration_event").n,
      outbox: one<{ n: number }>(db, "SELECT COUNT(*) n FROM sim_source_outbox").n,
      versions: one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_version").n,
      orders: all(db, "SELECT id, source_version, source_status, source_updated_at FROM source_order ORDER BY id"),
    });
    const before = snapshot();

    const draft = must<{ ruleSetId: string }>(db, STAFF.tanya, "routing.draftRuleSet", { reason: "Seagrape reviewed", changes: [{ officeId: "off_sss", pathologistId: STAFF.ferreira }] });
    must(db, STAFF.md, "routing.approveRuleSet", { ruleSetId: draft.ruleSetId });
    must(db, STAFF.tanya, "office.updateContact", { contactId: "oc_cld_1", patch: { out_until: null } });

    const registered = new Set(listCommands().map((c) => c.name));
    if (registered.has("gross.recordSourceEntry")) {
      const g = one<{ id: string; version: number } | undefined>(db, "SELECT id, version FROM gross_record WHERE source_update_state = 'pending_entry' LIMIT 1");
      if (g) {
        must(db, STAFF.sam, "gross.recordSourceEntry", { grossRecordId: g.id, expectedVersion: g.version });
        const after = one<{ source_update_state: string }>(db, "SELECT source_update_state FROM gross_record WHERE id = ?", g.id);
        expect(after.source_update_state).toBe("entered_attested"); // attested by staff, NOT acknowledged by the source
      }
    }
    expect(snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------- acceptance 14

describe("acceptance 14: a canceled stain stays traceable and triggers review of prepared material", () => {
  it("the 11:20 PAS cancellation puts WO-2142 in cancel_review, keeps the prepared PAS slide for review, opens a task and records a worklist change", () => {
    const db = testDb();
    const slideBefore = one<{ physical_state: string; label_state: string }>(db, "SELECT physical_state, label_state FROM slide WHERE id = ?", PAS_SLIDE);
    const seqBefore = one<{ s: number }>(db, "SELECT MAX(seq) s FROM worklist_change").s;
    clockAt(db, "11:20");
    pumpSources(db);

    const wo = one<{ status: string; status_reason: string }>(db, "SELECT status, status_reason FROM work_order WHERE id = ?", PAS_WO);
    expect(wo.status).toBe("cancel_review");
    expect(wo.status_reason).toMatch(/PAS removed at source by ORD-75061 v2/);

    const slide = one<{ status: string; physical_state: string; label_state: string } | undefined>(db, "SELECT status, physical_state, label_state FROM slide WHERE id = ?", PAS_SLIDE);
    expect(slide).toBeDefined(); // not deleted
    expect(slide!.status).toBe("canceled_needs_review");
    expect(slide!.physical_state).toBe(slideBefore.physical_state);
    expect(slide!.label_state).toBe(slideBefore.label_state);

    const task = one<{ status: string; owner_role: string; title: string }>(db, "SELECT status, owner_role, title FROM task WHERE kind = 'order_change_review' AND entity_type = 'work_order' AND entity_id = ?", PAS_WO);
    expect(task.status).toBe("open");
    expect(task.title).toMatch(/PAS canceled at source after material was prepared/);

    const change = one<{ change_type: string; summary: string } | undefined>(
      db,
      "SELECT change_type, summary FROM worklist_change WHERE seq > ? AND accession_id = 'acc_d26_04749' AND change_type = 'canceled'",
      seqBefore,
    );
    expect(change).toBeDefined();
    expect(change!.summary).toMatch(/WO-2142/);

    // Traceable: the original order version that requested PAS is still stored next to the amendment.
    const versions = all<{ source_version: number; payload: string; change_summary: string }>(
      db,
      "SELECT source_version, payload, change_summary FROM source_order_version WHERE source_order_id = 'ord_ord_75061' ORDER BY source_version",
    );
    expect(versions.map((v) => v.source_version)).toEqual([1, 2]);
    expect(JSON.parse(versions[0].payload).specimens[0].requested_stains).toEqual(["PAS"]);
    expect(JSON.parse(versions[1].payload).specimens[0].requested_stains).toEqual([]);
    expect(one<{ source_status: string }>(db, "SELECT source_status FROM source_order WHERE id = 'ord_ord_75061'").source_status).toBe("amended");

    // Delivering the same amendment again does not open a second review.
    must(db, STAFF.maya, "integration.replayDuplicate", { sourceId: "src_ema" });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM task WHERE kind = 'order_change_review' AND entity_id = ?", PAS_WO).n).toBe(1);
  });

  it("a stain canceled before anything was printed or prepared is simply canceled and its planned slides are voided", () => {
    const db = testDb();
    const part = setupUnpreparedPas(db);
    clockAt(db, "11:00");
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: `${part.order}#v2`, messageType: "order.upsert", payload: pasRemoved(db, part.order) });
    expect(r.outcome).toBe("applied");
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = 'wo_test_pas'").status).toBe("canceled");
    expect(one<{ status: string }>(db, "SELECT status FROM slide WHERE id = 'sl_test_pas'").status).toBe("void"); // kept as a record, not deleted
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM task WHERE kind = 'order_change_review' AND entity_id = 'wo_test_pas'").n).toBe(0);
    expect(one<{ change_type: string }>(db, "SELECT change_type FROM worklist_change WHERE accession_id = ? ORDER BY seq DESC LIMIT 1", part.accession_id).change_type).toBe("canceled");
  });

  it("a stain canceled while its label's print outcome is UNKNOWN (printer timeout) is treated as possibly printed: cancel_review, slide kept for review, task says to reconcile", () => {
    const db = testDb();
    const s = setupUnpreparedPas(db);
    clockAt(db, "10:58");
    // S5's real path: the printer times out after submission, leaving the job unknown_outcome and no label row.
    must(db, STAFF.tanya, "printer.setStatus", { printerId: "prn_s1", status: "simulate_timeout" });
    const job = must<{ state: string; displayId: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: "sl_test_pas", kind: "slide_label" });
    expect(job.state).toBe("unknown_outcome");
    expect(one<{ label_state: string }>(db, "SELECT label_state FROM slide WHERE id = 'sl_test_pas'").label_state).toBe("none");

    clockAt(db, "11:00");
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: `${s.order}#v2`, messageType: "order.upsert", payload: pasRemoved(db, s.order) });
    expect(r.outcome).toBe("applied");
    const wo = one<{ status: string; status_reason: string }>(db, "SELECT status, status_reason FROM work_order WHERE id = 'wo_test_pas'");
    expect(wo.status).toBe("cancel_review");
    expect(wo.status_reason).toMatch(/print outcome unknown/);
    expect(wo.status_reason).not.toMatch(/Nothing had been/);
    expect(one<{ status: string }>(db, "SELECT status FROM slide WHERE id = 'sl_test_pas'").status).toBe("canceled_needs_review");
    const task = one<{ title: string; detail: string }>(db, "SELECT title, detail FROM task WHERE kind = 'order_change_review' AND entity_id = 'wo_test_pas'");
    expect(task.title).toMatch(/possibly printed/);
    expect(task.detail).toMatch(new RegExp(`${job.displayId}.*reconcile`));
    // The unknown-outcome job is left for reconciliation, not canceled behind the operator's back.
    expect(one<{ state: string }>(db, "SELECT state FROM print_job WHERE display_id = ?", job.displayId).state).toBe("unknown_outcome");
  });

  it("a queued (never sent) label for a canceled stain is withdrawn with an audit record", () => {
    const db = testDb();
    const s = setupUnpreparedPas(db);
    must(db, STAFF.tanya, "printer.setStatus", { printerId: "prn_s1", status: "offline" });
    const job = must<{ state: string; displayId: string; printJobId: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: "sl_test_pas", kind: "slide_label" });
    expect(job.state).toBe("queued");
    clockAt(db, "11:00");
    importSourceMessage(importCtx(db), "src_ema", { messageId: `${s.order}#v2`, messageType: "order.upsert", payload: pasRemoved(db, s.order) });
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = 'wo_test_pas'").status).toBe("canceled");
    expect(one<{ state: string }>(db, "SELECT state FROM print_job WHERE id = ?", job.printJobId).state).toBe("canceled");
    expect(one<{ summary: string }>(db, "SELECT summary FROM audit_event WHERE action = 'print.withdrawn_by_source_change' AND entity_id = ?", job.printJobId).summary).toMatch(job.displayId);
  });

  it("a stain added by an amendment creates a new requested work order (no slide invented) and a histotech task", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const p = orderPayload(db, "ORD-75061", 1);
    const v2 = { ...p, version: 2, updated_at: at("10:58"), specimens: [{ ...p.specimens[0], requested_stains: ["PAS", "GMS"] }] };
    const slidesBefore = one<{ n: number }>(db, "SELECT COUNT(*) n FROM slide WHERE accession_id = 'acc_d26_04749'").n;
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v2-gms", messageType: "order.upsert", payload: v2 });
    expect(r.outcome).toBe("applied");
    const wo = one<{ id: string; status: string; authorization_source: string; source_version: number }>(db, "SELECT * FROM work_order WHERE accession_id = 'acc_d26_04749' AND stain = 'GMS'");
    expect(wo).toMatchObject({ status: "requested", authorization_source: "source_order", source_version: 2 });
    expect(one<{ owner_role: string }>(db, "SELECT owner_role FROM task WHERE kind = 'order_change_review' AND entity_id = ?", wo.id).owner_role).toBe("histotech");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM slide WHERE accession_id = 'acc_d26_04749'").n).toBe(slidesBefore);
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = ?", PAS_WO).status).toBe("completed"); // PAS still requested
  });

  it("later versions do not repeat a cancellation: no second 'canceled' worklist entry and a closed review is not reopened", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const p = orderPayload(db, "ORD-75061", 1);
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v2-cancel", messageType: "order.cancel", payload: { ...p, version: 2, updated_at: at("10:58"), status: "canceled" } });
    const canceledEntries = () => one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_change WHERE accession_id = 'acc_d26_04749' AND change_type = 'canceled'").n;
    const after2 = canceledEntries();
    expect(after2).toBeGreaterThan(0);
    db.prepare("UPDATE task SET status = 'done' WHERE kind = 'order_change_review' AND entity_type = 'specimen_part' AND entity_id = 'acc_d26_04749_pa'").run();

    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v3-cancel", messageType: "order.cancel", payload: { ...p, version: 3, updated_at: at("10:59"), status: "canceled" } });
    expect(r.outcome).toBe("applied");
    expect(canceledEntries()).toBe(after2);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM task WHERE kind = 'order_change_review' AND entity_id = 'acc_d26_04749_pa' AND status = 'open'").n).toBe(0);
  });

  it("an order canceled at source never erases prepared material: the case keeps its parts and a review task is opened", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const p = orderPayload(db, "ORD-75061", 1);
    const before = { blocks: one<{ n: number }>(db, "SELECT COUNT(*) n FROM block WHERE accession_id = 'acc_d26_04749'").n, slides: one<{ n: number }>(db, "SELECT COUNT(*) n FROM slide WHERE accession_id = 'acc_d26_04749'").n };
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v2-cancel", messageType: "order.cancel", payload: { ...p, version: 2, updated_at: at("10:58"), status: "canceled" } });
    expect(r.outcome).toBe("applied");
    expect(one<{ source_status: string }>(db, "SELECT source_status FROM source_order WHERE id = 'ord_ord_75061'").source_status).toBe("canceled");
    expect(one<{ status: string }>(db, "SELECT status FROM specimen_part WHERE id = 'acc_d26_04749_pa'").status).toBe("active");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM block WHERE accession_id = 'acc_d26_04749'").n).toBe(before.blocks);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM slide WHERE accession_id = 'acc_d26_04749'").n).toBe(before.slides);
    expect(one<{ status: string }>(db, "SELECT status FROM task WHERE kind = 'order_change_review' AND entity_type = 'specimen_part' AND entity_id = 'acc_d26_04749_pa'").status).toBe("open");
  });
});

// ---------------------------------------------------------------------------- amendments vs accession

describe("amended orders: issued parts are never silently changed; pre-accession parts update with a lead review", () => {
  it("hero ORD-77121 v2 updates the pre-accession order part's working laterality and opens the lead task to review and release the hold", () => {
    const db = testDb();
    clockAt(db, "11:05");
    // Part B laterality clarification + scoped hold, as S2 would create them (direct SQL keeps this test independent).
    db.prepare(
      `INSERT INTO clarification (id, display_id, category, source_order_id, order_part_id, subject_label, question, evidence, office_id, contact_role, lab_owner_id, priority, state, created_at, created_by, dedupe_key, version)
       VALUES ('clr_test_b', 'CLR-0999', 'laterality', 'ord_ord_77121', 'ord_ord_77121_b', 'Part B · ORD-77121', 'Order says right; bottle says left.', ?, 'off_hpd', 'Biopsy coordinator (MA lead)', 'stf_maya', 'high', 'resolved', ?, 'stf_maya', 'test:b', 3)`,
    ).run(JSON.stringify([{ field: "Laterality", order_value: "right", observed_value: "left", source: "bottle label" }]), at("11:01"));
    db.prepare(
      `INSERT INTO hold (id, display_id, scope_type, scope_id, scope_label, blocks, reason_code, reason_text, clarification_id, status, placed_by, placed_at, version)
       VALUES ('hold_test_b', 'H-0999', 'order_part', 'ord_ord_77121_b', 'Part B (ORD-77121 · B)', '["gross_approval","processing","print","tray_delivery"]', 'laterality', 'Laterality mismatch', 'clr_test_b', 'active', 'stf_maya', ?, 1)`,
    ).run(at("11:01"));

    // The simulated office amends the order; it arrives through the outbox one minute later.
    const v1 = orderPayload(db, "ORD-77121", 1);
    const v2 = { ...v1, version: 2, updated_at: at("11:05"), amendment_note: "Laterality corrected by office", specimens: [{ ...v1.specimens[0], laterality: "left", site: "Left dorsal forearm" }] };
    db.prepare("INSERT INTO sim_source_outbox (id, source_id, message_id, message_type, available_at, payload) VALUES ('ob_test_77121', 'src_ema', 'ORD-77121#v2', 'order.upsert', ?, ?)").run(at("11:06"), JSON.stringify(v2));
    clockAt(db, "11:06");
    pumpSources(db);

    const part = one<{ laterality: string; site_text: string }>(db, "SELECT laterality, site_text FROM source_order_part WHERE id = 'ord_ord_77121_b'");
    expect(part).toEqual({ laterality: "left", site_text: "Left dorsal forearm" });
    expect(JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = 'ord_ord_77121' AND source_version = 1").payload).specimens[0].laterality).toBe("right");

    const task = one<{ id: string; title: string; owner_id: string; status: string; detail: string }>(db, "SELECT * FROM task WHERE kind = 'order_change_review' AND entity_type = 'hold' AND entity_id = 'hold_test_b'");
    expect(task.title).toBe("Amended order received — review and release H-0999");
    expect(task.owner_id).toBe(STAFF.kim);
    expect(task.detail).toMatch(/CLR-0999/);
    expect(one<{ status: string }>(db, "SELECT status FROM hold WHERE id = 'hold_test_b'").status).toBe("active"); // never released automatically
    const evidence = JSON.parse(one<{ evidence: string }>(db, "SELECT evidence FROM clarification WHERE id = 'clr_test_b'").evidence) as { superseded_by_amendment?: string }[];
    expect(evidence[0].superseded_by_amendment).toBe("ORD-77121 v2");
    expect(one<{ version: number }>(db, "SELECT version FROM clarification WHERE id = 'clr_test_b'").version).toBe(3); // annotation only

    // Once the lead releases the hold, the review task closes on the next poll.
    db.prepare("UPDATE hold SET status = 'released', released_by = 'stf_kim', released_at = ?, release_reason = 'Amended order matches the bottle' WHERE id = 'hold_test_b'").run(at("11:08"));
    clockAt(db, "11:08");
    pumpSources(db);
    expect(one<{ status: string }>(db, "SELECT status FROM task WHERE id = ?", task.id).status).toBe("done");
  });

  it("hero end to end with the clarification slice's own commands: office answer → amended ORD-77121 v2 from the outbox → lead review task for the real hold", () => {
    const db = testDb();
    clockAt(db, "11:01");
    const c = must<{ clarificationId: string; holdId: string; holdDisplayId: string }>(db, STAFF.maya, "clarification.create", {
      category: "laterality",
      refs: { sourceOrderId: "ord_ord_77121", orderPartId: "ord_ord_77121_b" },
      subjectLabel: "Part B · ORD-77121",
      question: "The bottle for part B says left dorsal forearm but order ORD-77121 says right dorsal forearm. Which side is correct?",
      evidence: [{ field: "Laterality", order_value: "right (Right dorsal forearm)", observed_value: "L dorsal forearm", requisition_value: null, source: "bottle label (staff entry)" }],
      priority: "high",
      hold: { scope: { type: "order_part", id: "ord_ord_77121_b" }, scopeLabel: "Part B (ORD-77121 · B)", blocks: ["gross_approval", "processing", "print", "tray_delivery"] },
    });
    const version = () => one<{ version: number }>(db, "SELECT version FROM clarification WHERE id = ?", c.clarificationId).version;
    must(db, STAFF.maya, "clarification.send", { clarificationId: c.clarificationId, expectedVersion: version() });
    must(db, STAFF.maya, "clarification.simulateOfficeAnswer", { clarificationId: c.clarificationId });
    expect(pumpSources(db).delivered).toBe(0); // the amendment is not due yet

    clockAt(db, "11:03");
    pumpSources(db);
    expect(one<{ laterality: string; site_text: string }>(db, "SELECT laterality, site_text FROM source_order_part WHERE id = 'ord_ord_77121_b'")).toEqual({
      laterality: "left",
      site_text: "Left dorsal forearm",
    });
    expect(one<{ source_version: number }>(db, "SELECT source_version FROM source_order WHERE id = 'ord_ord_77121'").source_version).toBe(2);
    const task = one<{ title: string; owner_id: string; status: string }>(db, "SELECT * FROM task WHERE kind = 'order_change_review' AND entity_type = 'hold' AND entity_id = ?", c.holdId);
    expect(task).toMatchObject({ title: `Amended order received — review and release ${c.holdDisplayId}`, owner_id: STAFF.kim, status: "open" });
    expect(one<{ status: string }>(db, "SELECT status FROM hold WHERE id = ?", c.holdId).status).toBe("active");
    // Delivered once: later polls add nothing.
    const n = one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_version WHERE source_order_id = 'ord_ord_77121'").n;
    pumpSources(db);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_version WHERE source_order_id = 'ord_ord_77121'").n).toBe(n);
  });

  it("amendments are compared with the ISSUED part: v2 opens one correction review, and a v3 that matches the issued part again opens no second review", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const p = orderPayload(db, "ORD-75061", 1);
    const issued = one<{ site_text: string; laterality: string | null }>(db, "SELECT site_text, laterality FROM specimen_part WHERE id = 'acc_d26_04749_pa'");
    const v2 = { ...p, version: 2, updated_at: at("10:58"), specimens: [{ ...p.specimens[0], laterality: "right", site: "Right great toenail" }] };
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v2-site", messageType: "order.upsert", payload: v2 });
    const reviews = () => all<{ id: string; display_id: string }>(db, "SELECT id, display_id FROM correction_review WHERE accession_id = 'acc_d26_04749' AND kind = 'site_discrepancy'");
    expect(reviews()).toHaveLength(1);

    const v3 = { ...p, version: 3, updated_at: at("10:59"), specimens: [{ ...p.specimens[0] }] }; // back to the values the part was issued with
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v3-site", messageType: "order.upsert", payload: v3 });
    expect(r.outcome).toBe("applied");
    expect(reviews()).toHaveLength(1);
    const note = r.reconciliation.find((n) => n.kind === "correction_review_updated");
    expect(note?.summary).toMatch(new RegExp(`now matches the issued part.*${reviews()[0].display_id}`));
    expect(one(db, "SELECT site_text, laterality FROM specimen_part WHERE id = 'acc_d26_04749_pa'")).toEqual(issued);

    // A v4 that differs again is recorded on the same open review, still no second one.
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v4-site", messageType: "order.upsert", payload: { ...v2, version: 4, updated_at: at("11:00") } });
    expect(reviews()).toHaveLength(1);
  });

  it("patient, office or encounter changes in a newer version are sent to review and not applied; the ordering provider is updated as a working value", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const p = orderPayload(db, "ORD-77118", 1);
    const before = one<{ patient_ref_id: string; office_id: string; encounter_id: string }>(db, "SELECT patient_ref_id, office_id, encounter_id FROM source_order WHERE id = 'ord_ord_77118'");
    const otherOffice = one<{ source_office_id: string }>(db, "SELECT source_office_id FROM office WHERE tenant_id = 'ten_ema' AND source_office_id <> ? AND status = 'active' LIMIT 1", p.office_id);
    const otherProvider = one<{ id: string; source_provider_id: string }>(db, "SELECT id, source_provider_id FROM clinician WHERE tenant_id = 'ten_ema' AND source_provider_id <> ? LIMIT 1", p.ordering_provider_id);
    const v2 = { ...p, version: 2, updated_at: at("10:58"), patient: { ...p.patient, mrn: "999999" }, office_id: otherOffice.source_office_id, encounter_id: "ENC-00001", ordering_provider_id: otherProvider.source_provider_id };
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77118#v2-hdr", messageType: "order.upsert", payload: v2 });
    expect(r.outcome).toBe("applied");
    expect(r.detail).not.toMatch(/No specimen or stain changes\.$/);

    const after = one<{ patient_ref_id: string; office_id: string; encounter_id: string; ordering_clinician_id: string; review_state: string }>(db, "SELECT * FROM source_order WHERE id = 'ord_ord_77118'");
    expect({ patient_ref_id: after.patient_ref_id, office_id: after.office_id, encounter_id: after.encounter_id }).toEqual(before);
    expect(after.ordering_clinician_id).toBe(otherProvider.id);
    expect(after.review_state).toBe("needs_reconciliation");
    const task = one<{ priority: string; detail: string; owner_role: string }>(db, "SELECT priority, detail, owner_role FROM task WHERE kind = 'source_conflict' AND entity_type = 'source_order' AND entity_id = 'ord_ord_77118'");
    expect(task.priority).toBe("urgent");
    expect(task.owner_role).toBe("accessioning_lead");
    expect(task.detail).toMatch(/MRN/);
    expect(task.detail).toMatch(/office/);
    expect(task.detail).toMatch(/encounter/);
  });

  it("an order canceled at source before accession: parts canceled, nothing erased, and the lead gets a review task for the intake-item hold", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const p = orderPayload(db, "ORD-75469", 1);
    const containersBefore = one<{ n: number }>(db, "SELECT COUNT(*) n FROM container WHERE intake_item_id = 'int_int_1014_022'").n;
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75469#v2", messageType: "order.cancel", payload: { ...p, version: 2, updated_at: at("10:58"), status: "canceled" } });
    expect(r.outcome).toBe("applied");
    expect(all<{ status: string }>(db, "SELECT status FROM source_order_part WHERE source_order_id = 'ord_ord_75469'").map((x) => x.status)).toEqual(["canceled", "canceled"]);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM container WHERE intake_item_id = 'int_int_1014_022'").n).toBe(containersBefore);
    const task = one<{ title: string; owner_id: string; detail: string }>(db, "SELECT * FROM task WHERE kind = 'order_change_review' AND entity_type = 'hold' AND entity_id = 'hold_h_0088'");
    expect(task.title).toBe("Amended order received — review and release H-0088");
    expect(task.owner_id).toBe(STAFF.kim);
    expect(task.detail).toMatch(/order canceled at source/);
    expect(one<{ status: string }>(db, "SELECT status FROM hold WHERE id = 'hold_h_0088'").status).toBe("active");
  });

  it("a change to expected containers after the item was received (no hold) opens a re-check task for the lead", () => {
    const db = testDb();
    clockAt(db, "11:00");
    db.prepare("UPDATE hold SET status = 'released', released_by = 'stf_kim', released_at = ?, release_reason = 'test setup' WHERE id = 'hold_h_0088'").run(at("10:59"));
    const p = orderPayload(db, "ORD-75469", 1);
    const v2 = { ...p, version: 2, updated_at: at("10:58"), specimens: p.specimens.map((s: { designation: string; expected_containers: number }) => (s.designation === "A" ? { ...s, expected_containers: 2 } : s)) };
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75469#v2-containers", messageType: "order.upsert", payload: v2 });
    expect(r.outcome).toBe("applied");
    const task = one<{ title: string; intake_item_id: string; detail: string }>(db, "SELECT * FROM task WHERE kind = 'order_change_review' AND entity_type = 'source_order_part' AND entity_id = 'ord_ord_75469_a'");
    expect(task.title).toMatch(/Order changed after receipt — re-check INT-1014-022 part A/);
    expect(task.intake_item_id).toBe("int_int_1014_022");
    expect(task.detail).toMatch(/expected containers now 2/);
  });

  it("a laterality change on an already-accessioned part opens a correction review and never changes the issued part", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const issued = one<{ site_text: string; laterality: string }>(db, "SELECT site_text, laterality FROM specimen_part WHERE id = 'acc_d26_04749_pa'");
    const p = orderPayload(db, "ORD-75061", 1);
    const v2 = { ...p, version: 2, updated_at: at("10:58"), specimens: [{ ...p.specimens[0], laterality: "right", site: "Right great toenail" }] };
    const r = importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v2-site", messageType: "order.upsert", payload: v2 });
    expect(r.outcome).toBe("applied");

    expect(one(db, "SELECT site_text, laterality FROM specimen_part WHERE id = 'acc_d26_04749_pa'")).toEqual(issued);
    const xr = one<{ id: string; kind: string; status: string; original_refs: string; display_id: string }>(db, "SELECT * FROM correction_review WHERE accession_id = 'acc_d26_04749'");
    expect(xr.kind).toBe("site_discrepancy");
    expect(xr.status).toBe("open");
    expect(JSON.parse(xr.original_refs).specimen_part).toMatchObject({ site_text: issued.site_text, laterality: issued.laterality });
    expect(one<{ status: string }>(db, "SELECT status FROM task WHERE kind = 'correction_review' AND entity_id = ?", xr.id).status).toBe("open");
    // The requested PAS did not change, so the PAS work order is untouched.
    expect(one<{ status: string }>(db, "SELECT status FROM work_order WHERE id = ?", PAS_WO).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------- routing rule versions

describe("routing rules: approved versions are frozen; changes need a reasoned draft and an authorized approval", () => {
  it("the database refuses to edit, add or delete rules in an approved or retired set", () => {
    const db = testDb();
    expect(() => db.prepare("UPDATE routing_rule SET pathologist_id = 'stf_okafor' WHERE rule_set_id = 'rrs_v3'").run()).toThrow(/frozen/);
    expect(() => db.prepare("INSERT INTO routing_rule (id, rule_set_id, office_id, pathologist_id) VALUES ('x', 'rrs_v3', 'off_sss', 'stf_marsh')").run()).toThrow(/frozen/);
    expect(() => db.prepare("DELETE FROM routing_rule WHERE rule_set_id = 'rrs_v2'").run()).toThrow(/frozen/);
  });

  it("a supervisor drafts v4 with a reason, only a permitted role approves it, and v3 is retired with an end date", () => {
    const db = testDb();
    clockAt(db, "11:30");
    const denied = run(db, STAFF.maya, "routing.draftRuleSet", { reason: "Route Seagrape", changes: [{ officeId: "off_sss", pathologistId: STAFF.ferreira }] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    const noReason = run(db, STAFF.tanya, "routing.draftRuleSet", { reason: "", changes: [{ officeId: "off_sss", pathologistId: STAFF.ferreira }] });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe("VALIDATION");

    const draft = must<{ ruleSetId: string; version: number }>(db, STAFF.tanya, "routing.draftRuleSet", {
      reason: "Seagrape Skin Studio reviewed by the medical director (synthetic)",
      changes: [{ officeId: "off_sss", pathologistId: STAFF.ferreira }],
    });
    expect(draft.version).toBe(4);
    const rules = all<{ office_id: string; pathologist_id: string }>(db, "SELECT office_id, pathologist_id FROM routing_rule WHERE rule_set_id = ? ORDER BY office_id", draft.ruleSetId);
    expect(rules).toHaveLength(7); // the six v3 rules copied + Seagrape
    expect(rules.find((r) => r.office_id === "off_ckd")!.pathologist_id).toBe(STAFF.ferreira);
    // Still a draft: not in effect, and a second draft is refused until this one is decided.
    expect(one<{ status: string }>(db, "SELECT status FROM routing_rule_set WHERE id = 'rrs_v3'").status).toBe("approved");
    const second = run(db, STAFF.tanya, "routing.draftRuleSet", { reason: "Another change", changes: [{ officeId: "off_pgs", pathologistId: STAFF.okafor }] });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CONFLICT");

    for (const who of [STAFF.maya, STAFF.kim, STAFF.director]) {
      const r = run(db, who, "routing.approveRuleSet", { ruleSetId: draft.ruleSetId });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
    }
    const approved = must<{ version: number; retired: number[] }>(db, STAFF.md, "routing.approveRuleSet", { ruleSetId: draft.ruleSetId });
    expect(approved.retired).toEqual([3]);
    const v3 = one<{ status: string; effective_to: string }>(db, "SELECT status, effective_to FROM routing_rule_set WHERE id = 'rrs_v3'");
    expect(v3).toEqual({ status: "retired", effective_to: at("11:30") });
    const v4 = one<{ status: string; effective_from: string; approved_by: string }>(db, "SELECT status, effective_from, approved_by FROM routing_rule_set WHERE id = ?", draft.ruleSetId);
    expect(v4).toEqual({ status: "approved", effective_from: at("11:30"), approved_by: STAFF.md });
    expect(() => db.prepare("UPDATE routing_rule SET pathologist_id = 'stf_marsh' WHERE rule_set_id = ?").run(draft.ruleSetId)).toThrow(/frozen/);
    const again = run(db, STAFF.md, "routing.approveRuleSet", { ruleSetId: draft.ruleSetId });
    expect(again.ok).toBe(false);
  });

  it("a future-dated approval keeps the current version until then; a later draft copies the future version (nothing dropped); the poll retires the old set when its period ends", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const v4 = must<{ ruleSetId: string }>(db, STAFF.tanya, "routing.draftRuleSet", { reason: "Seagrape reviewed", changes: [{ officeId: "off_sss", pathologistId: STAFF.ferreira }] });
    must(db, STAFF.md, "routing.approveRuleSet", { ruleSetId: v4.ruleSetId, effectiveFrom: at("13:00") });
    expect(one<{ status: string; effective_to: string }>(db, "SELECT status, effective_to FROM routing_rule_set WHERE id = 'rrs_v3'")).toEqual({ status: "approved", effective_to: at("13:00") });

    const v5 = must<{ ruleSetId: string; version: number }>(db, STAFF.tanya, "routing.draftRuleSet", { reason: "Move Palm Grove", changes: [{ officeId: "off_pgs", pathologistId: STAFF.okafor }] });
    expect(v5.version).toBe(5);
    // v5 is based on v4: it keeps v4's Seagrape rule.
    expect(one<{ pathologist_id: string }>(db, "SELECT pathologist_id FROM routing_rule WHERE rule_set_id = ? AND office_id = 'off_sss'", v5.ruleSetId).pathologist_id).toBe(STAFF.ferreira);
    // v5 cannot start before v4.
    const early = run(db, STAFF.md, "routing.approveRuleSet", { ruleSetId: v5.ruleSetId });
    expect(early.ok ? null : early.error.code).toBe("INVARIANT");

    clockAt(db, "13:01");
    pumpSources(db);
    expect(one<{ status: string }>(db, "SELECT status FROM routing_rule_set WHERE id = 'rrs_v3'").status).toBe("retired");
    const routing = loadRoutingSettings(db);
    expect(routing.current?.version).toBe(4);
    expect(routing.draft?.diffBaseVersion).toBe(4);
  });

  it("a rule set cannot be approved to take effect in the past", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const d = must<{ ruleSetId: string }>(db, STAFF.tanya, "routing.draftRuleSet", { reason: "Seagrape reviewed", changes: [{ officeId: "off_sss", pathologistId: STAFF.ferreira }] });
    const past = run(db, STAFF.md, "routing.approveRuleSet", { ruleSetId: d.ruleSetId, effectiveFrom: at("10:30") });
    expect(past.ok ? null : past.error.code).toBe("VALIDATION");
    expect(one<{ status: string }>(db, "SELECT status FROM routing_rule_set WHERE id = ?", d.ruleSetId).status).toBe("draft");
  });

  it("coverage exceptions need a permitted role, a reason and two different dermatopathologists", () => {
    const db = testDb();
    const input = { pathologistId: STAFF.ferreira, coveringPathologistId: STAFF.marsh, startsAt: at("12:00"), endsAt: at("17:00"), reason: "Afternoon off (synthetic)" };
    const denied = run(db, STAFF.kim, "routing.addCoverage", input);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    const self = run(db, STAFF.tanya, "routing.addCoverage", { ...input, coveringPathologistId: STAFF.ferreira });
    expect(self.ok).toBe(false);
    must(db, STAFF.tanya, "routing.addCoverage", input);
    const overlap = run(db, STAFF.md, "routing.addCoverage", { ...input, coveringPathologistId: STAFF.okafor });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.error.code).toBe("CONFLICT");
  });
});

// ---------------------------------------------------------------------------- demo controls & directory

describe("demo controls and the contact directory", () => {
  it("the demo clock never moves backwards unless it is an explicit reset", () => {
    const db = testDb();
    must(db, STAFF.maya, "demo.setClock", { iso: at("11:00") });
    const back = run(db, STAFF.maya, "demo.setClock", { iso: at("10:52") });
    expect(back.ok).toBe(false);
    const fwd = must<{ now: string }>(db, STAFF.maya, "demo.setClock", { advanceMinutes: 5 });
    expect(fwd.now).toBe(at("11:05"));
    const rewind = must<{ now: string }>(db, STAFF.maya, "demo.setClock", { iso: at("10:52"), reset: true });
    expect(rewind.now).toBe(at("10:52"));
  });

  it("jumping the clock forward lets the simulated source deliver what became due", () => {
    const db = testDb();
    const r = must<{ delivered: number }>(db, STAFF.maya, "demo.setClock", { iso: at("11:21") });
    expect(r.delivered).toBe(2); // 11:04 duplicate + 11:20 PAS amendment
  });

  it("a stale contact-directory edit is rejected instead of overwriting a colleague's change", () => {
    const db = testDb();
    const denied = run(db, STAFF.maya, "office.updateContact", { contactId: "oc_cld_1", patch: { out_until: null } });
    expect(denied.ok).toBe(false);
    const first = must<{ version: number }>(db, STAFF.tanya, "office.updateContact", { contactId: "oc_cld_1", expectedVersion: 1, patch: { out_until: null } });
    expect(first.version).toBe(2);
    const stale = run(db, STAFF.tanya, "office.updateContact", { contactId: "oc_cld_1", expectedVersion: 1, patch: { is_escalation: true } });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
    // Promoting a new primary demotes the previous one (one primary per office).
    must(db, STAFF.tanya, "office.updateContact", { contactId: "oc_cld_3", patch: { is_primary: true } });
    expect(all<{ id: string }>(db, "SELECT id FROM office_contact WHERE office_id = 'off_cld' AND is_primary = 1").map((r) => r.id)).toEqual(["oc_cld_3"]);
  });

  it("'Deliver queued source messages now' delivers every pending message once through the importer", () => {
    const db = testDb();
    const r = must<{ madeAvailable: number; delivered: number; outcomes: { messageId: string; outcome: string }[]; notes: string[] }>(
      db,
      STAFF.maya,
      "integration.deliverQueuedNow",
      {},
    );
    expect(r.madeAvailable).toBe(3);
    expect(r.delivered).toBe(3);
    expect(Object.fromEntries(r.outcomes.map((o) => [o.messageId, o.outcome]))).toEqual({
      "ORD-77118#v1": "duplicate_ignored",
      "ORD-75061#v2": "applied",
      "ORD-75347#v1-replay": "stale_ignored",
    });
    expect(r.notes).toEqual([]);
    const again = must<{ madeAvailable: number; delivered: number }>(db, STAFF.maya, "integration.deliverQueuedNow", {});
    expect(again).toMatchObject({ madeAvailable: 0, delivered: 0 });
  });

  it("with a simulated slow link, delivery waits 5 minutes and 'deliver now' says why nothing arrived", () => {
    const db = testDb();
    clockAt(db, "11:00");
    must(db, STAFF.maya, "integration.setSourceStatus", { sourceId: "src_ema", status: "degraded" });
    const r = must<{ delivered: number; degraded: string[]; notes: string[] }>(db, STAFF.maya, "integration.deliverQueuedNow", { sourceId: "src_ema" });
    expect(r.delivered).toBe(0);
    expect(r.degraded).toEqual(["src_ema"]);
    expect(r.notes.join(" ")).toMatch(/slow link.*5 minutes/);
    clockAt(db, "11:04");
    expect(pumpSources(db).delivered).toBe(0);
    clockAt(db, "11:05");
    expect(pumpSources(db).delivered).toBe(3);
  });

  it("'Replay a duplicate' only replays order messages, not accession events recorded by another simulator", () => {
    const db = testDb();
    clockAt(db, "11:10");
    // What the accession simulator records when it issues a number (no receipt, message type accession.issued).
    db.prepare(
      `INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
       VALUES ('ie_test_acc', 'src_ema', 'accession.issued:AR-9999', 'accession.issued', 'D26:D26-09999', 1, ?, ?, 'applied', 'Accession issued (simulated)', '{}', 1)`,
    ).run(at("11:10"), at("11:10"));
    const r = must<{ messageId: string; outcome: string }>(db, STAFF.maya, "integration.replayDuplicate", { sourceId: "src_ema" });
    expect(r.messageId).not.toMatch(/^accession\.issued/);
    expect(r.outcome).toBe("duplicate_ignored");
  });

  it("one contact cannot be both primary and escalation contact (routing and the directory would disagree)", () => {
    const db = testDb();
    const both = run(db, STAFF.tanya, "office.updateContact", { contactId: "oc_hpd_1", patch: { is_escalation: true } });
    expect(both.ok ? null : both.error.code).toBe("VALIDATION");
    const promote = run(db, STAFF.tanya, "office.updateContact", { contactId: "oc_hpd_2", patch: { is_primary: true } });
    expect(promote.ok ? null : promote.error.code).toBe("VALIDATION");
    must(db, STAFF.tanya, "office.updateContact", { contactId: "oc_hpd_2", patch: { is_primary: true, is_escalation: false } });
    expect(all<{ id: string }>(db, "SELECT id FROM office_contact WHERE office_id = 'off_hpd' AND is_primary = 1").map((x) => x.id)).toEqual(["oc_hpd_2"]);
  });

  it("the directory's 'new clarifications go to' preview matches the clarification slice's contact selection for every office", async () => {
    const { loadContactsSettings } = await import("@/server/queries/settings");
    const { selectContact } = await import("@/server/domain/clarification");
    const db = testDb();
    // Make the coverage interesting: an office with no flagged primary, and a primary that is out without a backup.
    db.prepare("UPDATE office_contact SET is_primary = 0 WHERE id = 'oc_pgs_1'").run();
    db.prepare("UPDATE office_contact SET out_until = ? WHERE id = 'oc_mbd_1'").run(at("15:00"));
    const now = at("10:52");
    for (const o of loadContactsSettings(db).offices) {
      const sel = selectContact(db, o.officeId, "laterality", now);
      const expected = sel.contact && (!sel.primaryOut || sel.usedBackup) ? sel.contact.display_name : null;
      expect({ office: o.officeId, routesTo: o.routesTo }).toEqual({ office: o.officeId, routesTo: expected });
    }
  });

  it("an older version delivered late through the demo control is ignored as stale", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const r = must<{ outcome: string; sentVersion: number; storedVersion: number }>(db, STAFF.maya, "integration.deliverOlderVersion", { sourceId: "src_ema" });
    expect(r.sentVersion).toBeLessThan(r.storedVersion);
    expect(r.outcome).toBe("stale_ignored");
  });
});

// ---------------------------------------------------------------------------- settings read models

describe("settings read models are honest about routing gaps, connector capability and pending source messages", () => {
  it("Seagrape Skin Studio is listed as an unknown office with no approved rule, and every connector capability uses only the four honest words", async () => {
    const { loadRoutingSettings, loadIntegrationSettings, loadContactsSettings, CAPABILITY_MATRIX_SUMMARY } = await import("@/server/queries/settings");
    const db = testDb();
    const routing = loadRoutingSettings(db);
    expect(routing.current?.version).toBe(3);
    const seagrape = routing.unknownOffices.find((o) => o.officeId === "off_sss");
    expect(seagrape).toBeDefined();
    expect(routing.current!.rules.some((r) => r.officeId === "off_sss")).toBe(false);

    const integ = loadIntegrationSettings(db);
    const words = new Set(integ.connectors.flatMap((c) => [c.word, ...c.capabilities.map((x) => x.word)]));
    for (const w of words) expect(["Simulated", "Documented", "Unknown", "Unsupported"]).toContain(w);
    expect(JSON.stringify(integ)).not.toMatch(/Implemented/);
    // Writing gross text to the source is reported as unsupported, not as a working capability.
    const ema = integ.connectors.find((c) => c.id === "src_ema")!;
    expect(ema.capabilities.find((c) => c.capability === "gross_text.write")!.word).toBe("Unsupported");

    // The condensed capability matrix uses the same four words only.
    for (const row of CAPABILITY_MATRIX_SUMMARY) expect(["Simulated", "Documented", "Unknown", "Unsupported"]).toContain(row.documented);

    // Coral Lane's primary contact is out until 17:00 → new clarifications go to the backup.
    const contacts = loadContactsSettings(db);
    const cld = contacts.offices.find((o) => o.officeId === "off_cld")!;
    expect(cld.routesTo).toBe("Jade Kim");
    expect(cld.coverageGap).toMatch(/Tess Monroe is out until/);
  });

  it("the integration log labels where each event came from: seed events as seed, live accession events as the accession simulator", async () => {
    const { loadIntegrationSettings } = await import("@/server/queries/settings");
    const db = testDb();
    clockAt(db, "11:10");
    db.prepare(
      `INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
       VALUES ('ie_test_acc', 'src_ema', 'accession.issued:AR-9999', 'accession.issued', 'D26:D26-09999', 1, ?, ?, 'applied', 'Accession issued (simulated)', '{}', 1)`,
    ).run(at("11:10"), at("11:10"));
    const log = loadIntegrationSettings(db).log;
    expect(log.find((l) => l.messageId === "accession.issued:AR-9999")?.via).toBe("accession_sim");
    expect(log.find((l) => l.eventId === "ie_ord_ord_77118_v1")?.via).toBe("seed");
  });

  it("the demo outbox shows each pending message with its available time and what the importer will do", async () => {
    const { loadDemoSettings } = await import("@/server/queries/settings");
    const db = testDb();
    const demo = loadDemoSettings(db);
    const byId = Object.fromEntries(demo.outbox.map((o) => [o.messageId, o]));
    expect(byId["ORD-77118#v1"].expectation).toMatch(/duplicate/);
    expect(byId["ORD-75061#v2"].expectation).toMatch(/Newer than stored v1/);
    expect(byId["ORD-75347#v1-replay"].expectation).toMatch(/stale/);
    expect(byId["ORD-75061#v2"].availableAt).toBe(at("11:20"));
    expect(demo.outbox.every((o) => !o.deliveredAt && !o.due)).toBe(true); // nothing due at 10:52
  });
});
