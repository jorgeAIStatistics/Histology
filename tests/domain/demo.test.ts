import { describe, it, expect, beforeAll } from "vitest";
import type { DB } from "@/server/db/db";
import { testDb, run, must, one, all, STAFF, simulate } from "../helpers";
import { listCommands } from "@/server/commands";
import { loadActor, makeCtx } from "@/server/core/context";
import { readClock } from "@/server/core/clock";
import {
  DEMO_IDS,
  STEP_COMMANDS,
  demoStatus,
  missingCommandsFor,
  runDemoStep,
  type DemoStepNumber,
  type DemoStepResult,
} from "@/server/domain/demoSteps";
import { caseReadiness } from "@/server/domain/readiness";
import { getOperations } from "@/server/queries/operations";
import {
  MIN_N_FOR_P90,
  P90_TOO_SMALL,
  getInsights,
  median,
  nearestRank,
  p90,
  summarizeTimings,
  type TimingItem,
} from "@/server/queries/insights";
import { BLANK_INPUTS, ILLUSTRATIVE_EXAMPLE, computeScenario, type ScenarioInputs } from "@/components/insights/scenario-math";
import { checkText, missingRecordText, recordsDoneText } from "@/components/demo/content";

const STEPS: DemoStepNumber[] = [1, 2, 3, 4, 5, 6, 7, 8];
const registered = new Set(listCommands().map((c) => c.name));
/** Commands from other slices the full rehearsal journey needs (contract names). */
const journeyMissing = [...new Set(STEPS.flatMap((s) => missingCommandsFor(s, true, registered)))];

/** it() when every named command is registered; otherwise it.todo naming what is missing (other slices ship concurrently). */
const itNeeds = (names: string[], name: string, fn: () => void) => {
  const missing = names.filter((n) => !registered.has(n));
  return missing.length ? it.todo(`${name} [waiting for: ${missing.join(", ")}]`) : it(name, fn);
};

const T0 = "2026-10-14T14:00:00.000Z"; // 10:00 ET
const plus = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

// ---------------------------------------------------------------------------------------------
describe("insights statistics: nearest-rank percentiles, still-open and missing events", () => {
  it("uses the nearest-rank method, so every reported percentile is an observed value", () => {
    const v = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10].sort((a, b) => a - b);
    expect(nearestRank(v, 50)).toBe(5); // rank ceil(0.5*10) = 5
    expect(nearestRank(v, 90)).toBe(9); // rank ceil(0.9*10) = 9, no floating-point overshoot to 10
    expect(nearestRank([10, 20, 30, 40, 50, 60, 70], 50)).toBe(40); // rank ceil(3.5) = 4
    expect(nearestRank([42], 90)).toBe(42);
    expect(nearestRank([], 50)).toBeNull();
    // Median does not average the two middle values; it reports an actual observation.
    expect(median([4, 1, 3, 2])).toBe(2);
  });

  it("withholds the 90th percentile when fewer than 10 completed observations exist", () => {
    expect(MIN_N_FOR_P90).toBe(10);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({ value: null, reason: P90_TOO_SMALL });
    expect(p90(Array.from({ length: 10 }, (_, i) => i + 1))).toEqual({ value: 9, reason: null });
    expect(p90([]).value).toBeNull();
  });

  it("reports still-open items separately: they never enter the median or p90", () => {
    const items: TimingItem[] = [
      { ref: "a", start: T0, end: plus(10), open: false },
      { ref: "b", start: T0, end: plus(20), open: false },
      { ref: "c", start: T0, end: plus(30), open: false },
      { ref: "open-1", start: plus(-600), end: null, open: true },
      { ref: "open-2", start: plus(-60), end: null, open: true },
    ];
    const s = summarizeTimings(items, plus(0));
    expect(s.n).toBe(3);
    expect(s.medianMin).toBe(20);
    expect(s.stillOpen).toBe(2);
    expect(s.stillOpenOldestMin).toBe(600);
    expect(s.p90Min).toBeNull();
    expect(s.p90Note).toBe(P90_TOO_SMALL);
    expect(s.total).toBe(5);
  });

  it("counts missing or invalid events as missing instead of treating them as fast (zero) completions", () => {
    const items: TimingItem[] = [
      { ref: "ok", start: T0, end: plus(45), open: false },
      { ref: "no-start", start: null, end: plus(5), open: false },
      { ref: "no-end", start: T0, end: null, open: false },
      { ref: "end-before-start", start: plus(30), end: plus(10), open: false },
      { ref: "open-unknown-age", start: null, end: null, open: true },
    ];
    const s = summarizeTimings(items, plus(60));
    expect(s.n).toBe(1);
    expect(s.values).toEqual([45]);
    expect(s.minMin).toBe(45); // no zero-minute "completions" were invented
    expect(s.missing).toBe(3);
    expect(s.missingPct).toBe(60); // reported as a number AND a percent of all items (3 of 5)
    expect(s.missingRefs.sort()).toEqual(["end-before-start", "no-end", "no-start"]);
    expect(s.stillOpen).toBe(1);
    expect(s.stillOpenAgeUnknown).toBe(1);
    expect(s.stillOpenOldestMin).toBeNull(); // unknown age stays unknown, not 0
  });
});

