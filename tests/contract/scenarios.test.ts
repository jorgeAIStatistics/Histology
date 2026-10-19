// The 12 simulator scenarios (src/server/integration/simulator.ts), end to end in-process: deterministic synthetic
// envelopes, signed, through the same handleInboundRequest the route calls. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, one, all } from "../helpers";
import { loadReconciliation } from "@/server/integration/reconciliation";
import { prepareDelayedAck } from "@/server/integration/in-process";
import { SCENARIOS, SimSourceState, worldFromDb, backoffDelayMs, DEFAULT_RETRY, seededRandom } from "@/server/integration/simulator";
import { counts, enableInbound, localSnapshot, restoreEnv, runIn } from "./support";
import type { DB } from "@/server/db/db";

beforeAll(enableInbound);
afterAll(restoreEnv);

const order = (db: DB, id: string) =>
  one<{ id: string; source_version: number; source_status: string; patient_ref_id: string } | undefined>(db, "SELECT id, source_version, source_status, patient_ref_id FROM source_order WHERE source_order_id = ?", id);
const event = (db: DB, messageId: string) =>
  one<{ outcome: string; message_type: string; receipt_count: number } | undefined>(db, "SELECT outcome, message_type, receipt_count FROM integration_event WHERE message_id = ?", messageId);

