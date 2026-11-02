// Stage 6 Phase C4: the audit trail does not duplicate patient identifiers. On the seeded synthetic day, every
// guided demo step runs in rehearsal mode (the staff actions too, as Tanya Brooks), then a source-conflict import
// (patient level and order level) with a claim, a release and the reviews, then an identity clarification raised
// from a bottle whose label is typed in (name, MRN, a different date of birth), answered with text that quotes the
// date of birth, reviewed and resolved. Every audit row's summary, before_json and after_json is then scanned for
// every patient_ref family name, given plus family name, MRN and birth date, and for the other values the source
// and the bottle gave. Expected: none. Synthetic data only.
//
// What the scan does NOT cover, on purpose (documented in docs/release/privacy-review.md):
// - audit_event.reason: free text typed by staff, stored as typed (pinned below);
// - patient reference ids: the SYNTHETIC SEED builds them from the MRN (pt_ema_447902), so they are masked before
//   the scan; ids made by the importer are opaque sequence ids (checked below).
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import type { DB } from "@/server/db/db";
import { testDb, must, all, one, STAFF } from "../helpers";
import type { DemoStepNumber } from "@/server/domain/demoSteps";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { labLocalToIso } from "@/lib/time";
import { auditedPatientRef, fingerprint, historyPayload, isIdentityField, redactIdentifiers, knownIdentifiers, withheld } from "@/server/domain/privacy";
import { verifyAuditChain, demoAuditKey } from "@/server/core/audit-seal";
import { intakeBench } from "@/server/queries/intake";
import { loadActor } from "@/server/core/context";
import { audit } from "@/server/core/audit";

const at = (hhmm: string) => labLocalToIso("2026-10-14", hhmm);
const ver = (db: DB, table: string, id: string) => one<{ version: number }>(db, `SELECT version FROM ${table} WHERE id = ?`, id).version;
const importCtx = (db: DB) => makeCtx(db, SYSTEM_ACTOR, "import", `phi-${crypto.randomUUID()}`);

function orderPayload(db: DB, srcOrderId: string, version: number): Record<string, any> {
  const row = one<{ payload: string }>(
    db, "SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = ? AND v.source_version = ?", srcOrderId, version,
  );
  return JSON.parse(row.payload);
}

/** Values the flows below put into the system that are NOT on any patient_ref row (and must not reach the audit trail either). */
const OTHER_VALUES = {
  bottleBirthDate: "1972-04-16", // what Maya types from the bottle
  sourceName: "Theodore", // the conflicting order's given name
  sourceBirthDate: "1901-01-01", // the conflicting order's birth date
  amendedBirthDate: "1972-06-15", // the newer version's birth date
  amendedMrn: "999123", // the newer version's MRN
};

// ------------------------------------------------------------------ the flows

interface Scenario {
  db: DB;
  barnesItem: string;
  barnesContainer: string;
  clarificationId: string;
  conflictTasks: { id: string; entity_type: string }[];
}