// ---------------------------------------------------------------------------------------------
describe("insights on the seeded synthetic day", () => {
  it("measures clarification times on illustrative prior days with still-open shown separately", () => {
    const db = testDb();
    const ins = getInsights(db);
    const ack = ins.clarAck.prior;
    expect(ins.priorDays.length).toBeGreaterThanOrEqual(5);
    expect(ack.n).toBeGreaterThanOrEqual(MIN_N_FOR_P90);
    expect(ack.p90Min).not.toBeNull();
    expect(ack.medianMin!).toBeLessThanOrEqual(ack.p90Min!);
    // Some illustrative clarifications never got an answer: they are open, not counted as fast.
    expect(ack.stillOpen).toBeGreaterThan(0);
    expect(ack.n + ack.stillOpen + ack.missing).toBe(ack.total);
    // Resolution: an answer is not a resolution, so resolution n never exceeds acknowledgement n.
    expect(ins.clarResolve.prior.n).toBeLessThanOrEqual(ack.n);
  });

  it("today's live sample is small, so p90 is withheld rather than reported from a handful of cases", () => {
    const db = testDb();
    const ins = getInsights(db);
    const t = ins.clarAck.today;
    expect(t.n).toBeLessThan(MIN_N_FOR_P90);
    expect(t.p90Min).toBeNull();
    expect(t.p90Note).toBe(P90_TOO_SMALL);
    // The seeded open clarifications (e.g. sent but not acknowledged) are counted as still open.
    expect(t.stillOpen).toBeGreaterThan(0);
  });

  it("illustrates the evening-batch pattern in gross approval to source entry (illustrative data only)", () => {
    const db = testDb();
    const g = getInsights(db).grossEntry;
    expect(g.prior.n).toBeGreaterThan(100);
    expect(g.eveningEntries / g.priorEntries).toBeGreaterThan(0.5);
    expect(g.histogram.reduce((a, b) => a + b.count, 0)).toBe(g.prior.n);
    // Today's approved records still waiting for entry are open items, not zero-minute entries.
    expect(g.today.stillOpen).toBeGreaterThan(0);
  });

  it("snapshots unresolved work by type with ages, including the unknown-outcome print job", () => {
    const db = testDb();
    const w = getInsights(db).workAge;
    const print = w.rows.find((r) => r.type === "print_unknown")!;
    expect(print.count).toBe(1);
    expect(print.oldestRef).toBe(DEMO_IDS.printJobDisplay);
    expect(print.oldestMin).toBeGreaterThan(0);
    expect(w.unreadableTypes).toBe(0);
    expect(w.total).toBe(w.rows.reduce((a, r) => a + (r.count ?? 0), 0));
    for (const r of w.rows) {
      expect(r.count).not.toBeNull();
      expect(r.buckets.reduce((a, b) => a + b, 0) + r.ageUnknown).toBe(r.count);
      expect(r.ownerRoles.length).toBeGreaterThan(0); // M5 is broken down by owning role
    }
  });

  it("counts a failed source entry as unresolved work, not as done", () => {
    const db = testDb();
    const before = getInsights(db).workAge.rows.find((r) => r.type === "source_entry")!.count!;
    const g = one<{ id: string } | undefined>(
      db,
      "SELECT id FROM gross_record WHERE state = 'approved_for_downstream' AND source_update_state = 'entered_attested' LIMIT 1",
    );
    expect(g).toBeTruthy();
    db.prepare("UPDATE gross_record SET source_update_state = 'failed' WHERE id = ?").run(g!.id); // fixture: a rejected entry
    expect(getInsights(db).workAge.rows.find((r) => r.type === "source_entry")!.count).toBe(before + 1);
  });

  it("filters illustrative data by office and dermatopathologist without inventing unassigned zeros", () => {
    const db = testDb();
    const allDocs = getInsights(db);
    const marsh = getInsights(db, { doctor: "stf_marsh" });
    expect(marsh.byDoctor.rows.map((r) => r.id)).toEqual(["stf_marsh"]);
    // Today's figures are never filtered: every dermatopathologist still appears.
    expect(marsh.byDoctor.todayRows.map((r) => r.id)).toEqual(allDocs.byDoctor.todayRows.map((r) => r.id));
    expect(marsh.byDoctor.todayRows.length).toBeGreaterThan(1);
    expect(marsh.arrivals.priorArrivals).toBeLessThan(allDocs.arrivals.priorArrivals);
    const hpd = getInsights(db, { office: "off_hpd" });
    expect(hpd.arrivals.priorArrivals).toBeGreaterThan(0);
    expect(hpd.arrivals.priorArrivals).toBeLessThan(allDocs.arrivals.priorArrivals);
  });
});

