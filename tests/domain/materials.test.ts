// S5 Materials: print queue, labels, trays, block retrieval, source-change review.
// Acceptance checks 8, 9, 10 and 14 (review side) from the master spec §13,
// exercised through the command layer against the seeded synthetic day.
import { describe, it, expect } from "vitest";
import { testDb, run, must, one, all, clockAt, STAFF } from "../helpers";
import type { DB } from "@/server/db/db";
import { decodeLabel } from "@/lib/identifiers";
import { getRetrievalDetail, getTrayDetail, getPrintJobDetail } from "@/server/queries/materials";
import { demoNow } from "@/server/core/clock";
import * as q from "@/server/queries/materials";

type PrintResult = { outcome: string; printJobId: string; displayId: string; state: string; message: string; printerUnavailable?: boolean; labelId?: string | null; retireLabelId?: string | null };

const countJobs = (db: DB, targetId?: string) =>
  targetId
    ? one<{ n: number }>(db, "SELECT COUNT(*) n FROM print_job WHERE target_id = ?", targetId).n
    : one<{ n: number }>(db, "SELECT COUNT(*) n FROM print_job").n;
const countSlides = (db: DB) => one<{ n: number }>(db, "SELECT COUNT(*) n FROM slide").n;

/** The presenter sets a simulated printer's behavior in Settings (S6 printer.setStatus); tests set it directly. */
const setPrinter = (db: DB, id: string, status: "online" | "offline" | "simulate_timeout") =>
  db.prepare("UPDATE printer SET status = ? WHERE id = ?").run(status, id);

/** A fresh planned slide (via an authorized additional-slide work order) that has never been printed. */
function freshSlide(db: DB): { slideId: string; blockId: string } {
  const block = one<{ id: string }>(
    db,
    `SELECT b.id FROM block b JOIN accession a ON a.id = b.accession_id
      WHERE a.assigned_pathologist_id = 'stf_marsh' AND b.physical_state = 'sectioned' AND b.custody_state = 'in_workflow' ORDER BY b.id LIMIT 1`,
  );
  const r = must<{ slideId: string }>(db, STAFF.marsh, "slide.orderAdditional", { blockId: block.id, stain: "PAS", reason: "Rule out fungal elements (synthetic)" });
  return { slideId: r.slideId, blockId: block.id };
}

const scenario = (db: DB) =>
  JSON.parse(one<{ value: string }>(db, "SELECT value FROM app_setting WHERE key = 'scenario_tray_present'").value) as {
    expectedUnscanned: string;
    missing: string;
    unexpected: string;
  };
const ident = (db: DB, slideId: string) => one<{ identifier: string }>(db, "SELECT identifier FROM slide WHERE id = ?", slideId).identifier;
const jobVersion = (db: DB, jobId: string) => one<{ version: number }>(db, "SELECT version FROM print_job WHERE id = ?", jobId).version;
/** A person checks the printer output and records it (the only way an acknowledged job gets a label row). */
const recordOutput = (db: DB, actor: string, jobId: string, outcome: "printed_ok" | "not_printed" | "printed_damaged" | "cant_tell", note = "Checked the output tray") =>
  must<PrintResult>(db, actor, "print.reconcile", { printJobId: jobId, expectedVersion: jobVersion(db, jobId), outcome, note });
const trayVersion = (db: DB) => one<{ version: number }>(db, "SELECT version FROM tray WHERE id = 'tray_m03'").version;

