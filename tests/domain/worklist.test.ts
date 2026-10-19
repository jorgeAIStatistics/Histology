// S3 worklist / case / operations — domain tests against the seeded in-memory demo day.
// State owned by other slices (gross approval, routing exceptions, source outages) is set up
// with direct SQL so these tests do not depend on other slices' commands.
import { describe, it, expect } from "vitest";
import { testDb, run, must, one, all, clockAt, STAFF } from "../helpers";
import type { DB } from "@/server/db/db";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { audit } from "@/server/core/audit";
import { recordWorklistChange } from "@/server/core/feed";
import { openTask } from "@/server/core/tasks";
import { computeReadiness } from "@/server/domain/readiness";
import { labLocalToIso } from "@/lib/time";
import { decodeLabel } from "@/lib/identifiers";
import { getWorklist, findWorklistRow, buildWorklistCsv, listSavedFilters, caseIsComplete, type WorklistRow, type WorklistData } from "@/server/queries/worklist";
import { getCase, safeDecode } from "@/server/queries/case";
import { getOperations } from "@/server/queries/operations";
import { exportWorklistCsv } from "@/app/api/worklist/export/export-csv";

const at = (hhmm: string) => labLocalToIso("2026-10-14", hhmm);

function rowsOf(data: WorklistData): WorklistRow[] {
  return data.groups.flatMap((g) => g.rows);
}

function sysCtx(db: DB) {
  return makeCtx(db, SYSTEM_ACTOR, "system");
}

/** A case received today with two or more parts, nothing grossed yet and no holds. */
function untouchedMultipartCase(db: DB): { id: string; number: string; parts: { id: string; designation: string }[] } {
  const c = one<{ id: string; accession_number: string }>(
    db,
    `SELECT a.id, a.accession_number FROM accession a
      WHERE a.received_day = '2026-10-14'
        AND (SELECT COUNT(*) FROM specimen_part sp WHERE sp.accession_id = a.id) >= 2
        AND NOT EXISTS (SELECT 1 FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id WHERE sp.accession_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM block b WHERE b.accession_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.status = 'active' AND (h.accession_id = a.id OR h.scope_id IN (SELECT id FROM specimen_part WHERE accession_id = a.id)))
      ORDER BY a.accession_number LIMIT 1`,
  );
  expect(c, "seed should contain an untouched multipart case").toBeTruthy();
  const parts = all<{ id: string; designation: string }>(db, "SELECT id, designation FROM specimen_part WHERE accession_id = ? ORDER BY designation", c.id);
  return { id: c.id, number: c.accession_number, parts };
}

/**
 * What S4's gross.approve does to the data (domain/gross.ts), written directly so this file does not depend
 * on S4's command inputs: approved record (source entry pending), cassette A1 loaded, `gross.approved` audit on
 * the gross record, a source_entry task for Sam, a processing_eligible task per block, and a worklist change.
 * The approval summary mentions the OTHER part on purpose (S4 does: "part B still awaiting grossing").
 */
function simulateGrossApproval(db: DB, acc: { id: string; number: string; parts: { designation: string }[] }, part: { id: string; designation: string }) {
  const ctx = sysCtx(db);
  const recId = `gr_test_${part.id}`;
  const blockId = `${part.id}_b1`;
  const fields = { cassettes: { value: [{ label: `${part.designation}1`, pieces: 1, description: "entire specimen" }], status: "confirmed" } };
  db.prepare(
    `INSERT INTO gross_record (id, specimen_part_id, record_version, state, source_update_state, narrative, fields, grosser_id, reviewed_by, reviewed_at,
       approved_by, approved_at, created_at, updated_at, version)
     VALUES (?, ?, 1, 'approved_for_downstream', 'pending_entry', 'Test narrative', ?, 'stf_dana', 'stf_dana', ?, 'stf_dana', ?, ?, ?, 1)`,
  ).run(recId, part.id, JSON.stringify(fields), ctx.now, ctx.now, ctx.now, ctx.now);
  db.prepare(
    `INSERT INTO block (id, accession_id, part_id, block_seq, label_text, identifier, physical_state, pieces_submitted, status, version)
     VALUES (?, ?, ?, 1, ?, ?, 'cassette_loaded', 1, 'active', 1)`,
  ).run(blockId, acc.id, part.id, `${part.designation}1`, `TEST:${acc.number}:${part.designation}1`);
  db.prepare("UPDATE specimen_part SET physical_state = 'grossed', version = version + 1 WHERE id = ?").run(part.id);
  const others = acc.parts.filter((p) => p.designation !== part.designation).map((p) => `part ${p.designation} still awaiting grossing`).join("; ");
  audit(ctx, {
    action: "gross.approved", entityType: "gross_record", entityId: recId, accessionId: acc.id,
    summary: `${acc.number} Part ${part.designation} gross approved: ${part.designation}1 eligible for processing${others ? `; ${others}` : ""}`,
  });
  openTask(ctx, { kind: "source_entry", entityType: "specimen_part", entityId: part.id, title: `Enter approved gross description in source system — ${acc.number} part ${part.designation}`, ownerId: "stf_sam", ownerRole: "histology_assistant", accessionId: acc.id });
  openTask(ctx, { kind: "processing_eligible", entityType: "block", entityId: blockId, title: `${acc.number} ${part.designation}1 eligible for the next processing run`, ownerRole: "histotech", accessionId: acc.id });
  recordWorklistChange(ctx, { accessionId: acc.id, type: "changed", summary: `Part ${part.designation} gross record approved for downstream use` });
}

