import { describe, it, expect } from "vitest";
import { testDb, must } from "../helpers";
import { getCase } from "@/server/queries/case";
import { caseReadiness, partDescription, partHeading, partLines, partNext, railSteps, readinessLine, stainSource, taskTitleInPart } from "@/components/case/format";
import type { TrackStep } from "@/server/queries/case";

const physical = (states: TrackStep["state"][]): TrackStep[] =>
  ["received", "grossed", "processing", "embedded", "sectioned", "stained", "qc", "delivered"].map((key, i) => ({ key, label: key, state: states[i] ?? "todo", detail: `d-${key}` }));

describe("case page: part rails and wording (pure display helpers)", () => {
  it("marks the first step not yet reached as next only when nothing is in progress", () => {
    const quiet = railSteps(physical(["done", "done", "todo", "todo"]), [], "physical");
    expect(quiet.map((s) => s.state)).toEqual(["done", "done", "next", "todo", "todo", "todo", "todo", "todo"]);
    // Details show for done and current steps only; a step not yet reached carries no repeated "No blocks yet".
    expect(quiet[1].detail).toBe("d-grossed");
    expect(quiet[2].detail).toBeNull();

    const busy = railSteps(physical(["done", "done", "current", "todo"]), [], "physical");
    expect(busy.filter((s) => s.state === "next")).toHaveLength(0);
    expect(busy[2]).toMatchObject({ state: "current", detail: "d-processing" });
  });

  it("puts a hold on exactly the steps it stops, never on a done step", () => {
    const hold = { displayId: "H-0089", blocks: ["gross_approval"] };
    const doc: TrackStep[] = [
      { key: "draft", label: "Gross record started", state: "done" },
      { key: "reviewed", label: "Reviewed by the grosser", state: "todo" },
      { key: "approved", label: "Approved for downstream use", state: "todo" },
      { key: "source", label: "Source-system update: not started", state: "todo" },
    ];
    const rail = railSteps(doc, [hold], "documentation");
    expect(rail.find((s) => s.key === "approved")!.held).toEqual(["H-0089"]);
    expect(rail.filter((s) => s.held.length)).toHaveLength(1);
    // A gross-approval hold does not touch the physical path.
    expect(railSteps(physical(["done"]), [hold], "physical").some((s) => s.held.length)).toBe(false);

    const all = railSteps(physical(["done", "done", "todo"]), [{ displayId: "H-1", blocks: ["all"] }], "physical");
    expect(all.filter((s) => s.held.length).map((s) => s.key)).toEqual(["processing", "embedded", "sectioned", "stained", "qc", "delivered"]);
  });

  it("splits the source-system state off its label and flags a failed update or a record that needs clarification", () => {
    const [pending] = railSteps([{ key: "source", label: "Source-system update: pending entry", state: "current" }], [], "documentation");
    expect(pending).toMatchObject({ label: "Source-system update", detail: "Pending entry", warning: false });
    const [failed] = railSteps([{ key: "source", label: "Source-system update: failed", state: "current" }], [], "documentation");
    expect(failed).toMatchObject({ detail: "Failed", warning: true });
    const [notStarted] = railSteps([{ key: "source", label: "Source-system update: not started", state: "todo" }], [], "documentation");
    expect(notStarted.detail).toBeNull();
    const [clar] = railSteps([{ key: "reviewed", label: "Reviewed by the grosser", state: "current", detail: "Needs clarification" }], [], "documentation");
    expect(clar).toMatchObject({ warning: true, detail: "Needs clarification" });
  });

  it("writes a part as one phrase and drops the part prefix inside its own row", () => {
    expect(partDescription("Left upper back", null, "Shave")).toBe("Left upper back, shave");
    expect(partDescription("Left upper back", "Left", "Shave")).toBe("Left upper back, shave");
    expect(partDescription("dorsal forearm", "Right", null)).toBe("Dorsal forearm, right");
    expect(readinessLine("Part A: ready for grossing: case issued", "A")).toBe("Ready for grossing: case issued");
    expect(readinessLine("A1 eligible for the next processing run", "A")).toBe("A1 eligible for the next processing run");
  });
});