// =====================================================================================
describe("Acceptance 8: a printer timeout stays unknown until reconciled; no uncontrolled duplicates", () => {
  it("a timeout after submission leaves the job in Unknown outcome with a reconcile task, and retries or double clicks create no new job", () => {
    const db = testDb();
    const { slideId } = freshSlide(db);
    setPrinter(db, "prn_s1", "simulate_timeout");

    const first = must<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" }, "click-1");
    expect(first.outcome).toBe("created");
    expect(first.state).toBe("unknown_outcome");
    const job = one<{ state: string; submitted_at: string | null }>(db, "SELECT state, submitted_at FROM print_job WHERE id = ?", first.printJobId);
    expect(job.state).toBe("unknown_outcome");
    expect(job.submitted_at).not.toBeNull();
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'print_reconcile' AND entity_id = ? AND status = 'open'", first.printJobId)).toEqual({ n: 1 });
    // No label row is claimed for an unknown outcome.
    expect(one(db, "SELECT COUNT(*) n FROM label WHERE print_job_id = ?", first.printJobId)).toEqual({ n: 0 });

    // Double click: the same idempotency key replays the original result.
    const replay = run<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" }, "click-1");
    expect(replay.ok && replay.replayed).toBe(true);
    if (replay.ok) expect(replay.result.printJobId).toBe(first.printJobId);

    // A new click (different key) before reconciliation: duplicate prevented, nothing created.
    const retry = must<PrintResult>(db, STAFF.marcus, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" }, "click-2");
    expect(retry.outcome).toBe("duplicate_prevented");
    expect(retry.displayId).toBe(first.displayId);
    expect(retry.message).toMatch(/unknown outcome.*Reconcile/i);

    // A reprint before reconciliation is refused.
    const reprint = run(db, STAFF.priya, "print.reprint", { printJobId: first.printJobId, reason: "Try again" });
    expect(reprint.ok).toBe(false);
    if (!reprint.ok) expect(reprint.error.code).toBe("BLOCKED");

    expect(countJobs(db, slideId)).toBe(1);
    // The database itself refuses a second in-flight job for the same label.
    expect(() =>
      db
        .prepare(
          `INSERT INTO print_job (id, display_id, printer_id, kind, target_type, target_id, payload, purpose, state, idempotency_key, requested_by, created_at)
           VALUES ('pj_x', 'PJ-9999', 'prn_s1', 'slide_label', 'slide', ?, 'x', 'initial', 'queued', 'k-x', 'stf_priya', '2026-10-14T15:00:00Z')`,
        )
        .run(slideId),
    ).toThrow(/UNIQUE/);
  });

  it("PJ-8841: after 'Not printed' reconciliation, a reprint needs a reason, links the original, records the operator and creates no new slide", () => {
    const db = testDb();
    const pj = one<{ id: string; target_id: string; version: number; state: string }>(db, "SELECT id, target_id, version, state FROM print_job WHERE display_id = 'PJ-8841'");
    expect(pj.state).toBe("unknown_outcome");
    const slidesBefore = countSlides(db);

    // An accessioner cannot reconcile (server-side role check).
    const denied = run(db, STAFF.maya, "print.reconcile", { printJobId: pj.id, expectedVersion: pj.version, outcome: "not_printed" });
    expect(!denied.ok && denied.error.code).toBe("FORBIDDEN");
    // A stale version is a conflict, not a silent overwrite.
    const stale = run(db, STAFF.priya, "print.reconcile", { printJobId: pj.id, expectedVersion: pj.version - 1, outcome: "not_printed" });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");

    const rec = must<PrintResult>(db, STAFF.priya, "print.reconcile", { printJobId: pj.id, expectedVersion: pj.version, outcome: "not_printed", note: "Printer tray empty, nothing came out" });
    expect(rec.state).toBe("failed");
    const after = one<{ state: string; reconciliation: string; reconciled_by: string }>(db, "SELECT state, reconciliation, reconciled_by FROM print_job WHERE id = ?", pj.id);
    expect(after).toEqual({ state: "failed", reconciliation: "not_printed", reconciled_by: STAFF.priya });
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'print_reconcile' AND entity_id = ? AND status = 'open'", pj.id)).toEqual({ n: 0 });

    // Reprint without a reason is rejected and creates nothing.
    const jobsBefore = countJobs(db);
    const noReason = run(db, STAFF.priya, "print.reprint", { printJobId: pj.id, reason: "   " });
    expect(!noReason.ok && noReason.error.code).toBe("VALIDATION");
    expect(countJobs(db)).toBe(jobsBefore);

    const re = must<PrintResult>(db, STAFF.priya, "print.reprint", { printJobId: pj.id, reason: "Not printed after the timeout; reprinting" });
    expect(re.outcome).toBe("created");
    const reprint = one<{ reprint_of_job_id: string; reprint_reason: string; requested_by: string; purpose: string; target_id: string; state: string }>(
      db,
      "SELECT reprint_of_job_id, reprint_reason, requested_by, purpose, target_id, state FROM print_job WHERE id = ?",
      re.printJobId,
    );
    expect(reprint).toMatchObject({
      reprint_of_job_id: pj.id,
      reprint_reason: "Not printed after the timeout; reprinting",
      requested_by: STAFF.priya,
      purpose: "reprint_after_unknown",
      target_id: pj.target_id,
      state: "acknowledged",
    });
    expect(countJobs(db)).toBe(jobsBefore + 1);
    expect(countSlides(db)).toBe(slidesBefore);
    // The detail view shows the chain original → reprint.
    const detail = getPrintJobDetail(db, re.printJobId, demoNow(db))!;
    expect(detail.chain.map((c) => c.displayId)).toEqual(["PJ-8841", re.displayId]);
  });

  it("\"Can't tell\" keeps the job unknown, escalates to a supervisor, and still blocks any retry", () => {
    const db = testDb();
    const pj = one<{ id: string; version: number }>(db, "SELECT id, version FROM print_job WHERE display_id = 'PJ-8841'");
    const noNote = run(db, STAFF.priya, "print.reconcile", { printJobId: pj.id, expectedVersion: pj.version, outcome: "cant_tell" });
    expect(!noNote.ok && noNote.error.code).toBe("VALIDATION");
    const r = must<PrintResult>(db, STAFF.priya, "print.reconcile", { printJobId: pj.id, expectedVersion: pj.version, outcome: "cant_tell", note: "A blank label is in the tray; not sure it is ours" });
    expect(r.state).toBe("unknown_outcome");
    expect(one(db, "SELECT owner_id FROM task WHERE kind = 'print_escalation' AND entity_id = ? AND status = 'open'", pj.id)).toEqual({ owner_id: STAFF.tanya });
    // The only open task for the job is now the supervisor's, so Operations shows the supervisor as owner.
    expect(all(db, "SELECT kind, owner_id FROM task WHERE entity_type = 'print_job' AND entity_id = ? AND status = 'open'", pj.id)).toEqual([{ kind: "print_escalation", owner_id: STAFF.tanya }]);
    const retry = run(db, STAFF.priya, "print.reprint", { printJobId: pj.id, reason: "Again" });
    expect(!retry.ok && retry.error.code).toBe("BLOCKED");
    // The supervisor checks and records the real outcome; the escalation closes.
    const v = one<{ version: number }>(db, "SELECT version FROM print_job WHERE id = ?", pj.id).version;
    must(db, STAFF.tanya, "print.reconcile", { printJobId: pj.id, expectedVersion: v, outcome: "printed_ok", note: "Found the label in the output tray" });
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'print_escalation' AND entity_id = ? AND status = 'open'", pj.id)).toEqual({ n: 0 });
    expect(one(db, "SELECT state FROM label WHERE print_job_id = ?", pj.id)).toEqual({ state: "printed" });
  });

  it("an offline printer keeps the job queued (nothing lost, no duplicate) and it prints when released", () => {
    const db = testDb();
    const { slideId } = freshSlide(db);
    setPrinter(db, "prn_s1", "offline");
    const r = must<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    expect(r.outcome).toBe("created");
    expect(r.state).toBe("queued");
    expect(r.printerUnavailable).toBe(true);
    expect(r.message).toMatch(/unavailable \(simulated\)/i);
    expect(one(db, "SELECT state, submitted_at FROM print_job WHERE id = ?", r.printJobId)).toEqual({ state: "queued", submitted_at: null });

    const again = must<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    expect(again.outcome).toBe("duplicate_prevented");
    expect(again.message).toMatch(/Already in flight as PJ-\d{4}/);

    // Still offline: releasing keeps it queued.
    expect(must<PrintResult>(db, STAFF.priya, "print.release", { printJobId: r.printJobId }).state).toBe("queued");
    setPrinter(db, "prn_s1", "online");
    const released = must<PrintResult>(db, STAFF.priya, "print.release", { printJobId: r.printJobId });
    expect(released.state).toBe("acknowledged");
    expect(countJobs(db, slideId)).toBe(1);
    // The slide printer does not report completion: no label is claimed until someone checks the output.
    expect(one(db, "SELECT label_state FROM slide WHERE id = ?", slideId)).toEqual({ label_state: "none" });
    recordOutput(db, STAFF.priya, r.printJobId, "printed_ok");
    expect(one(db, "SELECT label_state FROM slide WHERE id = ?", slideId)).toEqual({ label_state: "printed" });
  });

  it("printing, applying and verifying a label are separate; a damaged-label reprint retires the old label through an explicit step", () => {
    const db = testDb();
    // A seeded slide whose label is verified, printed by an acknowledged job.
    const old = one<{ id: string; target_id: string; print_job_id: string; payload: string }>(
      db,
      `SELECT l.id, l.target_id, l.print_job_id, l.payload FROM label l JOIN print_job pj ON pj.id = l.print_job_id JOIN slide s ON s.id = l.target_id
        WHERE l.target_type = 'slide' AND l.state = 'verified' AND pj.state = 'acknowledged' AND s.status = 'active' ORDER BY l.id LIMIT 1`,
    );
    const slidesBefore = countSlides(db);
    const origBefore = one<{ acknowledged_at: string; completed_at: string | null }>(db, "SELECT acknowledged_at, completed_at FROM print_job WHERE id = ?", old.print_job_id);
    const re = must<PrintResult>(db, STAFF.priya, "print.reprint", { printJobId: old.print_job_id, reason: "Label smudged by xylene; code unreadable" });
    expect(re.retireLabelId).toBe(old.id);
    expect(one(db, "SELECT purpose FROM print_job WHERE id = ?", re.printJobId)).toEqual({ purpose: "reprint_damaged" });
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'label_retire' AND entity_id = ? AND status = 'open'", old.id)).toEqual({ n: 1 });
    // The original is closed from its label on record, not from the reprint reason, and no printer timestamp is invented.
    const orig = one<{ state: string; reconciliation: string; reconciled_by: string; acknowledged_at: string; completed_at: string | null; reconciliation_note: string }>(
      db, "SELECT state, reconciliation, reconciled_by, acknowledged_at, completed_at, reconciliation_note FROM print_job WHERE id = ?", old.print_job_id,
    );
    expect(orig).toMatchObject({ state: "completion_confirmed", reconciliation: "printed_ok", reconciled_by: STAFF.priya, ...origBefore });
    expect(orig.reconciliation_note).toMatch(/on record \(verified/);
    // The new job was only acknowledged: no label row until a person records the output.
    expect(re.labelId).toBeNull();
    expect(one(db, "SELECT COUNT(*) n FROM label WHERE print_job_id = ?", re.printJobId)).toEqual({ n: 0 });
    recordOutput(db, STAFF.priya, re.printJobId, "printed_ok");
    const fresh = one<{ id: string; state: string; replaces_label_id: string }>(db, "SELECT id, state, replaces_label_id FROM label WHERE print_job_id = ?", re.printJobId);
    expect(fresh).toMatchObject({ state: "printed", replaces_label_id: old.id });
    expect(countSlides(db)).toBe(slidesBefore);

    // The new label cannot be applied while the old one is still on the slide.
    const blocked = run(db, STAFF.priya, "label.apply", { labelId: fresh.id });
    expect(!blocked.ok && blocked.error.code).toBe("BLOCKED");
    // An accessioner cannot retire labels; the histotech can, with a reason.
    expect((run(db, STAFF.maya, "label.retire", { labelId: old.id, reason: "x" }) as { ok: boolean }).ok).toBe(false);
    expect(run(db, STAFF.priya, "label.retire", { labelId: old.id, reason: "" }).ok).toBe(false);
    must(db, STAFF.priya, "label.retire", { labelId: old.id, reason: "Damaged label removed and destroyed at the bench" });
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'label_retire' AND entity_id = ? AND status = 'open'", old.id)).toEqual({ n: 0 });

    must(db, STAFF.priya, "label.apply", { labelId: fresh.id });
    expect(one(db, "SELECT state FROM label WHERE id = ?", fresh.id)).toEqual({ state: "applied" });
    // Verification requires a scan that decodes and matches.
    const damaged = old.payload.slice(0, -1) + (old.payload.endsWith("A") ? "B" : "A");
    const bad = must<{ verified: boolean; reason: string }>(db, STAFF.priya, "label.verify", { labelId: fresh.id, scannedPayload: damaged });
    expect(bad.verified).toBe(false);
    expect(bad.reason).toMatch(/Check character/i);
    expect(one(db, "SELECT state FROM label WHERE id = ?", fresh.id)).toEqual({ state: "applied" });
    const ok = must<{ verified: boolean }>(db, STAFF.priya, "label.verify", { labelId: fresh.id, scannedPayload: old.payload });
    expect(ok.verified).toBe(true);
    expect(one(db, "SELECT label_state FROM slide WHERE id = ?", old.target_id)).toEqual({ label_state: "verified" });
  });

  it("ordering an additional slide creates a work order and a new planned slide; it is not a reprint", () => {
    const db = testDb();
    const block = one<{ id: string }>(db, "SELECT id FROM block WHERE physical_state = 'sectioned' AND custody_state = 'in_workflow' ORDER BY id LIMIT 1");
    const before = { slides: countSlides(db), jobs: countJobs(db) };
    const r = must<{ workOrderId: string; slideId: string; slideLabel: string }>(db, STAFF.priya, "slide.orderAdditional", {
      blockId: block.id, stain: "H&E", level: "deeper L2", reason: "Dr. Marsh asked for a deeper level",
    });
    expect(countSlides(db)).toBe(before.slides + 1);
    expect(countJobs(db)).toBe(before.jobs);
    expect(one(db, "SELECT kind, status, authorization_source, target_block_id FROM work_order WHERE id = ?", r.workOrderId)).toEqual({
      kind: "levels", status: "requested", authorization_source: "pathologist_request", target_block_id: block.id,
    });
    expect(one(db, "SELECT physical_state, label_state, work_order_id FROM slide WHERE id = ?", r.slideId)).toEqual({
      physical_state: "planned", label_state: "none", work_order_id: r.workOrderId,
    });
    expect(decodeLabel(ident(db, r.slideId)).ok).toBe(true);
    // An accessioner cannot order additional work.
    expect(run(db, STAFF.maya, "slide.orderAdditional", { blockId: block.id, stain: "PAS", reason: "x" }).ok).toBe(false);
  });
});

// =====================================================================================
describe("Acceptance 9: TRY-M-03 cannot become verified complete with a missing and an unexpected slide", () => {
  it("storyline step 6: 9 expected + 1 unexpected scanned → completion is BLOCKED with reasons; a histotech cannot release with exceptions", () => {
    const db = testDb();
    const sc = scenario(db);
    const nine = must<{ result: string; scannedCount: number; expectedCount: number }>(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.expectedUnscanned) });
    expect(nine.result).toBe("verified_expected");
    expect([nine.scannedCount, nine.expectedCount]).toEqual([9, 10]);
    const odd = must<{ result: string; accepted: boolean; message: string }>(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.unexpected) });
    expect(odd.result).toBe("unexpected");
    expect(odd.accepted).toBe(false);
    expect(odd.message).toMatch(/Dr\. Samuel Okafor/);
    expect(one(db, "SELECT status FROM tray WHERE id = 'tray_m03'")).toEqual({ status: "exception" });

    const done = run(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: trayVersion(db) });
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.error.code).toBe("BLOCKED");
      expect(done.error.message).toMatch(/1 not scanned/);
      expect(done.error.message).toMatch(/1 unexpected/);
      const reasons = (done.error.details as { reasons: string[] }).reasons;
      expect(reasons.some((x) => x.includes("expected, not scanned"))).toBe(true);
      expect(reasons.some((x) => x.startsWith("Unexpected slide"))).toBe(true);
    }
    expect(one(db, "SELECT status FROM tray WHERE id = 'tray_m03'")).toEqual({ status: "exception" });

    // Removing the unexpected slide is not enough: the 10th is still not scanned.
    const scan = one<{ id: string }>(db, "SELECT id FROM tray_scan WHERE tray_id = 'tray_m03' AND result = 'unexpected'");
    must(db, STAFF.priya, "tray.resolveScan", { scanId: scan.id, resolution: "removed_from_tray" });
    const still = run(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: trayVersion(db) });
    expect(!still.ok && still.error.code).toBe("BLOCKED");
    // Storyline step 8: the tray stays visibly blocked (status + an owned task) for Operations, not quietly "assembling".
    expect(one(db, "SELECT status FROM tray WHERE id = 'tray_m03'")).toEqual({ status: "exception" });
    expect(one(db, "SELECT owner_id FROM task WHERE kind = 'tray_exception' AND entity_type = 'tray' AND entity_id = 'tray_m03' AND status = 'open'")).toEqual({ owner_id: STAFF.priya });

    // Only a supervisor may release with exceptions; a histotech is refused by the server.
    const ht = run(db, STAFF.priya, "tray.releaseWithExceptions", { trayId: "tray_m03", note: "Release anyway" });
    expect(!ht.ok && ht.error.code).toBe("FORBIDDEN");
    // Even a supervisor needs a controlled disposition for the missing slide first.
    const early = run(db, STAFF.tanya, "tray.releaseWithExceptions", { trayId: "tray_m03", note: "Release" });
    expect(!early.ok && early.error.code).toBe("BLOCKED");

    must(db, STAFF.priya, "tray.setDisposition", { trayId: "tray_m03", slideId: sc.missing, disposition: "follows_separately", note: "Still at the coverslipper; will walk it over" });
    expect(one<{ title: string }>(db, "SELECT title FROM task WHERE kind = 'tray_exception' AND entity_type = 'slide' AND entity_id = ? AND status = 'open'", sc.missing).title).toMatch(/^Deliver .* separately/);
    // A disposition never turns the tray into "verified complete".
    const stillNot = run(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: trayVersion(db) });
    expect(!stillNot.ok && stillNot.error.code).toBe("BLOCKED");

    const rel = must<{ status: string }>(db, STAFF.tanya, "tray.releaseWithExceptions", { trayId: "tray_m03", note: "Dr. Marsh agreed to start; A1-2 follows" });
    expect(rel.status).toBe("released_with_exceptions");
    // The tray-level exception is decided; the slide that follows separately keeps its own task.
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'tray_exception' AND entity_type = 'tray' AND entity_id = 'tray_m03' AND status = 'open'")).toEqual({ n: 0 });
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'tray_exception' AND entity_type = 'slide' AND entity_id = ? AND status = 'open'", sc.missing)).toEqual({ n: 1 });
    const t = one<{ status: string; close_note: string }>(db, "SELECT status, close_note FROM tray WHERE id = 'tray_m03'");
    expect(t.status).toBe("released_with_exceptions");
    expect(t.close_note).toMatch(/Outstanding: .*follows separately/);

    const del = must<{ delivered: number; outstanding: string[] }>(db, STAFF.priya, "tray.deliver", { trayId: "tray_m03" });
    expect(del.delivered).toBe(9);
    expect(del.outstanding).toHaveLength(1);
    expect(one(db, "SELECT physical_state FROM slide WHERE id = ?", sc.missing)).toEqual({ physical_state: "qc_reviewed" });
    expect(one(db, "SELECT physical_state FROM slide WHERE id = ?", sc.expectedUnscanned)).toEqual({ physical_state: "delivered" });
  });

  it("finding the missing slide and scanning it (after removing the unexpected one) lets the tray be verified complete", () => {
    const db = testDb();
    const sc = scenario(db);
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.expectedUnscanned) });
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.unexpected) });
    must(db, STAFF.priya, "tray.setDisposition", { trayId: "tray_m03", slideId: sc.missing, disposition: "missing_investigation", note: "Not at coverslipper or QC bench" });
    expect(one<{ title: string }>(db, "SELECT title FROM task WHERE kind = 'tray_exception' AND entity_type = 'slide' AND entity_id = ? AND status = 'open'", sc.missing).title).toMatch(/^Missing-material investigation/);
    const scan = one<{ id: string }>(db, "SELECT id FROM tray_scan WHERE tray_id = 'tray_m03' AND result = 'unexpected'");
    must(db, STAFF.priya, "tray.resolveScan", { scanId: scan.id, resolution: "removed_from_tray" });
    const found = must<{ result: string }>(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.missing) });
    expect(found.result).toBe("verified_expected");
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'tray_exception' AND entity_type = 'slide' AND entity_id = ? AND status = 'open'", sc.missing)).toEqual({ n: 0 });
    // Nothing is outstanding any more, so the tray is back to normal assembly and its exception task is closed.
    expect(one(db, "SELECT status FROM tray WHERE id = 'tray_m03'")).toEqual({ status: "assembling" });
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'tray_exception' AND entity_type = 'tray' AND status = 'open'")).toEqual({ n: 0 });

    // A stale "Mark complete" (from before the last scan) is a conflict.
    const stale = run(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: trayVersion(db) - 1 });
    expect(!stale.ok && stale.error.code).toBe("CONFLICT");
    const ok = must<{ status: string }>(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: trayVersion(db) });
    expect(ok.status).toBe("verified_complete");
  });

  it("a duplicate scan is counted once and must be resolved; a label with a bad check character is rejected", () => {
    const db = testDb();
    const sc = scenario(db);
    const already = one<{ slide_id: string }>(db, "SELECT slide_id FROM tray_scan WHERE id = 'ts_m03_1'").slide_id;
    const dup = must<{ result: string; scannedCount: number }>(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, already) });
    expect(dup.result).toBe("duplicate");
    expect(dup.scannedCount).toBe(8);

    const good = ident(db, sc.expectedUnscanned);
    const last = good.slice(-1);
    const smudged = good.slice(0, -1) + (last === "Z" ? "Y" : last === "9" ? "A" : String.fromCharCode(last.charCodeAt(0) + 1));
    const bad = must<{ result: string; accepted: boolean; message: string }>(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: smudged });
    expect(bad.result).toBe("invalid_payload");
    expect(bad.accepted).toBe(false);
    expect(bad.message).toMatch(/Check character/i);
    // A misread identifies nothing, so it is logged as "not accepted" rather than left as an open item on Operations.
    expect(one(db, "SELECT resolution, resolved_by FROM tray_scan WHERE tray_id = 'tray_m03' AND result = 'invalid_payload'")).toEqual({ resolution: "not_accepted", resolved_by: STAFF.priya });

    const view = getTrayDetail(db, "TRY-M-03")!.view;
    expect(view.counts.scanned).toBe(8);
    expect(view.unresolved.map((s) => s.result)).toEqual(["duplicate"]);
    const dupScan = view.unresolved[0];
    must(db, STAFF.priya, "tray.resolveScan", { scanId: dupScan.id, resolution: "same_slide_rescanned" });
    expect(getTrayDetail(db, "TRY-M-03")!.view.unresolved).toHaveLength(0);
  });

  it("an unexpected slide from another pathologist cannot be added to the tray's list, even by a supervisor", () => {
    const db = testDb();
    const sc = scenario(db);
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.unexpected) });
    const scan = one<{ id: string }>(db, "SELECT id FROM tray_scan WHERE tray_id = 'tray_m03' AND result = 'unexpected'");
    const ht = run(db, STAFF.priya, "tray.resolveScan", { scanId: scan.id, resolution: "added_by_authorized_change" });
    expect(!ht.ok && ht.error.code).toBe("FORBIDDEN");
    const sup = run(db, STAFF.tanya, "tray.resolveScan", { scanId: scan.id, resolution: "added_by_authorized_change" });
    expect(!sup.ok && sup.error.code).toBe("INVARIANT");
  });
});

