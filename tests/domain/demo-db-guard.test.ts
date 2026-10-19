// Demo mode serves only the synthetic demo database (Stage 6 Phase B review: "demo mode serves whatever database it opens").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSyntheticForDemo, closeSharedDb, getDb, openDatabase } from "@/server/db/db";
import { ensureAuthSchema } from "@/server/db/auth-schema";
import { seedDemo } from "@/server/seed/seed";

const env = { ...process.env };
afterEach(() => {
  closeSharedDb();
  process.env = { ...env };
});
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hlos-demo-guard-")), "x.db");
/** A seeded synthetic demo database on disk (vitest cannot run getDb's lazy require of the seed). */
function seededFile(): string {
  const file = tmp();
  const db = openDatabase(file);
  seedDemo(db);
  db.close();
  return file;
}

describe("demo mode refuses a database that is not the synthetic demo database", () => {
  it("the seeded synthetic demo database is served in demo mode", () => {
    process.env.HLOS_MODE = "demo";
    process.env.HLOS_DB_PATH = seededFile();
    const db = getDb();
    expect(db.prepare("SELECT value FROM app_setting WHERE key = 'seeded_at'").get()).toBeTruthy();
  });

  it("a database without the synthetic seed marker is refused (never served through the demo role switch)", () => {
    const file = tmp();
    const raw = openDatabase(file);
    ensureAuthSchema(raw);
    raw.close();
    // Not seedable either: secured mode does not seed, so open it as demo with seeding of an existing DB impossible.
    process.env.HLOS_MODE = "demo";
    process.env.HLOS_DB_PATH = file;
    const db = openDatabase(file);
    expect(() => assertSyntheticForDemo(db, file)).toThrow(/no synthetic seed marker/);
  });

  it("a seeded database with a linked sign-in identity (a secured deployment's) is refused", () => {
    process.env.HLOS_MODE = "demo";
    process.env.HLOS_DB_PATH = seededFile();
    const db = getDb();
    db.prepare(
      "INSERT INTO staff_identity (lab_id, issuer, subject, staff_id, active, linked_by, linked_at) VALUES ('lab:local', 'https://idp.example.test', 'sub-1', 'stf_kim', 1, 'system', '2026-10-19T00:00:00Z')",
    ).run();
    closeSharedDb();
    expect(() => getDb()).toThrow(/linked sign-in identities/);
  });
});

describe("outside demo mode a missing database is never created silently", () => {
  it("secured mode with no file at HLOS_DB_PATH refuses, and creates nothing", () => {
    const file = tmp();
    process.env.HLOS_MODE = "secured";
    process.env.HLOS_DB_PATH = file;
    delete process.env.HLOS_SEED_SYNTHETIC;
    delete process.env.HLOS_DB_ALLOW_CREATE;
    expect(() => getDb()).toThrow(/not created automatically/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("an explicit initialization (HLOS_DB_ALLOW_CREATE=1) creates it", () => {
    const file = tmp();
    process.env.HLOS_MODE = "secured";
    process.env.HLOS_DB_PATH = file;
    process.env.HLOS_DB_ALLOW_CREATE = "1";
    delete process.env.HLOS_SEED_SYNTHETIC;
    getDb();
    expect(fs.existsSync(file)).toBe(true);
  });
});