// ---------------------------------------------------------------------------------------------
describe("guided demo: step runner safety", () => {
  it("knows which commands from other slices each step needs and reports the missing ones", () => {
    const none = new Set<string>();
    expect(missingCommandsFor(1, false, none)).toEqual(["intake.receiveDelivery", "intake.receiveAll"]);
    expect(missingCommandsFor(1, true, none)).toContain("routing.confirm");
    expect(missingCommandsFor(8, true, none)).toEqual([]);
    const everything = new Set(STEPS.flatMap((s) => [...STEP_COMMANDS[s].world, ...STEP_COMMANDS[s].staff]));
    for (const s of STEPS) expect(missingCommandsFor(s, true, everything)).toEqual([]);
  });

  it("shows no step as done on the fresh seed (progress is derived from data)", () => {
    const db = testDb();
    const st = demoStatus(db);
    expect(st.doneCount).toBe(0);
    expect(st.steps.every((s) => s.state === "not_started")).toBe(true);
    expect(st.ids.accession).toBeNull();
    expect(st.lastResults).toEqual({});
  });

  it("does not run staff work or invent records when the presenter has not reached a step", () => {
    const db = testDb();
    const before = {
      intake: one<{ n: number }>(db, "SELECT COUNT(*) n FROM intake_item").n,
      clar: one<{ n: number }>(db, "SELECT COUNT(*) n FROM clarification").n,
      holds: one<{ n: number }>(db, "SELECT COUNT(*) n FROM hold").n,
    };
    for (const step of [2, 3, 4] as DemoStepNumber[]) {
      const res = run<DemoStepResult>(db, STAFF.tanya, "demo.runStep", { step });
      expect(res.ok).toBe(true);
      if (res.ok) expect(["needs_presenter", "not_available"]).toContain(res.result.status);
    }
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM intake_item").n).toBe(before.intake);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM clarification").n).toBe(before.clar);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM hold").n).toBe(before.holds);
  });

  it("step 8 moves the demo clock forward and audits the run (never backward on re-run)", () => {
    const db = testDb();
    const r1 = must<DemoStepResult>(db, STAFF.director, "demo.runStep", { step: 8 });
    expect(r1.status).toBe("ran");
    expect(r1.clockAfter).toBe("2026-10-14T15:50:00.000Z"); // 11:50 ET
    const a = one<{ summary: string; origin: string }>(db, "SELECT summary, origin FROM audit_event WHERE action = 'demo.step_run' ORDER BY seq DESC LIMIT 1");
    expect(a.summary).toMatch(/^Demo step 8 run/);
    expect(a.origin).toBe("demo");
    const r2 = must<DemoStepResult>(db, STAFF.director, "demo.runStep", { step: 1 });
    // Even if step 1 is not available yet, the clock never moves back to 11:00.
    expect(Date.parse(r2.clockAfter)).toBeGreaterThanOrEqual(Date.parse(r1.clockAfter));
    const st = demoStatus(db);
    // Step 8 is a review: pressing its button does not make it "done"; only the earlier steps' records do.
    expect(st.steps.find((s) => s.step === 8)!.state).not.toBe("done");
    // The last run of each step is kept, so the guide's action log survives a page reload.
    expect(st.lastResults[8]?.status).toBe("ran");
    expect(st.lastResults[8]?.clockAfter).toBe(r1.clockAfter);
  });

  it("refuses with 'not available' and changes nothing (no clock move, audit or log) when a needed command is missing", () => {
    const db = testDb();
    const ctx = makeCtx(db, loadActor(db, STAFF.tanya), "user");
    const clock = readClock(db).now;
    const audits = one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event").n;
    const res = runDemoStep(ctx, 1, false, new Set()); // as if intake had not shipped yet
    expect(res.status).toBe("not_available");
    expect(res.missingCommands).toEqual(["intake.receiveDelivery", "intake.receiveAll"]);
    expect(res.actions).toEqual([]);
    expect(readClock(db).now).toBe(clock);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event").n).toBe(audits);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM demo_step_log").n).toBe(0);
    expect(one<{ arrived_at: string | null }>(db, "SELECT arrived_at FROM courier_delivery WHERE id = ?", DEMO_IDS.delivery).arrived_at).toBeNull();
  });

  it("limits rehearsal (acting as other named staff) to the supervisor demo role; world events stay open to every role", () => {
    const db = testDb();
    for (const actor of [STAFF.director, STAFF.kim, STAFF.maya]) {
      const res = run(db, actor, "demo.runStep", { step: 1, autoStaffActions: true });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    }
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM demo_step_log").n).toBe(0);
    expect(one<{ arrived_at: string | null }>(db, "SELECT arrived_at FROM courier_delivery WHERE id = ?", DEMO_IDS.delivery).arrived_at).toBeNull();
    // The read-only director can still run the simulator events of a step.
    expect(must<DemoStepResult>(db, STAFF.director, "demo.runStep", { step: 8 }).status).toBe("ran");
  });

  it("rejects an out-of-range step", () => {
    const db = testDb();
    const res = run(db, STAFF.tanya, "demo.runStep", { step: 9 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION");
  });

  it("the guide's rail and step chip count the same record checks, and a missing check is named as a record, not claimed", () => {
    const db = testDb();
    must<DemoStepResult>(db, STAFF.tanya, "demo.runStep", { step: 8 }); // the run finishes; the step's record check does not
    const st = demoStatus(db);
    const s8 = st.steps.find((s) => s.step === 8)!;
    // Step 8's one server check is the earlier steps' outcomes; the guide rewords it as a condition (checkText).
    expect(s8.checks.map((c) => c.label)).toEqual(["Steps 1 to 7 reached their outcomes; Operations now shows what is still blocked"]);
    expect(checkText(8, s8.checks[0].label)).toBe("Steps 1 to 7 reach their outcomes in the records; Operations then shows what is still blocked");
    expect(recordsDoneText(s8.checks)).toBe("0 of 1 check done");
    expect(missingRecordText(s8, st.steps)).toBe("Outcomes of steps 1 to 7 (0 of 7 in the records so far)");
    // Other steps keep their own labels; more than one open check points to the Progress list.
    const s1 = st.steps.find((s) => s.step === 1)!;
    expect(checkText(1, s1.checks[0].label)).toBe(s1.checks[0].label);
    expect(recordsDoneText(s1.checks)).toBe(`0 of ${s1.checks.length} checks done`);
    expect(missingRecordText(s1, st.steps)).toBe(`${s1.checks[0].label}, and ${s1.checks.length - 1} more under Progress`);
    // Every check in: nothing is named as missing.
    expect(missingRecordText({ ...s1, state: "done", checks: s1.checks.map((c) => ({ ...c, done: true })) }, st.steps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Full hero journey (master spec §12) as a domain-level acceptance test. It drives steps 1→8 with
// autoStaffActions, so every staff action goes through the owning slice's command by name.
// While another slice has not shipped a command yet, these become it.todo (listing what is missing).
const journeyIt = (name: string, fn: () => void) =>
  journeyMissing.length ? it.todo(`${name} [waiting for: ${journeyMissing.join(", ")}]`) : it(name, fn);

describe("guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode)", () => {
  let db: DB;
  const results = {} as Record<DemoStepNumber, DemoStepResult>;
  const ids = { orderA: "", orderB: "", partBOrderPart: "", accession: "" };

  beforeAll(() => {
    if (journeyMissing.length) return;
    db = testDb();
    for (const step of STEPS) results[step] = must<DemoStepResult>(db, STAFF.tanya, "demo.runStep", { step, autoStaffActions: true });
    ids.orderA = one<{ id: string }>(db, "SELECT id FROM source_order WHERE source_order_id = 'ORD-77120' AND tenant_id = 'ten_ema'").id;
    ids.orderB = one<{ id: string }>(db, "SELECT id FROM source_order WHERE source_order_id = 'ORD-77121' AND tenant_id = 'ten_ema'").id;
    ids.partBOrderPart = one<{ id: string }>(db, "SELECT id FROM source_order_part WHERE source_order_id = ?", ids.orderB).id;
    ids.accession = one<{ id: string } | undefined>(db, "SELECT id FROM accession WHERE accession_number = 'D26-04817'")?.id ?? "";
  });

  journeyIt("every step's actions complete without unexpected failures", () => {
    for (const step of STEPS) {
      const unexpected = results[step].actions.filter((a) => a.outcome === "failed" || a.outcome === "not_available");
      expect(unexpected, `step ${step}: ${JSON.stringify(unexpected)}`).toEqual([]);
    }
  });

  journeyIt("issues D26-04817 with part A on ORD-77120 and part B on ORD-77121 (both source ids preserved)", () => {
    expect(ids.accession).not.toBe("");
    const parts = all<{ designation: string; src: string }>(
      db,
      "SELECT sp.designation, so.source_order_id AS src FROM specimen_part sp JOIN source_order so ON so.id = sp.source_order_id WHERE sp.accession_id = ? ORDER BY sp.designation",
      ids.accession,
    );
    expect(parts).toEqual([
      { designation: "A", src: "ORD-77120" },
      { designation: "B", src: "ORD-77121" },
    ]);
    // Both intake items point at the one accession; neither was deleted or merged.
    const items = all<{ accession_id: string | null }>(
      db,
      "SELECT ii.accession_id FROM sim_physical_item p JOIN intake_item ii ON ii.id = p.received_intake_item_id WHERE p.id IN (?, ?)",
      DEMO_IDS.physA,
      DEMO_IDS.physB,
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.accession_id === ids.accession)).toBe(true);
  });

  journeyIt("reviews the related-order candidate (lead decision) without merging the two orders", () => {
    const [a, b] = [ids.orderA, ids.orderB].sort();
    const cand = one<{ status: string; reviewed_by: string; decision_reason: string }>(
      db,
      "SELECT status, reviewed_by, decision_reason FROM related_order_candidate WHERE order_a_id = ? AND order_b_id = ?",
      a,
      b,
    );
    expect(cand.status).toBe("single_accession_approved");
    expect(cand.reviewed_by).toBe(STAFF.kim);
    expect(cand.decision_reason.length).toBeGreaterThan(0);
    // Two separate source orders, each with its own part, still exist.
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order WHERE id IN (?, ?)", ids.orderA, ids.orderB).n).toBe(2);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_part WHERE source_order_id IN (?, ?)", ids.orderA, ids.orderB).n).toBe(2);
  });

  journeyIt("resolves the Part B laterality clarification only after review, and releases its hold only after the amended order arrived", () => {
    const clr = one<{ id: string; state: string; answered_at: string; reviewed_at: string; resolved_at: string; resolution_code: string }>(
      db,
      "SELECT id, state, answered_at, reviewed_at, resolved_at, resolution_code FROM clarification WHERE category = 'laterality' AND order_part_id = ? ORDER BY created_at DESC LIMIT 1",
      ids.partBOrderPart,
    );
    expect(clr.state).toBe("resolved");
    expect(clr.resolution_code).toBe("confirmed_observed");
    expect(Date.parse(clr.answered_at)).toBeLessThanOrEqual(Date.parse(clr.reviewed_at));
    expect(Date.parse(clr.reviewed_at)).toBeLessThanOrEqual(Date.parse(clr.resolved_at));

    const hold = one<{ status: string; blocks: string; released_at: string; released_by: string; release_reason: string; scope_type: string }>(
      db,
      "SELECT status, blocks, released_at, released_by, release_reason, scope_type FROM hold WHERE clarification_id = ?",
      clr.id,
    );
    const blocks = JSON.parse(hold.blocks) as string[];
    expect(blocks).toEqual(expect.arrayContaining(["gross_approval", "processing", "print", "tray_delivery"]));
    expect(blocks).not.toContain("accession_request");
    expect(hold.status).toBe("released");
    expect(hold.released_by).toBe(STAFF.kim);
    expect(hold.release_reason.length).toBeGreaterThan(0);

    const v2 = one<{ imported_at: string } | undefined>(db, "SELECT imported_at FROM source_order_version WHERE source_order_id = ? AND source_version = 2", ids.orderB);
    expect(v2).toBeTruthy();
    expect(Date.parse(hold.released_at)).toBeGreaterThanOrEqual(Date.parse(v2!.imported_at));
    // The original order version (RIGHT) is preserved next to the amendment.
    const v1 = one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = ? AND source_version = 1", ids.orderB);
    expect(v1.payload.toLowerCase()).toContain("right");
  });

  journeyIt("approving Part A makes A1 eligible and opens a source-entry task for Sam, while Part B stays incomplete", () => {
    const r = caseReadiness(db, ids.accession)!;
    const A = r.parts.find((p) => p.designation === "A")!;
    const B = r.parts.find((p) => p.designation === "B")!;
    expect(A.grossState).toBe("approved_for_downstream");
    expect(A.eligible.some((e) => e.includes("A1") && /processing/i.test(e))).toBe(true);
    // Local approval never implies a source-system write.
    expect(A.sourceUpdateState).toBe("pending_entry");
    const task = one<{ owner_id: string } | undefined>(
      db,
      "SELECT owner_id FROM task WHERE kind = 'source_entry' AND accession_id = ? AND status IN ('open','in_progress')",
      ids.accession,
    );
    expect(task?.owner_id).toBe(STAFF.sam);
    expect(B.grossState).toBe("not_started");
    expect(B.stage).toBe("awaiting_gross");
    expect(r.isComplete).toBe(false);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_change WHERE accession_id = ?", ids.accession).n).toBeGreaterThan(0);
  });

  journeyIt("does not verify TRY-M-03 complete while a slide is missing and an unexpected slide was scanned", () => {
    const tray = one<{ status: string }>(db, "SELECT status FROM tray WHERE id = ?", DEMO_IDS.tray);
    expect(["verified_complete", "delivered"]).not.toContain(tray.status);
    const attempt = results[6].actions.find((a) => a.command === "tray.complete");
    expect(attempt?.outcome).toBe("rejected_as_expected");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM tray_scan WHERE tray_id = ? AND result = 'unexpected'", DEMO_IDS.tray).n).toBe(1);
    const present = JSON.parse(one<{ value: string }>(db, "SELECT value FROM app_setting WHERE key = 'scenario_tray_present'").value) as { missing: string };
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM tray_scan WHERE tray_id = ? AND slide_id = ?", DEMO_IDS.tray, present.missing).n).toBe(0);
  });

  journeyIt("does not retry PJ-8841 before its unknown outcome is reconciled", () => {
    const attempts = results[6].actions.filter((a) => a.command === "print.reprint");
    expect(attempts[0]?.outcome).toBe("rejected_as_expected");
    const pj = one<{ state: string; reconciliation: string; reconciled_at: string; target_id: string }>(
      db,
      "SELECT state, reconciliation, reconciled_at, target_id FROM print_job WHERE id = ?",
      DEMO_IDS.printJob,
    );
    expect(pj.reconciliation).toBe("not_printed");
    const reprints = all<{ created_at: string; reprint_reason: string; target_id: string }>(
      db,
      "SELECT created_at, reprint_reason, target_id FROM print_job WHERE reprint_of_job_id = ?",
      DEMO_IDS.printJob,
    );
    expect(reprints).toHaveLength(1);
    expect(Date.parse(reprints[0].created_at)).toBeGreaterThanOrEqual(Date.parse(pj.reconciled_at));
    expect(reprints[0].reprint_reason.length).toBeGreaterThan(0);
    expect(reprints[0].target_id).toBe(pj.target_id); // same slide: a reprint never creates new material
  });

  journeyIt("rejects the wrong block for RR-0192 and changes nothing about it", () => {
    const scan = results[7].actions.find((a) => a.command === "retrieval.scan" && a.label.includes(DEMO_IDS.wrongBlockAccession));
    expect(scan?.outcome).toBe("rejected_as_expected");
    const wrong = one<{ id: string; custody_state: string; current_location_id: string }>(
      db,
      "SELECT b.id, b.custody_state, b.current_location_id FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = ? AND b.label_text = 'A1'",
      DEMO_IDS.wrongBlockAccession,
    );
    const fresh = testDb();
    const original = one<{ custody_state: string; current_location_id: string }>(fresh, "SELECT custody_state, current_location_id FROM block WHERE id = ?", wrong.id);
    expect(wrong.custody_state).toBe(original.custody_state);
    expect(wrong.current_location_id).toBe(original.current_location_id);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM retrieval_item WHERE request_id = ? AND block_id = ?", DEMO_IDS.retrieval, wrong.id).n).toBe(0);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM custody_event WHERE event = 'scan_mismatch'").n).toBeGreaterThan(0);
  });

  journeyIt("operations (the real read model) still shows what is blocked with owners, and every guide step reads as done from the data", () => {
    const st = demoStatus(db);
    expect(st.ids.accession).toBe("D26-04817");
    expect(st.doneCount).toBe(8);
    const ops = getOperations(db);
    const sourceEntry = ops.blocked.find((b) => b.category === "source_entry" && b.item.includes("D26-04817"));
    expect(sourceEntry?.owner).toBe("Sam Ortiz");
    // The released Part B hold is no longer listed among active holds.
    const heroHold = one<{ display_id: string }>(db, "SELECT h.display_id FROM hold h JOIN clarification c ON c.id = h.clarification_id WHERE c.order_part_id = ?", ids.partBOrderPart);
    expect(ops.blocked.some((b) => b.category === "holds" && b.item.includes(heroHold.display_id))).toBe(false);
  });

  journeyIt("leaves no open 'review and release' work for the Part B hold once it has been released", () => {
    const heroHold = one<{ display_id: string }>(db, "SELECT h.display_id FROM hold h JOIN clarification c ON c.id = h.clarification_id WHERE c.order_part_id = ?", ids.partBOrderPart);
    const stale = all<{ kind: string; title: string }>(
      db,
      "SELECT kind, title FROM task WHERE status IN ('open','in_progress') AND title LIKE '%' || ? || '%'",
      heroHold.display_id,
    );
    expect(stale, `stale tasks for released ${heroHold.display_id}: ${JSON.stringify(stale)}`).toEqual([]);
    const ops = getOperations(db);
    expect(ops.blocked.filter((b) => b.item.includes(heroHold.display_id) || b.blocks.includes(heroHold.display_id))).toEqual([]);
  });

  journeyIt("re-running steps does not duplicate intake items, accessions, clarifications or print jobs", () => {
    const count = (sql: string, ...p: unknown[]) => one<{ n: number }>(db, sql, ...p).n;
    const before = [
      count("SELECT COUNT(*) n FROM intake_item WHERE delivery_id = ?", DEMO_IDS.delivery),
      count("SELECT COUNT(*) n FROM accession"),
      count("SELECT COUNT(*) n FROM clarification"),
      count("SELECT COUNT(*) n FROM print_job"),
      count("SELECT COUNT(*) n FROM hold"),
    ];
    for (const step of [1, 3, 4, 6] as DemoStepNumber[]) must(db, STAFF.tanya, "demo.runStep", { step, autoStaffActions: true });
    const after = [
      count("SELECT COUNT(*) n FROM intake_item WHERE delivery_id = ?", DEMO_IDS.delivery),
      count("SELECT COUNT(*) n FROM accession"),
      count("SELECT COUNT(*) n FROM clarification"),
      count("SELECT COUNT(*) n FROM print_job"),
      count("SELECT COUNT(*) n FROM hold"),
    ];
    expect(after).toEqual(before);
  });
});

// The presenter path: the simulated office answer arrives, but nothing resolves or releases by itself.
const presenterMissing = [
  ...new Set([
    ...missingCommandsFor(1, true, registered),
    ...missingCommandsFor(2, true, registered),
    ...missingCommandsFor(3, false, registered),
    ...["intake.verifyContainer", "clarification.create", "clarification.send"].filter((n) => !registered.has(n)),
  ]),
];

describe("guided demo: simulator events alone never resolve work", () => {
  const name = "a simulated office answer and the amended order leave the clarification unresolved and the Part B hold active until staff act";
  if (presenterMissing.length) {
    it.todo(`${name} [waiting for: ${presenterMissing.join(", ")}]`);
    return;
  }
  it(name, () => {
    const db = testDb();
    must(db, STAFF.tanya, "demo.runStep", { step: 1, autoStaffActions: true });
    must(db, STAFF.tanya, "demo.runStep", { step: 2, autoStaffActions: true });
    // The presenter performs the Part B staff actions on the real screens (here: the same commands).
    const intakeB = one<{ id: string }>(db, "SELECT received_intake_item_id AS id FROM sim_physical_item WHERE id = ?", DEMO_IDS.physB).id;
    const c = one<{ id: string; version: number; order_part_id: string }>(db, "SELECT id, version, order_part_id FROM container WHERE intake_item_id = ?", intakeB);
    const orderB = one<{ id: string }>(db, "SELECT id FROM source_order WHERE source_order_id = 'ORD-77121' AND tenant_id = 'ten_ema'").id;
    const partB = one<{ id: string }>(db, "SELECT id FROM source_order_part WHERE source_order_id = ?", orderB).id;
    must(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id ?? partB });
    const created = must<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", {
      category: "laterality",
      refs: { intakeItemId: intakeB, sourceOrderId: orderB, orderPartId: partB, containerId: c.id },
      subjectLabel: "Part B · ORD-77121",
      question: "Bottle says left dorsal forearm; order says right. Which is correct?",
      evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", source: "bottle label" }],
      priority: "high",
      hold: { scope: { type: "order_part", id: partB }, scopeLabel: "Part B (ORD-77121 · B)", blocks: ["gross_approval", "processing", "print", "tray_delivery"] },
    });
    const v = one<{ version: number }>(db, "SELECT version FROM clarification WHERE id = ?", created.clarificationId).version;
    must(db, STAFF.maya, "clarification.send", { clarificationId: created.clarificationId, expectedVersion: v, body: "Please open the secure case view to respond." });

    const res = must<DemoStepResult>(db, STAFF.tanya, "demo.runStep", { step: 3 }); // simulator events only
    expect(res.status).toBe("ran");
    const clr = one<{ state: string }>(db, "SELECT state FROM clarification WHERE id = ?", created.clarificationId);
    expect(clr.state).toBe("answered");
    const hold = one<{ status: string }>(db, "SELECT status FROM hold WHERE clarification_id = ?", created.clarificationId);
    expect(hold.status).toBe("active");
    // The amended order did arrive from the simulated source, yet the hold waits for a lead's release.
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_version WHERE source_order_id = ? AND source_version = 2", orderB).n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// World events only ("Run simulator events"): the presenter does every staff action on the real screens.
const worldOnlyCommands = [...new Set(STEPS.flatMap((s) => STEP_COMMANDS[s].world))];

describe("guided demo: simulator events alone never do staff work", () => {
  itNeeds(worldOnlyCommands, "steps 1 to 8 without rehearsal change only the clock, the courier arrival and the unpacking", () => {
    const db = testDb();
    const scanCount = () => one<{ n: number }>(db, "SELECT COUNT(*) n FROM tray_scan WHERE tray_id = ?", DEMO_IDS.tray).n;
    const retrievalItems = () => JSON.stringify(all(db, "SELECT id, status FROM retrieval_item WHERE request_id = ? ORDER BY bench_seq", DEMO_IDS.retrieval));
    const before = { scans: scanCount(), retrieval: retrievalItems(), accessions: one<{ n: number }>(db, "SELECT COUNT(*) n FROM accession").n };

    const results = STEPS.map((step) => must<DemoStepResult>(db, STAFF.director, "demo.runStep", { step }));
    // No staff command ran (a "skipped: run step 4 first" note is not an action).
    for (const r of results) expect(r.actions.filter((a) => a.kind === "staff" && a.command)).toEqual([]);

    // Step 1 world events happened: the courier arrived and every container was unpacked.
    expect(one<{ arrived_at: string | null }>(db, "SELECT arrived_at FROM courier_delivery WHERE id = ?", DEMO_IDS.delivery).arrived_at).not.toBeNull();
    const intakeA = one<{ id: string }>(db, "SELECT received_intake_item_id AS id FROM sim_physical_item WHERE id = ?", DEMO_IDS.physA).id;
    // ...but nobody accepted the routing suggestion, reviewed the candidate, raised a question or requested an accession.
    expect(one<{ status: string }>(db, "SELECT status FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded'", intakeA).status).toBe("suggested");
    expect(all<{ status: string }>(db, "SELECT status FROM related_order_candidate WHERE status <> 'pending_review' AND order_a_id IN (SELECT id FROM source_order WHERE source_order_id IN ('ORD-77120','ORD-77121'))")).toEqual([]);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM clarification WHERE intake_item_id = (SELECT received_intake_item_id FROM sim_physical_item WHERE id = ?)", DEMO_IDS.physB).n).toBe(0);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM accession").n).toBe(before.accessions);
    // Materials untouched: no tray scans, PJ-8841 still unknown, no retrieval scans.
    expect(scanCount()).toBe(before.scans);
    expect(one<{ state: string }>(db, "SELECT state FROM print_job WHERE id = ?", DEMO_IDS.printJob).state).toBe("unknown_outcome");
    expect(retrievalItems()).toBe(before.retrieval);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM custody_event WHERE event = 'scan_mismatch' AND request_id = ?", DEMO_IDS.retrieval).n).toBe(0);
    // Steps that need the presenter say so instead of pretending.
    for (const step of [4, 5, 6, 7] as DemoStepNumber[]) expect(results[step - 1].status).toBe("needs_presenter");
    expect(demoStatus(db).steps.find((s) => s.step === 1)!.state).toBe("done");
    expect(demoStatus(db).steps.find((s) => s.step === 2)!.state).not.toBe("done");
  });
});