describe("case page: next step, readiness and evidence on the step it stops", () => {
  it("carries a rule block and the cassette's place onto the step it stops, never onto a held or done step", () => {
    const steps: TrackStep[] = [
      { key: "grossed", label: "Grossed", state: "done", detail: "1 cassette" },
      { key: "processing", label: "Processed", state: "todo", detail: "0 of 1 block", note: "Loaded on P1", blocked: "Gross record not approved" },
    ];
    const rail = railSteps(steps, [], "physical");
    const [, proc] = rail;
    // A blocked step keeps its lock and reason and is never outlined as next: the track has no next step that cannot start.
    expect(proc).toMatchObject({ state: "todo", note: "Loaded on P1", blocked: "Gross record not approved", detail: null });
    expect(rail.filter((s) => s.state === "next")).toHaveLength(0);
    const [, held] = railSteps(steps, [{ displayId: "H-1", blocks: ["processing"] }], "physical");
    expect(held).toMatchObject({ held: ["H-1"], blocked: null, note: "Loaded on P1" });
  });

  it("names shared reasons together instead of '(+2 more)', and leaves hold detail to the hold", () => {
    const loaded = (d: string) => ({ designation: d, status: "active", eligible: [], blockedBy: [`${d}1 loaded but not eligible for processing: gross record not approved (local policy setting)`], holds: [] });
    expect(caseReadiness([loaded("A"), loaded("B"), loaded("C")], false)).toBe(
      "Not ready: A1, B1 and C1 waiting for gross record approval before processing (local policy setting).",
    );
    const hold = { id: "h1", displayId: "H-0089", scopeLabel: "D26-04804 part B", reasonText: "x", blocks: ["gross_approval"], clarificationId: null, placedAt: "2026-10-14T13:36:00.000Z" };
    expect(
      caseReadiness(
        [
          { designation: "A", status: "active", eligible: ["Part A: ready for grossing"], blockedBy: [], holds: [] },
          { designation: "B", status: "active", eligible: [], blockedBy: ["H-0089 on D26-04804 part B: x (holds gross approval)", "Grossing documentation for part B cannot be approved until H-0089 is released"], holds: [hold] },
          { designation: "C", status: "active", eligible: ["Part C: ready for grossing"], blockedBy: [], holds: [] },
        ],
        false,
      ),
    ).toBe("Eligible: Parts A and C for grossing. Not ready: Part B on hold (H-0089).");
    expect(caseReadiness([], true)).toBe("All parts sent on trays; receipt not recorded.");
  });

  it("says where extra work was requested in words", () => {
    expect(stainSource("Source order", "ORD-75392 v1 · part A (PAS requested on order)")).toBe("Requested on order ORD-75392 v1, part A");
    expect(stainSource("Pathologist request", "Dr. Marsh request after H&E review (A1)")).toBe("Dr. Marsh request after H&E review (A1)");
  });

  it("names who a blocked part waits on from the gross record when no task is open, and does not repeat what the rail says", () => {
    const db = testDb();
    const c = getCase(db, "D26-04797")!;
    for (const p of c.parts) {
      const next = partNext(p, c.identity.accessionNumber)!;
      expect(next.fromRecord).toBe(true);
      expect(next.who).toBe(p.gross?.grosserName);
      expect(next.who).toBeTruthy();
      expect(next.action).toMatch(p.gross?.state === "draft" ? /^Review gross record v1$/ : /^Approve gross record v1 for downstream use$/);
      // The local-policy reason is said once, in the readiness line; the next step does not repeat it.
      expect(next.note).toBeNull();
      const physicalRail = railSteps(p.physical.steps, [], "physical");
      const proc = physicalRail.find((s) => s.key === "processing")!;
      expect(proc).toMatchObject({ state: "todo", note: "Loaded on P1", blocked: "Gross record not approved" });
      // One outlined next step per part: the approval on the documentation track, never the blocked Processed step.
      const documentationRail = railSteps(p.documentation.steps, [], "documentation");
      expect(physicalRail.filter((s) => s.state === "next")).toHaveLength(0);
      expect(documentationRail.filter((s) => s.state === "next").map((s) => s.key)).toEqual([p.gross?.state === "draft" ? "reviewed" : "approved"]);
      expect(partHeading(p.stageLabel, next)).toBe("Gross documentation");
      // The started step names the record, never a later step's state.
      expect(p.documentation.steps[0].detail).toMatch(/^(Draft|Record) v1$/);
      expect(partLines(p, [], next)).toEqual([]);
    }
    const readiness = caseReadiness(c.parts, c.summary.isComplete);
    expect(readiness).toMatch(/^Not ready: A1, B1 and C1 waiting for gross record approval/);
    expect(readiness.match(/local policy setting/g)).toHaveLength(1);
  });
});

