// Cross-screen consistency: one state change, one authoritative derivation, the same words on every screen
// that depends on it (Operations, worklist, case page, grossing bench, Insights). Regression tests for the
// independent review findings B-1 … B-15 and A-11. Synthetic seed data only.
import { listClarifications } from "@/server/queries/clarifications";
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { DB } from "@/server/db/db";
import { testDb, run, must, one, all, clockAt, tick, STAFF } from "../helpers";
import { makeCtx, loadActor, SYSTEM_ACTOR } from "@/server/core/context";
import { demoNow } from "@/server/core/clock";
import { computeReadiness, ALL_SENT_ON_TRAYS } from "@/server/domain/readiness";
import { trayReadinessProblem, eligibleSlidesFor } from "@/server/domain/tray";
import { holdsBlocking, scopesForPart } from "@/server/domain/holds";
import { holdPartForSourceAmendment, SOURCE_AMENDMENT_HOLD_BLOCKS } from "@/server/domain/correction";
import { custodyFacts, locationCard, returnBlock } from "@/server/domain/retrieval";
import { getBlock } from "@/server/domain/material";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { getOperations, CLOSES_WHEN, type BlockedItem } from "@/server/queries/operations";
import { findWorklistRow, loadWorklistRows } from "@/server/queries/worklist";
import { getCase } from "@/server/queries/case";
import { grossingQueue, partWorkspace, sourceEntryQueue } from "@/server/queries/grossing";
import { getInsights, workAgeSnapshot, TODAY_PROVENANCE } from "@/server/queries/insights";
import { holdNextStep } from "@/server/queries/hold-next";
import { AWAITING_SOURCE_ENTRY, AWAITING_SOURCE_ENTRY_SQL, SLIDE_STATE, STAGE } from "@/lib/domain";
import { labLocalToIso } from "@/lib/time";
import { holdStepsShort, partsText } from "@/components/worklist/format";
import { EXCEPTION_CATEGORIES, summarizeBlocked } from "@/components/operations/summary";
import type { GrossFields } from "@/lib/gross";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }), usePathname: () => "/cases", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: (p: { href: string; className?: string; children?: unknown }) => createElement("a", { href: p.href, className: p.className }, p.children as never) }));

const at = (hhmm: string) => labLocalToIso("2026-10-14", hhmm);
const importCtx = (db: DB) => makeCtx(db, SYSTEM_ACTOR, "import", "test");
const htmlText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const blockedHold = (db: DB, displayId: string) => getOperations(db).blocked.find((b) => b.category === "holds" && b.ref === displayId)!;
const holdId = (db: DB, displayId: string) => one<{ id: string; version: number }>(db, "SELECT id, version FROM hold WHERE display_id = ?", displayId);
const clrVersion = (db: DB, displayId: string) => one<{ id: string; version: number }>(db, "SELECT id, version FROM clarification WHERE display_id = ?", displayId);

// ---------------------------------------------------------------- grossing through the real commands

type Summary = { id: string; state: string; version: number };
function seenGross(db: DB, partId: string): number | null {
  return one<{ version: number } | undefined>(db, "SELECT version FROM gross_record WHERE specimen_part_id = ? AND state <> 'superseded' ORDER BY record_version DESC LIMIT 1", partId)?.version ?? null;
}
/** Dictation → confirm every clean proposal → narrative → operator reviewed (the grossing bench flow). */
function grossToReviewed(db: DB, partId: string): Summary {
  const procedure = one<{ procedure: string }>(db, "SELECT procedure FROM specimen_part WHERE id = ?", partId).procedure;
  const observed: Partial<Record<keyof GrossFields, unknown>> = { container_label_matches: true, specimen_type: procedure };
  must(db, STAFF.dana, "gross.loadTranscript", { specimenPartId: partId, transcriptKey: procedure === "punch" ? "generic-punch" : "generic-shave", expectedVersion: seenGross(db, partId) });
  const r = one<{ id: string; version: number; fields: string }>(db, "SELECT id, version, fields FROM gross_record WHERE specimen_part_id = ? AND state <> 'superseded'", partId);
  const f = JSON.parse(r.fields) as Record<string, { status: string }>;
  let version = r.version;
  for (const k of ["specimen_type", "received_in", "container_label_matches", "piece_count", "dimensions", "appearance", "ink_orientation", "sectioning", "cassettes"] as const) {
    let res: Summary | null = null;
    if (k in observed) res = must<Summary>(db, STAFF.dana, "gross.confirmField", { grossRecordId: r.id, expectedVersion: version, field: k, value: observed[k] });
    else if (f[k]?.status === "proposed") res = must<Summary>(db, STAFF.dana, "gross.confirmField", { grossRecordId: r.id, expectedVersion: version, field: k });
    if (res) version = res.version;
  }
  version = must<Summary>(db, STAFF.dana, "gross.updateFields", { grossRecordId: r.id, expectedVersion: version, patch: {}, narrative: "Received in formalin. Synthetic narrative from confirmed values." }).version;
  return must<Summary>(db, STAFF.dana, "gross.markReviewed", { grossRecordId: r.id, expectedVersion: version });
}

/** A part from this morning with no gross record, a container from an intake item, and no active hold on its case. */
function freshPart(db: DB): { id: string; accessionId: string; accession: string; designation: string; intakeItemId: string; intakeDisplay: string } {
  return one(
    db,
    `SELECT sp.id, sp.accession_id AS accessionId, a.accession_number AS accession, sp.designation, c.intake_item_id AS intakeItemId, ii.display_id AS intakeDisplay
       FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id JOIN container c ON c.id = sp.container_id JOIN intake_item ii ON ii.id = c.intake_item_id
      WHERE a.is_prior_day = 0 AND a.case_status = 'open' AND sp.status = 'active' AND sp.procedure IN ('punch','shave')
        AND NOT EXISTS (SELECT 1 FROM gross_record g WHERE g.specimen_part_id = sp.id)
        AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.status = 'active' AND (h.accession_id = a.id OR h.intake_item_id = ii.id))
      ORDER BY a.accession_number, sp.designation LIMIT 1`,
  );
}

