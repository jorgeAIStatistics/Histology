// Operations view: the derived bench path, the owner queue and the blocked-list summary.
// Every number must come from the same records the page links to; nothing ranks people.
import { describe, it, expect } from "vitest";
import { testDb, one, clockAt } from "../helpers";
import { mustRun } from "@/server/commands";
import { demoNow } from "@/server/core/clock";
import { STAGE } from "@/lib/domain";
import { getOperations, ownerKeyFor } from "@/server/queries/operations";
import { loadWorklistRows } from "@/server/queries/worklist";
import { EXCEPTION_CATEGORIES, groupRoutine, matchesOwner, summarizeBlocked } from "@/components/operations/summary";

const PATH_ORDER = ["intake", "awaiting_gross", "gross_in_progress", "awaiting_processing", "processing", "embedding", "sectioning", "staining", "qc", "ready_for_tray", "delivered"];

describe("operations view: derived read model", () => {
  it("the bench path runs intake to delivered and counts exactly the records each stage opens", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const stages = ops.path.stages;
    expect(stages.map((s) => s.key)).toEqual(PATH_ORDER);
    for (const s of stages) expect(s.label).toBe(STAGE[s.key]);

    // Intake: provisional orders not yet accessioned (orders, not parts), opened on the intake bench.
    const intake = stages[0];
    expect(intake.unit).toBe("order");
    expect(intake.href).toBe("/intake");
    expect(intake.count).toBe(one<{ n: number }>(db, "SELECT COUNT(*) n FROM intake_item WHERE status NOT IN ('accessioned','canceled')").n);

    // Later stages: parts on today's worklist at that derived stage, opened on the worklist filtered to the stage.
    const rows = loadWorklistRows(db, Number.MAX_SAFE_INTEGER, demoNow(db), { includeIntake: false });
    for (const s of stages.slice(1)) {
      expect(s.unit).toBe("part");
      expect(s.href).toBe(`/worklist?view=operations&stage=${s.key}`);
      expect(s.count).toBe(rows.flatMap((r) => r.parts).filter((p) => p.stage === s.key).length);
      expect(s.held).toBeLessThanOrEqual(s.count);
    }
    // The path and the queue-age read agree on every waiting stage.
    for (const q of ops.queueAge.rows) expect(stages.find((s) => s.key === q.stage)!.count).toBe(q.total);
    // Delivered is done: no wait is shown for it.
    const delivered = stages.at(-1)!;
    expect(delivered.oldestSince).toBeNull();
    expect(delivered.held).toBe(0);
    // A stage with work shows its longest wait (or counts the parts whose age is Unknown).
    for (const s of stages.slice(0, -1)) {
      if (s.count === 0) expect(s.oldestAge).toBeNull();
      else expect(s.oldestAge !== null || s.unknownAge === s.count).toBe(true);
    }
  });

  it("each active hold sits at exactly one stage of the path, where its material is", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const active = db.prepare("SELECT display_id, scope_type, accession_id FROM hold WHERE status = 'active'").all() as { display_id: string; scope_type: string; accession_id: string | null }[];
    expect(active.length).toBeGreaterThan(0);
    for (const h of active) {
      const at = ops.path.stages.filter((s) => s.holdIds.includes(h.display_id));
      expect(at, `${h.display_id} should sit at one stage`).toHaveLength(1);
      // Holds on material not yet accessioned sit at intake; holds on accessioned parts sit at that part's stage.
      if (!h.accession_id && h.scope_type === "intake_item") expect(at[0].key).toBe("intake");
    }
    const partHold = one<{ display_id: string; scope_id: string }>(db, "SELECT display_id, scope_id FROM hold WHERE status = 'active' AND scope_type = 'specimen_part' LIMIT 1");
    const rows = loadWorklistRows(db, Number.MAX_SAFE_INTEGER, demoNow(db), { includeIntake: false });
    const part = rows.flatMap((r) => r.parts).find((p) => p.partId === partHold.scope_id)!;
    expect(ops.path.stages.find((s) => s.holdIds.includes(partHold.display_id))!.key).toBe(part.stage);
    // The held count is the number of held items, never more than the holds placed.
    expect(ops.path.stages.reduce((n, s) => n + s.held, 0)).toBeLessThanOrEqual(active.length);
  });

  it("a hold placed on a later-stage part appears hatched at that stage, and nowhere else", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const rows = loadWorklistRows(db, Number.MAX_SAFE_INTEGER, demoNow(db), { includeIntake: false });
    const target = rows.flatMap((r) => r.parts.map((p) => ({ p, acc: r }))).find(({ p }) => p.stage === "sectioning" && p.holds.length === 0)!;
    expect(target, "seed should have a sectioning part without a hold").toBeTruthy();
    const before = getOperations(db).path.stages.find((s) => s.key === "sectioning")!;
    db.prepare(
      `INSERT INTO hold (id, display_id, scope_type, scope_id, scope_label, blocks, reason_code, reason_text, clarification_id, status, placed_by, placed_at, intake_item_id, accession_id, version)
       VALUES ('hold_test_1', 'H-0999', 'specimen_part', ?, 'test part', '["print"]', 'other', 'Test hold', NULL, 'active', 'stf_tanya', ?, NULL, ?, 1)`,
    ).run(target.p.partId, demoNow(db), target.acc.id);
    const after = getOperations(db);
    const sectioning = after.path.stages.find((s) => s.key === "sectioning")!;
    expect(sectioning.held).toBe(before.held + 1);
    expect(sectioning.holdIds).toContain("H-0999");
    expect(after.path.stages.filter((s) => s.holdIds.includes("H-0999"))).toHaveLength(1);
    // The same hold is a "Blocked now" exception with its owner and evidence.
    const item = after.blocked.find((b) => b.ref === "H-0999")!;
    expect(item.category).toBe("holds");
    expect(item.evidenceHref).toMatch(/^\//);
  });

  it("the owner queue counts every blocked item once, by who holds its next step, sorted by name with unassigned last", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const { rows } = ops.owners;
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(ops.blocked.length);
    for (const r of rows) {
      expect(r.buckets.reduce((a, b) => a + b, 0) + r.unknown).toBe(r.total);
      const mine = ops.blocked.filter((b) => b.ownerKey === r.key);
      expect(mine).toHaveLength(r.total);
      expect(mine.filter((b) => b.category === "holds")).toHaveLength(r.holds);
      // The row's link filters the page to exactly these items.
      expect(r.href).toBe(`/operations?owner=${encodeURIComponent(r.key)}#blocked`);
      expect(ops.blocked.filter((b) => matchesOwner(b, r.key))).toHaveLength(r.total);
      // Read-only, descriptive fields only: no score, rate or rank.
      expect(Object.keys(r).some((k) => /score|rate|rank|percent/i.test(k))).toBe(false);
    }
    const named = rows.filter((r) => !r.unassigned).map((r) => r.owner);
    expect(named).toEqual([...named].sort((a, b) => a.localeCompare(b)));
    const firstUnassigned = rows.findIndex((r) => r.unassigned);
    if (firstUnassigned >= 0) expect(rows.slice(firstUnassigned).every((r) => r.unassigned)).toBe(true);
    // Unowned work is visible as its own row.
    expect(rows.some((r) => r.unassigned && r.owner === "Unassigned (histology assistant)")).toBe(true);
    expect(ownerKeyFor(null, "Unassigned (histology assistant)")).toBe("unassigned-histology-assistant");
    expect(ownerKeyFor("stf_sam", "Sam Ortiz")).toBe("stf_sam");
  });

  it("the blocked summary separates exceptions from routine entry, names what is clear and the longest wait", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const s = summarizeBlocked(ops.blocked);
    expect(s.exceptions.length + s.routine.length).toBe(ops.blocked.length);
    expect(s.routine.every((b) => b.category === "source_entry")).toBe(true);
    expect(s.holds).toBe(one<{ n: number }>(db, "SELECT COUNT(*) n FROM hold WHERE status = 'active'").n);
    expect(s.holds + s.others).toBe(s.exceptions.length);
    // Every exception category is either counted (with items) or listed as clear: zeros are said, not shown as tiles.
    expect([...s.counts.map((c) => c.key), ...s.clear].sort()).toEqual([...EXCEPTION_CATEGORIES].sort());
    for (const c of s.counts) expect(c.count).toBe(s.exceptions.filter((b) => b.category === c.key).length);
    for (const k of s.clear) expect(s.exceptions.some((b) => b.category === k)).toBe(false);
    // The "Clear now" line agrees with the print and tray counts the old tiles showed.
    const tile = (k: string) => ops.tiles.find((t) => t.key === k)!.value;
    expect(s.clear.includes("print")).toBe(tile("print_unknown") === 0);
    expect(s.clear.includes("trays")).toBe(tile("trays_blocked") === 0);
    expect(s.overdue).toBe(tile("clarifications_overdue"));
    // The longest-waiting exception has the earliest start time.
    const starts = s.exceptions.filter((b) => b.since).map((b) => Date.parse(b.since!));
    expect(Date.parse(s.longest!.since!)).toBe(Math.min(...starts));
    // Routine entry with no owner is called out.
    expect(s.routineUnowned.every((b) => b.ownerId === null)).toBe(true);
    expect(s.routineUnowned.length).toBeGreaterThan(0);
  });

  it("patient-identity holds are marked as the top rung of the severity ladder; other holds are not", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const identityHolds = db.prepare("SELECT display_id FROM hold WHERE status = 'active' AND reason_code = 'identity_conflict'").all() as { display_id: string }[];
    expect(identityHolds.length).toBeGreaterThan(0);
    for (const b of ops.blocked.filter((x) => x.category === "holds")) {
      expect(!!b.identity).toBe(identityHolds.some((h) => h.display_id === b.ref));
    }
  });
  it("patient identity leads Blocked now; every other exception keeps the query's order", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const s = summarizeBlocked(ops.blocked);
    expect(s.identity.length).toBeGreaterThan(0);
    expect(s.exceptions.slice(0, s.identity.length).every((b) => b.identity)).toBe(true);
    expect(s.exceptions.slice(s.identity.length).some((b) => b.identity)).toBe(false);
    // Nothing else moves: holds first, oldest first within each category, exactly as the query sorts them.
    const queryOrder = ops.blocked.filter((b) => b.category !== "source_entry" && !b.identity).map((b) => b.key);
    expect(s.exceptions.filter((b) => !b.identity).map((b) => b.key)).toEqual(queryOrder);
  });

  it("routine entry groups say status, owner and next step once: unowned first, every record in exactly one group, query order kept", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const routine = summarizeBlocked(ops.blocked).routine;
    const groups = groupRoutine(routine);
    expect(groups.length).toBeGreaterThan(1);
    // Unowned first, then owners by name.
    expect(groups[0].ownerId).toBeNull();
    const owned = groups.filter((g) => g.ownerId);
    expect(owned.map((g) => g.owner)).toEqual([...owned.map((g) => g.owner)].sort((a, b) => a.localeCompare(b)));
    // Every routine record appears exactly once, and each group keeps the query's order.
    expect(groups.flatMap((g) => g.items.map((b) => b.key)).sort()).toEqual(routine.map((b) => b.key).sort());
    for (const g of groups) {
      const order = routine.filter((b) => g.items.includes(b)).map((b) => b.key);
      expect(g.items.map((b) => b.key)).toEqual(order);
      // What the heading says once is true of every row under it.
      for (const b of g.items) {
        expect(b.ownerId).toBe(g.ownerId);
        expect(b.owner).toBe(g.owner);
        expect(b.blocks.startsWith(g.status)).toBe(true);
        expect(b.nextStep).toBe(g.nextStep);
      }
    }
  });

  it("a review whose title carries an identifier leads with it (REL-0112), and the item text is unchanged", () => {
    const db = testDb();
    clockAt(db, "11:00");
    // The 11:00 courier (demo step 1) brings the related-order candidate REL-0112 and its review task.
    mustRun(db, "stf_maya", "demo.runStep", { step: 1 }, { origin: "demo" });
    const ops = getOperations(db);
    const reviews = ops.blocked.filter((b) => b.category === "review" && /\b[A-Z][A-Z0-9]{0,4}(?:-[A-Z0-9]+)+\b/.test(b.item));
    expect(reviews.length).toBeGreaterThan(0);
    for (const b of reviews) {
      expect(b.ref, b.item).toBeTruthy();
      expect(b.item).toContain(b.ref!);
      expect(b.subject && b.subject.length).toBeTruthy();
    }
    const rel = ops.blocked.find((b) => b.ref?.startsWith("REL-"));
    expect(rel, "a related-order review is listed").toBeTruthy();
    expect(rel!.subject).toMatch(/ORD-\d+/);
  });

  it("each stage's longest wait names the record that shows it and links to that record", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const rows = loadWorklistRows(db, Number.MAX_SAFE_INTEGER, demoNow(db), { includeIntake: false });
    let linked = 0;
    for (const s of ops.path.stages) {
      if (!s.oldestRef) {
        expect(s.oldestHref).toBeNull();
        continue;
      }
      linked += 1;
      if (s.key === "intake") {
        expect(s.oldestHref).toBe(`/intake?item=${encodeURIComponent(s.oldestRef)}`);
        continue;
      }
      const m = /^(\S+) part ([A-Z])$/.exec(s.oldestRef)!;
      expect(m, s.oldestRef).toBeTruthy();
      expect(s.oldestHref).toBe(`/cases/${encodeURIComponent(m[1])}?part=${m[2]}`);
      // The linked part really sits at this stage.
      const part = rows.find((r) => r.accessionNumber === m[1])!.parts.find((p) => p.designation === m[2])!;
      expect(part.stage).toBe(s.key);
    }
    expect(linked).toBeGreaterThan(0);
  });
});
