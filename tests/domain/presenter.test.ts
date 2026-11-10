// Presenter console (/demo): the read-only target lists behind the World events
// tab (src/server/queries/presenter.ts) and the synthetic-demo gate. Each list must
// offer exactly the synthetic records its simulated event can act on now: every
// listed target is accepted by the command, and records the command would refuse
// are not listed.
import { afterEach, describe, expect, it } from "vitest";
import { testDb, run, must, one, all, STAFF } from "../helpers";
import {
  SIMULATED_ANSWER_STATES,
  courierTargets,
  intakeEditTargets,
  officeAnswerTargets,
  sourceAckTargets,
  worldEventTargets,
} from "@/server/queries/presenter";
import { requirePresenterSurface } from "@/app/demo/gate";

const DELIVERY = "cr_1100";

describe("presenter console: world event targets", () => {
  it("at the 10:52 starting state lists today's courier bag, open intake items, sent clarifications, attested gross entries and every printer", () => {
    const db = testDb();
    const t = worldEventTargets(db);

    const courier = t.couriers.find((c) => c.id === DELIVERY);
    expect(courier, "the 11:00 courier bag is listed").toBeDefined();
    expect(courier!.arrivedAt).toBeNull();
    expect(courier!.total).toBeGreaterThan(0);
    expect(courier!.remaining).toBe(courier!.total);
    expect(courier!.remaining).toBe(one<{ n: number }>(db, "SELECT COUNT(*) n FROM sim_physical_item WHERE delivery_id = ? AND received_intake_item_id IS NULL", DELIVERY).n);

    expect(t.intakeItems.map((i) => i.displayId)).toContain("INT-1014-022");
    expect(t.intakeItems.every((i) => i.status !== "canceled")).toBe(true);

    // Sent and not yet answered: delivery unknown, acknowledged, sent. Never drafted, failed, answered or closed.
    const listed = t.clarifications.map((c) => c.displayId);
    expect(listed).toEqual(expect.arrayContaining(["CLR-0451", "CLR-0452", "CLR-0455"]));
    expect(listed).not.toContain("CLR-0453"); // answered
    expect(listed).not.toContain("CLR-0454"); // delivery failed
    expect(listed).not.toContain("CLR-0456"); // drafted
    const eligible = all<{ display_id: string }>(
      db,
      `SELECT display_id FROM clarification WHERE state IN (${SIMULATED_ANSWER_STATES.map((s) => `'${s}'`).join(",")}) ORDER BY display_id`,
    ).map((r) => r.display_id);
    expect(listed).toEqual(eligible);
    expect(t.clarifications.find((c) => c.displayId === "CLR-0455")).toMatchObject({ state: "sent", stateLabel: "Sent (simulated)" });

    const attested = one<{ n: number }>(
      db,
      `SELECT COUNT(*) n FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id
        WHERE gr.state = 'approved_for_downstream' AND gr.source_update_state = 'entered_attested' AND sp.status <> 'canceled'`,
    ).n;
    expect(attested).toBeGreaterThan(0);
    expect(t.grossAcks).toHaveLength(attested);
    expect(t.grossAcks.every((g) => !g.sourceOffline)).toBe(true);
    expect(t.grossAcks.every((g) => g.sourceName === null || !/\(simulated/i.test(g.sourceName))).toBe(true);

    expect(t.printers.map((p) => p.id).sort()).toEqual(all<{ id: string }>(db, "SELECT id FROM printer ORDER BY id").map((p) => p.id));
  });

  it("intake items still in review come before accessioned ones", () => {
    const db = testDb();
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    const items = intakeEditTargets(db);
    const firstClosed = items.findIndex((i) => i.status === "accessioned");
    if (firstClosed >= 0) expect(items.slice(firstClosed).every((i) => i.status === "accessioned")).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it("unpacking empties the courier bag one requisition at a time, then the delivery leaves the list", () => {
    const db = testDb();
    const before = courierTargets(db).find((c) => c.id === DELIVERY)!;
    must(db, STAFF.maya, "intake.receivePhysicalItem", { deliveryId: DELIVERY });
    const after = courierTargets(db).find((c) => c.id === DELIVERY)!;
    expect(after.remaining).toBe(before.remaining - 1);
    expect(after.arrivedAt).not.toBeNull();
    must(db, STAFF.maya, "intake.receiveAll", { deliveryId: DELIVERY });
    expect(courierTargets(db).find((c) => c.id === DELIVERY)).toBeUndefined();
  });

  it("every listed clarification is answered by the office simulator, then leaves the list; an unlisted one is refused", () => {
    const db = testDb();
    for (const c of officeAnswerTargets(db)) {
      const res = run<{ duplicate: boolean }>(db, STAFF.kim, "clarification.simulateOfficeAnswer", { clarificationId: c.id });
      expect(res.ok, `${c.displayId}: ${res.ok ? "" : res.error.message}`).toBe(true);
      if (res.ok) expect(res.result.duplicate).toBe(false);
    }
    expect(officeAnswerTargets(db)).toEqual([]);
    const failed = one<{ id: string }>(db, "SELECT id FROM clarification WHERE display_id = 'CLR-0454'");
    const refused = run(db, STAFF.kim, "clarification.simulateOfficeAnswer", { clarificationId: failed.id });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("BLOCKED");
  });

  it("every listed gross entry is acknowledged by the simulated source; while the source is offline its entries say so and the command refuses", () => {
    const db = testDb();
    must(db, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });
    const targets = sourceAckTargets(db);
    const offline = targets.filter((g) => g.sourceOffline);
    expect(offline.length).toBeGreaterThan(0);
    const refused = run(db, STAFF.sam, "gross.simulateSourceAck", { grossRecordId: offline[0].recordId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("SOURCE_OFFLINE");

    must(db, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "connected" });
    for (const g of sourceAckTargets(db)) {
      expect(g.sourceOffline).toBe(false);
      const res = run<{ replayed: boolean }>(db, STAFF.sam, "gross.simulateSourceAck", { grossRecordId: g.recordId });
      expect(res.ok, `${g.ref}: ${res.ok ? "" : res.error.message}`).toBe(true);
      if (res.ok) expect(res.result.replayed).toBe(false);
    }
    expect(sourceAckTargets(db)).toEqual([]);
  });

  it("every listed intake item accepts a simulated colleague's edit (recorded as a demo control), and the read-only director is still refused", () => {
    const db = testDb();
    const item = intakeEditTargets(db).find((i) => i.displayId === "INT-1014-022")!;
    const denied = run(db, STAFF.director, "intake.simulateColleagueEdit", { intakeItemId: item.id });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    const res = must<{ version: number; editedBy: string }>(db, STAFF.maya, "intake.simulateColleagueEdit", { intakeItemId: item.id });
    expect(res).toMatchObject({ version: 2, editedBy: "Luis Benitez" });
    const audit = one<{ origin: string }>(db, "SELECT origin FROM audit_event WHERE action = 'demo.colleague_edit_requested' ORDER BY seq DESC LIMIT 1");
    expect(audit.origin).toBe("demo");
  });

  it("the lists only read: building them changes nothing", () => {
    const db = testDb();
    const seq = () => one<{ n: number }>(db, "SELECT COALESCE(MAX(seq), 0) n FROM audit_event").n;
    const before = seq();
    worldEventTargets(db);
    worldEventTargets(db);
    expect(seq()).toBe(before);
  });
});

describe("presenter console: synthetic demo gate", () => {
  const saved = process.env.HLOS_MODE;
  afterEach(() => {
    process.env.HLOS_MODE = saved;
  });

  it("is a 404 (notFound) outside synthetic demo mode and passes in demo mode", () => {
    process.env.HLOS_MODE = "demo";
    expect(() => requirePresenterSurface()).not.toThrow();
    for (const mode of ["locked", "production", "pilot"]) {
      process.env.HLOS_MODE = mode;
      let digest: string | undefined;
      try {
        requirePresenterSurface();
      } catch (e) {
        digest = (e as { digest?: string }).digest;
      }
      expect(digest, `mode ${mode}`).toMatch(/404/);
    }
  });
});