// =====================================================================================
describe("B-1: a hold's next step follows its clarification's state (never 'waiting for the office' when it was not sent or not delivered)", () => {
  const setState = (db: DB, display: string, state: string, extra = "") => db.prepare(`UPDATE clarification SET state = ?${extra}, version = version + 1 WHERE display_id = ?`).run(state, display);

  it("drafted, delivery failed or unknown, sent, answered, reviewed and resolved each say the right next step", () => {
    const db = testDb();
    clockAt(db, "11:00");
    // Seed: H-0089 holds D26-04804 part B on CLR-0455, which was sent and is waiting on the office.
    expect(blockedHold(db, "H-0089").nextStep).toMatch(/^Waiting for the office on CLR-0455: sent \(simulated\)/);

    setState(db, "CLR-0455", "drafted");
    expect(blockedHold(db, "H-0089").nextStep).toBe("Send CLR-0455, not sent yet");

    for (const s of ["delivery_failed", "delivery_unknown"]) {
      setState(db, "CLR-0455", s);
      const ops = getOperations(db);
      const item = ops.blocked.find((b) => b.ref === "H-0089")!;
      expect(item.nextStep).toMatch(/^Delivery not confirmed: follow up on CLR-0455/);
      expect(item.nextStep).not.toMatch(/Waiting for the office/);
      // The clarification itself is listed too, although a hold links to it (no longer hidden).
      const clr = ops.blocked.find((b) => b.category === "clarifications" && b.ref === "CLR-0455")!;
      expect(clr, `${s}: CLR-0455 is listed under Clarifications`).toBeTruthy();
      expect(clr.blocks).toMatch(/Linked to hold H-0089/);
      expect(clr.nextStep).toMatch(/^Delivery not confirmed/);
    }

    for (const s of ["sent", "delivered", "acknowledged"]) {
      setState(db, "CLR-0455", s);
      expect(blockedHold(db, "H-0089").nextStep).toMatch(/^Waiting for the office on CLR-0455/);
    }
    setState(db, "CLR-0455", "answered");
    expect(blockedHold(db, "H-0089").nextStep).toBe("Lead reviews the office answer on CLR-0455");
    setState(db, "CLR-0455", "reviewed");
    expect(blockedHold(db, "H-0089").nextStep).toBe("Lead resolves CLR-0455, then releases H-0089 with a reason");
    setState(db, "CLR-0455", "resolved", `, resolution_code = 'confirmed_order', resolved_at = '${at("10:59")}'`);
    expect(blockedHold(db, "H-0089").nextStep).toBe("CLR-0455 is resolved: lead releases H-0089 with a reason (not automatic)");
  });

  it("the case page and the grossing bench show the same next step and owner for the hold as Operations", () => {
    const db = testDb();
    clockAt(db, "11:00");
    for (const state of ["drafted", "delivery_failed", "sent", "answered"]) {
      setState(db, "CLR-0455", state);
      const ops = blockedHold(db, "H-0089");
      const c = getCase(db, "D26-04804")!;
      const caseHold = c.holdsAll.find((h) => h.displayId === "H-0089")!;
      const ws = partWorkspace(db, one<{ scope_id: string }>(db, "SELECT scope_id FROM hold WHERE display_id = 'H-0089'").scope_id)!;
      const benchHold = ws.holds.find((h) => h.displayId === "H-0089")!;
      expect([caseHold.nextStep, benchHold.nextStep], state).toEqual([ops.nextStep, ops.nextStep]);
      expect([caseHold.owner, benchHold.owner], state).toEqual([ops.owner, ops.owner]);
    }
  });
});

// =====================================================================================
describe("B-2: after resolution the hold's owner is whoever holds the release decision, on every screen", () => {
  it("Operations, the case page and the grossing bench name the release-decision owner, not the clarification's lab owner", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const before = blockedHold(db, "H-0089");
    expect(before.owner).toBe("Dana Whitfield"); // the follow-up task on CLR-0455 (lab owner)

    must(db, STAFF.dana, "clarification.recordAnswer", { clarificationId: "CLR-0455", answerText: "Suture marks 12 o'clock (synthetic).", answeredBy: "Office nurse", channel: "phone_recorded_by_staff" });
    // Answered: the lead's review task holds the next step.
    expect(blockedHold(db, "H-0089").owner).toBe("Kim Nguyen");
    must(db, STAFF.kim, "clarification.review", { clarificationId: "CLR-0455", expectedVersion: clrVersion(db, "CLR-0455").version });
    must(db, STAFF.kim, "clarification.resolve", { clarificationId: "CLR-0455", expectedVersion: clrVersion(db, "CLR-0455").version, resolutionCode: "confirmed_order", note: "Order is correct (synthetic)." });

    const task = one<{ kind: string; owner_id: string }>(db, "SELECT kind, owner_id FROM task WHERE entity_type = 'hold' AND entity_id = ? AND status = 'open'", holdId(db, "H-0089").id);
    expect(task.kind).toBe("hold_release_decision");
    const next = holdNextStep(db, holdId(db, "H-0089").id)!;
    expect(next).toMatchObject({ ownerFrom: "hold_task", ownerId: task.owner_id, owner: "Kim Nguyen" });

    const ops = getOperations(db);
    const row = ops.blocked.find((b) => b.ref === "H-0089")!;
    expect(row.owner).toBe("Kim Nguyen");
    expect(row.owner).not.toBe("Dana Whitfield");
    // The release-decision task is said by the hold row, not listed a second time as a review.
    expect(ops.blocked.filter((b) => b.key.startsWith("task:") && /Decide whether to release H-0089/.test(b.item))).toHaveLength(0);

    const c = getCase(db, "D26-04804")!;
    expect(c.holdsAll.find((h) => h.displayId === "H-0089")!.owner).toBe("Kim Nguyen");
    const partB = one<{ scope_id: string }>(db, "SELECT scope_id FROM hold WHERE display_id = 'H-0089'").scope_id;
    expect(partWorkspace(db, partB)!.holds.find((h) => h.displayId === "H-0089")!.owner).toBe("Kim Nguyen");
    expect(grossingQueue(db).find((r) => r.partId === partB)!.holds.find((h) => h.displayId === "H-0089")!.owner).toBe("Kim Nguyen");
  });
});