// =====================================================================================
describe("Acceptance 10: RR-0192 — wrong block scan is a mismatch; locations are last confirmed, not live", () => {
  it("scanning D26-03909 A1 for RR-0192 shows a mismatch, changes nothing, and records a scan_mismatch custody event", () => {
    const db = testDb();
    const wrong = one<{ id: string; identifier: string; custody_state: string; version: number }>(
      db,
      "SELECT b.id, b.identifier, b.custody_state, b.version FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = 'D26-03909'",
    );
    const itemsBefore = all(db, "SELECT * FROM retrieval_item WHERE request_id = 'rr_0192' ORDER BY bench_seq");
    const reqBefore = one(db, "SELECT status, version FROM retrieval_request WHERE id = 'rr_0192'");

    const r = must<{ result: string; accepted: boolean; message: string }>(db, STAFF.marcus, "retrieval.scan", { requestId: "rr_0192", payload: wrong.identifier });
    expect(r.result).toBe("mismatch");
    expect(r.accepted).toBe(false);
    expect(r.message).toMatch(/^Mismatch\. Scanned D26-03909 A1\. RR-0192 needs D26-03990 B1, D26-03990 A1, D26-03912 A1\. Not accepted\.$/);

    // Nothing about the request's items changed (no counters, no status) — only the custody event below.
    expect(all(db, "SELECT * FROM retrieval_item WHERE request_id = 'rr_0192' ORDER BY bench_seq")).toEqual(itemsBefore);
    expect(one(db, "SELECT status, version FROM retrieval_request WHERE id = 'rr_0192'")).toEqual(reqBefore);
    expect(one(db, "SELECT custody_state, version FROM block WHERE id = ?", wrong.id)).toEqual({ custody_state: wrong.custody_state, version: wrong.version });
    const ev = all<{ event: string; request_id: string; actor_id: string }>(db, "SELECT event, request_id, actor_id FROM custody_event WHERE material_id = ? AND event = 'scan_mismatch'", wrong.id);
    expect(ev).toEqual([{ event: "scan_mismatch", request_id: "rr_0192", actor_id: STAFF.marcus }]);
  });

  it("the request view shows each location as last confirmed with time and person, with the fixed not-live caption, and the overdue checkout", () => {
    const db = testDb();
    const d = getRetrievalDetail(db, "RR-0192", demoNow(db))!;
    const a1 = d.items.find((i) => i.blockLabel === "D26-03990 A1")!;
    expect(a1.location.text).toBe("Last confirmed: CAB-2/DR-4/BX-11/S-14 · confirmed Oct 9, 3:20 PM ET by Marcus Lee");
    expect(d.locationCaption).toBe("Last confirmed location, not live tracking. The block may have moved since.");
    // Pick list grouped by location, keeping the bench order.
    const box = d.pickList.find((g) => g.key === "CAB-2/DR-4/BX-11")!;
    expect(box.items.map((i) => `${i.blockLabel} pick ${i.benchSeq} of ${i.total}`)).toEqual(["D26-03990 A1 pick 2 of 3", "D26-03990 B1 pick 1 of 3"]);
    const overdue = d.items.find((i) => i.blockLabel === "D26-03912 A1")!;
    expect(overdue.custody.overdue).toBe(true);
    expect(overdue.custody.summary).toMatch(/Checked out to Marcus Lee since Oct 10, 11:00 AM ET .*overdue/);
    expect(d.pickList.find((g) => g.key === "~not-in-storage")!.items.map((i) => i.blockLabel)).toEqual(["D26-03912 A1"]);
  });

  it("the correct block scan picks it and checks it out to the scanner with the destination; a second scan is a duplicate", () => {
    const db = testDb();
    const a1 = one<{ id: string; identifier: string }>(db, "SELECT b.id, b.identifier FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = 'D26-03990' AND b.label_text = 'A1'");
    const r = must<{ result: string; accepted: boolean; message: string; requestStatus: string }>(db, STAFF.marcus, "retrieval.scan", { requestId: "rr_0192", payload: a1.identifier });
    expect(r.result).toBe("picked");
    expect(r.message).toMatch(/Matches RR-0192 \(pick 2 of 3\)/);
    expect(r.requestStatus).toBe("picking");
    expect(one(db, "SELECT status, picked_by FROM retrieval_item WHERE id = 'ri_0192_2'")).toEqual({ status: "picked", picked_by: STAFF.marcus });
    expect(one(db, "SELECT custody_state, checkout_holder_id FROM block WHERE id = ?", a1.id)).toEqual({ custody_state: "checked_out", checkout_holder_id: STAFF.marcus });
    expect(one(db, "SELECT holder_id, destination FROM custody_event WHERE material_id = ? AND event = 'checked_out' AND request_id = 'rr_0192'", a1.id)).toEqual({
      holder_id: STAFF.marcus, destination: "Microtomy bench 2",
    });
    const again = must<{ result: string }>(db, STAFF.marcus, "retrieval.scan", { requestId: "rr_0192", payload: a1.identifier });
    expect(again.result).toBe("duplicate");
    // An accessioner cannot pick blocks.
    expect(run(db, STAFF.maya, "retrieval.scan", { requestId: "rr_0192", payload: a1.identifier }).ok).toBe(false);
  });

  it("a block not at its last location opens a missing-material investigation; the request becomes a partial retrieval", () => {
    const db = testDb();
    const blocks = all<{ id: string; identifier: string; label_text: string; accession_number: string }>(
      db,
      "SELECT b.id, b.identifier, b.label_text, a.accession_number FROM retrieval_item ri JOIN block b ON b.id = ri.block_id JOIN accession a ON a.id = b.accession_id WHERE ri.request_id = 'rr_0192' ORDER BY ri.bench_seq",
    );
    must(db, STAFF.marcus, "retrieval.scan", { requestId: "rr_0192", payload: blocks[1].identifier });
    must(db, STAFF.marcus, "retrieval.scan", { requestId: "rr_0192", payload: blocks[2].identifier }); // the overdue checkout, found at the bench
    const nf = must<{ taskId: string }>(db, STAFF.marcus, "retrieval.markNotFound", { itemId: "ri_0192_1", note: "Slot S-15 empty; checked S-14 and S-16" });
    expect(one(db, "SELECT kind, entity_id, status FROM task WHERE id = ?", nf.taskId)).toEqual({ kind: "missing_material", entity_id: blocks[0].id, status: "open" });
    expect(one(db, "SELECT custody_state FROM block WHERE id = ?", blocks[0].id)).toEqual({ custody_state: "missing_investigation" });
    expect(one(db, "SELECT status FROM retrieval_request WHERE id = 'rr_0192'")).toEqual({ status: "partially_retrieved" });
    const del = must<{ delivered: number; message: string }>(db, STAFF.marcus, "retrieval.deliver", { requestId: "rr_0192" });
    expect(del.delivered).toBe(2);
    expect(del.message).toMatch(/1 still outstanding/);
    // Returning a block confirms that block's slot only.
    must(db, STAFF.marcus, "retrieval.return", { blockId: blocks[1].id, locationCode: "CAB-2/DR-4/BX-11/S-14" });
    expect(one(db, "SELECT custody_state, location_confirmed_by FROM block WHERE id = ?", blocks[1].id)).toEqual({ custody_state: "stored", location_confirmed_by: STAFF.marcus });
    expect(run(db, STAFF.marcus, "retrieval.return", { blockId: blocks[1].id, locationCode: "CAB-2/DR-4" }).ok).toBe(false);
  });

  it("a block recorded as sent outside the lab is not silently picked when scanned (conflicting records go to a supervisor)", () => {
    const db = testDb();
    const out = one<{ id: string; identifier: string }>(db, "SELECT b.id, b.identifier FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = 'D26-03991'");
    const req = must<{ requestId: string }>(db, STAFF.okafor, "retrieval.create", { blockIds: [out.id], purpose: "Compare with send-out (synthetic)", destination: "Microtomy bench 2" });
    const r = must<{ result: string }>(db, STAFF.marcus, "retrieval.scan", { requestId: req.requestId, payload: out.identifier });
    expect(r.result).toBe("conflict");
    expect(one(db, "SELECT custody_state FROM block WHERE id = ?", out.id)).toEqual({ custody_state: "sent_out" });
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'custody_conflict' AND entity_id = ? AND status = 'open'", out.id)).toEqual({ n: 1 });
  });
});