function buildScenario(): Scenario {
  const db = testDb();
  // 1. Every guided demo step, rehearsal mode (simulator events and staff actions), as the supervisor.
  for (const step of [1, 2, 3, 4, 5, 6, 7, 8] as DemoStepNumber[]) {
    const r = must<{ status: string }>(db, STAFF.tanya, "demo.runStep", { step, autoStaffActions: true });
    expect(r.status, `step ${step}`).not.toBe("not_available");
  }

  // 2. Theo Barnes (ORD-77118), unpacked by step 1: Maya types the bottle (name and MRN as on the order, another
  //    date of birth; the name typed in capitals as on the bottle), checks it against the order (an identity
  //    discrepancy), and raises an identity question.
  const barnesItem = one<{ id: string }>(
    db,
    `SELECT ii.id FROM intake_item ii JOIN intake_order_link l ON l.intake_item_id = ii.id JOIN source_order so ON so.id = l.source_order_id
      WHERE so.source_order_id = 'ORD-77118'`,
  ).id;
  const c = one<{ id: string; version: number; order_part_id: string }>(db, "SELECT id, version, order_part_id FROM container WHERE intake_item_id = ? ORDER BY seq LIMIT 1", barnesItem);
  must(db, STAFF.maya, "intake.recordObservation", { containerId: c.id, expectedVersion: c.version, observed: { patient_name: "BARNES, THEO", mrn: "447902", birth_date: OTHER_VALUES.bottleBirthDate } });
  must(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: ver(db, "container", c.id), orderPartId: c.order_part_id });
  const created = must<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", {
    category: "identity_conflict",
    refs: { intakeItemId: barnesItem, orderPartId: c.order_part_id, containerId: c.id },
    subjectLabel: "Part A · ORD-77118",
    priority: "urgent",
    question: "The bottle and the order disagree on the patient's date of birth. Please confirm.",
    evidence: [
      { field: "Date of birth", order_value: "1972-06-14", observed_value: OTHER_VALUES.bottleBirthDate, requisition_value: "1972-06-14", source: "bottle label" },
      { field: "Patient name", order_value: "Barnes, Theo", observed_value: "Barnes, Theo", source: "bottle label" },
      { field: "MRN", order_value: "447902", observed_value: "447902", source: "bottle label" },
    ],
    hold: { scope: { type: "intake_item", id: barnesItem }, scopeLabel: "INT (all containers) · ORD-77118", blocks: ["accession_request"] },
  });
  const id = created.clarificationId;
  must(db, STAFF.maya, "clarification.send", { clarificationId: id, expectedVersion: ver(db, "clarification", id) });
  // The office's answer quotes the date of birth and the name (it is the office's own text; the clarification keeps it).
  must(db, STAFF.maya, "clarification.recordAnswer", {
    clarificationId: id,
    answerText: "Our chart has Theo Barnes, DOB 06/14/1972 (1972-06-14), MRN 447902. The bottle date was miswritten at the office.",
    answeredBy: "Office manager (synthetic)",
    channel: "phone_recorded_by_staff",
  });
  must(db, STAFF.kim, "clarification.review", { clarificationId: id, expectedVersion: ver(db, "clarification", id), note: "Office confirmed the order's details." });
  must(db, STAFF.kim, "clarification.resolve", {
    clarificationId: id, expectedVersion: ver(db, "clarification", id), resolutionCode: "confirmed_order", note: "Office confirmed the patient on ORD-77118 (synthetic).",
  });
  const hold = one<{ id: string; version: number }>(db, "SELECT id, version FROM hold WHERE clarification_id = ? AND status = 'active'", id);
  must(db, STAFF.kim, "hold.release", { holdId: hold.id, expectedVersion: hold.version, reason: "Identity question resolved (synthetic)." });

  // 3. Source conflicts: a new order for MRN 447902 with another name and birth date (patient level), and a newer
  //    ORD-77118 version with another MRN and birth date (order level). A lead claims and releases one, then both are reviewed.
  const v1 = orderPayload(db, "ORD-77118", 1);
  importSourceMessage(importCtx(db), "src_ema", {
    messageId: "ORD-77990#v1", messageType: "order.upsert",
    payload: { ...v1, order_id: "ORD-77990", patient: { ...v1.patient, name: `Barnes, ${OTHER_VALUES.sourceName}`, birth_date: OTHER_VALUES.sourceBirthDate } },
  });
  importSourceMessage(importCtx(db), "src_ema", {
    messageId: "ORD-77118#v2", messageType: "order.upsert",
    payload: { ...v1, version: 2, updated_at: at("11:59"), patient: { ...v1.patient, mrn: OTHER_VALUES.amendedMrn, birth_date: OTHER_VALUES.amendedBirthDate } },
  });
  const conflictTasks = all<{ id: string; version: number; entity_type: string }>(
    db, "SELECT id, version, entity_type FROM task WHERE kind = 'source_conflict' AND entity_type IN ('patient_ref','source_order') AND status = 'open' ORDER BY created_at, id",
  );
  expect(conflictTasks.map((t) => t.entity_type).sort()).toEqual(["patient_ref", "source_order"]);
  const first = conflictTasks[0];
  must(db, STAFF.kim, "task.claim", { taskId: first.id, expectedVersion: first.version });
  must(db, STAFF.kim, "task.release", { taskId: first.id, expectedVersion: ver(db, "task", first.id) });
  for (const t of conflictTasks) {
    must(db, STAFF.kim, "sourceConflict.review", { taskId: t.id, expectedVersion: ver(db, "task", t.id), decision: "details_on_file_confirmed", reason: "Checked with the office (synthetic)." });
  }
  return { db, barnesItem, barnesContainer: c.id, clarificationId: id, conflictTasks };
}