// =====================================================================================
describe("B-3: a pending source amendment on an issued part is an ordinary scoped hold every screen inherits", () => {
  /** ORD-75061 v2 changes the site of issued part D26-04749 A: the importer opens a correction review. */
  function amendIssuedPart(db: DB): { xr: { id: string; display_id: string; version: number }; partId: string } {
    const row = one<{ payload: string }>(db, "SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = 'ORD-75061' AND v.source_version = 1");
    const p = JSON.parse(row.payload) as { specimens: Record<string, unknown>[] } & Record<string, unknown>;
    const v2 = { ...p, version: 2, updated_at: at("10:58"), specimens: [{ ...p.specimens[0], laterality: "right", site: "Right great toenail" }] };
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-75061#v2-consistency", messageType: "order.upsert", payload: v2 });
    const xr = one<{ id: string; display_id: string; version: number }>(db, "SELECT id, display_id, version FROM correction_review WHERE accession_id = 'acc_d26_04749' AND kind = 'site_discrepancy' AND status = 'open'");
    expect(xr, "the import opened a correction review").toBeTruthy();
    // The import itself placed the hold (sourceImport.ts openCorrectionReview); calling again changes nothing.
    expect(all(db, "SELECT 1 FROM hold WHERE reason_code = ? AND status = 'active'", `correction_review:${xr.id}`), "the import placed the hold").toHaveLength(1);
    db.transaction(() => holdPartForSourceAmendment(importCtx(db), xr.id))();
    db.transaction(() => holdPartForSourceAmendment(importCtx(db), xr.id))();
    return { xr, partId: "acc_d26_04749_pa" };
  }

  it("holds exactly that part for gross approval, print and tray delivery; every screen and command sees it; closing the review releases it", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const { xr, partId } = amendIssuedPart(db);
    const holds = all<{ id: string; display_id: string; scope_type: string; scope_id: string; blocks: string; status: string }>(db, "SELECT * FROM hold WHERE reason_code = ?", `correction_review:${xr.id}`);
    expect(holds).toHaveLength(1);
    const h = holds[0];
    expect(h).toMatchObject({ scope_type: "specimen_part", scope_id: partId, status: "active" });
    expect(JSON.parse(h.blocks)).toEqual(SOURCE_AMENDMENT_HOLD_BLOCKS);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'hold.placed' AND entity_id = ?", h.id).n).toBe(1);
    // Only this part: the case's other parts (if any) carry no such hold.
    const r = computeReadiness(db, ["acc_d26_04749"]).get("acc_d26_04749")!;
    for (const p of r.parts) expect(p.holds.some((x) => x.id === h.id)).toBe(p.partId === partId);

    // Enforcement: a label print for this part's slide is refused by the hold.
    const slide = one<{ id: string }>(db, "SELECT s.id FROM slide s JOIN block b ON b.id = s.block_id WHERE b.part_id = ? AND s.status = 'active' ORDER BY s.slide_seq LIMIT 1", partId);
    const print = run(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slide.id, kind: "slide_label" });
    expect(print.ok).toBe(false);
    if (!print.ok) expect(print.error.message).toContain(h.display_id);
    expect(holdsBlocking(db, "gross_approval", scopesForPart(db, partId)).map((x) => x.id)).toContain(h.id);

    // Operations: the hold says the correction review is what it waits on, owned by the review's owner.
    const item = blockedHold(db, h.display_id);
    expect(item.nextStep).toContain(`Correction review ${xr.display_id} is open`);
    const reviewOwner = one<{ owner_id: string }>(db, "SELECT owner_id FROM task WHERE entity_type = 'correction_review' AND entity_id = ? AND status = 'open'", xr.id).owner_id;
    expect(item.ownerId).toBe(reviewOwner);
    // The worklist and the case page show the same hold on the same part.
    const row = findWorklistRow(db, STAFF.priya, "D26-04749")!;
    expect(row.holds.map((x) => x.displayId)).toContain(h.display_id);
    expect(getCase(db, "D26-04749")!.holdsAll.find((x) => x.displayId === h.display_id)!.status).toBe("active");

    // Closing the review (a lead's decision) releases the hold, with its own audit record.
    must(db, STAFF.kim, "correction.close", { correctionId: xr.id, outcome: "closed_no_change", note: "Issued part confirmed with the office (synthetic).", expectedVersion: xr.version });
    expect(one<{ status: string }>(db, "SELECT status FROM hold WHERE id = ?", h.id).status).toBe("released");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'hold.released' AND entity_id = ?", h.id).n).toBe(1);
    expect(getOperations(db).blocked.some((b) => b.ref === h.display_id)).toBe(false);
  });

  it("a referral to the source process keeps the hold (the review is still open there)", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const { xr } = amendIssuedPart(db);
    must(db, STAFF.kim, "correction.close", { correctionId: xr.id, outcome: "referred_to_source_process", note: "Referred (synthetic).", expectedVersion: xr.version });
    expect(one<{ status: string }>(db, "SELECT status FROM hold WHERE reason_code = ?", `correction_review:${xr.id}`).status).toBe("active");
  });

  it("a resolution that says the order must change waits for the amended order from the source, not for a release", () => {
    const db = testDb();
    clockAt(db, "11:00");
    db.prepare("UPDATE clarification SET state = 'resolved', resolution_code = 'confirmed_observed', resolved_at = ?, version = version + 1 WHERE display_id = 'CLR-0455'").run(at("10:55"));
    const item = blockedHold(db, "H-0089");
    expect(item.nextStep).toMatch(/waiting for the amended order from the source \(simulated\)/);
    expect(item.nextStep).not.toMatch(/lead releases/);
    expect(getCase(db, "D26-04804")!.holdsAll.find((h) => h.displayId === "H-0089")!.nextStep).toBe(item.nextStep);
    // The Clarify desk says the same thing: the hold waits for the amended order, not for a release.
    const clrRow = () => listClarifications(db, { filter: "all", actorId: STAFF.kim, now: at("11:00") }).rows.find((r) => r.displayId === "CLR-0455")!;
    expect(clrRow()).toMatchObject({ holdToRelease: true, awaitingAmendedOrder: true });
    // Once a newer order version is imported after the resolution, the lead can release.
    const order = one<{ source_order_id: string; payload: string; source_version: number }>(
      db,
      `SELECT v.source_order_id, v.payload, v.source_version FROM specimen_part sp JOIN source_order_version v ON v.source_order_id = sp.source_order_id
        WHERE sp.id = 'acc_d26_04804_pb' ORDER BY v.source_version DESC LIMIT 1`,
    );
    db.prepare("INSERT INTO source_order_version (id, source_order_id, source_version, source_updated_at, imported_at, payload, change_summary) VALUES ('sov_consistency', ?, ?, ?, ?, ?, 'Amended (test)')").run(
      order.source_order_id, order.source_version + 1, at("10:56"), at("10:57"), order.payload,
    );
    expect(blockedHold(db, "H-0089").nextStep).toBe("CLR-0455 is resolved: lead releases H-0089 with a reason (not automatic)");
    expect(clrRow()).toMatchObject({ holdToRelease: true, awaitingAmendedOrder: false });
    // The resolved hold with a pending amendment is not called releasable in the handoff summary.
  });

  it("an amendment that arrived after the question was asked, but before the resolution, settles it (scripted hero order)", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const created = one<{ created_at: string }>(db, "SELECT created_at FROM clarification WHERE display_id = 'CLR-0455'").created_at;
    const order = one<{ source_order_id: string; payload: string; source_version: number }>(
      db,
      `SELECT v.source_order_id, v.payload, v.source_version FROM specimen_part sp JOIN source_order_version v ON v.source_order_id = sp.source_order_id
        WHERE sp.id = 'acc_d26_04804_pb' ORDER BY v.source_version DESC LIMIT 1`,
    );
    const importedAt = new Date(Date.parse(created) + 60_000).toISOString(); // after the question, before the resolution
    db.prepare("INSERT INTO source_order_version (id, source_order_id, source_version, source_updated_at, imported_at, payload, change_summary) VALUES ('sov_early', ?, ?, ?, ?, ?, 'Amended (test)')").run(
      order.source_order_id, order.source_version + 1, importedAt, importedAt, order.payload,
    );
    db.prepare("UPDATE clarification SET state = 'resolved', resolution_code = 'confirmed_observed', resolved_at = ?, version = version + 1 WHERE display_id = 'CLR-0455'").run(at("10:58"));
    expect(blockedHold(db, "H-0089").nextStep).toBe("CLR-0455 is resolved: lead releases H-0089 with a reason (not automatic)");
  });

  it("a confirmed-observed resolution is not listed as 'resolved but still active, release it' in the handoffs", () => {
    const db = testDb();
    clockAt(db, "11:00");
    db.prepare("UPDATE clarification SET state = 'resolved', resolution_code = 'source_amended', resolved_at = ?, version = version + 1 WHERE display_id = 'CLR-0455'").run(at("10:55"));
    expect(getOperations(db).handoffs.lines.some((l) => /resolved clarification but .* still active: .*H-0089/.test(l.text))).toBe(false);
  });
});