// Presenter-path orderings: progress must reflect what actually happened, in what order.
const heroCommands = [
  ...new Set([
    ...missingCommandsFor(1, true, new Set()),
    ...missingCommandsFor(2, true, new Set()),
    ...missingCommandsFor(3, false, new Set()),
    "intake.verifyContainer",
    "clarification.create",
    "clarification.send",
    "clarification.review",
    "clarification.resolve",
    "clarification.recordDelivery",
    "hold.release",
  ]),
];

function raisePartBClarification(db: DB): { clarificationId: string; holdId: string; orderB: string } {
  must(db, STAFF.tanya, "demo.runStep", { step: 1, autoStaffActions: true });
  must(db, STAFF.tanya, "demo.runStep", { step: 2, autoStaffActions: true });
  const intakeB = one<{ id: string }>(db, "SELECT received_intake_item_id AS id FROM sim_physical_item WHERE id = ?", DEMO_IDS.physB).id;
  const c = one<{ id: string; version: number; order_part_id: string }>(db, "SELECT id, version, order_part_id FROM container WHERE intake_item_id = ?", intakeB);
  const orderB = one<{ id: string }>(db, "SELECT id FROM source_order WHERE source_order_id = 'ORD-77121' AND tenant_id = 'ten_ema'").id;
  const partB = one<{ id: string }>(db, "SELECT id FROM source_order_part WHERE source_order_id = ?", orderB).id;
  must(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version, orderPartId: c.order_part_id ?? partB });
  const created = must<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", {
    category: "laterality",
    refs: { intakeItemId: intakeB, sourceOrderId: orderB, orderPartId: partB, containerId: c.id },
    subjectLabel: "Part B · ORD-77121",
    question: "Bottle says left dorsal forearm; order says right. Which is correct?",
    evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", source: "bottle label" }],
    priority: "high",
    hold: { scope: { type: "order_part", id: partB }, scopeLabel: "Part B (ORD-77121 · B)", blocks: ["gross_approval", "processing", "print", "tray_delivery"] },
  });
  const v = one<{ version: number }>(db, "SELECT version FROM clarification WHERE id = ?", created.clarificationId).version;
  must(db, STAFF.maya, "clarification.send", { clarificationId: created.clarificationId, expectedVersion: v, body: "Please open the secure case view to respond." });
  const holdId = one<{ id: string }>(db, "SELECT id FROM hold WHERE clarification_id = ?", created.clarificationId).id;
  return { clarificationId: created.clarificationId, holdId, orderB };
}