// =====================================================================================
describe("Acceptance 14 (review side): a canceled stain order stays traceable and its printed/prepared work is reviewed", () => {
  /** Mirrors what the S6 importer does when ORD-xxxx v2 removes the PAS (contract: cancel_review + slides canceled_needs_review + task). */
  function simulateSourceCancel(db: DB): { woId: string; slideId: string } {
    const woId = one<{ value: string }>(db, "SELECT value FROM app_setting WHERE key = 'scenario_pas_cancel_wo'").value;
    db.prepare("UPDATE work_order SET status = 'cancel_review', status_reason = 'PAS removed by office (entered in error)', version = version + 1 WHERE id = ?").run(woId);
    db.prepare("UPDATE slide SET status = 'canceled_needs_review', version = version + 1 WHERE work_order_id = ?").run(woId);
    db.prepare(
      `INSERT INTO task (id, kind, entity_type, entity_id, title, owner_role, status, priority, created_at, version)
       VALUES ('task_wo_review', 'order_change_review', 'work_order', ?, 'Review material for canceled PAS', 'histotech', 'open', 'high', '2026-10-14T15:20:00Z', 1)`,
    ).run(woId);
    const slideId = one<{ id: string }>(db, "SELECT id FROM slide WHERE work_order_id = ?", woId).id;
    return { woId, slideId };
  }

  it("the printed PAS slide stays visible, cannot be reprinted, and the review decision is recorded without deleting anything", () => {
    const db = testDb();
    const { woId, slideId } = simulateSourceCancel(db);
    const labelsBefore = all(db, "SELECT id FROM label WHERE target_type = 'slide' AND target_id = ?", slideId);
    expect(labelsBefore.length).toBeGreaterThan(0);

    // While under review no new label can be printed for that slide.
    const pr = run(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    expect(!pr.ok && pr.error.code).toBe("BLOCKED");
    // The slide was already stained: it cannot be voided as "unprepared".
    const v = run(db, STAFF.priya, "workorder.reviewSourceChange", { workOrderId: woId, decision: "void_unprepared", note: "Not needed" });
    expect(!v.ok && v.error.code).toBe("BLOCKED");
    // Role and note checks.
    expect(!run(db, STAFF.maya, "workorder.reviewSourceChange", { workOrderId: woId, decision: "retain_prepared_material", note: "x" }).ok).toBe(true);
    expect(!run(db, STAFF.priya, "workorder.reviewSourceChange", { workOrderId: woId, decision: "retain_prepared_material", note: " " }).ok).toBe(true);

    const r = must<{ status: string; slides: { disposition: string }[] }>(db, STAFF.priya, "workorder.reviewSourceChange", {
      workOrderId: woId, decision: "retain_prepared_material", note: "Stained PAS slide retained and filed with the case; not delivered as ordered work",
    });
    expect(r.status).toBe("canceled");
    expect(r.slides.map((s) => s.disposition)).toEqual(["retained_per_review"]);
    expect(one(db, "SELECT status, review_decision, reviewed_by FROM work_order WHERE id = ?", woId)).toEqual({
      status: "canceled", review_decision: "retain_prepared_material", reviewed_by: STAFF.priya,
    });
    // Nothing deleted: the slide row and its label rows are still there, with the decision recorded.
    expect(one(db, "SELECT review_disposition, physical_state FROM slide WHERE id = ?", slideId)).toEqual({ review_disposition: "retained_per_review", physical_state: "stained" });
    expect(all(db, "SELECT id FROM label WHERE target_type = 'slide' AND target_id = ?", slideId)).toEqual(labelsBefore);
    expect(one(db, "SELECT status FROM task WHERE id = 'task_wo_review'")).toEqual({ status: "done" });
    expect(one(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'work_order.reviewed' AND entity_id = ?", woId)).toEqual({ n: 1 });
    expect(one<{ change_type: string }>(db, "SELECT change_type FROM worklist_change ORDER BY seq DESC LIMIT 1").change_type).toBe("canceled");
    // A second decision is refused: the work order is no longer awaiting review.
    expect(!run(db, STAFF.priya, "workorder.reviewSourceChange", { workOrderId: woId, decision: "keep_active", note: "Changed my mind" }).ok).toBe(true);
  });
});

// =====================================================================================
describe("Bench progress respects holds and never delivers slides outside a tray", () => {
  it("a sectioning hold blocks cutting; delivery is only through a tray; gross approval gates processing", () => {
    const db = testDb();
    const slide = one<{ id: string; block_id: string; part_id: string; accession_id: string }>(
      db,
      `SELECT s.id, s.block_id, b.part_id, s.accession_id FROM slide s JOIN block b ON b.id = s.block_id
        WHERE s.physical_state = 'planned' AND s.status = 'active' AND b.physical_state = 'embedded' ORDER BY s.id LIMIT 1`,
    );
    db.prepare(
      `INSERT INTO hold (id, display_id, scope_type, scope_id, scope_label, blocks, reason_code, reason_text, status, placed_by, placed_at, accession_id, version)
       VALUES ('hold_t', 'H-9001', 'specimen_part', ?, 'Part A', '["sectioning"]', 'other', 'Pathologist review pending', 'active', 'stf_kim', '2026-10-14T14:00:00Z', ?, 1)`,
    ).run(slide.part_id, slide.accession_id);
    const cut = run(db, STAFF.priya, "slide.advance", { slideIds: [slide.id], toState: "sectioned" });
    expect(!cut.ok && cut.error.code).toBe("BLOCKED");
    if (!cut.ok) expect(cut.error.message).toMatch(/H-9001/);
    db.prepare("UPDATE hold SET status = 'released' WHERE id = 'hold_t'").run();
    must(db, STAFF.priya, "slide.advance", { slideIds: [slide.id], toState: "sectioned" });
    expect(one(db, "SELECT physical_state FROM block WHERE id = ?", slide.block_id)).toEqual({ physical_state: "sectioned" });

    const deliver = run(db, STAFF.priya, "slide.advance", { slideIds: [slide.id], toState: "delivered" });
    expect(!deliver.ok && deliver.error.code).toBe("VALIDATION");

    const loaded = one<{ id: string } | undefined>(
      db,
      `SELECT b.id FROM block b WHERE b.physical_state = 'cassette_loaded'
         AND NOT EXISTS (SELECT 1 FROM gross_record g WHERE g.specimen_part_id = b.part_id AND g.state = 'approved_for_downstream') LIMIT 1`,
    );
    expect(loaded).toBeTruthy();
    const proc = run(db, STAFF.priya, "block.advance", { blockIds: [loaded!.id], toState: "processing" });
    expect(!proc.ok && proc.error.code).toBe("BLOCKED");
    if (!proc.ok) expect(proc.error.message).toMatch(/not approved for downstream use/);
  });
});

// =====================================================================================
describe("Materials read models used by /materials", () => {
  it("open the demo on the right facts: PJ-8841 first, TRY-M-03's simulated bench follows storyline step 6, RR-0192 offers the wrong block", async () => {
    const db = testDb();
    const now = demoNow(db);
    const q = await import("@/server/queries/materials");
    const jobs = q.listPrintJobs(db, { filter: "attention", now });
    expect(jobs.rows[0].displayId).toBe("PJ-8841");
    expect(jobs.counts.unknown).toBe(1);
    const pj = q.getPrintJobDetail(db, "PJ-8841", now)!;
    expect(pj.preview.matches).toBe(true);
    expect(pj.preview.human).toBe(pj.target.label.replace(/ deeper L1$/, ""));
    expect(pj.openTasks.map((t) => t.kind)).toContain("print_reconcile");

    const sc = scenario(db);
    const tray = q.getTrayDetail(db, "TRY-M-03")!;
    expect(tray.view.counts).toMatchObject({ expected: 10, scanned: 8, unresolved: 0 });
    const byKind = Object.fromEntries(tray.bench.map((b) => [b.kind, b]));
    expect(byKind.expected.payload).toBe(ident(db, sc.expectedUnscanned));
    expect(byKind.unexpected.payload).toBe(ident(db, sc.unexpected));
    expect(byKind.missing.hiddenUntilFound).toBe(true);
    expect(decodeLabel(byKind.damaged.payload).ok).toBe(false);

    const rr = q.getRetrievalDetail(db, "RR-0192", now)!;
    expect(rr.sampleWrongBlock?.label).toBe("D26-03909 A1");
    expect(q.custodyExceptions(db, now).overdue.map((o) => o.label)).toContain("D26-03912 A1");
    expect(q.custodyExceptions(db, now).sentOut.map((o) => o.label)).toContain("D26-03991 A1");
    expect(q.materialsCounts(db, now)).toMatchObject({ print: 1, trays: 1 });
    expect(q.listTrays(db).length).toBeGreaterThan(0);
    expect(q.storedBlocks(db).length).toBeGreaterThan(0);
    expect(q.pathologistsForTrays(db).find((p) => p.id === STAFF.marsh)!.ready).toBeGreaterThanOrEqual(0);
  });
});

describe("Reprint traceability", () => {
  it("after a 'not printed' reconciliation, a plain new print is refused so the retry stays linked to the original job", () => {
    const db = testDb();
    const pj = one<{ id: string; target_id: string; version: number }>(db, "SELECT id, target_id, version FROM print_job WHERE display_id = 'PJ-8841'");
    must(db, STAFF.priya, "print.reconcile", { printJobId: pj.id, expectedVersion: pj.version, outcome: "not_printed" });
    const plain = run(db, STAFF.priya, "print.request", { targetType: "slide", targetId: pj.target_id, kind: "slide_label" });
    expect(!plain.ok && plain.error.code).toBe("BLOCKED");
    if (!plain.ok) expect(plain.error.message).toMatch(/Reprint with reason.*PJ-8841/);
    expect(countJobs(db, pj.target_id)).toBe(1);
  });
});

// =====================================================================================
describe("Printer acknowledgement is not proof of output; reprints stay one linear chain", () => {
  it("an acknowledged job has no label until a person records the output, can be recorded as not printed, and blocks reprint until then", () => {
    const db = testDb();
    const { slideId } = freshSlide(db);
    const r = must<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    expect(r.state).toBe("acknowledged");
    expect(r.labelId).toBeNull();
    expect(one(db, "SELECT COUNT(*) n FROM label WHERE target_id = ?", slideId)).toEqual({ n: 0 });
    expect(one(db, "SELECT label_state FROM slide WHERE id = ?", slideId)).toEqual({ label_state: "none" });
    // The job is still the open one for this label: a second request is prevented, not duplicated.
    const again = must<PrintResult>(db, STAFF.marcus, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    expect(again.outcome).toBe("duplicate_prevented");
    expect(again.message).toMatch(/Record what came out/);
    // A reprint cannot assume the label came out.
    const early = run(db, STAFF.priya, "print.reprint", { printJobId: r.printJobId, reason: "Smudged" });
    expect(!early.ok && early.error.code).toBe("BLOCKED");
    if (!early.ok) expect(early.error.message).toMatch(/nobody has recorded what came out/);
    expect(countJobs(db, slideId)).toBe(1);

    const before = one<{ acknowledged_at: string; completed_at: string | null }>(db, "SELECT acknowledged_at, completed_at FROM print_job WHERE id = ?", r.printJobId);
    const np = recordOutput(db, STAFF.priya, r.printJobId, "not_printed", "Printer jammed; nothing came out");
    expect(np.state).toBe("failed");
    const after = one<{ acknowledged_at: string; completed_at: string | null; reconciled_by: string }>(db, "SELECT acknowledged_at, completed_at, reconciled_by FROM print_job WHERE id = ?", r.printJobId);
    // A person's check is recorded as such; the printer timestamps are not rewritten.
    expect(after).toEqual({ ...before, reconciled_by: STAFF.priya });
    expect(one(db, "SELECT COUNT(*) n FROM label WHERE target_id = ?", slideId)).toEqual({ n: 0 });

    const re = must<PrintResult>(db, STAFF.priya, "print.reprint", { printJobId: r.printJobId, reason: "Not printed (jam); reprinting" });
    expect(one(db, "SELECT purpose, reprint_of_job_id FROM print_job WHERE id = ?", re.printJobId)).toEqual({ purpose: "reprint_after_unknown", reprint_of_job_id: r.printJobId });
    const ok = recordOutput(db, STAFF.priya, re.printJobId, "printed_ok");
    expect(ok.labelId).toBeTruthy();
    expect(one(db, "SELECT completed_at FROM print_job WHERE id = ?", re.printJobId)).toEqual({ completed_at: null });
  });

  it("on the cassette printer (reports completion), a second reprint of the same original is refused and points at the newer job", () => {
    const db = testDb();
    const orig = one<{ id: string; display_id: string; target_id: string }>(
      db,
      `SELECT pj.id, pj.display_id, pj.target_id FROM print_job pj JOIN label l ON l.print_job_id = pj.id JOIN block b ON b.id = pj.target_id
        WHERE pj.printer_id = 'prn_c1' AND pj.state = 'completion_confirmed' AND b.status = 'active' ORDER BY pj.id LIMIT 1`,
    );
    const first = must<PrintResult>(db, STAFF.priya, "print.reprint", { printJobId: orig.id, reason: "Cassette label scuffed in processor" }, "tab-1");
    expect(first.state).toBe("completion_confirmed");
    expect(first.labelId).toBeTruthy();
    // A second operator (another tab, different idempotency key) reprints the same original: refused.
    const second = run(db, STAFF.marcus, "print.reprint", { printJobId: orig.id, reason: "Scuffed" }, "tab-2");
    expect(!second.ok && second.error.code).toBe("BLOCKED");
    if (!second.ok) expect(second.error.message).toContain(first.displayId);
    // A plain "Print label" for the block is refused too (a label exists).
    const plain = must<PrintResult>(db, STAFF.marcus, "print.request", { targetType: "block", targetId: orig.target_id, kind: "cassette_label" });
    expect(plain.outcome).toBe("duplicate_prevented");
    expect(plain.printJobId).toBe(first.printJobId);
    // Exactly one live (non-retired) label from a reprint, and the original's label is waiting to be retired.
    expect(one(db, "SELECT COUNT(*) n FROM print_job WHERE reprint_of_job_id = ?", orig.id)).toEqual({ n: 1 });
    expect(one(db, "SELECT COUNT(*) n FROM label WHERE target_id = ? AND state <> 'retired' AND print_job_id <> ?", orig.target_id, orig.id)).toEqual({ n: 1 });
    // The duplicate attempt is in the audit trail with the job it pointed to.
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'print.duplicate_prevented' AND entity_id = ?", first.printJobId).n).toBe(1);
  });

  it("after a failed job and a successful reprint, the failed job cannot be reprinted again", () => {
    const db = testDb();
    const pj = one<{ id: string; target_id: string; version: number }>(db, "SELECT id, target_id, version FROM print_job WHERE display_id = 'PJ-8841'");
    must(db, STAFF.priya, "print.reconcile", { printJobId: pj.id, expectedVersion: pj.version, outcome: "not_printed", note: "Nothing in the tray" });
    const re = must<PrintResult>(db, STAFF.priya, "print.reprint", { printJobId: pj.id, reason: "Not printed; reprint" });
    recordOutput(db, STAFF.priya, re.printJobId, "printed_ok");
    const again = run(db, STAFF.marcus, "print.reprint", { printJobId: pj.id, reason: "Reprint again" });
    expect(!again.ok && again.error.code).toBe("BLOCKED");
    if (!again.ok) expect(again.error.message).toContain(re.displayId);
    expect(countJobs(db, pj.target_id)).toBe(2);
    // The Print jobs tab no longer counts PJ-8841 as needing attention once it has been replaced.
    expect(q.listPrintJobs(db, { filter: "all", now: demoNow(db) }).rows.find((r) => r.id === pj.id)).toMatchObject({ needsAttention: false, supersededBy: re.displayId });
    expect(q.materialsCounts(db, demoNow(db)).print).toBe(0);
  });

  it("a damaged label confirmed at the printer opens a reprint task that the reprint closes; a print hold blocks printing; cancel needs a reason", () => {
    const db = testDb();
    const { slideId } = freshSlide(db);
    const r = must<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    expect(run(db, STAFF.priya, "print.reconcile", { printJobId: r.printJobId, expectedVersion: jobVersion(db, r.printJobId), outcome: "printed_damaged", note: "" }).ok).toBe(false);
    const dmg = recordOutput(db, STAFF.priya, r.printJobId, "printed_damaged", "Code smeared");
    expect(dmg.state).toBe("completion_confirmed");
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'print_reprint' AND entity_id = ? AND status = 'open'", r.printJobId)).toEqual({ n: 1 });
    const re = must<PrintResult>(db, STAFF.priya, "print.reprint", { printJobId: r.printJobId, reason: "Code smeared at the printer" });
    expect(re.retireLabelId).toBe(dmg.labelId);
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'print_reprint' AND entity_id = ? AND status = 'open'", r.printJobId)).toEqual({ n: 0 });

    // A hold that blocks printing stops a new label on another fresh slide.
    const other = freshSlide(db);
    db.prepare(
      `INSERT INTO hold (id, display_id, scope_type, scope_id, scope_label, blocks, reason_code, reason_text, status, placed_by, placed_at, version)
       VALUES ('hold_p', 'H-9002', 'slide', ?, 'Slide', '["print"]', 'other', 'Order under review', 'active', 'stf_kim', '2026-10-14T14:00:00Z', 1)`,
    ).run(other.slideId);
    const held = run(db, STAFF.priya, "print.request", { targetType: "slide", targetId: other.slideId, kind: "slide_label" });
    expect(!held.ok && held.error.code).toBe("BLOCKED");
    if (!held.ok) expect(held.error.message).toMatch(/H-9002/);

    // Cancel: only before printing, and only with a reason.
    setPrinter(db, "prn_s1", "offline");
    const third = freshSlide(db);
    const queued = must<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: third.slideId, kind: "slide_label" });
    expect(run(db, STAFF.priya, "print.cancel", { printJobId: queued.printJobId, reason: " " }).ok).toBe(false);
    expect(must<PrintResult>(db, STAFF.priya, "print.cancel", { printJobId: queued.printJobId, reason: "Printed on the backup printer" }).state).toBe("canceled");
    expect(run(db, STAFF.priya, "print.cancel", { printJobId: re.printJobId, reason: "x" }).ok).toBe(false);
  });

  it("the label check compares the decoded code with the record: a code for another slide or stain is a mismatch, and the level is listed as not encoded", async () => {
    const db = testDb();
    const { checkPayloadAgainstRecord } = await import("@/server/domain/labels");
    const pj = one<{ target_id: string; payload: string }>(db, "SELECT target_id, payload FROM print_job WHERE display_id = 'PJ-8841'");
    const own = checkPayloadAgainstRecord(db, "slide", pj.target_id, pj.payload);
    expect(own.matchesRecord).toBe(true);
    expect(own.recordText).toMatch(/deeper L1$/);
    expect(own.fields.find((f) => f.field === "Level")).toMatchObject({ ok: null, encoded: "—" });
    // A valid code (correct check character) for a different slide must not pass as this slide's label.
    const otherSlide = one<{ identifier: string }>(db, "SELECT identifier FROM slide WHERE id <> ? AND stain <> 'H&E' LIMIT 1", pj.target_id).identifier;
    const wrong = checkPayloadAgainstRecord(db, "slide", pj.target_id, otherSlide);
    expect(wrong.decodes).toBe(true);
    expect(wrong.matchesRecord).toBe(false);
    expect(wrong.fields.some((f) => f.ok === false)).toBe(true);
    const detail = q.getPrintJobDetail(db, "PJ-8841", demoNow(db))!;
    expect(detail.recordCheck.matchesRecord).toBe(true);
  });
});

// =====================================================================================
describe("Trays: canceled material, consistent eligibility", () => {
  it("a slide whose work is canceled after it was scanned no longer counts, blocks completion and delivery until it is taken off", () => {
    const db = testDb();
    const sc = scenario(db);
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.expectedUnscanned) });
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.missing) });
    expect(must<{ status: string }>(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: trayVersion(db) }).status).toBe("verified_complete");
    // After completion (before delivery) the source cancels the work for one scanned slide.
    const canceled = one<{ slide_id: string }>(db, "SELECT slide_id FROM tray_scan WHERE id = 'ts_m03_1'").slide_id;
    db.prepare("UPDATE slide SET status = 'canceled_needs_review', version = version + 1 WHERE id = ?").run(canceled);
    const view = getTrayDetail(db, "TRY-M-03")!.view;
    const row = view.expected.find((e) => e.slideId === canceled)!;
    expect(row).toMatchObject({ state: "canceled", canceledOnTray: true });
    expect(view.counts.scanned).toBe(9);
    const del = run(db, STAFF.priya, "tray.deliver", { trayId: "tray_m03" });
    expect(!del.ok && del.error.code).toBe("BLOCKED");
    expect(one(db, "SELECT physical_state FROM slide WHERE id = ?", canceled)).toEqual({ physical_state: "qc_reviewed" });
    // Taking it off is recorded; then the remaining slides can be delivered, and the canceled one is not.
    must(db, STAFF.priya, "tray.resolveScan", { scanId: row.scanId, resolution: "removed_from_tray" });
    const ok = must<{ delivered: number }>(db, STAFF.priya, "tray.deliver", { trayId: "tray_m03" });
    expect(ok.delivered).toBe(9);
    expect(one(db, "SELECT physical_state FROM slide WHERE id = ?", canceled)).toEqual({ physical_state: "qc_reviewed" });
  });

  it("while a scanned slide is canceled on an open tray, completion is BLOCKED with that reason and the tray is in exception", () => {
    const db = testDb();
    const sc = scenario(db);
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.expectedUnscanned) });
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, sc.missing) });
    const canceled = one<{ slide_id: string }>(db, "SELECT slide_id FROM tray_scan WHERE id = 'ts_m03_2'").slide_id;
    db.prepare("UPDATE slide SET status = 'canceled_needs_review', version = version + 1 WHERE id = ?").run(canceled);
    // The next scan or decision refreshes the tray; a stale-version complete is a conflict, a fresh one is blocked.
    must(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: "HL1:S:BAD" });
    expect(one(db, "SELECT status FROM tray WHERE id = 'tray_m03'")).toEqual({ status: "exception" });
    const done = run(db, STAFF.priya, "tray.complete", { trayId: "tray_m03", expectedVersion: trayVersion(db) });
    expect(!done.ok && done.error.code).toBe("BLOCKED");
    if (!done.ok) expect((done.error.details as { reasons: string[] }).reasons.some((r) => /scanned onto the tray, but/.test(r))).toBe(true);
  });

  it("a supervisor cannot add an unexpected slide whose label was never scanned after application; the tray picker counts what tray.open accepts", () => {
    const db = testDb();
    const candidate = one<{ id: string } | undefined>(
      db,
      `SELECT s.id FROM slide s JOIN accession a ON a.id = s.accession_id WHERE a.assigned_pathologist_id = 'stf_marsh' AND s.physical_state = 'qc_reviewed'
         AND s.status = 'active' AND NOT EXISTS (SELECT 1 FROM tray_expected_slide t WHERE t.slide_id = s.id) ORDER BY s.id LIMIT 1`,
    );
    expect(candidate).toBeTruthy();
    db.prepare("UPDATE slide SET label_state = 'applied' WHERE id = ?").run(candidate!.id);
    const scanned = must<{ result: string; scanId: string }>(db, STAFF.priya, "tray.scan", { trayId: "tray_m03", payload: ident(db, candidate!.id) });
    expect(scanned.result).toBe("unexpected");
    const add = run(db, STAFF.tanya, "tray.resolveScan", { scanId: scanned.scanId, resolution: "added_by_authorized_change" });
    expect(!add.ok && add.error.code).toBe("BLOCKED");
    if (!add.ok) expect(add.error.message).toMatch(/label has not been scanned/);

    // The "Open tray" picker uses the same rules as tray.open (holds, work orders, labels, other trays).
    const ready = q.pathologistsForTrays(db).find((p) => p.id === STAFF.marsh)!.ready;
    const opened = run<{ expected: number }>(db, STAFF.priya, "tray.open", { pathologistId: STAFF.marsh });
    if (ready === 0) expect(!opened.ok && opened.error.code).toBe("BLOCKED");
    else expect(opened.ok && opened.result.expected).toBe(ready);
  });
});