// =====================================================================================
describe("B-4: a loaded cassette with an approved record is 'Ready for processing', not 'Processing'", () => {
  it("every screen shows the shared stage until the block is on the processor", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const part = freshPart(db);
    const reviewed = grossToReviewed(db, part.id);
    must(db, STAFF.dana, "gross.approve", { grossRecordId: reviewed.id, expectedVersion: reviewed.version });
    const blocks = all<{ id: string; physical_state: string }>(db, "SELECT id, physical_state FROM block WHERE part_id = ?", part.id);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.physical_state === "cassette_loaded")).toBe(true);

    const r = computeReadiness(db, [part.accessionId]).get(part.accessionId)!;
    expect(r.parts.find((p) => p.partId === part.id)!.stage).toBe("awaiting_processing");
    expect(STAGE.awaiting_processing).toBe("Ready for processing");
    const row = findWorklistRow(db, STAFF.priya, part.accession)!;
    expect(row.parts.find((p) => p.partId === part.id)!.stageLabel).toBe("Ready for processing");
    const c = getCase(db, part.accession)!;
    expect(c.parts.find((p) => p.partId === part.id)!.stageLabel).toBe("Ready for processing");
    const ops = getOperations(db);
    const stage = ops.path.stages.find((s) => s.key === "awaiting_processing")!;
    expect(stage.label).toBe("Ready for processing");
    expect(stage.count).toBe(loadWorklistRows(db, Number.MAX_SAFE_INTEGER, demoNow(db), { includeIntake: false }).flatMap((x) => x.parts).filter((p) => p.stage === "awaiting_processing").length);
    expect(ops.queueAge.rows.map((q) => q.stage)).toContain("awaiting_processing");
    // The grossing bench says the shared words (its local re-wording is gone).
    expect(partWorkspace(db, part.id)!.readiness!.caseSummary).toContain(`Part ${part.designation}: ready for processing`);

    // On the processor: now it is Processing.
    must(db, STAFF.priya, "block.advance", { blockIds: blocks.map((b) => b.id), toState: "processing" });
    expect(computeReadiness(db, [part.accessionId]).get(part.accessionId)!.parts.find((p) => p.partId === part.id)!.stage).toBe("processing");
    expect(getCase(db, part.accession)!.parts.find((p) => p.partId === part.id)!.stageLabel).toBe("Processing");
  });
});

// =====================================================================================
describe("B-5: 'ready for tray' counts only slides a tray would accept", () => {
  it("readiness and the tray rules agree slide for slide, and an excluded slide's reason is in blockedBy", () => {
    const db = testDb();
    const ids = all<{ id: string }>(db, "SELECT DISTINCT accession_id AS id FROM slide WHERE physical_state = 'qc_reviewed' AND status = 'active'").map((r) => r.id);
    const total = (m: ReturnType<typeof computeReadiness>) =>
      [...m.values()].flatMap((c) => c.parts.flatMap((p) => p.eligible)).reduce((n, e) => n + Number(/^(\d+) slide\(s\) ready for tray$/.exec(e)?.[1] ?? 0), 0);
    const accepted = () =>
      all<{ id: string }>(db, "SELECT id FROM slide WHERE physical_state = 'qc_reviewed' AND status = 'active'").filter((s) => trayReadinessProblem(db, s.id) === null).length;
    expect(total(computeReadiness(db, ids))).toBe(accepted());

    // A QC-reviewed slide a tray accepts now, whose label is then recorded as applied but never scanned: a tray would refuse it.
    const s = all<{ id: string; accession_id: string; label: string; pathologist: string }>(
      db,
      `SELECT s.id, s.accession_id, b.label_text || '-' || s.slide_seq AS label, a.assigned_pathologist_id AS pathologist FROM slide s JOIN block b ON b.id = s.block_id JOIN accession a ON a.id = s.accession_id
        WHERE s.physical_state = 'qc_reviewed' AND s.status = 'active' ORDER BY s.id`,
    ).find((x) => trayReadinessProblem(db, x.id) === null)!;
    expect(s, "seed has a slide ready for a tray").toBeTruthy();
    expect(eligibleSlidesFor(db, s.pathologist)).toContain(s.id);
    const before = total(computeReadiness(db, [s.accession_id]));
    db.prepare("UPDATE slide SET label_state = 'applied', version = version + 1 WHERE id = ?").run(s.id);
    const r = computeReadiness(db, [s.accession_id]).get(s.accession_id)!;
    expect(total(new Map([[s.accession_id, r]]))).toBe(before - 1);
    expect(r.blockedBy.some((b) => b.startsWith("Not ready for a tray:") && b.includes(`${s.label} (label not scanned after it was applied)`))).toBe(true);
    // The tray opener (eligibleSlidesFor) uses the same rules: it does not list that slide either.
    expect(eligibleSlidesFor(db, s.pathologist)).not.toContain(s.id);
    expect(total(computeReadiness(db, ids))).toBe(accepted());
  });
});