describe("worklist: completing one part (acceptance check 7, worklist angle)", () => {
  it("shows part A eligible for processing while part B stays awaiting grossing and the case is not complete", () => {
    const db = testDb();
    const acc = untouchedMultipartCase(db);
    const [partA, partB] = acc.parts;

    const before = findWorklistRow(db, STAFF.priya, acc.number)!;
    expect(before.parts.every((p) => p.stage === "awaiting_gross")).toBe(true);
    expect(before.blocks.text).toMatch(/^Unknown/); // no gross record yet: never shown as 0 expected

    simulateGrossApproval(db, acc, partA);

    const row = findWorklistRow(db, STAFF.priya, acc.number)!;
    const a = row.parts.find((p) => p.designation === partA.designation)!;
    const b = row.parts.find((p) => p.designation === partB.designation)!;
    expect(a.eligible).toContain(`${partA.designation}1 eligible for the next processing run`);
    expect(a.word).toBe("ready");
    expect(a.documentation.grossState).toBe("approved_for_downstream");
    expect(a.documentation.sourceUpdateState).toBe("pending_entry"); // approval never implies a source write
    expect(b.stage).toBe("awaiting_gross");
    expect(b.documentation.grossState).toBe("not_started");
    expect(row.isComplete).toBe(false);
    expect(row.readinessText).toContain(`${partA.designation}1 for processing`);
    expect(row.readinessText).not.toMatch(/delivered|complete/i);
    expect(row.partsSummary.startsWith(`${partA.designation} ready for processing · ${partB.designation} awaiting gross`)).toBe(true);
    // Known + unknown = unknown: B has no gross record, so the expected total is only a lower bound.
    expect(row.blocks.expected).toBeNull();
    expect(row.blocks.text).toBe("1 of at least 1 (some Unknown)");
    expect(row.sourceEntry.pendingParts).toEqual([partA.designation]);
    expect(row.change).toBe("changed");
    // Who holds the next step: an unowned processing task for a histotech, and Sam's source-entry task.
    expect(row.tasks.find((t) => t.kind === "processing_eligible")).toMatchObject({ ownerId: null, ownerRole: "histotech" });
    expect(row.tasks.find((t) => t.kind === "source_entry")).toMatchObject({ ownerName: "Sam Ortiz" });

    // The right views pick it up: histotech (processing) and Sam's source-entry queue.
    const histo = rowsOf(getWorklist(db, { staffId: STAFF.priya, view: "histotech" }));
    expect(histo.some((r) => r.id === acc.id)).toBe(true);
    const queue = rowsOf(getWorklist(db, { staffId: STAFF.sam, view: "grossing", filters: { queue: "source_entry" } }));
    expect(queue.some((r) => r.id === acc.id)).toBe(true);
    expect(queue.every((r) => r.sourceEntry.pendingParts.length > 0)).toBe(true);
  });
});

describe("worklist: completing one part through the real commands (acceptance check 7, guided demo steps 1-5)", () => {
  it("after S4 approves Part A of the hero case, the row shows A ready and B not ready, and the case is not complete", () => {
    const db = testDb();
    for (const step of [1, 2, 3, 4, 5]) {
      const res = must<{ status: string; actions: { label: string; outcome: string; detail?: string }[] }>(db, STAFF.tanya, "demo.runStep", { step, autoStaffActions: true });
      expect(res.status, `demo step ${step}`).toBe("ran");
    }
    const hero = one<{ id: string; accession_number: string }>(
      db,
      `SELECT DISTINCT a.id, a.accession_number FROM accession a JOIN specimen_part sp ON sp.accession_id = a.id JOIN source_order so ON so.id = sp.source_order_id
        WHERE so.source_order_id = 'ORD-77120'`,
    );
    expect(hero, "step 4 issues the hero accession").toBeTruthy();
    const approved = one<{ n: number }>(
      db,
      `SELECT COUNT(*) n FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id
        WHERE sp.accession_id = ? AND sp.designation = 'A' AND gr.state = 'approved_for_downstream'`,
      hero.id,
    ).n;
    expect(approved, "step 5 approves Part A through gross.approve").toBe(1);

    const row = findWorklistRow(db, STAFF.priya, hero.accession_number)!;
    const a = row.parts.find((p) => p.designation === "A")!;
    const b = row.parts.find((p) => p.designation === "B")!;
    expect(a.word).toBe("ready");
    expect(a.eligible.some((e) => /^A1 eligible for the next processing run$/.test(e))).toBe(true);
    expect(a.documentation.sourceUpdateState).toBe("pending_entry");
    expect(b.documentation.grossState).toBe("not_started");
    expect(b.eligible.some((e) => /processing/.test(e))).toBe(false);
    expect(row.partsSummary).toMatch(/^A ready for processing · B (awaiting gross|on hold)$/);
    expect(row.isComplete).toBe(false);
    expect(row.readinessText).toMatch(/A1 for processing/);
    expect(row.sourceEntry.pendingParts).toEqual(["A"]);
    expect(row.tasks.some((t) => t.kind === "processing_eligible" && t.ownerRole === "histotech")).toBe(true);

    // Case page: not complete, and Part B's summary line never cites Part A's approval as evidence.
    const c = getCase(db, hero.accession_number)!;
    expect(c.summary.isComplete).toBe(false);
    const partB = c.operationalSummary.items.find((i) => i.text.startsWith("Part B:"))!;
    expect(partB.evidence.some((e) => /gross record approved/i.test(e.label))).toBe(false);
    const partA = c.operationalSummary.items.find((i) => i.text.startsWith("Part A:"))!;
    expect(partA.evidence.some((e) => /gross record approved/i.test(e.label))).toBe(true);
  });
});

describe("worklist: change tracking against each user's acknowledged version", () => {
  it("tags rows new, changed and canceled since the acknowledgment; acknowledging clears them for that user and view only", () => {
    const db = testDb();
    const ctx = sysCtx(db);
    const base = getWorklist(db, { staffId: STAFF.priya, view: "operations" });
    expect(base.changes.total).toBe(0); // seed: everyone acknowledged the 10:50 baseline

    const cases = rowsOf(base).filter((r) => r.kind === "case").slice(0, 4);
    const [x, y, z, w] = cases;
    recordWorklistChange(ctx, { accessionId: x.id, type: "new", summary: `${x.accessionNumber} added to worklist` });
    recordWorklistChange(ctx, { accessionId: x.id, type: "changed", summary: "Hold placed after it was added" });
    recordWorklistChange(ctx, { accessionId: y.id, type: "changed", summary: "Part A gross record approved" });
    recordWorklistChange(ctx, { accessionId: z.id, type: "canceled", summary: "PAS canceled at source" });
    recordWorklistChange(ctx, { accessionId: w.id, type: "new", summary: `${w.accessionNumber} added to worklist` });
    recordWorklistChange(ctx, { accessionId: w.id, type: "canceled", summary: "Levels canceled at source" });

    const data = getWorklist(db, { staffId: STAFF.priya, view: "operations" });
    expect(data.changes).toEqual({ new: 1, changed: 1, canceled: 2, total: 4 });
    const byId = new Map(rowsOf(data).map((r) => [r.id, r]));
    expect(byId.get(x.id)!.change).toBe("new"); // new wins over a later change
    expect(byId.get(x.id)!.changeTags).toEqual(["new"]);
    expect(byId.get(x.id)!.changeSummaries).toContain("Hold placed after it was added");
    expect(byId.get(y.id)!.change).toBe("changed");
    expect(byId.get(z.id)!.change).toBe("canceled");
    // Canceled work is never hidden behind "New": both tags show, and it counts as canceled.
    expect(byId.get(w.id)!.change).toBe("canceled");
    expect(byId.get(w.id)!.changeTags).toEqual(["new", "canceled"]);
    expect(rowsOf(getWorklist(db, { staffId: STAFF.priya, view: "operations", filters: { changedOnly: true } })).map((r) => r.id).sort()).toEqual([x.id, y.id, z.id, w.id].sort());

    const ack = must<{ ackedSeq: number }>(db, STAFF.priya, "worklist.ack", { view: "operations", seq: data.seq });
    expect(ack.ackedSeq).toBe(data.seq);
    expect(getWorklist(db, { staffId: STAFF.priya, view: "operations" }).changes.total).toBe(0);
    expect(one<{ acked_seq: number }>(db, "SELECT acked_seq FROM worklist_ack WHERE staff_id = ? AND view = 'operations'", STAFF.priya).acked_seq).toBe(data.seq);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'worklist.acknowledged' AND actor_id = ?", STAFF.priya).n).toBe(1);

    // Another user, and another view of the same user, still see the changes.
    expect(getWorklist(db, { staffId: STAFF.marcus, view: "operations" }).changes.total).toBe(4);
    expect(one<{ acked_seq: number }>(db, "SELECT acked_seq FROM worklist_ack WHERE staff_id = ? AND view = 'histotech'", STAFF.priya).acked_seq).toBeLessThan(data.seq);

    // Only later changes show after acknowledging.
    recordWorklistChange(ctx, { accessionId: y.id, type: "changed", summary: "Block A1 eligible for processing" });
    const later = getWorklist(db, { staffId: STAFF.priya, view: "operations" });
    expect(later.changes).toEqual({ new: 0, changed: 1, canceled: 0, total: 1 });

    // An old tab acknowledging an older version never moves the acknowledgment backwards.
    const stale = must<{ ackedSeq: number; unchanged: boolean }>(db, STAFF.priya, "worklist.ack", { view: "operations", seq: base.seq });
    expect(stale.unchanged).toBe(true);
    expect(stale.ackedSeq).toBe(data.seq);
    // A version that does not exist yet cannot be acknowledged.
    const future = run(db, STAFF.priya, "worklist.ack", { view: "operations", seq: later.seq + 50 });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe("VALIDATION");
  });
});