// ------------------------------------------------------------------ the scan

interface Hit {
  seq: number;
  action: string;
  column: string;
  what: string;
  excerpt: string;
}

/**
 * Scans summary, before_json and after_json of every audit row. Before the scan, two kinds of text are masked:
 * patient reference ids (the synthetic seed builds them from the MRN) and the names of people who are not patients
 * (staff, clinicians, office contacts), whose family names can coincide with a patient's in the synthetic seed.
 */
function scanAudit(db: DB): { rows: number; needles: number; hits: Hit[] } {
  const patients = all<{ id: string; family_name: string; given_name: string; source_mrn: string; birth_date: string }>(
    db, "SELECT id, family_name, given_name, source_mrn, birth_date FROM patient_ref",
  );
  const people = [
    ...all<{ n: string }>(db, "SELECT display_name n FROM staff"),
    ...all<{ n: string }>(db, "SELECT display_name n FROM clinician"),
    ...all<{ n: string }>(db, "SELECT display_name n FROM office_contact"),
  ].map((r) => r.n).sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const needles: [string, RegExp][] = [];
  for (const p of patients) {
    needles.push([`family name of ${p.id}`, new RegExp(`(?<![\\p{L}])${esc(p.family_name)}(?![\\p{L}])`, "u")]);
    needles.push([`given and family name of ${p.id}`, new RegExp(esc(`${p.given_name} ${p.family_name}`), "i")]);
    needles.push([`MRN of ${p.id}`, new RegExp(`(?<![0-9])${esc(p.source_mrn)}(?![0-9])`)]);
    needles.push([`birth date of ${p.id}`, new RegExp(esc(p.birth_date))]);
  }
  for (const [k, v] of Object.entries(OTHER_VALUES)) needles.push([k, new RegExp(`(?<![0-9\\p{L}])${esc(v)}(?![0-9\\p{L}])`, "u")]);
  const ids = patients.map((p) => p.id).sort((a, b) => b.length - a.length);

  const rows = all<{ seq: number; action: string; summary: string; before_json: string | null; after_json: string | null }>(
    db, "SELECT seq, action, summary, before_json, after_json FROM audit_event ORDER BY seq",
  );
  const hits: Hit[] = [];
  for (const r of rows) {
    for (const column of ["summary", "before_json", "after_json"] as const) {
      let text = r[column] ?? "";
      for (const id of ids) text = text.split(id).join("‹patient_ref id›");
      for (const n of people) text = text.split(n).join("‹person›");
      for (const [what, re] of needles) {
        const m = re.exec(text);
        if (m) hits.push({ seq: r.seq, action: r.action, column, what, excerpt: text.slice(Math.max(0, m.index - 60), m.index + 40) });
      }
    }
  }
  return { rows: rows.length, needles: needles.length, hits };
}