// =====================================================================================
describe("B-6: hold scope never collapses onto the part", () => {
  it("a block hold names the block (A1), not 'A1, A2'; the other block stays eligible; scopeType is kept", () => {
    const db = testDb();
    const part = one<{ id: string; accession_id: string; accession: string }>(db, "SELECT sp.id, sp.accession_id, a.accession_number AS accession FROM specimen_part sp JOIN accession a ON a.id = sp.accession_id WHERE sp.id = 'acc_d26_04742_pa'");
    const [a1, a2] = all<{ id: string; label_text: string; physical_state: string }>(db, "SELECT id, label_text, physical_state FROM block WHERE part_id = ? ORDER BY block_seq", part.id);
    expect([a1.physical_state, a2.physical_state]).toEqual(["embedded", "embedded"]);
    const placed = must<{ displayId: string }>(db, STAFF.priya, "hold.place", { scope: { type: "block", id: a1.id }, scopeLabel: `${part.accession} ${a1.label_text}`, blocks: ["sectioning"], reasonText: "Block face damaged (synthetic)" });

    const p = computeReadiness(db, [part.accession_id]).get(part.accession_id)!.parts.find((x) => x.partId === part.id)!;
    const hv = p.holds.find((h) => h.displayId === placed.displayId)!;
    expect(hv).toMatchObject({ scopeType: "block", target: a1.label_text });
    expect(p.blockedBy).toContain(`Sectioning held: ${a1.label_text} (${placed.displayId})`);
    expect(p.blockedBy.some((b) => b.includes(`${a1.label_text}, ${a2.label_text}`))).toBe(false);
    expect(p.eligible.some((e) => e.startsWith(`Sectioning: ${a2.label_text} (`))).toBe(true);

    const row = findWorklistRow(db, STAFF.priya, part.accession)!;
    expect(row.blockedShort).toContain(`${a1.label_text} on hold (${placed.displayId}: sectioning)`);
    expect(row.blockedShort.some((b) => b.startsWith(`Part A on hold`))).toBe(false);
    const wp = row.parts.find((x) => x.partId === part.id)!;
    expect(wp.word).not.toBe("hold"); // A2 can still move
  });

  it("an accession-scoped hold is a whole-case hold, said once above the parts, never 'this part only'", async () => {
    const db = testDb();
    const acc = one<{ id: string; accession_number: string }>(db, "SELECT id, accession_number FROM accession WHERE accession_number = 'D26-04742'");
    const placed = must<{ displayId: string }>(db, STAFF.kim, "hold.place", { scope: { type: "accession", id: acc.id }, scopeLabel: `Case ${acc.accession_number}`, blocks: ["print"], reasonText: "Requisition under review (synthetic)" });
    const r = computeReadiness(db, [acc.id]).get(acc.id)!;
    for (const p of r.parts) expect(p.holds.find((h) => h.displayId === placed.displayId)).toMatchObject({ scopeType: "accession", target: "Whole case" });
    const c = getCase(db, acc.accession_number)!;
    expect(c.holdsAll.find((h) => h.displayId === placed.displayId)).toMatchObject({ scopeType: "accession", target: "Whole case" });
    expect(findWorklistRow(db, STAFF.priya, acc.accession_number)!.blockedShort).toContain(`Whole case on hold (${placed.displayId}: print)`);

    const { CaseOverview } = await import("@/components/case/case-overview");
    const html = htmlText(renderToString(createElement(CaseOverview, { c, focusPart: null, readOnly: false })));
    expect(html).toContain(`Whole case ${acc.accession_number} on hold: Requisition under review (synthetic)`);
    expect(html).toContain("for every part of the case");
    // The whole-case hold is not repeated inside each part's row as a part-only hold.
    expect(html).not.toMatch(new RegExp(`Hold ${placed.displayId}: .*for this part only`));
  });
});

// =====================================================================================
describe("B-7: an intake-item hold keeps applying after accession", () => {
  it("gross approval is refused (through the commands) while a hold on the part's intake item blocks it", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const part = freshPart(db);
    expect(scopesForPart(db, part.id)).toContainEqual({ type: "intake_item", id: part.intakeItemId });
    const placed = must<{ displayId: string }>(db, STAFF.kim, "hold.place", {
      scope: { type: "intake_item", id: part.intakeItemId }, scopeLabel: `${part.intakeDisplay} (all containers)`, blocks: ["gross_approval"], reasonText: "Requisition signature missing (synthetic)",
    });
    const reviewed = grossToReviewed(db, part.id);
    const res = run(db, STAFF.dana, "gross.approve", { grossRecordId: reviewed.id, expectedVersion: reviewed.version });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("BLOCKED");
      expect(res.error.message).toContain(placed.displayId);
    }
    expect(one<{ state: string }>(db, "SELECT state FROM gross_record WHERE id = ?", reviewed.id).state).toBe("operator_reviewed");
    // Every screen shows the same hold on that part.
    const p = computeReadiness(db, [part.accessionId]).get(part.accessionId)!.parts.find((x) => x.partId === part.id)!;
    expect(p.holds.map((h) => h.displayId)).toContain(placed.displayId);
    expect(p.blockedBy).toContain(`Gross record for part ${part.designation} cannot be approved: ${placed.displayId}`);
    expect(grossingQueue(db).find((r) => r.partId === part.id)!.state).toBe("on_hold");
  });
});

