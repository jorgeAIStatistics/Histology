import { describe, it, expect } from "vitest";
import { testDb, one, all } from "../helpers";
import { computeReadiness } from "@/server/domain/readiness";
import { encodeLabel, decodeLabel } from "@/lib/identifiers";

describe("foundation: seed, invariants enforced by the database", () => {
  it("seeds a reproducible synthetic day with >300 slides and ~60 active cases", () => {
    const db = testDb();
    const slides = one<{ n: number }>(db, "SELECT COUNT(*) n FROM slide").n;
    const cases = one<{ n: number }>(db, "SELECT COUNT(*) n FROM accession WHERE is_prior_day = 0").n;
    expect(slides).toBeGreaterThan(300);
    expect(cases).toBeGreaterThanOrEqual(55);
    // Deterministic: a second seed produces identical identifiers.
    const db2 = testDb();
    const a = all<{ accession_number: string }>(db, "SELECT accession_number FROM accession ORDER BY id").map((r) => r.accession_number);
    const b = all<{ accession_number: string }>(db2, "SELECT accession_number FROM accession ORDER BY id").map((r) => r.accession_number);
    expect(a).toEqual(b);
  });

  it("refuses to renumber an issued accession or change a part's site/designation (DB trigger)", () => {
    const db = testDb();
    const acc = one<{ id: string }>(db, "SELECT id FROM accession LIMIT 1");
    expect(() => db.prepare("UPDATE accession SET accession_number = 'D26-99999' WHERE id = ?").run(acc.id)).toThrow(/renumber/);
    const part = one<{ id: string }>(db, "SELECT id FROM specimen_part LIMIT 1");
    expect(() => db.prepare("UPDATE specimen_part SET site_text = 'Somewhere else' WHERE id = ?").run(part.id)).toThrow(/silently changed/);
    expect(() => db.prepare("UPDATE specimen_part SET designation = 'Z' WHERE id = ?").run(part.id)).toThrow(/silently changed/);
  });

  it("keeps the audit log append-only", () => {
    const db = testDb();
    expect(() => db.prepare("UPDATE audit_event SET summary = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_event").run()).toThrow(/append-only/);
  });

  it("same MRN in two source tenants is two different patient references", () => {
    const db = testDb();
    const rows = all<{ tenant_id: string; family_name: string }>(db, "SELECT tenant_id, family_name FROM patient_ref WHERE source_mrn = '100234' ORDER BY tenant_id");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenant_id)).size).toBe(2);
    expect(rows.map((r) => r.family_name).sort()).toEqual(["Marten", "Ruiz"]);
  });

  it("derives readiness per part: one finished part never makes the case complete", () => {
    const db = testDb();
    const ids = all<{ id: string }>(db, "SELECT id FROM accession WHERE is_prior_day = 0").map((r) => r.id);
    const r = computeReadiness(db, ids);
    for (const c of r.values()) {
      if (c.parts.some((p) => p.stage !== "delivered" && p.status !== "canceled")) expect(c.isComplete).toBe(false);
    }
    const mixed = [...r.values()].find((c) => new Set(c.parts.map((p) => p.stage)).size > 1);
    expect(mixed).toBeTruthy();
  });

  it("demo label identifiers round-trip and reject a damaged scan", () => {
    const payload = encodeLabel({ kind: "S", namespace: "EMS", accession: "D26-04817", part: "A", block: 1, slide: 2, stain: "PAS" });
    const d = decodeLabel(payload);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.identity).toMatchObject({ accession: "D26-04817", part: "A", block: 1, slide: 2, stain: "PAS" });
    const damaged = payload.replace("04817", "04811");
    expect(decodeLabel(damaged).ok).toBe(false);
  });
});