describe("case page: the seeded held case", () => {
  it("draws D26-04804's hold on part B's approval step only, and never calls the case complete", () => {
    const db = testDb();
    const c = getCase(db, "D26-04804")!;
    expect(c.summary.isComplete).toBe(false);
    expect(c.summary.text).toMatch(/^Not complete: 0 of 3 parts sent on trays, 1 part on hold\.$/);
    for (const p of c.parts) {
      const holds = c.holdsAll.filter((h) => h.status === "active" && p.holds.some((x) => x.id === h.id));
      const held = [...railSteps(p.physical.steps, holds, "physical"), ...railSteps(p.documentation.steps, holds, "documentation")].filter((s) => s.held.length);
      expect(held.map((s) => s.key)).toEqual(p.designation === "B" ? ["approved"] : []);
    }
  });
});

describe("case page: the hero case after the guided demo's grossing step", () => {
  it("shows part A's source entry once, with its owner, and the started record by its version only", () => {
    const db = testDb();
    for (const step of [1, 2, 3, 4, 5]) must(db, "stf_tanya", "demo.runStep", { step, autoStaffActions: true });
    const c = getCase(db, "D26-04817")!;
    expect(c.summary.isComplete).toBe(false);
    const a = c.parts.find((p) => p.designation === "A")!;
    const next = partNext(a, c.identity.accessionNumber)!;
    expect(next).toMatchObject({ action: "Enter approved gross description in source system", who: "Sam Ortiz", fromRecord: false });
    // A documentation action is not headed by the physical stage. A loaded cassette with an approved record is
    // "Ready for processing", never "Processing" (B-4).
    expect(a.stageLabel).toBe("Ready for processing");
    expect(partHeading(a.stageLabel, next)).toBe("Source-system entry");
    expect(next.note).toMatch(/manual entry in the source system/);
    // The instruction is the next step; it is not repeated as a readiness line.
    expect(partLines(a, [], next).some((l) => /source system/i.test(l))).toBe(false);
    // A1's processing-run task names the same thing with its owner, so the readiness line is not repeated either.
    expect(a.openTasks.map((t) => taskTitleInPart(t.title, c.identity.accessionNumber, "A"))).toEqual([
      "Enter approved gross description in source system",
      "A1 eligible for the next processing run",
    ]);
    expect(partLines(a, [], next, c.identity.accessionNumber)).toEqual([]);
    expect(a.documentation.steps.find((s) => s.key === "draft")!.detail).toBe("Record v1");
    const b = c.parts.find((p) => p.designation === "B")!;
    const nextB = partNext(b, c.identity.accessionNumber)!;
    expect(nextB).toMatchObject({ action: "Gross part B", who: null, fromRecord: true });
    expect(partHeading(b.stageLabel, nextB)).toBe("Awaiting grossing");
  });
});