// =====================================================================================
describe("B-9: a tray delivery is a digital record, not a receipt", () => {
  it("delivered slides read 'Sent on tray (receipt not recorded)' and a finished case says so, stored state unchanged", () => {
    const db = testDb();
    expect(SLIDE_STATE.delivered).toBe("Sent on tray (receipt not recorded)");
    expect(STAGE.delivered).toBe("Sent on tray");
    const ids = all<{ id: string }>(db, "SELECT id FROM accession").map((r) => r.id);
    const done = [...computeReadiness(db, ids).values()].find((r) => r.isComplete && !r.parts.some((p) => p.workOrders.some((w) => ["requested", "in_progress", "cancel_review", "amended_review"].includes(w.status))))!;
    expect(done, "seed has a finished case").toBeTruthy();
    expect(done.readinessText).toBe(ALL_SENT_ON_TRAYS);
    expect(ALL_SENT_ON_TRAYS).toBe("All parts sent on trays; receipt not recorded");
    const c = getCase(db, done.accessionNumber)!;
    expect(c.summary.isComplete).toBe(true);
    expect(c.summary.text).toMatch(/sent on trays \(receipt not recorded\); no additional work open\.$/);
    expect(c.summary.text).not.toMatch(/delivered/i);
    expect(c.parts.every((p) => p.physical.steps.find((s) => s.key === "delivered")!.label === "Sent on tray")).toBe(true);
    const slide = c.material.flatMap((m) => m.blocks.flatMap((b) => b.slides)).find((s) => s.state === "delivered")!;
    expect(slide.stateLabel).toBe("Sent on tray (receipt not recorded)");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM slide WHERE accession_id = ? AND physical_state = 'delivered'", done.accessionId).n).toBeGreaterThan(0);
  });
});

// =====================================================================================
describe("B-10 and A-11: retrieval records custody, not a location it did not scan", () => {
  it("delivering picked blocks logs the hand-over and leaves the last confirmed location, its time and person unchanged", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const a1 = one<{ id: string; identifier: string }>(db, "SELECT b.id, b.identifier FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = 'D26-03990' AND b.label_text = 'A1'");
    const before = one<{ current_location_id: string; location_confirmed_at: string; location_confirmed_by: string }>(db, "SELECT current_location_id, location_confirmed_at, location_confirmed_by FROM block WHERE id = ?", a1.id);
    const cardBefore = locationCard(getBlock(db, a1.id)!).text;
    must(db, STAFF.marcus, "retrieval.scan", { requestId: "rr_0192", payload: a1.identifier });
    const since = custodyFacts(db, getBlock(db, a1.id)!, demoNow(db)).since;
    tick(db, 7);
    must(db, STAFF.marcus, "retrieval.deliver", { requestId: "rr_0192" });

    expect(one(db, "SELECT current_location_id, location_confirmed_at, location_confirmed_by FROM block WHERE id = ?", a1.id)).toEqual(before);
    expect(locationCard(getBlock(db, a1.id)!).text).toBe(cardBefore);
    expect(locationCard(getBlock(db, a1.id)!).text).not.toMatch(/bench/i);
    const ev = one<{ event: string; destination: string; holder_id: string; note: string; location_id: string | null }>(
      db, "SELECT event, destination, holder_id, note, location_id FROM custody_event WHERE material_id = ? AND request_id = 'rr_0192' ORDER BY at DESC, id DESC LIMIT 1", a1.id,
    );
    expect(ev).toMatchObject({ event: "checked_out", destination: "Microtomy bench 2", holder_id: STAFF.marcus, location_id: null });
    expect(ev.note).toMatch(/^Delivered to Microtomy bench 2 for RR-0192 .*destination not scanned/);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM custody_event WHERE material_id = ? AND event = 'location_confirmed' AND request_id = 'rr_0192'", a1.id).n).toBe(0);
    // The checkout still started at the pick (a hand-over does not restart it).
    expect(custodyFacts(db, getBlock(db, a1.id)!, demoNow(db)).since).toBe(since);
  });

  it("only a checked-out or missing block can be returned, and a missing block needs a note saying where it was found", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const stored = one<{ id: string; code: string }>(db, "SELECT b.id, l.code FROM block b JOIN storage_location l ON l.id = b.current_location_id WHERE b.custody_state = 'stored' AND l.kind = 'slot' LIMIT 1");
    const otherSlot = one<{ code: string }>(db, "SELECT code FROM storage_location WHERE kind = 'slot' AND code <> ? LIMIT 1", stored.code).code;
    const refused = run(db, STAFF.marcus, "retrieval.return", { blockId: stored.id, locationCode: otherSlot });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/Only a checked-out or missing block can be returned/);

    // A block reported missing: returning it without saying where it was found is refused; with a note it is filed.
    const items = all<{ id: string; block_id: string }>(db, "SELECT id, block_id FROM retrieval_item WHERE request_id = 'rr_0192' ORDER BY bench_seq");
    must(db, STAFF.marcus, "retrieval.markNotFound", { itemId: items[0].id, note: "Slot empty; neighbours checked (synthetic)" });
    expect(one<{ custody_state: string }>(db, "SELECT custody_state FROM block WHERE id = ?", items[0].block_id).custody_state).toBe("missing_investigation");
    const noNote = run(db, STAFF.marcus, "retrieval.return", { blockId: items[0].block_id, locationCode: "CAB-2/DR-4/BX-11/S-14" });
    expect(noNote.ok).toBe(false);
    if (!noNote.ok) expect(noNote.error.message).toMatch(/Say where it was found/);
    const ctx = makeCtx(db, loadActor(db, STAFF.marcus));
    db.transaction(() => returnBlock(ctx, items[0].block_id, "CAB-2/DR-4/BX-11/S-14", "Found in the embedding center tray (synthetic)"))();
    expect(one<{ custody_state: string }>(db, "SELECT custody_state FROM block WHERE id = ?", items[0].block_id).custody_state).toBe("stored");
    expect(one<{ note: string }>(db, "SELECT note FROM custody_event WHERE material_id = ? AND event = 'found' ORDER BY at DESC, id DESC LIMIT 1", items[0].block_id).note).toMatch(/^Found \(Found in the embedding center tray/);
  });
});