describe("C4: no patient name, date of birth or MRN in audit payloads", () => {
  let s: Scenario;
  beforeAll(() => {
    s = buildScenario();
  });

  it("after every guided demo step (rehearsal), a source-conflict import, claim and review, and an identity clarification resolution, no audit row quotes a patient identifier", () => {
    const { rows, needles, hits } = scanAudit(s.db);
    expect(rows).toBeGreaterThan(200); // the seed's history plus every event of the flows above
    expect(needles).toBeGreaterThan(300);
    expect(hits, JSON.stringify(hits.slice(0, 10), null, 1)).toEqual([]);
    // The flows really ran: each kind of event this test is about was written.
    const actions = new Set(all<{ action: string }>(s.db, "SELECT DISTINCT action FROM audit_event").map((r) => r.action));
    for (const a of [
      "demo.step_run", "intake.observation_recorded", "intake.container_discrepancy", "clarification.created", "clarification.sent", "clarification.answered",
      "clarification.resolved", "hold.placed", "hold.released", "integration.order_imported", "integration.order_level_change_review", "task.claimed",
      "task.released", "source_conflict.reviewed",
    ]) {
      expect(actions.has(a), a).toBe(true);
    }
    // The chain still verifies (payload changes are ordinary audit content, sealed as written).
    expect(verifyAuditChain(s.db, { key: demoAuditKey() }).ok).toBe(true);
  });

  it("control: the scan does find an identifier when one is written (so an empty result means something)", () => {
    const db = testDb();
    const ctx = makeCtx(db, loadActor(db, STAFF.kim), "user", "phi-control");
    audit(ctx, {
      action: "test.phi_control", entityType: "test", entityId: "t1",
      summary: "Checked Theo Barnes", before: { mrn: "447902" }, after: { dob: "1972-06-14", note: `${OTHER_VALUES.sourceName} as sent` },
    });
    const found = scanAudit(db).hits.filter((h) => h.action === "test.phi_control").map((h) => `${h.column}:${h.what}`).sort();
    expect(found).toEqual([
      "after_json:birth date of pt_ema_447902",
      "after_json:sourceName",
      "before_json:MRN of pt_ema_447902",
      "summary:family name of pt_ema_447902",
      "summary:given and family name of pt_ema_447902",
    ]);
  });

  it("the records themselves keep the values: the patient, the bottle's label, the clarification's evidence and answer, the task titles", () => {
    const db = s.db;
    expect(one(db, "SELECT family_name, given_name, birth_date, source_mrn FROM patient_ref WHERE id = 'pt_ema_447902'")).toEqual({
      family_name: "Barnes", given_name: "Theo", birth_date: "1972-06-14", source_mrn: "447902",
    });
    expect(JSON.parse(one<{ observed_label: string }>(db, "SELECT observed_label FROM container WHERE id = ?", s.barnesContainer).observed_label)).toMatchObject({
      patient_name: "BARNES, THEO", birth_date: OTHER_VALUES.bottleBirthDate, mrn: "447902",
    });
    const clr = one<{ evidence: string; answer_text: string }>(db, "SELECT evidence, answer_text FROM clarification WHERE id = ?", s.clarificationId);
    expect(clr.evidence).toContain(OTHER_VALUES.bottleBirthDate);
    expect(clr.answer_text).toContain("1972-06-14");
    const titles = all<{ title: string }>(db, "SELECT title FROM task WHERE kind = 'source_conflict' AND entity_type IN ('patient_ref','source_order')").map((t) => t.title).join(" | ");
    expect(titles).toContain(OTHER_VALUES.sourceBirthDate);
    expect(titles).toContain(OTHER_VALUES.amendedMrn);
    // And the Intake screen still shows the patient for positive identification (nothing masked there).
    const bench = intakeBench(db, loadActor(db, STAFF.kim), { item: one<{ display_id: string }>(db, "SELECT display_id FROM intake_item WHERE id = ?", s.barnesItem).display_id });
    expect(JSON.stringify(bench.selected)).toContain("Barnes, Theo");
    expect(JSON.stringify(bench.selected)).toContain("1972-06-14");
  });

  it("identity values are recorded as field names, record ids and fingerprints; other values (site, laterality) as written", () => {
    const db = s.db;
    const obs = one<{ before_json: string; after_json: string; summary: string }>(
      db, "SELECT before_json, after_json, summary FROM audit_event WHERE action = 'intake.observation_recorded' AND entity_id = ? ORDER BY seq DESC LIMIT 1", s.barnesContainer,
    );
    const after = JSON.parse(obs.after_json) as Record<string, string>;
    expect(Object.keys(after).sort()).toEqual(["birth_date", "mrn", "patient_name"]);
    for (const k of ["birth_date", "mrn", "patient_name"]) expect(after[k]).toMatch(/^withheld \(fingerprint [0-9a-f]{16}\)$/);
    expect(obs.summary).toMatch(/\(patient_name, birth_date, mrn\)|\(birth_date, mrn, patient_name\)|patient_name/);
    // The fingerprint is the one the documented formula gives for this container and field.
    expect(after.birth_date).toBe(withheld(`container:${s.barnesContainer}:birth_date`, OTHER_VALUES.bottleBirthDate));

    const disc = one<{ summary: string }>(db, "SELECT summary FROM audit_event WHERE action = 'intake.container_discrepancy' AND entity_id = ? ORDER BY seq DESC LIMIT 1", s.barnesContainer);
    expect(disc.summary).toMatch(/Date of birth: order and bottle differ/);

    const created = JSON.parse(one<{ after_json: string }>(db, "SELECT after_json FROM audit_event WHERE action = 'clarification.created' AND entity_id = ?", s.clarificationId).after_json) as {
      evidence: { field: string; order_value: string | null; observed_value: string | null; source: string }[]; question: string;
    };
    expect(created.evidence.map((e) => e.field)).toEqual(["Date of birth", "Patient name", "MRN"]);
    for (const e of created.evidence) {
      expect(e.order_value).toMatch(/^withheld \(fingerprint [0-9a-f]{16}\)$/);
      expect(e.observed_value).toMatch(/^withheld \(fingerprint [0-9a-f]{16}\)$/);
      expect(e.source).toBe("bottle label");
    }
    // Name and MRN on the bottle equal the order's: equal values, equal fingerprints within one clarification, field and column...
    const name = created.evidence.find((e) => e.field === "Patient name")!;
    expect(name.order_value).not.toBe(name.observed_value); // ...but the column is part of the scope, so they are not joinable.
    expect(name.order_value).toBe(withheld(`clarification:${s.clarificationId}:Patient name:order`, "Barnes, Theo"));

    // The hero journey's laterality question keeps its (non-identifying) values in the audit trail.
    const lat = all<{ after_json: string }>(db, "SELECT after_json FROM audit_event WHERE action = 'clarification.created' AND after_json LIKE '%Laterality%'");
    expect(lat.length).toBeGreaterThan(0);
    expect(lat[0].after_json).toMatch(/dorsal forearm/i);

    // The answer's audit copy has the identifiers replaced; the summary still reads as an answer.
    const answered = one<{ summary: string }>(db, "SELECT summary FROM audit_event WHERE action = 'clarification.answered' AND entity_id = ?", s.clarificationId);
    expect(answered.summary).toContain("Our chart has [patient name], DOB [date of birth] ([date of birth]), MRN [MRN].");

    // The order-level review names the patient fields only.
    const ol = one<{ summary: string; after_json: string }>(db, "SELECT summary, after_json FROM audit_event WHERE action = 'integration.order_level_change_review' ORDER BY seq DESC LIMIT 1");
    expect(ol.summary).toMatch(/changed patient MRN \(order stays linked to the original patient\)/);
    expect(JSON.parse(ol.after_json).changes).toEqual(["patient MRN (order stays linked to the original patient)"]);

    // Task claims quote the task title with the identifiers replaced.
    const claimed = one<{ summary: string }>(db, "SELECT summary FROM audit_event WHERE action = 'task.claimed' ORDER BY seq DESC LIMIT 1");
    expect(claimed.summary).toMatch(/\[(MRN|date of birth|patient name)\]/);
  });

  it("the source-conflict review proves the details on file are unchanged with the reference id and a fingerprint, and History shows the details from the record itself", () => {
    const db = s.db;
    const rows = all<{ before_json: string; after_json: string; intake_item_id: string | null }>(
      db, "SELECT before_json, after_json, intake_item_id FROM audit_event WHERE action = 'source_conflict.reviewed' ORDER BY seq",
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      const before = JSON.parse(r.before_json);
      const after = JSON.parse(r.after_json);
      expect(Object.keys(before.patientRef).sort()).toEqual(["fingerprint", "id"]);
      expect(before.patientRef).toEqual(after.patientRef);
      expect(after.patientRefUnchanged).toBe(true);
      expect(before.patientRef.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      // Recomputed from the record now: the same fingerprint (anyone holding the audit key can check it).
      expect(auditedPatientRef(db, before.patientRef.id)).toEqual(before.patientRef);
      expect(before.task).not.toHaveProperty("title");
      // History (intake item and case screens) shows the details from the patient record, which matches the fingerprint.
      const shown = JSON.parse(historyPayload(db, r.after_json)!).patientRef;
      expect(shown).toMatchObject({ id: "pt_ema_447902", family_name: "Barnes", given_name: "Theo", birth_date: "1972-06-14", shown: expect.stringMatching(/matches the audited fingerprint/) });
    }
  });

  it("History withholds the details when the patient record no longer matches the audited fingerprint (the audit row is never changed)", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77991#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-77991", patient: { ...v1.patient, birth_date: "1902-02-02" } } });
    const t = one<{ id: string; version: number }>(db, "SELECT id, version FROM task WHERE kind = 'source_conflict' AND entity_type = 'patient_ref' AND status = 'open'");
    must(db, STAFF.kim, "sourceConflict.review", { taskId: t.id, expectedVersion: t.version, decision: "details_on_file_confirmed", reason: "Checked (synthetic)" });
    const row = one<{ after_json: string }>(db, "SELECT after_json FROM audit_event WHERE action = 'source_conflict.reviewed' ORDER BY seq DESC LIMIT 1");
    // Someone with file access edits the patient record afterwards.
    db.prepare("UPDATE patient_ref SET birth_date = '1972-06-13' WHERE id = 'pt_ema_447902'").run();
    const shown = JSON.parse(historyPayload(db, row.after_json)!).patientRef;
    expect(shown).toEqual({ id: "pt_ema_447902", fingerprint: JSON.parse(row.after_json).patientRef.fingerprint, shown: expect.stringMatching(/no longer matches/) });
    expect(JSON.stringify(shown)).not.toContain("1972-06-1");
    // Other payloads pass through untouched.
    expect(historyPayload(db, '{"state":"open"}')).toBe('{"state":"open"}');
    expect(historyPayload(db, null)).toBeNull();
  });

  it("patient references made by the importer are opaque sequence ids (only the synthetic seed derives ids from the MRN)", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-88001#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-88001", patient: { mrn: "771234", name: "Ortega, Lina", birth_date: "1988-03-09" } } });
    const p = one<{ id: string }>(db, "SELECT id FROM patient_ref WHERE source_mrn = '771234'");
    expect(p.id).toMatch(/^pt_\d{6}$/);
    expect(p.id).not.toContain("771234");
    const imported = one<{ after_json: string; summary: string }>(db, "SELECT after_json, summary FROM audit_event WHERE action = 'integration.order_imported' ORDER BY seq DESC LIMIT 1");
    expect(`${imported.summary}${imported.after_json}`).not.toMatch(/771234|Ortega|Lina|1988-03-09/);
  });

  it("pinned limitation: audit_event.reason is stored as typed (staff free text is out of scope)", () => {
    const db = testDb();
    const v1 = orderPayload(db, "ORD-77118", 1);
    importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77992#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-77992", patient: { ...v1.patient, birth_date: "1903-03-03" } } });
    const t = one<{ id: string; version: number }>(db, "SELECT id, version FROM task WHERE kind = 'source_conflict' AND entity_type = 'patient_ref' AND status = 'open'");
    const typed = "Called the office: Theo Barnes, born 1972-06-14, is correct (synthetic).";
    must(db, STAFF.kim, "sourceConflict.review", { taskId: t.id, expectedVersion: t.version, decision: "details_on_file_confirmed", reason: typed });
    const row = one<{ reason: string; summary: string; after_json: string }>(db, "SELECT reason, summary, after_json FROM audit_event WHERE action = 'source_conflict.reviewed' ORDER BY seq DESC LIMIT 1");
    expect(row.reason).toBe(typed); // the person's words, as typed
    expect(`${row.summary}${row.after_json}`).not.toMatch(/Barnes|1972-06-14/);
  });
});