// =====================================================================================
describe("Retrieval: conflicting custody records are not resolved silently; retrieved blocks can be cut", () => {
  const blockOf = (db: DB, acc: string, label = "A1") =>
    one<{ id: string; identifier: string }>(db, "SELECT b.id, b.identifier FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = ? AND b.label_text = ?", acc, label);

  it("a block recorded as checked out to someone else is not picked by another person; a supervisor can record the hand-off", () => {
    const db = testDb();
    const overdue = blockOf(db, "D26-03912");
    const before = one(db, "SELECT custody_state, checkout_holder_id, version FROM block WHERE id = ?", overdue.id);
    const itemsBefore = all(db, "SELECT * FROM retrieval_item WHERE request_id = 'rr_0192' ORDER BY bench_seq");
    const r = must<{ result: string; accepted: boolean; message: string }>(db, STAFF.priya, "retrieval.scan", { requestId: "rr_0192", payload: overdue.identifier });
    expect(r.result).toBe("held_by_other");
    expect(r.accepted).toBe(false);
    expect(r.message).toMatch(/checked out to Marcus Lee/);
    expect(one(db, "SELECT custody_state, checkout_holder_id, version FROM block WHERE id = ?", overdue.id)).toEqual(before);
    expect(all(db, "SELECT * FROM retrieval_item WHERE request_id = 'rr_0192' ORDER BY bench_seq")).toEqual(itemsBefore);

    const sup = must<{ result: string }>(db, STAFF.tanya, "retrieval.scan", { requestId: "rr_0192", payload: overdue.identifier });
    expect(sup.result).toBe("picked");
    expect(one(db, "SELECT checkout_holder_id FROM block WHERE id = ?", overdue.id)).toEqual({ checkout_holder_id: STAFF.tanya });
    expect(one<{ note: string }>(db, "SELECT note FROM custody_event WHERE material_id = ? AND event = 'checked_out' AND request_id = 'rr_0192'", overdue.id).note).toMatch(/hand-off from recorded holder Marcus Lee/);
  });

  it("'not found' for a checked-out block clears the recorded holder and says where it should have been; a sent-out block is not reported missing", () => {
    const db = testDb();
    const overdue = blockOf(db, "D26-03912");
    const nf = must<{ taskId: string }>(db, STAFF.marcus, "retrieval.markNotFound", { itemId: "ri_0192_3", note: "Not at my bench or in my drawer" });
    expect(one(db, "SELECT custody_state, checkout_holder_id FROM block WHERE id = ?", overdue.id)).toEqual({ custody_state: "missing_investigation", checkout_holder_id: null });
    expect(one<{ title: string }>(db, "SELECT title FROM task WHERE id = ?", nf.taskId).title).toMatch(/not found with recorded holder Marcus Lee/);
    expect(one(db, "SELECT holder_id FROM custody_event WHERE material_id = ? AND event = 'missing_reported'", overdue.id)).toEqual({ holder_id: STAFF.marcus });

    const out = blockOf(db, "D26-03991");
    const req = must<{ requestId: string }>(db, STAFF.okafor, "retrieval.create", { blockIds: [out.id], purpose: "Compare (synthetic)", destination: "Microtomy bench 2" });
    const item = one<{ id: string }>(db, "SELECT id FROM retrieval_item WHERE request_id = ?", req.requestId);
    const sent = run(db, STAFF.marcus, "retrieval.markNotFound", { itemId: item.id, note: "Not in storage" });
    expect(!sent.ok && sent.error.code).toBe("BLOCKED");
    expect(one(db, "SELECT custody_state FROM block WHERE id = ?", out.id)).toEqual({ custody_state: "sent_out" });
  });

  it("a deeper level ordered on an archived block can be sectioned only once the block is retrieved to the bench", () => {
    const db = testDb();
    const a1 = blockOf(db, "D26-03990");
    expect(one(db, "SELECT physical_state, custody_state FROM block WHERE id = ?", a1.id)).toEqual({ physical_state: "stored", custody_state: "stored" });
    const level = must<{ slideId: string }>(db, STAFF.okafor, "slide.orderAdditional", { blockId: a1.id, stain: "H&E", level: "deeper L1", reason: "Deeper levels for comparison (RR-0192)" });
    const inCabinet = run(db, STAFF.marcus, "slide.advance", { slideIds: [level.slideId], toState: "sectioned" });
    expect(!inCabinet.ok && inCabinet.error.code).toBe("BLOCKED");
    if (!inCabinet.ok) expect(inCabinet.error.message).toMatch(/filed in storage/);
    must(db, STAFF.marcus, "retrieval.scan", { requestId: "rr_0192", payload: a1.identifier });
    must(db, STAFF.marcus, "slide.advance", { slideIds: [level.slideId], toState: "sectioned" });
    expect(one(db, "SELECT physical_state FROM slide WHERE id = ?", level.slideId)).toEqual({ physical_state: "sectioned" });
    // The block is still an archived block that is out on the bench (not rewound to "embedded").
    expect(one(db, "SELECT physical_state, custody_state FROM block WHERE id = ?", a1.id)).toEqual({ physical_state: "stored", custody_state: "checked_out" });
  });
});