// =====================================================================================
describe("B-11: Blocked now lists every exception with its kind, where the material is and what evidence closes it", () => {
  it("every item carries a taxonomy kind, a location and its closing evidence; integration is its own category", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const ops = getOperations(db);
    const kinds = new Set(["identity_conflict", "source_disagreement", "missing_evidence", "location_uncertain", "processing_hold", "pending_decision", "integration_failure", "delay"]);
    for (const b of ops.blocked) {
      expect(kinds.has(b.kind), `${b.key} kind`).toBe(true);
      expect(b.where.length, `${b.key} where`).toBeGreaterThan(0);
      expect(b.closesWhen).toBe(CLOSES_WHEN[b.category]);
    }
    expect(EXCEPTION_CATEGORIES).toContain("integration");
    // Identity items are always identity_conflict.
    for (const b of ops.blocked.filter((x) => x.identity)) expect(b.kind).toBe("identity_conflict");
    // A held part with no block yet says its container's location is not confirmed (never a guessed place).
    expect(blockedHold(db, "H-0089").where).toMatch(/location not confirmed/);
    // A hold on an intake item is at the accessioning bench, as received.
    expect(blockedHold(db, "H-0088").where).toMatch(/^Accessioning bench \(INT-1014-022, as received\)$/);
  });

  it("answered and reviewed clarifications, their review tasks, missing material and integration failures are all listed once", () => {
    const db = testDb();
    clockAt(db, "11:00");
    // CLR-0452 (acknowledged, no hold): the office answers, then a lead reviews it.
    must(db, STAFF.maya, "clarification.recordAnswer", { clarificationId: "CLR-0452", answerText: "It was a punch (synthetic).", answeredBy: "Office MA", channel: "phone_recorded_by_staff" });
    let ops = getOperations(db);
    let rows = ops.blocked.filter((b) => b.ref === "CLR-0452" || /CLR-0452/.test(b.item));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "clarifications", nextStep: "Lead reviews the office answer", kind: "pending_decision", owner: "Kim Nguyen" });
    must(db, STAFF.kim, "clarification.review", { clarificationId: "CLR-0452", expectedVersion: clrVersion(db, "CLR-0452").version });
    ops = getOperations(db);
    rows = ops.blocked.filter((b) => b.ref === "CLR-0452" || /CLR-0452/.test(b.item));
    expect(rows, "a reviewed clarification is not dropped").toHaveLength(1);
    expect(rows[0].nextStep).toMatch(/^Lead resolves it/);

    // A block not found where it was last confirmed: a missing-material investigation is listed with where it was.
    const item = one<{ id: string; block_id: string }>(db, "SELECT id, block_id FROM retrieval_item WHERE request_id = 'rr_0192' ORDER BY bench_seq LIMIT 1");
    must(db, STAFF.marcus, "retrieval.markNotFound", { itemId: item.id, note: "Slot empty (synthetic)" });
    const missing = getOperations(db).blocked.find((b) => /^Missing-material investigation/.test(b.item))!;
    expect(missing).toMatchObject({ category: "review", kind: "location_uncertain" });
    expect(missing.where).toMatch(/missing, investigation open/);

    // Custody records that disagree (scanned in the lab, recorded as sent out) are listed with the block's custody.
    const out = one<{ id: string; identifier: string }>(db, "SELECT b.id, b.identifier FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = 'D26-03991'");
    const req = must<{ requestId: string }>(db, STAFF.okafor, "retrieval.create", { blockIds: [out.id], purpose: "Compare (synthetic)", destination: "Microtomy bench 2" });
    expect(must<{ result: string }>(db, STAFF.marcus, "retrieval.scan", { requestId: req.requestId, payload: out.identifier }).result).toBe("conflict");
    const conflict = getOperations(db).blocked.find((b) => /^Conflicting custody records/.test(b.item))!;
    expect(conflict).toMatchObject({ category: "review", kind: "location_uncertain", owner: "Tanya Brooks" });
    expect(conflict.where).toMatch(/sent outside the lab/);

    // Integration: a print queued because the printer is down, a failed source message, an accession request stuck at "submitted".
    db.prepare("UPDATE printer SET status = 'offline' WHERE id = 'prn_s1'").run();
    const slide = one<{ id: string }>(
      db,
      `SELECT s.id FROM slide s WHERE s.label_state = 'none' AND s.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.status = 'active' AND h.accession_id = s.accession_id)
          AND NOT EXISTS (SELECT 1 FROM print_job j WHERE j.target_id = s.id) ORDER BY s.id LIMIT 1`,
    );
    const queued = must<{ state: string; displayId: string }>(db, STAFF.priya, "print.request", { targetType: "slide", targetId: slide.id, kind: "slide_label", printerId: "prn_s1" });
    expect(queued.state).toBe("queued");
    importSourceMessage(importCtx(db), "src_ema", { messageId: "BAD-consistency", messageType: "order.upsert", payload: "{not json" });
    const intake = one<{ id: string }>(db, "SELECT id FROM intake_item WHERE status NOT IN ('accessioned','canceled') ORDER BY id LIMIT 1").id;
    db.prepare("INSERT INTO accession_request (id, display_id, status, requested_by, requested_at, idempotency_key, version) VALUES ('ar_test', 'AR-9999', 'submitted', ?, ?, 'k-consistency', 1)").run(STAFF.maya, at("10:40"));
    db.prepare("INSERT INTO accession_request_item (request_id, intake_item_id) VALUES ('ar_test', ?)").run(intake);
    ops = getOperations(db);
    const integration = ops.blocked.filter((b) => b.category === "integration");
    expect(integration.some((b) => b.key.startsWith("pjq:") && /unavailable/.test(b.where))).toBe(true);
    expect(integration.some((b) => b.key.startsWith("ie:") && /BAD-consistency/.test(b.item))).toBe(true);
    expect(integration.some((b) => b.key === "ar:ar_test" && b.ref === "AR-9999")).toBe(true);
    expect(integration.every((b) => b.kind === "integration_failure")).toBe(true);
    const s = summarizeBlocked(ops.blocked);
    expect(s.counts.find((c) => c.key === "integration")!.count).toBe(integration.length);
    // Nothing is listed twice.
    const keys = ops.blocked.map((b: BlockedItem) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// =====================================================================================
describe("B-13: one definition of the source-entry backlog", () => {
  it("the worklist, readiness, the grossing queue, Operations and Insights count the same parts, failed entries included, canceled parts excluded", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const backlog = () =>
      new Set(all<{ id: string }>(db, `SELECT sp.id FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id WHERE ${AWAITING_SOURCE_ENTRY_SQL}`).map((r) => r.id));
    const views = () => {
      const rows = loadWorklistRows(db, Number.MAX_SAFE_INTEGER, demoNow(db), { includeIntake: false });
      const worklist = new Set(rows.flatMap((r) => r.parts.filter((p) => r.sourceEntry.pendingParts.includes(p.designation)).map((p) => p.partId)));
      const ids = all<{ id: string }>(db, "SELECT id FROM accession").map((r) => r.id);
      const readiness = new Set([...computeReadiness(db, ids).values()].flatMap((c) => c.parts.filter((p) => p.eligible.some((e) => /enter approved gross description in source system/.test(e))).map((p) => p.partId)));
      const queue = new Set(sourceEntryQueue(db).filter((r) => (AWAITING_SOURCE_ENTRY as readonly string[]).includes(r.sourceUpdateState)).map((r) => r.partId));
      const m5 = workAgeSnapshot(db, demoNow(db)).rows.find((r) => r.type === "source_entry")!.count;
      const tile = getOperations(db).tiles.find((t) => t.key === "source_pending")!.value;
      return { worklist, readiness, queue, m5, tile };
    };
    const check = () => {
      const b = backlog();
      const v = views();
      expect([...v.worklist].sort()).toEqual([...b].sort());
      expect([...v.readiness].sort()).toEqual([...b].sort());
      expect([...v.queue].sort()).toEqual([...b].sort());
      expect(v.m5).toBe(b.size);
      expect(v.tile).toBe(b.size);
      return b;
    };
    const start = check();
    expect(start.size).toBeGreaterThan(0);
    // A failed entry is still awaiting entry everywhere.
    const attested = one<{ id: string; part: string }>(db, "SELECT gr.id, gr.specimen_part_id AS part FROM gross_record gr WHERE gr.state = 'approved_for_downstream' AND gr.source_update_state = 'entered_attested' LIMIT 1");
    db.prepare("UPDATE gross_record SET source_update_state = 'failed', version = version + 1 WHERE id = ?").run(attested.id);
    expect(check().has(attested.part)).toBe(true);
    // A canceled part leaves the backlog everywhere.
    const pending = [...start][0];
    db.prepare("UPDATE specimen_part SET status = 'canceled', version = version + 1 WHERE id = ?").run(pending);
    expect(check().has(pending)).toBe(false);
  });
});

// =====================================================================================
describe("B-14: Insights says where today's figures come from", () => {
  it("today's figures are labeled seeded synthetic + this session; simulated office answers are counted apart from staff-recorded ones", () => {
    const db = testDb();
    clockAt(db, "11:00");
    let data = getInsights(db);
    expect(data.todayProvenance).toBe(TODAY_PROVENANCE);
    expect(TODAY_PROVENANCE).toBe("Seeded synthetic + this session");
    for (const s of [data.clarAck.today, data.clarResolve.today, data.grossEntry.today]) expect(s.provenance).toMatch(/^Seeded synthetic \+ this session\./);
    const staffCount = (t: string | undefined) => Number(/(\d+) recorded by staff/.exec(t ?? "")?.[1] ?? NaN);
    const simCount = (t: string | undefined) => Number(/(\d+) simulated office answers?/.exec(t ?? "")?.[1] ?? NaN);
    const staffBefore = staffCount(data.clarAck.today.provenance);
    const simBefore = simCount(data.clarAck.today.provenance);
    expect(Number.isFinite(staffBefore) && Number.isFinite(simBefore)).toBe(true);
    // CLR-0455 was sent, never acknowledged: a staff-recorded phone answer ends its M2 interval.
    must(db, STAFF.dana, "clarification.recordAnswer", { clarificationId: "CLR-0455", answerText: "Answer by phone (synthetic).", answeredBy: "Office nurse", channel: "phone_recorded_by_staff" });
    data = getInsights(db);
    expect(staffCount(data.clarAck.today.provenance)).toBe(staffBefore + 1);
    expect(simCount(data.clarAck.today.provenance)).toBe(simBefore);
    for (const def of [data.clarAck, data.clarResolve]) expect(def.today.provenance).toMatch(/simulated office answer/);
  });

  it("M5 leaves out canceled parts, and the routing-exception count is the Operations count", () => {
    const db = testDb();
    clockAt(db, "11:00");
    const m5 = () => workAgeSnapshot(db, demoNow(db)).rows.find((r) => r.type === "source_entry")!.count!;
    const before = m5();
    const pending = one<{ part: string }>(db, `SELECT sp.id AS part FROM gross_record gr JOIN specimen_part sp ON sp.id = gr.specimen_part_id WHERE ${AWAITING_SOURCE_ENTRY_SQL} LIMIT 1`).part;
    db.prepare("UPDATE specimen_part SET status = 'canceled', version = version + 1 WHERE id = ?").run(pending);
    expect(m5()).toBe(before - 1);
    expect(getInsights(db).byDoctor.todayRoutingExceptions).toBe(getOperations(db).tiles.find((t) => t.key === "routing_exceptions")!.value);
  });
});

// =====================================================================================
describe("B-15: the worklist never shows a bare 'hold'", () => {
  it("a held part names the steps the hold stops", () => {
    const db = testDb();
    const row = findWorklistRow(db, STAFF.priya, "D26-04804")!;
    const b = row.parts.find((p) => p.designation === "B")!;
    expect(b.word).toBe("hold");
    expect(b.holdSteps).toBe("gross approval");
    expect(row.partsSummary).toContain("B on hold (gross approval)");
    expect(row.blockedShort).toContain("Part B on hold (H-0089: gross approval)");
    expect(holdStepsShort(["print", "tray_delivery"])).toBe("print, tray");
    expect(holdStepsShort(["all", "print"])).toBe("all steps");
    expect(partsText([{ word: "hold", stage: "awaiting_gross", designation: "C", holdSteps: "print, tray" }])).toBe("C on hold (print, tray)");
  });
});

describe("C1-4: unowned source entry reads the same on the worklist as on Operations", () => {
  it("a case with an approved gross description pending entry and no open task names the role that should own it, never a blank", () => {
    const db = testDb();
    const ops = getOperations(db).blocked.filter((b) => b.category === "source_entry" && b.ownerId === null);
    expect(ops.length, "the seed includes unowned source entry (prior-day late entries)").toBeGreaterThan(0);
    const rows = loadWorklistRows(db, Number.MAX_SAFE_INTEGER, demoNow(db), { includeIntake: false });
    let checked = 0;
    for (const item of ops) {
      const row = rows.find((r) => r.accessionNumber === item.ref)!;
      expect(row, `${item.ref} is on the worklist`).toBeTruthy();
      if (row.owner) continue; // another open task on the case names its owner
      expect(row.unownedOwner).toBe(item.owner);
      expect(row.ownerText).toContain(item.owner);
      checked += 1;
    }
    expect(checked, "at least one case has no open task at all (D26-04772 in the seed)").toBeGreaterThan(0);
    // A case whose owner comes from a task never carries the fallback.
    for (const r of rows) if (r.owner) expect(r.unownedOwner).toBeNull();
  });
});