describe("the 12 integration scenarios, each end to end in-process", () => {
  it("1. new order: accepted; a new order, patient reference and part exist once", async () => {
    const db = testDb();
    const r = await runIn(db, "new-order");
    expect(r.ok).toBe(true);
    const o = order(db, "SIM-90101")!;
    expect(o).toMatchObject({ source_version: 1, source_status: "active" });
    expect(one<{ source_mrn: string }>(db, "SELECT source_mrn FROM patient_ref WHERE id = ?", o.patient_ref_id).source_mrn).toBe("990101");
    expect(all(db, "SELECT designation FROM source_order_part WHERE source_order_id = ?", o.id)).toEqual([{ designation: "A" }]);
  });

  it("2. specimen submitted: the specimen line recorded as sent becomes a part of the order (no container is marked received here)", async () => {
    const db = testDb();
    const containersBefore = one<{ n: number }>(db, "SELECT COUNT(*) n FROM container").n;
    const r = await runIn(db, "specimen-submitted");
    expect(r.ok).toBe(true);
    const o = order(db, "SIM-90201")!;
    expect(o.source_version).toBe(2);
    expect(one(db, "SELECT designation, expected_containers, status FROM source_order_part WHERE source_order_id = ?", o.id)).toEqual({ designation: "A", expected_containers: 1, status: "active" });
    expect(event(db, "sim/specimen-submitted/SIM-90201#v2")).toMatchObject({ outcome: "applied", message_type: "specimen.submitted" });
    expect(JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = ? AND source_version = 2", o.id).payload).submitted).toEqual([{ designation: "A", containers: 1 }]);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM container").n).toBe(containersBefore);
  });

  it("3. multiple specimens on one order: three parts with their container counts", async () => {
    const db = testDb();
    expect((await runIn(db, "multiple-specimens")).ok).toBe(true);
    const o = order(db, "SIM-90301")!;
    expect(all(db, "SELECT designation, expected_containers FROM source_order_part WHERE source_order_id = ? ORDER BY designation", o.id)).toEqual([
      { designation: "A", expected_containers: 1 },
      { designation: "B", expected_containers: 1 },
      { designation: "C", expected_containers: 2 },
    ]);
  });

  it("4. amended order: the new version is applied, the original version is kept", async () => {
    const db = testDb();
    const w = worldFromDb(db);
    expect((await runIn(db, "amended-order")).ok).toBe(true);
    const o = order(db, w.amendable.order_id)!;
    expect(o).toMatchObject({ source_version: w.amendable.version + 1, source_status: "amended" });
    expect(all<{ source_version: number }>(db, "SELECT source_version FROM source_order_version WHERE source_order_id = ? ORDER BY source_version", o.id).map((v) => v.source_version)).toEqual([1, 2]);
    expect(one<{ site_text: string }>(db, "SELECT site_text FROM source_order_part WHERE source_order_id = ? AND designation = 'A'", o.id).site_text).toBe(`${w.amendable.specimens[0].site} (lateral aspect)`);
  });

  it("5. duplicate: one order; the stored message counts three receipts", async () => {
    const db = testDb();
    const r = await runIn(db, "duplicate");
    expect(r.steps.map((s) => s.result)).toEqual(["accepted", "duplicate", "duplicate"]);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id = 'SIM-90501'").n).toBe(1);
    expect(event(db, "sim/duplicate/SIM-90501#v1")!.receipt_count).toBe(3);
  });

  it("6. conflicting identifiers: both held for review, nothing merged or relinked", async () => {
    const db = testDb();
    const w = worldFromDb(db);
    const patient = one(db, "SELECT * FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = ?", w.patientOnFile.mrn);
    const accessioned = order(db, w.accessioned.order_id)!;
    const r = await runIn(db, "conflicting-identifiers");
    expect(r.steps.map((s) => s.result)).toEqual(["conflict_review", "conflict_review"]);
    expect(one(db, "SELECT * FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = ?", w.patientOnFile.mrn)).toEqual(patient);
    expect(order(db, w.accessioned.order_id)!.patient_ref_id).toBe(accessioned.patient_ref_id);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM task WHERE kind = 'source_conflict' AND status = 'open' AND entity_type IN ('patient_ref','source_order')").n).toBe(2);
  });

  it("7. missing required data: NAK 400 with the paths, one attempt only (no retry on a NAK), kept in the failure queue", async () => {
    const db = testDb();
    const r = await runIn(db, "missing-data");
    expect(r.ok).toBe(true);
    expect(r.steps[0].attempts).toHaveLength(1);
    expect(r.steps[0].errors.map((e) => `${e.path}:${e.code}`).sort()).toEqual(["payload.patient.birth_date:required", "payload.specimens.0.site:required"]);
    expect(event(db, "sim/missing-data/SIM-90701#v1")!.outcome).toBe("failed");
    expect(order(db, "SIM-90701")).toBeUndefined();
  });

  it("8. out of order (v3 then v2): v3 stays; v2 is stale and not stored", async () => {
    const db = testDb();
    const r = await runIn(db, "out-of-order");
    expect(r.steps.map((s) => s.result)).toEqual(["accepted", "accepted", "stale"]);
    const o = order(db, "SIM-90801")!;
    expect(o.source_version).toBe(3);
    expect(all<{ source_version: number }>(db, "SELECT source_version FROM source_order_version WHERE source_order_id = ? ORDER BY source_version", o.id).map((v) => v.source_version)).toEqual([1, 3]);
  });

  it("9. delayed acknowledgment: the request waits for the source's acknowledgment, which arrives late and changes nothing", async () => {
    const db = testDb();
    const params = prepareDelayedAck(db);
    expect(params.requestId).toMatch(/^AR-\d{4}$/);
    const waiting = loadReconciliation(db).rows.find((r) => r.kind === "accession")!;
    expect(waiting).toMatchObject({ status: "waiting", difference: `Issued ${params.accessionNumber}; waiting for the source's acknowledgment.` });
    const sleeps: number[] = [];
    const snap = localSnapshot(db);
    const r = await runIn(db, "delayed-ack", { delayedAck: { ...params, delayMs: 15_000 }, sleep: async (ms) => void sleeps.push(ms) });
    expect(r.ok).toBe(true);
    expect(sleeps).toEqual([15_000]);
    expect(localSnapshot(db)).toEqual(snap);
    expect(loadReconciliation(db).summary.unacknowledgedAccessionRequests).toBe(0);
    expect(event(db, `sim/delayed-ack/${params.requestId}/${params.accessionNumber}`)).toMatchObject({ outcome: "applied", message_type: "accession.acknowledged" });
  });

  it("9 without a request id is skipped with guidance (the simulator never invents a laboratory request)", async () => {
    const db = testDb();
    const r = await runIn(db, "delayed-ack");
    expect(r).toMatchObject({ skipped: true, ok: false, steps: [] });
    expect(r.notes[0]).toMatch(/--request AR-0001/);
  });

  it("10. source outage: every attempt refused with 503, the source backs off and keeps both messages; nothing recorded", async () => {
    const db = testDb();
    const before = counts(db);
    const r = await runIn(db, "source-outage");
    expect(r.ok).toBe(true);
    expect(r.backlog).toHaveLength(2);
    expect(r.steps.every((s) => s.result === "unavailable" && s.attempts.length === 5)).toBe(true);
    expect(order(db, "SIM-91001")).toBeUndefined();
    const after = counts(db);
    expect({ ...after, audit: before.audit }).toEqual(before); // only the presenter control's own audit rows (offline, restored)
    expect(one<{ status: string }>(db, "SELECT status FROM integration_source WHERE id = 'src_ema'").status).toBe("connected");
  });

  it("11. recovery: the backlog left by the outage is delivered exactly once (10 then 11 sharing the source's outbox)", async () => {
    const db = testDb();
    const state = new SimSourceState();
    await runIn(db, "source-outage", { state });
    const r = await runIn(db, "recovery", { state });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.result)).toEqual(["accepted", "accepted", "duplicate", "duplicate"]); // no second outage phase
    expect(state.outbox).toEqual([]);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id IN ('SIM-91001','SIM-91002')").n).toBe(2);
  });

  it("12. unexpected versions: contract 2.0 refused (422), a lower source version is stale, an unknown source is refused (401)", async () => {
    const db = testDb();
    const r = await runIn(db, "unexpected-version");
    expect(r.steps.map((s) => s.result)).toEqual(["unsupported_version", "accepted", "stale", "unauthorized"]);
    expect(order(db, "SIM-91202")!.source_version).toBe(2);
    expect(order(db, "SIM-91201")).toBeUndefined();
    expect(order(db, "SIM-91203")).toBeUndefined();
    expect(event(db, "sim/unexpected-version/SIM-91201#v1-c2")).toBeUndefined();
    expect(event(db, "sim/unexpected-version/SIM-91203#v1")).toBeUndefined();
  });

  it("all 12 in sequence on one database (as `npm run integration:sim -- all --in-process` runs them)", async () => {
    const db = testDb();
    const state = new SimSourceState();
    const delayedAck = prepareDelayedAck(db);
    const reports = [];
    for (const s of SCENARIOS) reports.push(await runIn(db, s.name, { state, delayedAck }));
    expect(reports.map((r) => `${r.n}:${r.ok}`)).toEqual(SCENARIOS.map((s) => `${s.n}:true`));
    const rec = loadReconciliation(db);
    expect(rec.summary).toMatchObject({ failedImports: 1, staleIgnored: 2, unacknowledgedAccessionRequests: 0 });
  });
});

describe("delivery policy", () => {
  it("exponential backoff with deterministic jitter, capped, never below the server's Retry-After", () => {
    const rand = seededRandom("x");
    const delays = [1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, DEFAULT_RETRY, rand));
    delays.forEach((d, i) => {
      const exp = Math.min(DEFAULT_RETRY.maxDelayMs, DEFAULT_RETRY.baseDelayMs * 2 ** i);
      expect(d).toBeGreaterThanOrEqual(exp / 2);
      expect(d).toBeLessThanOrEqual(exp);
    });
    expect(backoffDelayMs(1, DEFAULT_RETRY, seededRandom("x"), 3)).toBe(3000);
    expect(backoffDelayMs(1, DEFAULT_RETRY, seededRandom("x"), 600)).toBe(DEFAULT_RETRY.maxDelayMs);
    expect([1, 2, 3].map((n) => backoffDelayMs(n, DEFAULT_RETRY, seededRandom("same")))).toEqual([1, 2, 3].map((n) => backoffDelayMs(n, DEFAULT_RETRY, seededRandom("same"))));
  });
});