// =====================================================================================
describe("Acceptance 14 (review side) through the real source import; holds and authorization are never changed implicitly", () => {
  /** Runs the simulated source pipeline (S6) at 11:21: ORD v2 removes the PAS whose label was printed. */
  function importPasCancellation(db: DB): { woId: string; slideId: string } {
    clockAt(db, "11:21");
    must(db, STAFF.tanya, "integration.syncNow", {});
    const woId = one<{ value: string }>(db, "SELECT value FROM app_setting WHERE key = 'scenario_pas_cancel_wo'").value;
    const slideId = one<{ id: string }>(db, "SELECT id FROM slide WHERE work_order_id = ?", woId).id;
    return { woId, slideId };
  }

  it("after the 11:20 amendment the printed PAS slide is kept for review; a review decision closes the importer's task and deletes nothing", () => {
    const db = testDb();
    const { woId, slideId } = importPasCancellation(db);
    expect(one(db, "SELECT status FROM work_order WHERE id = ?", woId)).toEqual({ status: "cancel_review" });
    expect(one(db, "SELECT status FROM slide WHERE id = ?", slideId)).toEqual({ status: "canceled_needs_review" });
    const labelsBefore = all(db, "SELECT id, state FROM label WHERE target_type = 'slide' AND target_id = ?", slideId);
    expect(labelsBefore.length).toBeGreaterThan(0);
    expect(q.listWorkOrdersInReview(db).map((w) => w.id)).toContain(woId);

    const r = must<{ status: string; heldOpen: string[] }>(db, STAFF.priya, "workorder.reviewSourceChange", {
      workOrderId: woId, decision: "retain_prepared_material", note: "Stained PAS slide retained with the case; not delivered as ordered work",
    });
    expect(r.status).toBe("canceled");
    expect(one(db, "SELECT COUNT(*) n FROM slide WHERE id = ?", slideId)).toEqual({ n: 1 });
    expect(one(db, "SELECT review_disposition FROM slide WHERE id = ?", slideId)).toEqual({ review_disposition: "retained_per_review" });
    expect(all(db, "SELECT id, state FROM label WHERE target_type = 'slide' AND target_id = ?", slideId)).toEqual(labelsBefore);
    expect(one(db, "SELECT COUNT(*) n FROM task WHERE kind = 'order_change_review' AND entity_id IN (?, ?) AND status = 'open'", woId, slideId)).toEqual({ n: 0 });
  });

  it("the review never releases holds as a side effect, even for a supervisor; it lists them instead", () => {
    const db = testDb();
    const { woId, slideId } = importPasCancellation(db);
    db.prepare(
      `INSERT INTO hold (id, display_id, scope_type, scope_id, scope_label, blocks, reason_code, reason_text, status, placed_by, placed_at, version)
       VALUES ('hold_w', 'H-9003', 'slide', ?, 'PAS slide', '["tray_delivery"]', 'other', 'Clarification about the stain request', 'active', 'stf_kim', '2026-10-14T15:00:00Z', 1)`,
    ).run(slideId);
    const r = must<{ heldOpen: string[]; message: string }>(db, STAFF.tanya, "workorder.reviewSourceChange", { workOrderId: woId, decision: "retain_prepared_material", note: "Retained" });
    expect(r.heldOpen).toEqual(["H-9003"]);
    expect(r.message).toMatch(/does not release holds/);
    expect(one(db, "SELECT status FROM hold WHERE id = 'hold_w'")).toEqual({ status: "active" });
  });

  it("keeping work the source canceled needs the dermatopathologist and records a new authorization", () => {
    const db = testDb();
    const { woId, slideId } = importPasCancellation(db);
    const ht = run(db, STAFF.priya, "workorder.reviewSourceChange", { workOrderId: woId, decision: "keep_active", note: "Keep it" });
    expect(!ht.ok && ht.error.code).toBe("FORBIDDEN");
    expect(one(db, "SELECT status FROM work_order WHERE id = ?", woId)).toEqual({ status: "cancel_review" });
    const pathologist = one<{ assigned_pathologist_id: string }>(db, "SELECT a.assigned_pathologist_id FROM work_order wo JOIN accession a ON a.id = wo.accession_id WHERE wo.id = ?", woId).assigned_pathologist_id;
    must(db, pathologist, "workorder.reviewSourceChange", { workOrderId: woId, decision: "keep_active", note: "I still want the PAS: fungal elements suspected" });
    const wo = one<{ status: string; authorization_source: string; requested_by_staff_id: string; source_reference: string }>(
      db, "SELECT status, authorization_source, requested_by_staff_id, source_reference FROM work_order WHERE id = ?", woId,
    );
    expect(wo).toMatchObject({ authorization_source: "pathologist_request", requested_by_staff_id: pathologist });
    expect(wo.source_reference).toMatch(/after the source canceled it/);
    expect(["requested", "in_progress"]).toContain(wo.status);
    expect(one(db, "SELECT status, review_disposition FROM slide WHERE id = ?", slideId)).toEqual({ status: "active", review_disposition: "kept_active" });
  });

  it("void unprepared work: a planned slide with a printed label is voided (row kept) and its unused label retired with a reason", () => {
    const db = testDb();
    const { slideId } = freshSlide(db);
    const job = must<PrintResult>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slideId, kind: "slide_label" });
    recordOutput(db, STAFF.priya, job.printJobId, "printed_ok");
    const woId = one<{ work_order_id: string }>(db, "SELECT work_order_id FROM slide WHERE id = ?", slideId).work_order_id;
    // Review state as the importer leaves it for possibly-printed material (the importer's own path is covered above and in S6's tests).
    db.prepare("UPDATE work_order SET status = 'cancel_review', version = version + 1 WHERE id = ?").run(woId);
    db.prepare("UPDATE slide SET status = 'canceled_needs_review', version = version + 1 WHERE id = ?").run(slideId);
    const r = must<{ status: string; retiredLabels: number }>(db, STAFF.priya, "workorder.reviewSourceChange", { workOrderId: woId, decision: "void_unprepared", note: "Never cut; label destroyed" });
    expect(r).toMatchObject({ status: "canceled", retiredLabels: 1 });
    expect(one(db, "SELECT status, review_disposition FROM slide WHERE id = ?", slideId)).toEqual({ status: "void", review_disposition: "voided_unprepared" });
    expect(one<{ state: string; retire_reason: string }>(db, "SELECT state, retire_reason FROM label WHERE target_id = ?", slideId)).toMatchObject({ state: "retired" });
  });
});