describe("guided demo: progress follows the order of events in the records", () => {
  itNeeds(heroCommands, "a hold released BEFORE the amended order arrived does not count as 'released after the amendment'", () => {
    const db = testDb();
    const { clarificationId, holdId, orderB } = raisePartBClarification(db);
    simulate(db, "clarification.simulateOfficeAnswer", { clarificationId });
    const ver = (t: string, id: string) => one<{ version: number }>(db, `SELECT version FROM ${t} WHERE id = ?`, id).version;
    must(db, STAFF.kim, "clarification.review", { clarificationId, expectedVersion: ver("clarification", clarificationId), note: "Office says left." });
    must(db, STAFF.kim, "clarification.resolve", { clarificationId, expectedVersion: ver("clarification", clarificationId), resolutionCode: "confirmed_observed", note: "Left confirmed." });
    must(db, STAFF.kim, "hold.release", { holdId, expectedVersion: ver("hold", holdId), reason: "Released early (before the amended order)." });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_version WHERE source_order_id = ? AND source_version >= 2", orderB).n).toBe(0);

    must(db, STAFF.tanya, "demo.runStep", { step: 3 }); // the amendment can now arrive from the simulated source
    const step3 = demoStatus(db).steps.find((s) => s.step === 3)!;
    const check = step3.checks.find((c) => c.label.startsWith("Hold released after"))!;
    expect(check.done).toBe(false);
    expect(check.detail).toMatch(/^Released (before the amended order arrived|, but the amended order has not arrived)/);
    expect(step3.state).not.toBe("done");
    // The scope check is real: this hold is on order part B only.
    expect(step3.checks.find((c) => c.label === "Hold placed on Part B only")!.done).toBe(true);
  });

  itNeeds(heroCommands, "the simulated office never answers a question whose delivery failed; the presenter is asked to resend first", () => {
    const db = testDb();
    const { clarificationId } = raisePartBClarification(db);
    must(db, STAFF.maya, "clarification.recordDelivery", { clarificationId, outcome: "delivery_failed", note: "Fax line busy (simulated)" });
    const res = must<DemoStepResult>(db, STAFF.tanya, "demo.runStep", { step: 3 });
    expect(res.status).toBe("needs_presenter");
    expect(res.message).toMatch(/Resend/);
    expect(res.actions.some((a) => a.command === "clarification.simulateOfficeAnswer")).toBe(false);
    const clr = one<{ state: string; answered_at: string | null }>(db, "SELECT state, answered_at FROM clarification WHERE id = ?", clarificationId);
    expect(clr.state).toBe("delivery_failed");
    expect(clr.answered_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("insights: canceled clarifications are excluded per the definition and counted, never silently dropped", () => {
  itNeeds([...heroCommands, "clarification.cancel"], "a question canceled after sending without acknowledgement is not open, not timed, and counted separately", () => {
    const db = testDb();
    const base = getInsights(db);
    const { clarificationId } = raisePartBClarification(db);
    const mid = getInsights(db);
    expect(mid.clarAck.today.stillOpen).toBe(base.clarAck.today.stillOpen + 1); // sent, waiting for the office
    must(db, STAFF.kim, "clarification.cancel", { clarificationId, reason: "Raised on the wrong container (test).", expectedVersion: one<{ version: number }>(db, "SELECT version FROM clarification WHERE id = ?", clarificationId).version });
    const after = getInsights(db);
    expect(after.clarAck.today.stillOpen).toBe(base.clarAck.today.stillOpen);
    expect(after.clarAck.today.n).toBe(base.clarAck.today.n);
    expect(after.clarAck.today.missing).toBe(base.clarAck.today.missing); // not "missing data": it was canceled
    expect(after.clarAck.todayCanceledUnacknowledged).toBe(base.clarAck.todayCanceledUnacknowledged + 1);
    expect(after.clarResolve.todayCanceledAfterSend).toBe(base.clarResolve.todayCanceledAfterSend + 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("scenario calculator arithmetic (pilot-proposal §8)", () => {
  const inputs = (o: Partial<ScenarioInputs>): ScenarioInputs => ({ ...BLANK_INPUTS, ...o });

  it("starts blank and assumes nothing for a blank input", () => {
    const r = computeScenario(BLANK_INPUTS);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["savedLow", "savedHigh", "added", "units", "days"]);
    expect(r.errors).toEqual({});
  });

  it("the illustrative example fills minutes and volumes only, so no money figure appears", () => {
    expect(ILLUSTRATIVE_EXAMPLE.rate).toBe("");
    expect(ILLUSTRATIVE_EXAMPLE.costs).toBe("");
    const r = computeScenario(ILLUSTRATIVE_EXAMPLE);
    if (!r.ready) throw new Error("example should be complete");
    // (B − P) − (V + A): 2 − 2 = 0 at the low end (the pilot proposal's point), 1 central, 2 high.
    expect([r.low.netMin, r.central?.netMin, r.high.netMin]).toEqual([0, 1, 2]);
    expect([r.low.annualHours, r.central?.annualHours, r.high.annualHours]).toEqual([0, 250, 500]); // net × 60 × 250 ÷ 60
    expect([r.low.laborValue, r.high.laborValue, r.high.netValue]).toEqual([null, null, null]);
  });

  it("accepts a zero or negative B − P and reports the resulting loss of time as it is", () => {
    const r = computeScenario(inputs({ savedLow: "-1", savedHigh: "1", added: "0.5", units: "10", days: "120" }));
    if (!r.ready) throw new Error(JSON.stringify(r.errors));
    expect(r.errors).toEqual({});
    expect(r.low.netMin).toBe(-1.5);
    expect(r.low.annualHours).toBe(-30); // −1.5 × 10 × 120 ÷ 60
    expect(r.high.annualHours).toBe(10);
  });

  it("rejects negative added minutes, volumes, days, rates and costs, and an inverted range", () => {
    const r = computeScenario(inputs({ savedLow: "3", savedCentral: "5", savedHigh: "2", added: "-1", units: "-2", days: "400", rate: "-5", costs: "x" }));
    expect(r.ready).toBe(false);
    expect(r.errors).toMatchObject({
      savedHigh: "High must be at least the low value.",
      added: "Enter zero or more.",
      units: "Enter zero or more.",
      days: "A year has at most 366 days.",
      rate: "Enter zero or more.",
      costs: "Enter a number.",
    });
    const c = computeScenario(inputs({ savedLow: "1", savedCentral: "5", savedHigh: "2", added: "0", units: "1", days: "1" }));
    expect(c.errors.savedCentral).toBe("Central must be between the low and high values.");
  });

  it("multiplies hours by the agreed rate only when one is given, and subtracts costs only when they are given", () => {
    const r = computeScenario(inputs({ savedLow: "2", savedHigh: "4", added: "1", units: "30", days: "200", rate: "50" }));
    if (!r.ready) throw new Error(JSON.stringify(r.errors));
    expect(r.low.annualHours).toBe(100); // 1 × 30 × 200 ÷ 60
    expect(r.low.laborValue).toBe(5000);
    expect(r.high.laborValue).toBe(15000);
    expect(r.low.netValue).toBeNull(); // C blank: quotes required
    const withCosts = computeScenario(inputs({ savedLow: "2", savedHigh: "4", added: "1", units: "30", days: "200", rate: "50", costs: "6000" }));
    if (!withCosts.ready) throw new Error("should be ready");
    expect([withCosts.low.netValue, withCosts.high.netValue]).toEqual([-1000, 9000]);
  });
});
