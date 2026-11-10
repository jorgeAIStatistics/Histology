// The source-versus-local reconciliation read model (src/server/integration/reconciliation.ts). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, must, one, STAFF, clockAt } from "../helpers";
import { loadReconciliation, type ReconRow } from "@/server/integration/reconciliation";
import { pumpSources } from "@/server/sim/pump";
import { ROOT_SECRET, at, enableInbound, envelope, orderPayload, post, restoreEnv, runIn } from "./support";

beforeAll(enableInbound);
afterAll(restoreEnv);

const changes = (db: ReturnType<typeof testDb>) => (db.prepare("SELECT total_changes() n").get() as { n: number }).n;

describe("the reconciliation read model", () => {
  it("writes nothing", async () => {
    const db = testDb();
    await runIn(db, "conflicting-identifiers");
    await runIn(db, "missing-data");
    const before = changes(db);
    loadReconciliation(db);
    loadReconciliation(db, { includeInSync: true });
    expect(changes(db)).toBe(before);
  });

  it("on the untouched seed, every linked order is compared and every row carries the full shape", () => {
    const db = testDb();
    const rec = loadReconciliation(db, { includeInSync: true });
    const linked = one<{ n: number }>(
      db,
      "SELECT COUNT(*) n FROM source_order so WHERE EXISTS (SELECT 1 FROM intake_order_link l WHERE l.source_order_id = so.id) OR EXISTS (SELECT 1 FROM specimen_part sp WHERE sp.source_order_id = so.id)",
    ).n;
    expect(rec.summary.ordersCompared).toBe(linked);
    expect(rec.summary.ordersInSync + rec.summary.ordersWithDifferences).toBe(linked);
    expect(rec.generatedAt).toBe(at("10:52"));
    const keys: (keyof ReconRow)[] = ["key", "kind", "sourceId", "entity", "externalAssertion", "localState", "difference", "sourceEventTime", "localReceivedTime", "impactedWork", "review", "status"];
    for (const r of rec.rows) for (const k of keys) expect(r).toHaveProperty(k);
    expect(new Set(rec.rows.map((r) => r.key)).size).toBe(rec.rows.length);
    // The default view lists only what differs or waits.
    expect(loadReconciliation(db).rows.every((r) => r.status !== "in_sync")).toBe(true);
  });

  it("lists failed imports, stale-ignored messages, open source conflicts and open correction reviews with their reviews", async () => {
    const db = testDb();
    clockAt(db, "11:25");
    pumpSources(db); // seed: the 11:20 PAS cancellation and the 11:25 stale replay of ORD-75347 v1
    await runIn(db, "missing-data");
    await post(db, envelope({ messageId: "R-NEW#v1", payload: orderPayload({ orderId: "R-90001", mrn: worldMrn(db), name: "Other, Person", birthDate: "1900-01-01" }) }));
    const rec = loadReconciliation(db);
    const kinds = new Set(rec.rows.map((r) => r.kind));
    for (const k of ["failed_import", "stale_ignored", "source_conflict"] as const) expect(kinds.has(k)).toBe(true);
    const stale = rec.rows.find((r) => r.kind === "stale_ignored" && r.messageId === "ORD-75347#v1-replay")!;
    expect(stale).toMatchObject({ status: "ignored", localState: "Stored v2 kept", sourceId: "src_ema" });
    const conflict = rec.rows.find((r) => r.kind === "source_conflict")!;
    expect(conflict).toMatchObject({ status: "review_open", entity: { type: "patient_ref", label: "Patient reference on file" }, review: { required: true } });
    expect(conflict.review.taskId).toBe(conflict.impactedWork.tasks[0].id);
    expect(rec.summary).toMatchObject({ failedImports: 1, openSourceConflicts: 1 });
    // A canceled stain with prepared material: the order is in sync (the work order review is the bench's), nothing hidden.
    expect(rec.summary.ordersCompared).toBeGreaterThan(0);
  });

  it("a canceled order with local work in progress is listed with the open review task and the impacted parts", async () => {
    const db = testDb();
    const so = one<{ id: string; source_order_id: string }>(db, "SELECT id, source_order_id FROM source_order WHERE id = 'ord_ord_75061'");
    const p = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = ? AND source_version = 1", so.id).payload);
    const r = await post(db, envelope({ messageId: "R-CANCEL#v2", type: "order.cancel", payload: { ...p, version: 2, status: "canceled", updated_at: at("10:44") }, sentAt: at("10:45") }));
    expect(r.body).toMatchObject({ status: "accepted", review_required: true });
    const row = loadReconciliation(db).rows.find((x) => x.kind === "cancellation" && x.entity.id === so.id)!;
    expect(row.status).toBe("review_open");
    expect(row.difference).toMatch(/Canceled at source while local work is in progress: D26-04749 part A \(\d+ blocks?, \d+ slides?\)/);
    expect(row.impactedWork.parts.map((x) => x.label)).toContain("D26-04749 part A");
    expect(row.review.taskId).toBe(one<{ id: string }>(db, "SELECT id FROM task WHERE kind = 'order_change_review' AND entity_type = 'specimen_part' AND entity_id = 'acc_d26_04749_pa'").id);
    expect(row).toMatchObject({ sourceEventTime: at("10:45"), localReceivedTime: at("10:52"), messageId: "R-CANCEL#v2" });
  });

  it("an amended order checked against an older version before accession is flagged, with the re-check task the importer opened", async () => {
    const db = testDb();
    must(db, STAFF.tanya, "demo.runStep", { step: 1, autoStaffActions: true });
    const c = one<{ id: string; version: number; order_part_id: string; order_id: string; version_now: number }>(
      db,
      `SELECT c.id, c.version, c.order_part_id, sop.source_order_id order_id, so.source_version version_now FROM container c
         JOIN source_order_part sop ON sop.id = c.order_part_id JOIN source_order so ON so.id = sop.source_order_id
         JOIN intake_item ii ON ii.id = c.intake_item_id
        WHERE ii.status NOT IN ('accessioned','canceled') ORDER BY ii.display_id, c.seq LIMIT 1`,
    );
    must(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id });
    const p = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = ? ORDER BY source_version DESC LIMIT 1", c.order_id).payload);
    const v = { ...p, version: c.version_now + 1, updated_at: at("11:00"), specimens: p.specimens.map((s: { site: string }) => ({ ...s, site: `${s.site} (revised)` })) };
    const r = await post(db, envelope({ messageId: `R-RECHECK#v${v.version}`, type: "order.amend", payload: v }));
    expect(r.body).toMatchObject({ status: "accepted", review_required: true });
    const row = loadReconciliation(db).rows.find((x) => x.kind === "site_laterality" && x.entity.id === c.order_part_id)!;
    expect(row.difference).toMatch(new RegExp(`checked against v${c.version_now}; the source is now at v${v.version}`));
    expect(row.status).toBe("review_open");
    // The importer's own review for this part: a re-check task, or (when a hold covers it) "review and release" the hold.
    expect(row.review).toMatchObject({ required: true, taskStatus: "open" });
    expect(row.review.taskTitle).toMatch(/re-check|Amended order received — review and release/);
  });

  it("never exposes a secret, a signature or a raw payload", async () => {
    const db = testDb();
    await runIn(db, "new-order");
    await runIn(db, "missing-data");
    const text = JSON.stringify(loadReconciliation(db, { includeInSync: true }));
    expect(text).not.toContain(ROOT_SECRET);
    expect(text).not.toMatch(/v1=[0-9a-f]{64}|x-hlos-signature|resourceType/i);
  });
});

function worldMrn(db: ReturnType<typeof testDb>): string {
  return (JSON.parse(one<{ payload: string }>(db, "SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = 'ORD-77150'").payload) as { patient: { mrn: string } }).patient.mrn;
}