describe("worklist: printed / downloaded snapshots", () => {
  it("records the worklist version, generation time, author and source data age, and refuses a snapshot of a list that moved on", () => {
    const db = testDb();
    clockAt(db, "11:05");
    const data = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    const shown = rowsOf(data).length;
    const res = must<{ snapshotId: string; displayId: string; seq: number; generatedAt: string; rowCount: number; dataAsOf: string | null }>(
      db, STAFF.priya, "worklist.snapshot", { view: "histotech", filters: {}, format: "print", expectedSeq: data.seq },
    );
    expect(res.displayId).toMatch(/^SNAP-\d{4}$/);
    expect(res.seq).toBe(data.seq);
    expect(res.generatedAt).toBe(at("11:05"));
    expect(res.rowCount).toBe(shown);
    expect(res.dataAsOf).toBe(at("10:51"));
    const stored = one<{ seq: number; generated_at: string; generated_by: string; row_count: number; data_as_of: string; format: string }>(
      db, "SELECT * FROM worklist_snapshot WHERE id = ?", res.snapshotId,
    );
    expect(stored).toMatchObject({ seq: data.seq, generated_at: at("11:05"), generated_by: STAFF.priya, row_count: shown, data_as_of: at("10:51"), format: "print" });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'worklist.snapshot' AND entity_id = ?", res.snapshotId).n).toBe(1);

    // The list moved on after the user loaded it: no snapshot is recorded for a version they did not see.
    recordWorklistChange(sysCtx(db), { accessionId: rowsOf(data)[0].id, type: "changed", summary: "Something changed" });
    const refused = run(db, STAFF.priya, "worklist.snapshot", { view: "histotech", filters: {}, format: "print", expectedSeq: data.seq });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CONFLICT");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_snapshot").n).toBe(1);
  });

  it("remembers each user's last snapshot of a view and counts the rows in scope that changed after it, without changing anything", () => {
    const db = testDb();
    clockAt(db, "11:05");
    const before = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    expect(before.lastSnapshot).toBeNull();
    const snap = must<{ displayId: string; seq: number }>(db, STAFF.priya, "worklist.snapshot", { view: "histotech", filters: {}, format: "print", expectedSeq: before.seq });

    const after = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    expect(after.lastSnapshot).toMatchObject({ displayId: snap.displayId, seq: snap.seq, generatedAt: at("11:05"), format: "print", changedRows: 0 });
    // Another person or view has no snapshot of its own.
    expect(getWorklist(db, { staffId: STAFF.priya, view: "operations" }).lastSnapshot).toBeNull();
    expect(getWorklist(db, { staffId: STAFF.maya, view: "histotech" }).lastSnapshot).toBeNull();

    // Two changes to one in-scope row count once; a change to a row outside the view's scope does not count.
    const inScope = rowsOf(after)[0];
    recordWorklistChange(sysCtx(db), { accessionId: inScope.id, type: "changed", summary: "Level requested" });
    recordWorklistChange(sysCtx(db), { accessionId: inScope.id, type: "changed", summary: "Level printed" });
    const outside = rowsOf(getWorklist(db, { staffId: STAFF.priya, view: "operations" })).find((r) => r.kind === "case" && !rowsOf(after).some((x) => x.id === r.id));
    expect(outside, "the seed has a case outside the histotech scope").toBeTruthy();
    recordWorklistChange(sysCtx(db), { accessionId: outside!.id, type: "changed", summary: "Outside the histotech scope" });
    const snapshots = one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_snapshot").n;
    const later = getWorklist(db, { staffId: STAFF.priya, view: "histotech", filters: { pasOnly: true } });
    expect(later.lastSnapshot?.changedRows).toBe(1);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_snapshot").n).toBe(snapshots);
  });

  it("CSV header lines state generation time in ET, version, source data age and synthetic data", () => {
    const db = testDb();
    const data = getWorklist(db, { staffId: STAFF.priya, view: "operations" });
    const csv = buildWorklistCsv(data, { displayId: "SNAP-0009", generatedAt: at("10:52"), generatedBy: "Priya Shah", seq: data.seq, dataAsOf: at("10:51"), stale: false }, "no filters");
    const lines = csv.split("\r\n");
    expect(lines[1]).toMatch(/^# Generated: Wed, Oct 14, 2026, 10:52:00 AM EDT by Priya Shah$/);
    expect(lines[2]).toBe(`# Worklist version: v${data.seq}`);
    expect(lines[3]).toMatch(/^# Source data as of: Wed, Oct 14, 2026, 10:51:00 AM EDT$/);
    expect(csv).toContain("Synthetic demo data");
    expect(lines.filter((l) => l && !l.startsWith("#")).length).toBe(rowsOf(data).length + 1);
  });

  it("CSV export records one snapshot whose row count matches the file, replays a repeated request, and refuses a list that moved on", () => {
    const db = testDb();
    const data = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    const first = exportWorklistCsv(db, STAFF.priya, { view: "histotech", filters: {}, expectedSeq: data.seq, idempotencyKey: "csv-test-1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stored = one<{ row_count: number; seq: number; format: string }>(db, "SELECT row_count, seq, format FROM worklist_snapshot WHERE id = ?", first.snapshot.snapshotId);
    expect(stored).toMatchObject({ seq: data.seq, format: "csv" });
    const dataLines = first.csv.split("\r\n").filter((l) => l && !l.startsWith("#"));
    expect(dataLines.length - 1).toBe(stored.row_count); // minus the column header line
    expect(first.csv).toContain(`# Worklist version: v${data.seq}`);
    expect(first.filename).toBe(`worklist-histotech-v${data.seq}-${first.snapshot.displayId}.csv`);

    // Double click / retry with the same key: same snapshot, nothing new recorded.
    const again = exportWorklistCsv(db, STAFF.priya, { view: "histotech", filters: {}, expectedSeq: data.seq, idempotencyKey: "csv-test-1" });
    expect(again.ok && again.replayed && again.snapshot.snapshotId === first.snapshot.snapshotId).toBe(true);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_snapshot").n).toBe(1);

    // The list moved on: a stale expected version is a 409 and records nothing.
    recordWorklistChange(sysCtx(db), { accessionId: rowsOf(data)[0].id, type: "changed", summary: "Moved on" });
    const stale = exportWorklistCsv(db, STAFF.priya, { view: "histotech", filters: {}, expectedSeq: data.seq, idempotencyKey: "csv-test-2" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect([stale.status, stale.error.code]).toEqual([409, "CONFLICT"]);
    // Replaying the first key after the list moved cannot rebuild that old version: refused, not a mixed file.
    const lateReplay = exportWorklistCsv(db, STAFF.priya, { view: "histotech", filters: {}, expectedSeq: data.seq, idempotencyKey: "csv-test-1" });
    expect(lateReplay.ok).toBe(false);
    if (!lateReplay.ok) expect(lateReplay.status).toBe(409);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_snapshot").n).toBe(1);
    const bad = exportWorklistCsv(db, STAFF.priya, { view: "nope", filters: {} });
    expect(bad.ok ? 200 : bad.status).toBe(400);
  });
});

describe("worklist: PAS shown only from explicit work orders or order lines", () => {
  it("a clinical note mentioning PAS in free text adds no PAS tag; a PAS work order shows its order, material and source", () => {
    const db = testDb();
    const plain = one<{ id: string; accession_number: string; order_id: string }>(
      db,
      `SELECT a.id, a.accession_number, sp.source_order_id AS order_id FROM accession a JOIN specimen_part sp ON sp.accession_id = a.id
        WHERE a.received_day = '2026-10-14'
          AND NOT EXISTS (SELECT 1 FROM work_order w WHERE w.accession_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM specimen_part p2 JOIN source_order_part sop ON sop.id = p2.source_order_part_id WHERE p2.accession_id = a.id AND sop.requested_stains LIKE '%PAS%')
        ORDER BY a.accession_number LIMIT 1`,
    );
    db.prepare("UPDATE source_order SET clinical_note = ? WHERE id = ?").run(
      "Dystrophic nail, rule out onychomycosis. Please do PAS if fungal elements suspected. Prior PAS negative.",
      plain.order_id,
    );
    const row = findWorklistRow(db, STAFF.priya, plain.accession_number)!;
    expect(row.hasPas).toBe(false);
    expect(row.pas).toEqual([]);
    const pasOnly = rowsOf(getWorklist(db, { staffId: STAFF.priya, view: "operations", filters: { pasOnly: true } }));
    expect(pasOnly.some((r) => r.id === plain.id)).toBe(false);

    const wo = one<{ accession_number: string; display_id: string; authorization_source: string; source_reference: string }>(
      db,
      `SELECT a.accession_number, w.display_id, w.authorization_source, w.source_reference FROM work_order w JOIN accession a ON a.id = w.accession_id
        WHERE w.stain = 'PAS' AND a.is_prior_day = 0 AND EXISTS (SELECT 1 FROM slide s WHERE s.work_order_id = w.id) ORDER BY w.display_id LIMIT 1`,
    );
    const pasRow = findWorklistRow(db, STAFF.priya, wo.accession_number)!;
    const tag = pasRow.pas.find((p) => p.workOrder === wo.display_id)!;
    expect(tag).toBeTruthy();
    expect(tag.text).toMatch(new RegExp(`^PAS \\(${wo.display_id}\\) · [A-Z]\\d+-\\d+ · Source: `));
    expect(tag.text).toContain(wo.source_reference);
    expect(pasOnly.some((r) => r.accessionNumber === wo.accession_number)).toBe(true);
  });
});

describe("worklist: PAS canceled at source", () => {
  it("a canceled PAS with prepared material is not an active PAS: no PAS count or tint, a visible review flag, and the case stays open", () => {
    const db = testDb();
    const wo = one<{ id: string; accession_id: string; accession_number: string; display_id: string }>(
      db,
      `SELECT w.id, w.accession_id, a.accession_number, w.display_id FROM work_order w JOIN accession a ON a.id = w.accession_id
        WHERE w.stain = 'PAS' AND w.status IN ('requested','in_progress') AND a.is_prior_day = 0
          AND EXISTS (SELECT 1 FROM slide s WHERE s.work_order_id = w.id)
          AND (SELECT COUNT(*) FROM work_order w2 WHERE w2.accession_id = w.accession_id AND w2.stain = 'PAS') = 1
        ORDER BY w.display_id LIMIT 1`,
    );
    expect(findWorklistRow(db, STAFF.priya, wo.accession_number)!.hasPas).toBe(true);
    // What S6's import does when the source removes the stain after slides exist.
    db.prepare("UPDATE work_order SET status = 'cancel_review', status_reason = 'Removed at source (test)', version = version + 1 WHERE id = ?").run(wo.id);
    recordWorklistChange(sysCtx(db), { accessionId: wo.accession_id, type: "canceled", summary: `${wo.display_id} PAS canceled at source; prepared material needs review` });

    const row = findWorklistRow(db, STAFF.priya, wo.accession_number)!;
    const pas = row.pas.find((p) => p.workOrder === wo.display_id)!;
    expect(pas).toMatchObject({ canceled: true, needsReview: true });
    expect(row.hasPas).toBe(false);
    expect(row.pasNeedsReview).toBe(true);
    expect(row.change).toBe("canceled");
    expect(row.isComplete).toBe(false);

    const histo = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    const group = histo.groups.find((g) => g.rows.some((r) => r.id === wo.accession_id))!;
    expect(group.counts.pas).toBe(group.rows.filter((r) => r.hasPas).length);
    expect(group.rows.filter((r) => r.hasPas).some((r) => r.id === wo.accession_id)).toBe(false);
    expect(group.counts.pasReview).toBeGreaterThanOrEqual(1);
    // The PAS-only list keeps it visible as canceled work to review (not as a PAS to do).
    const pasOnly = rowsOf(getWorklist(db, { staffId: STAFF.priya, view: "histotech", filters: { pasOnly: true } }));
    expect(pasOnly.find((r) => r.id === wo.accession_id)).toMatchObject({ hasPas: false, pasNeedsReview: true });
    // The CSV says so in words.
    const data = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    const csv = buildWorklistCsv(data, { displayId: "SNAP-0001", generatedAt: data.generatedAt, generatedBy: "Priya Shah", seq: data.seq, dataAsOf: null, stale: false }, "no filters");
    expect(csv).toMatch(new RegExp(`CANCELED: PAS \\(${wo.display_id}\\)[^|]*REVIEW NEEDED`));
  });
});

describe("worklist: source freshness", () => {
  it("an offline source marks the worklist stale with a data-as-of time; restoring the source clears it", () => {
    const db = testDb();
    clockAt(db, "11:03");
    db.prepare("UPDATE integration_source SET status = 'offline', last_attempt_at = ?, last_error = 'Simulated outage' WHERE id = 'src_ema'").run(at("11:02"));
    const data = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    expect(data.freshness.stale).toBe(true);
    expect(data.freshness.dataAsOf).toBe(at("10:51"));
    expect(data.freshness.banner).toMatch(/EMA-SIM Sunrise Coast unreachable/);
    expect(data.freshness.sources.find((s) => s.id === "src_ema")!.state).toBe("offline");
    // A snapshot taken now carries the stale data age.
    const snap = must<{ dataAsOf: string; stale: boolean }>(db, STAFF.priya, "worklist.snapshot", { view: "histotech", filters: {}, format: "csv" });
    expect(snap).toMatchObject({ dataAsOf: at("10:51"), stale: true });

    db.prepare("UPDATE integration_source SET status = 'connected', last_success_at = ? WHERE id = 'src_ema'").run(at("11:03"));
    expect(getWorklist(db, { staffId: STAFF.priya, view: "histotech" }).freshness.stale).toBe(false);

    // Connected but silent for longer than the threshold is also stale (never presented as live).
    clockAt(db, "11:30");
    db.prepare("UPDATE integration_source SET last_success_at = ? WHERE id = 'src_oth'").run(at("11:05"));
    const late = getWorklist(db, { staffId: STAFF.priya, view: "histotech" });
    expect(late.freshness.stale).toBe(true);
    expect(late.freshness.sources.find((s) => s.id === "src_oth")!.state).toBe("delayed");
  });
});

describe("worklist: routing exceptions", () => {
  it("puts an unknown-office intake item in its own unassigned group with no doctor color, never under a guessed doctor", () => {
    const db = testDb();
    db.prepare(
      `INSERT INTO intake_item (id, display_id, delivery_id, office_id, observed_office_text, received_at, received_by, status, current_owner_id, version, updated_at, updated_by)
       VALUES ('int_test_sss', 'INT-1014-090', 'cr_1100', 'off_sss', 'Seagrape Skin Studio', ?, 'stf_maya', 'in_review', 'stf_kim', 1, ?, 'stf_maya')`,
    ).run(at("11:02"), at("11:02"));
    db.prepare(
      `INSERT INTO routing_decision (id, intake_item_id, status, suggested_pathologist_id, final_pathologist_id, explanation, created_at)
       VALUES ('rd_test_sss', 'int_test_sss', 'exception', NULL, NULL, 'No approved routing rule for Seagrape Skin Studio (rule set v3). Needs lead review.', ?)`,
    ).run(at("11:02"));
    recordWorklistChange(sysCtx(db), { intakeItemId: "int_test_sss", type: "new", summary: "INT-1014-090 routing exception" });

    const data = getWorklist(db, { staffId: STAFF.kim, view: "accessioning" });
    const group = data.groups[0];
    expect(group.key).toBe("unassigned");
    expect(group.isException).toBe(true);
    expect(group.colorToken).toBeNull();
    expect(group.colorName).toBeNull();
    const row = group.rows.find((r) => r.provisionalId === "INT-1014-090")!;
    expect(row).toBeTruthy();
    expect(row.kind).toBe("intake");
    expect(row.accessionNumber).toBeNull();
    expect(row.pathologistId).toBeNull();
    expect(row.office).toBe("Seagrape Skin Studio");
    expect(row.readinessText).toMatch(/no approved routing rule/i);
    expect(row.change).toBe("new");
    for (const g of data.groups.filter((x) => !x.isException)) expect(g.rows.some((r) => r.provisionalId === "INT-1014-090")).toBe(false);
    // Doctor groups always carry a color name next to the doctor's name.
    for (const g of data.groups.filter((x) => !x.isException)) expect(g.colorName).toMatch(/^(teal|violet|amber)$/);
    // A provisional item never gets a label code: no DataMatrix before an official number exists.
    expect(row.labelPayload).toBeNull();
    // Every accessioned row's label code decodes to that row's own accession number, as a case label.
    const cases = rowsOf(data).filter((x) => x.kind === "case");
    expect(cases.length).toBeGreaterThan(0);
    for (const r of cases) {
      const decoded = decodeLabel(r.labelPayload!);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.identity).toMatchObject({ kind: "C", accession: r.accessionNumber });
    }
  });

  it("an accessioned case without an active assigned doctor gets its own group, never labeled a routing exception", () => {
    const db = testDb();
    const c = rowsOf(getWorklist(db, { staffId: STAFF.kim, view: "operations" })).find((r) => r.kind === "case")!;
    db.prepare("UPDATE accession SET assigned_pathologist_id = NULL WHERE id = ?").run(c.id);
    const data = getWorklist(db, { staffId: STAFF.kim, view: "operations" });
    const noDoctor = data.groups.find((g) => g.kind === "no_doctor")!;
    expect(noDoctor.rows.map((r) => r.id)).toEqual([c.id]);
    expect(noDoctor.colorToken).toBeNull();
    expect(noDoctor.name).not.toMatch(/routing exception/i);
    expect(data.groups.find((g) => g.kind === "routing_exception")?.rows.some((r) => r.id === c.id) ?? false).toBe(false);
    // The "no active doctor" filter finds it.
    expect(rowsOf(getWorklist(db, { staffId: STAFF.kim, view: "operations", filters: { doctor: "unassigned" } })).some((r) => r.id === c.id)).toBe(true);
  });
});

describe("tasks: claiming, taking over and releasing the next step", () => {
  it("only a role that fits the task can claim it, a stale view gets a conflict, and read-only roles are refused on the server", () => {
    const db = testDb();
    const acc = untouchedMultipartCase(db);
    // An unowned task meant for a histotech (like S4's processing_eligible task).
    const taskId = openTask(sysCtx(db), { kind: "processing_eligible", entityType: "specimen_part", entityId: acc.parts[0].id, title: `${acc.number} test task for a histotech`, ownerRole: "histotech", accessionId: acc.id });
    const v1 = one<{ version: number }>(db, "SELECT version FROM task WHERE id = ?", taskId).version;

    // An accessioner cannot claim histotech work.
    const wrongRole = run(db, STAFF.maya, "task.claim", { taskId, expectedVersion: v1 });
    expect(wrongRole.ok).toBe(false);
    if (!wrongRole.ok) expect(wrongRole.error.code).toBe("FORBIDDEN");

    const claimed = must<{ ownerId: string; version: number }>(db, STAFF.priya, "task.claim", { taskId, expectedVersion: v1 });
    expect(claimed.ownerId).toBe(STAFF.priya);
    expect(one<{ owner_id: string; owner_role: string; status: string }>(db, "SELECT owner_id, owner_role, status FROM task WHERE id = ?", taskId)).toEqual({
      owner_id: STAFF.priya, owner_role: "histotech", status: "in_progress", // the role the task is meant for never changes
    });
    const row = findWorklistRow(db, STAFF.sam, acc.number)!;
    expect(row.tasks.find((x) => x.id === taskId)!.ownerName).toBe("Priya Shah");
    expect(row.change).toBe("changed");

    // A colleague working from the old view gets a conflict, not a silent overwrite.
    const stale = run(db, STAFF.marcus, "task.claim", { taskId, expectedVersion: v1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
    // With the current version, a histotech still cannot take over a colleague's task.
    const takeover = run(db, STAFF.marcus, "task.claim", { taskId, expectedVersion: claimed.version });
    expect(takeover.ok).toBe(false);
    if (!takeover.ok) expect(takeover.error.code).toBe("FORBIDDEN");

    // The demo role selector is not authentication: the server refuses read-only roles.
    const denied = run(db, STAFF.director, "task.claim", { taskId, expectedVersion: claimed.version });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'command.denied' AND actor_id = ?", STAFF.director).n).toBe(1);

    // The owner releases without a reason; the task goes back to the histotech queue.
    must(db, STAFF.priya, "task.release", { taskId });
    expect(one<{ owner_id: string | null; owner_role: string; status: string }>(db, "SELECT owner_id, owner_role, status FROM task WHERE id = ?", taskId)).toEqual({
      owner_id: null, owner_role: "histotech", status: "open",
    });
    // A histology assistant may cover histotech bench work.
    const v3 = one<{ version: number }>(db, "SELECT version FROM task WHERE id = ?", taskId).version;
    expect(must<{ ownerId: string }>(db, STAFF.sam, "task.claim", { taskId, expectedVersion: v3 }).ownerId).toBe(STAFF.sam);
  });

  it("taking over or releasing someone else's task needs an accessioning lead or the supervisor and a reason; the task's role is kept", () => {
    const db = testDb();
    const task = one<{ id: string; accession_id: string; version: number; owner_id: string; owner_role: string }>(
      db, "SELECT id, accession_id, version, owner_id, owner_role FROM task WHERE kind = 'source_entry' AND status = 'open' ORDER BY id LIMIT 1",
    );
    expect(task).toMatchObject({ owner_id: STAFF.sam, owner_role: "histology_assistant" });

    // A histotech cannot do source-system entry, and cannot take it from Sam.
    const histotech = run(db, STAFF.marcus, "task.claim", { taskId: task.id, expectedVersion: task.version });
    expect(histotech.ok).toBe(false);
    if (!histotech.ok) expect(histotech.error.code).toBe("FORBIDDEN");
    // An accessioning lead can reassign, but not into work their role does not do.
    const lead = run(db, STAFF.kim, "task.claim", { taskId: task.id, expectedVersion: task.version, reason: "Sam is out" });
    expect(lead.ok).toBe(false);
    if (!lead.ok) expect(lead.error.code).toBe("FORBIDDEN");
    // The supervisor can take it over, but only with a reason.
    const noReason = run(db, STAFF.tanya, "task.claim", { taskId: task.id, expectedVersion: task.version });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe("VALIDATION");
    const took = must<{ ownerId: string; takeover: boolean; version: number }>(db, STAFF.tanya, "task.claim", {
      taskId: task.id, expectedVersion: task.version, reason: "Sam is at the grossing bench; entering this one now",
    });
    expect(took).toMatchObject({ ownerId: STAFF.tanya, takeover: true });
    expect(one<{ owner_role: string }>(db, "SELECT owner_role FROM task WHERE id = ?", task.id).owner_role).toBe("histology_assistant");
    const ev = one<{ action: string; reason: string; summary: string }>(db, "SELECT action, reason, summary FROM audit_event WHERE entity_id = ? ORDER BY seq DESC LIMIT 1", task.id);
    expect(ev.action).toBe("task.reassigned");
    expect(ev.reason).toMatch(/grossing bench/);
    expect(ev.summary).toMatch(/taken over from Sam Ortiz/);

    // Someone else's task: a histotech cannot release it; the lead can, with a reason.
    const notOwner = run(db, STAFF.priya, "task.release", { taskId: task.id });
    expect(notOwner.ok).toBe(false);
    if (!notOwner.ok) expect(notOwner.error.code).toBe("FORBIDDEN");
    const leadNoReason = run(db, STAFF.kim, "task.release", { taskId: task.id });
    expect(leadNoReason.ok).toBe(false);
    if (!leadNoReason.ok) expect(leadNoReason.error.code).toBe("VALIDATION");
    must(db, STAFF.kim, "task.release", { taskId: task.id, reason: "Back to the source-entry queue" });
    expect(one<{ owner_id: string | null; owner_role: string; status: string }>(db, "SELECT owner_id, owner_role, status FROM task WHERE id = ?", task.id)).toEqual({
      owner_id: null, owner_role: "histology_assistant", status: "open",
    });
    // The worklist names the queue the task went back to, not the role of whoever touched it last.
    const row = findWorklistRow(db, STAFF.sam, task.accession_id)!;
    const t = row.tasks.find((x) => x.id === task.id)!;
    expect(t.ownerName).toBeNull();
    expect(t.ownerRole).toBe("histology_assistant");
  });
});

describe("worklist: saved filters", () => {
  it("saves per user and view, replaces by name, and only the owner can delete", () => {
    const db = testDb();
    const saved = must<{ filterId: string; replaced: boolean }>(db, STAFF.priya, "worklist.saveFilter", { view: "histotech", name: "Marsh PAS", filters: { doctor: STAFF.marsh, pasOnly: true } });
    expect(saved.replaced).toBe(false);
    const again = must<{ filterId: string; replaced: boolean }>(db, STAFF.priya, "worklist.saveFilter", { view: "histotech", name: "Marsh PAS", filters: { doctor: STAFF.marsh, pasOnly: true, onHold: true } });
    expect(again).toMatchObject({ filterId: saved.filterId, replaced: true });
    expect(listSavedFilters(db, STAFF.priya, "histotech")).toEqual([expect.objectContaining({ name: "Marsh PAS", filters: { doctor: STAFF.marsh, pasOnly: true, onHold: true } })]);
    expect(listSavedFilters(db, STAFF.marcus, "histotech")).toEqual([]);
    const bad = run(db, STAFF.priya, "worklist.saveFilter", { view: "histotech", name: "x", filters: { notAFilter: 1 } });
    expect(bad.ok).toBe(false);
    const other = run(db, STAFF.marcus, "worklist.deleteFilter", { filterId: saved.filterId });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe("FORBIDDEN");
    must(db, STAFF.priya, "worklist.deleteFilter", { filterId: saved.filterId });
    expect(listSavedFilters(db, STAFF.priya)).toEqual([]);
  });
});

describe("case detail and operations read models", () => {
  it("case detail resolves by accession number, keeps physical and documentation tracks separate, and never calls a partial case complete", () => {
    const db = testDb();
    const acc = untouchedMultipartCase(db);
    simulateGrossApproval(db, acc, acc.parts[0]);
    const c = getCase(db, acc.number)!;
    expect(c).toBeTruthy();
    expect(c.identity.accessionNumber).toBe(acc.number);
    expect(getCase(db, acc.id)!.identity.accessionNumber).toBe(acc.number);
    expect(getCase(db, "D26-99999")).toBeNull();
    const [a, b] = c.parts;
    expect(a.documentation.steps.find((s) => s.key === "approved")!.state).toBe("done");
    expect(a.documentation.steps.find((s) => s.key === "source")!.label).toMatch(/pending/i);
    expect(a.physical.steps.find((s) => s.key === "grossed")!.state).toBe("done");
    expect(a.physical.steps.find((s) => s.key === "processing")!.state).not.toBe("done"); // approval never moves physical state
    expect(b.documentation.steps.every((s) => s.state !== "done")).toBe(true);
    expect(c.summary.isComplete).toBe(false);
    expect(c.summary.text).toMatch(/^Not complete: /);
    // The headline gives the count; the parts line under it names the part that is not done.
    expect(c.summary.text).toMatch(/^Not complete: 0 of 2 parts delivered/);
    expect(c.summary.partsSummary).toContain(`${acc.parts[1].designation} awaiting gross`);
    expect(c.operationalSummary.label).toMatch(/Computed summary \(deterministic demo\) — not AI/);
    expect(c.operationalSummary.items.length).toBeGreaterThan(0);
    for (const item of c.operationalSummary.items) expect(item.evidence.length).toBeGreaterThan(0);

    // Evidence and history are attached to parts by entity: A's approval mentions part B in its text,
    // but it is A's event (it must not show up as Part B's evidence or under the Part B history filter).
    const approval = c.history.find((h) => h.action === "gross.approved")!;
    expect(approval.parts).toEqual([acc.parts[0].designation]);
    const itemA = c.operationalSummary.items.find((i) => i.text.startsWith(`Part ${acc.parts[0].designation}:`))!;
    const itemB = c.operationalSummary.items.find((i) => i.text.startsWith(`Part ${acc.parts[1].designation}:`))!;
    expect(itemA.evidence.some((e) => e.href === `?tab=history#ev-${approval.id}`)).toBe(true);
    expect(itemB.evidence.some((e) => e.href === `?tab=history#ev-${approval.id}`)).toBe(false);
    // Grossing tasks deep-link: source entry to Sam's queue, other part work to the exact part.
    expect(c.tasks.find((t) => t.kind === "source_entry")!.href).toBe("/grossing?view=source");
  });

  it("source documents keep the ORIGINAL order values after an amendment, next to the current source value and the value on the case", () => {
    const db = testDb();
    const acc = untouchedMultipartCase(db);
    const part = one<{ id: string; designation: string; site_text: string; laterality: string | null; source_order_id: string; source_order_part_id: string }>(
      db, "SELECT id, designation, site_text, laterality, source_order_id, source_order_part_id FROM specimen_part WHERE accession_id = ? ORDER BY designation LIMIT 1", acc.id,
    );
    const order = one<{ source_order_id: string; source_version: number }>(db, "SELECT source_order_id, source_version FROM source_order WHERE id = ?", part.source_order_id);
    const v1 = one<{ payload: string }>(db, "SELECT payload FROM source_order_version WHERE source_order_id = ? ORDER BY source_version LIMIT 1", part.source_order_id);
    const orig = (JSON.parse(v1.payload) as { specimens: { designation: string; site: string; laterality: string | null }[] }).specimens.find((x) => x.designation === part.designation)!;
    const flipped = orig.laterality === "left" ? "right" : "left";
    const newSite = `${flipped === "left" ? "Left" : "Right"} test site`;
    // What S6's import does with a newer version: append the version and mirror the current values onto the order line.
    const payload2 = JSON.parse(v1.payload) as { specimens: { designation: string; site: string; laterality: string | null }[] };
    for (const sp of payload2.specimens) if (sp.designation === part.designation) Object.assign(sp, { site: newSite, laterality: flipped });
    db.prepare(
      "INSERT INTO source_order_version (id, source_order_id, source_version, source_updated_at, imported_at, payload, change_summary) VALUES (?, ?, ?, ?, ?, ?, 'Amended at source (test)')",
    ).run("sov_test_v2", part.source_order_id, order.source_version + 1, at("11:20"), at("11:21"), JSON.stringify(payload2));
    db.prepare("UPDATE source_order SET source_version = ?, source_updated_at = ?, imported_at = ? WHERE id = ?").run(order.source_version + 1, at("11:20"), at("11:21"), part.source_order_id);
    db.prepare("UPDATE source_order_part SET site_text = ?, site_normalized = ?, laterality = ? WHERE id = ?").run(newSite, newSite.toLowerCase(), flipped, part.source_order_part_id);
    clockAt(db, "11:22");

    const c = getCase(db, acc.number)!;
    const doc = c.sourceDocuments.find((d) => d.sourceOrderId === order.source_order_id)!;
    expect(doc.versions.map((v) => v.version)).toEqual([order.source_version + 1, order.source_version]);
    expect(doc.originalVersion).toBe(order.source_version);
    const line = doc.orderParts.find((o) => o.designation === part.designation)!;
    expect(line.original).toMatchObject({ site: orig.site, laterality: orig.laterality });
    expect(line.current).toMatchObject({ site: newSite, laterality: flipped });
    expect(line.changedSinceOriginal).toBe(true);
    expect(line.onCase).toEqual({ site: part.site_text, laterality: part.laterality }); // the issued part is never silently edited

    // The worklist dates a source change by when the lab received it (import time), not the source's clock.
    const row = findWorklistRow(db, STAFF.priya, acc.number)!;
    expect(row.lastUpdate).toMatchObject({ at: at("11:21"), origin: "Source (simulated)" });
  });

  it("a case whose parts are all delivered but with an open work order is not complete, anywhere it is shown", () => {
    const db = testDb();
    const ids = all<{ id: string }>(db, "SELECT DISTINCT accession_id AS id FROM work_order WHERE status IN ('requested','in_progress','cancel_review','amended_review')").map((r) => r.id);
    const readiness = computeReadiness(db, ids);
    const target = [...readiness.values()].find((r) => r.isComplete);
    expect(target, "seed has a delivered case with extra work still open").toBeTruthy();
    expect(caseIsComplete(target!)).toBe(false);
    const c = getCase(db, target!.accessionNumber)!;
    expect(c.summary.isComplete).toBe(false);
    expect(c.summary.text).toMatch(/^Not complete: (all \d+ parts|the only part is) delivered, but additional work is open: WO-\d+/);
    expect(c.operationalSummary.items[c.operationalSummary.items.length - 1].text).toMatch(/^Case not complete/);
    const row = findWorklistRow(db, STAFF.priya, target!.accessionNumber);
    if (row) {
      expect(row.isComplete).toBe(false);
      expect(row.readinessText).not.toMatch(/^All parts delivered/);
    }
  });

  it("an unknown or malformed case id gives the not-found result, never an error", () => {
    const db = testDb();
    expect(safeDecode("D26-%E0")).toBe("D26-%E0");
    expect(safeDecode("D26-04817")).toBe("D26-04817");
    expect(getCase(db, "D26-%E0")).toBeNull();
    expect(getCase(db, "100%")).toBeNull();
  });

  it("operations counts come from live records, separate pending source entry from attested-awaiting-acknowledgment, and list blocked work oldest first", () => {
    const db = testDb();
    const ops = getOperations(db);
    const tile = (k: string) => ops.tiles.find((t) => t.key === k)!;
    expect(tile("holds").value).toBe(one<{ n: number }>(db, "SELECT COUNT(*) n FROM hold WHERE status = 'active'").n);
    expect(tile("print_unknown").value).toBe(one<{ n: number }>(db, "SELECT COUNT(*) n FROM print_job WHERE state = 'unknown_outcome'").n);
    // Tiles that link to the worklist show exactly what the link opens.
    const partsIn = (view: "grossing", queue: "source_entry" | "source_attested", key: "pendingParts" | "attestedParts") =>
      rowsOf(getWorklist(db, { staffId: STAFF.tanya, view, filters: { queue } })).reduce((n, r) => n + r.sourceEntry[key].length, 0);
    expect(tile("source_pending").href).toBe("/worklist?view=grossing&queue=source_entry");
    expect(tile("source_pending").value).toBe(partsIn("grossing", "source_entry", "pendingParts"));
    // Every approved record still awaiting entry is on the queue, including late entries from earlier days.
    expect(tile("source_pending").value).toBe(
      one<{ n: number }>(db, "SELECT COUNT(*) n FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id JOIN accession a ON a.id = sp.accession_id WHERE gr.state = 'approved_for_downstream' AND gr.source_update_state = 'pending_entry' AND sp.status = 'active' AND a.case_status <> 'canceled'").n,
    );
    expect(tile("source_attested").href).toBe("/worklist?view=grossing&queue=source_attested");
    expect(tile("source_attested").value).toBe(partsIn("grossing", "source_attested", "attestedParts"));
    expect(tile("source_pending").label).not.toBe(tile("source_attested").label);
    // "Clarifications overdue" counts exactly the overdue items its link lists.
    expect(tile("clarifications_overdue").href).toBe("/operations?category=clarifications&overdue=1#blocked");
    expect(tile("clarifications_overdue").value).toBe(ops.blocked.filter((b) => b.category === "clarifications" && b.overdue).length);
    expect(tile("clarifications_overdue").value).toBe(
      one<{ n: number }>(db, "SELECT COUNT(*) n FROM clarification WHERE state NOT IN ('resolved','canceled','drafted') AND next_follow_up_at IS NOT NULL AND next_follow_up_at < ?", ops.generatedAt).n,
    );
    expect(tile("awaiting_gross").label).toBe("Parts awaiting an approved gross record");
    expect(tile("awaiting_gross").href).toBe("/worklist?view=grossing&queue=gross_pending");
    expect(tile("awaiting_gross").value).toBe(
      rowsOf(getWorklist(db, { staffId: STAFF.tanya, view: "grossing", filters: { queue: "gross_pending" } }))
        .flatMap((r) => r.parts)
        .filter((p) => p.status !== "canceled" && p.documentation.grossState !== "approved_for_downstream" && (p.stage === "awaiting_gross" || p.stage === "gross_in_progress")).length,
    );
    // Unowned work is listed too: every part awaiting source-system entry is a blocked item, with or without a task.
    expect(ops.blocked.filter((b) => b.category === "source_entry").length).toBe(tile("source_pending").value);
    expect(ops.blocked.some((b) => b.category === "source_entry" && b.owner === "Unassigned (histology assistant)")).toBe(true);
    expect(ops.blocked.length).toBeGreaterThan(0);
    // Exceptions first, routine source entry last; oldest first within each category.
    const order = ["holds", "clarifications", "print", "trays", "routing", "retrieval", "review", "source_entry"];
    for (let i = 1; i < ops.blocked.length; i++) {
      const a = ops.blocked[i - 1];
      const b = ops.blocked[i];
      expect(order.indexOf(a.category)).toBeLessThanOrEqual(order.indexOf(b.category));
      if (a.category === b.category && a.since && b.since) expect(Date.parse(a.since)).toBeLessThanOrEqual(Date.parse(b.since));
    }
    for (const b of ops.blocked) expect(b.evidenceHref).toMatch(/^\//);
    expect(ops.note).toMatch(/Not observed lab performance/);
    expect(ops.handoffs.label).toMatch(/not AI/);

    // A source outage: freshness says stale, it never claims current data.
    db.prepare("UPDATE integration_source SET status = 'offline' WHERE id = 'src_oth'").run();
    const off = getOperations(db);
    expect(off.freshness.stale).toBe(true);
    expect(off.freshness.sources.find((s) => s.id === "src_oth")!.state).toBe("offline");
  });
});