describe("C4: fingerprints and redaction (src/server/domain/privacy.ts)", () => {
  it("a fingerprint is an HMAC under a key derived from the audit key, scoped per record and field, insensitive to case and spacing", () => {
    const fp = fingerprint("container:c1:birth_date", "1972-06-14");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    const k = crypto.createHmac("sha256", demoAuditKey().key).update("hlos-audit-fingerprint/v1").digest();
    expect(fp).toBe(crypto.createHmac("sha256", k).update("container:c1:birth_date\n1972-06-14").digest("hex").slice(0, 16));
    expect(fingerprint("container:c2:birth_date", "1972-06-14")).not.toBe(fp); // another record: not joinable
    expect(fingerprint("x", "BARNES,  Theo")).toBe(fingerprint("x", "barnes, theo"));
    expect(fingerprint("x", "")).toBeNull();
    expect(withheld("x", null)).toBeNull();
  });

  it("without any audit key (a locked build with no HLOS_AUDIT_KEY) a value is withheld with no fingerprint", () => {
    const saved = { mode: process.env.HLOS_MODE, key: process.env.HLOS_AUDIT_KEY };
    try {
      process.env.HLOS_MODE = "locked";
      delete process.env.HLOS_AUDIT_KEY;
      expect(fingerprint("x", "1972-06-14")).toBe("");
      expect(withheld("x", "1972-06-14")).toBe("withheld");
    } finally {
      process.env.HLOS_MODE = saved.mode;
      if (saved.key === undefined) delete process.env.HLOS_AUDIT_KEY;
      else process.env.HLOS_AUDIT_KEY = saved.key;
    }
  });

  it("identity fields are recognised by key and by label", () => {
    for (const f of ["patient_name", "birth_date", "mrn", "Date of birth", "Patient name", "MRN", "Medical record number", "DOB"]) expect(isIdentityField(f), f).toBe(true);
    for (const f of ["site_text", "laterality", "procedure", "part_designation", "collection_date", "Laterality", "Site", "Source amendment"]) expect(isIdentityField(f), f).toBe(false);
  });

  it("redaction replaces the linked patient's name forms, birth-date formats and MRN, and what the source sent about them", () => {
    const db = testDb();
    const ids = knownIdentifiers(db, ["pt_ema_447902"]);
    const text = "Barnes, Theo (THEO BARNES) born 1972-06-14 / 6/14/1972 / 06/14/1972, MRN 447902; not 4479021 or Barnesville.";
    expect(redactIdentifiers(text, ids)).toBe(
      "[patient name] ([patient name]) born [date of birth] / [date of birth] / [date of birth], MRN [MRN]; not 4479021 or Barnesville.",
    );
  });
});
