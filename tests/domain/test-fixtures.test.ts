import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeSharedDb, getDb, openDatabase } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { importSourceMessage } from "@/server/domain/sourceImport";
import {
  FIXTURE_TOKEN_HEADER,
  TEST_FIXTURE_NAMES,
  buildTestFixture,
  fixtureTokenMatches,
  isTestFixtureName,
  testFixturesEnabled,
  type TestFixtureName,
} from "@/server/test-fixtures";
import { all, one, testDb } from "../helpers";

// Stage 6, A1: the test-only source-message fixtures (src/server/test-fixtures.ts) and their endpoint
// (POST /api/test/fixtures). The gate refuses with one identical 404 unless the synthetic demo mode,
// HLOS_TEST_FIXTURES=1 and a token of at least 32 characters are configured and the request carries that
// token. Only catalog names are accepted; each fixture is deterministic, so a repeat is a duplicate.

const TOKEN = "t".repeat(16) + "0123456789abcdef0123456789abcdef"; // 48 characters, synthetic
const ENV_KEYS = ["HLOS_MODE", "HLOS_TEST_FIXTURES", "HLOS_TEST_FIXTURE_TOKEN", "HLOS_DB_PATH"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (k === "HLOS_DB_PATH") continue; // owned by the HTTP block's beforeAll/afterAll
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

/** The configuration the browser tests run with: demo mode, the switch on, a long token. */
function enable(token = TOKEN): void {
  process.env.HLOS_MODE = "demo";
  process.env.HLOS_TEST_FIXTURES = "1";
  process.env.HLOS_TEST_FIXTURE_TOKEN = token;
}

afterEach(restoreEnv);

describe("testFixturesEnabled and the token comparison", () => {
  it("is true only in demo mode, with HLOS_TEST_FIXTURES=1 and a token of at least 32 characters", () => {
    enable();
    expect(testFixturesEnabled()).toBe(true);

    for (const mode of ["locked", "production", "pilot", "secured"]) {
      process.env.HLOS_MODE = mode;
      expect(testFixturesEnabled(), `HLOS_MODE=${mode}`).toBe(false);
    }
    enable();
    delete process.env.HLOS_MODE; // unset outside `next dev` (vitest runs with NODE_ENV=test) is the locked mode
    expect(testFixturesEnabled()).toBe(false);

    for (const flag of [undefined, "", "0", "true", "yes", " 1"]) {
      enable();
      if (flag === undefined) delete process.env.HLOS_TEST_FIXTURES;
      else process.env.HLOS_TEST_FIXTURES = flag;
      expect(testFixturesEnabled(), `HLOS_TEST_FIXTURES=${JSON.stringify(flag)}`).toBe(false);
    }

    enable("x".repeat(31));
    expect(testFixturesEnabled()).toBe(false);
    enable("x".repeat(32));
    expect(testFixturesEnabled()).toBe(true);
    enable();
    delete process.env.HLOS_TEST_FIXTURE_TOKEN;
    expect(testFixturesEnabled()).toBe(false);
  });

  it("matches only the exact configured token, and never an empty or short configured token", () => {
    enable();
    expect(fixtureTokenMatches(TOKEN)).toBe(true);
    for (const wrong of [null, undefined, "", TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), `${TOKEN.slice(0, -1)}g`, ` ${TOKEN}`]) {
      expect(fixtureTokenMatches(wrong), JSON.stringify(wrong)).toBe(false);
    }
    enable("short-token");
    expect(fixtureTokenMatches("short-token")).toBe(false);
    enable("");
    expect(fixtureTokenMatches("")).toBe(false);
    delete process.env.HLOS_TEST_FIXTURE_TOKEN;
    expect(fixtureTokenMatches("")).toBe(false);
  });

  it("knows only the fixed catalog", () => {
    expect([...TEST_FIXTURE_NAMES]).toEqual(["source-conflict-patient", "source-conflict-order-amend"]);
    for (const name of TEST_FIXTURE_NAMES) expect(isTestFixtureName(name)).toBe(true);
    for (const other of ["", "source-conflict", "SOURCE-CONFLICT-PATIENT", "__proto__", "constructor", "toString", null, 1, {}]) {
      expect(isTestFixtureName(other), JSON.stringify(other)).toBe(false);
    }
  });
});

describe("fixtures are deterministic and synthetic, built from seed records", () => {
  it("each fixture builds the same message every time, from any freshly seeded database", () => {
    const a = testDb();
    const b = testDb();
    for (const name of TEST_FIXTURE_NAMES) {
      const first = buildTestFixture(a, name);
      expect(buildTestFixture(a, name), name).toEqual(first);
      expect(buildTestFixture(b, name), name).toEqual(first);
      expect(first.message.messageId, name).toMatch(new RegExp(`^fixture/${name}/`));
      expect(first.sourceId).toBe("src_ema");
    }
  });

  it("source-conflict-patient: a new order naming the seeded MRN with a different name and date of birth", () => {
    const db = testDb();
    const f = buildTestFixture(db, "source-conflict-patient");
    expect(f.message).toMatchObject({ messageId: "fixture/source-conflict-patient/ORD-77990#v1", messageType: "order.upsert" });
    expect(f.message.payload).toMatchObject({
      order_id: "ORD-77990",
      version: 1,
      patient: { mrn: "447902", name: "Barnes, Thea", birth_date: "1927-06-14" },
      office_id: "LOC-104",
      encounter_id: null,
    });
    // The seed record it starts from is unchanged, and differs in exactly those details.
    expect(one(db, "SELECT family_name, given_name, birth_date FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = '447902'")).toEqual({
      family_name: "Barnes",
      given_name: "Theo",
      birth_date: "1972-06-14",
    });
  });

  it("source-conflict-order-amend: version 2 of the seeded order with the patient's date of birth changed", () => {
    const db = testDb();
    const f = buildTestFixture(db, "source-conflict-order-amend");
    expect(f.message).toMatchObject({ messageId: "fixture/source-conflict-order-amend/ORD-77118#v2", messageType: "order.upsert" });
    expect(f.message.payload).toMatchObject({ order_id: "ORD-77118", version: 2, patient: { mrn: "447902", name: "Barnes, Theo", birth_date: "1972-06-15" } });
  });

  it.each(TEST_FIXTURE_NAMES)("%s: the importer applies it once and opens one source-conflict review; the same fixture again is duplicate_ignored and changes nothing", (name) => {
    const db = testDb();
    const ctx = () => makeCtx(db, SYSTEM_ACTOR, "import", `fixture-test-${name}`);
    const patientBefore = one(db, "SELECT * FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = '447902'");
    const f = buildTestFixture(db, name);
    const first = db.transaction(() => importSourceMessage(ctx(), f.sourceId, f.message, { via: "sync" }))();
    expect(first.outcome).toBe("applied");
    const conflicts = all<{ entity_type: string; entity_id: string; title: string }>(
      db,
      "SELECT entity_type, entity_id, title FROM task WHERE kind = 'source_conflict' AND status = 'open' ORDER BY created_at",
    );
    expect(conflicts).toHaveLength(1);
    if (name === "source-conflict-patient") {
      expect(conflicts[0]).toMatchObject({ entity_type: "patient_ref", entity_id: (patientBefore as { id: string }).id });
      expect(conflicts[0].title).toBe(
        "New order ORD-77990 gives different details for MRN 447902 (name Barnes, Theo → Barnes, Thea; date of birth 1972-06-14 → 1927-06-14) — review; patient record not changed",
      );
      // Linked by MRN to the patient on file, never a second patient reference.
      expect(one<{ p: string }>(db, "SELECT patient_ref_id p FROM source_order WHERE source_order_id = 'ORD-77990'").p).toBe((patientBefore as { id: string }).id);
    } else {
      expect(conflicts[0]).toMatchObject({ entity_type: "source_order", entity_id: "ord_ord_77118" });
      expect(conflicts[0].title).toBe("ORD-77118 v2 changed the patient date of birth 1972-06-14 → 1972-06-15 — review; nothing was changed locally");
      expect(one<{ v: number }>(db, "SELECT source_version v FROM source_order WHERE id = 'ord_ord_77118'").v).toBe(2);
    }
    // Nothing merged or overwritten: the patient on file is exactly as it was.
    expect(one(db, "SELECT * FROM patient_ref WHERE tenant_id = 'ten_ema' AND source_mrn = '447902'")).toEqual(patientBefore);

    const counts = () => ({
      tasks: one<{ n: number }>(db, "SELECT COUNT(*) n FROM task").n,
      orders: one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order").n,
      versions: one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order_version").n,
      patients: one<{ n: number }>(db, "SELECT COUNT(*) n FROM patient_ref").n,
    });
    const before = counts();
    const again = db.transaction(() => importSourceMessage(ctx(), f.sourceId, buildTestFixture(db, name).message, { via: "sync" }))();
    expect(again.outcome).toBe("duplicate_ignored");
    expect(again.eventId).toBe(first.eventId);
    expect(again.receiptCount).toBe(2);
    expect(counts()).toEqual(before);
  });
});

describe("POST /api/test/fixtures", () => {
  let dir = "";
  let route: typeof import("@/app/api/test/fixtures/route");

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-fixtures-"));
    process.env.HLOS_DB_PATH = path.join(dir, "fixtures.sqlite");
    const seeded = openDatabase(process.env.HLOS_DB_PATH);
    seedDemo(seeded, { clockRunning: false });
    seeded.close();
    route = await import("@/app/api/test/fixtures/route");
  });

  afterAll(() => {
    closeSharedDb();
    if (saved.HLOS_DB_PATH === undefined) delete process.env.HLOS_DB_PATH;
    else process.env.HLOS_DB_PATH = saved.HLOS_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown, headers: Record<string, string> = { [FIXTURE_TOKEN_HEADER]: TOKEN }) =>
    route.POST(
      new Request("http://localhost/api/test/fixtures", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const events = () => one<{ n: number }>(getDb(), "SELECT COUNT(*) n FROM integration_event").n;
  const audits = () => one<{ n: number }>(getDb(), "SELECT COUNT(*) n FROM audit_event").n;
  const NOT_FOUND = { ok: false, error: { code: "NOT_FOUND", message: "Not found." } };

  async function expectNotFound(res: Response, label: string): Promise<void> {
    expect(res.status, label).toBe(404);
    expect(await res.json(), label).toEqual(NOT_FOUND);
    expect(res.headers.get("cache-control"), label).toBe("no-store");
  }

  it("refuses with the same 404 in a locked build, in demo mode without HLOS_TEST_FIXTURES, with a short or missing token, and for a wrong header; nothing is imported", async () => {
    const before = { events: events(), audits: audits() };
    const cases: { label: string; setup: () => void; headers?: Record<string, string> }[] = [
      { label: "locked mode (HLOS_MODE=locked)", setup: () => (enable(), (process.env.HLOS_MODE = "locked")) },
      { label: "locked mode (HLOS_MODE unset)", setup: () => (enable(), delete process.env.HLOS_MODE) },
      { label: "demo mode without HLOS_TEST_FIXTURES", setup: () => (enable(), delete process.env.HLOS_TEST_FIXTURES) },
      { label: "demo mode with HLOS_TEST_FIXTURES=0", setup: () => (enable(), (process.env.HLOS_TEST_FIXTURES = "0")) },
      { label: "short token (31 characters), sent exactly", setup: () => enable("s".repeat(31)), headers: { [FIXTURE_TOKEN_HEADER]: "s".repeat(31) } },
      { label: "missing token, empty header", setup: () => (enable(), delete process.env.HLOS_TEST_FIXTURE_TOKEN), headers: { [FIXTURE_TOKEN_HEADER]: "" } },
      { label: "missing token, no header", setup: () => (enable(), delete process.env.HLOS_TEST_FIXTURE_TOKEN), headers: {} },
      { label: "wrong header", setup: () => enable(), headers: { [FIXTURE_TOKEN_HEADER]: `${TOKEN.slice(0, -1)}x` } },
      { label: "header longer than the token", setup: () => enable(), headers: { [FIXTURE_TOKEN_HEADER]: `${TOKEN}0` } },
      { label: "no header", setup: () => enable(), headers: {} },
      { label: "the token in another header", setup: () => enable(), headers: { authorization: `Bearer ${TOKEN}` } },
    ];
    for (const c of cases) {
      restoreEnv();
      c.setup();
      await expectNotFound(await post({ fixture: "source-conflict-patient" }, c.headers), c.label);
      // An unknown fixture or a body that is not JSON is refused the same way: the gate comes first.
      await expectNotFound(await post({ fixture: "no-such-fixture" }, c.headers), `${c.label}, unknown fixture`);
      await expectNotFound(await post("not json", c.headers), `${c.label}, body not JSON`);
    }
    // Other methods never reveal the route, even with everything right.
    restoreEnv();
    enable();
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) await expectNotFound(await route[method](), method);
    expect({ events: events(), audits: audits() }).toEqual(before);
  });

  it("with the right token in demo mode: an unknown fixture or a bad body is 400 and imports nothing", async () => {
    enable();
    const before = { events: events(), audits: audits() };
    for (const body of [{ fixture: "no-such-fixture" }, { fixture: "__proto__" }, { fixture: 1 }, {}, { payload: { order_id: "ORD-1" } }, "not json", "[]"]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
    }
    expect({ events: events(), audits: audits() }).toEqual(before);
  });

  it("with the right token in demo mode: imports the named fixture through the importer and returns its ImportResult; the same fixture again is duplicate_ignored", async () => {
    enable();
    const db = getDb();
    const res = await post({ fixture: "source-conflict-patient" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fixture: TestFixtureName; result: { outcome: string; eventId: string; messageId: string; sourceOrderId: string; reconciliation: { kind: string; ref?: string }[] } };
    expect(body).toMatchObject({ ok: true, fixture: "source-conflict-patient" });
    expect(body.result).toMatchObject({ outcome: "applied", messageId: "fixture/source-conflict-patient/ORD-77990#v1", sourceOrderId: "ORD-77990" });
    const conflict = body.result.reconciliation.find((n) => n.kind === "patient_conflict");
    expect(conflict?.ref).toBeTruthy();
    expect(one(db, "SELECT kind, entity_type, status, owner_id FROM task WHERE id = ?", conflict!.ref)).toEqual({
      kind: "source_conflict",
      entity_type: "patient_ref",
      status: "open",
      owner_id: "stf_kim",
    });
    // Recorded as an import by the internal system actor (origin "import"), with a receipt marked as a demo control.
    const imported = one<{ origin: string; actor_id: string; correlation_id: string }>(
      db,
      "SELECT origin, actor_id, correlation_id FROM audit_event WHERE action = 'integration.order_imported' AND entity_id = (SELECT id FROM source_order WHERE source_order_id = 'ORD-77990')",
    );
    expect(imported).toMatchObject({ origin: "import", actor_id: "system" });
    expect(imported.correlation_id).toMatch(/^test-fixture-source-conflict-patient-/);
    expect(one<{ via: string; outcome: string }>(db, "SELECT via, outcome FROM integration_receipt WHERE event_id = ?", body.result.eventId)).toEqual({ via: "sync", outcome: "applied" });

    const tasks = one<{ n: number }>(db, "SELECT COUNT(*) n FROM task").n;
    const again = await post({ fixture: "source-conflict-patient" });
    expect(again.status).toBe(200);
    const repeat = (await again.json()) as { result: { outcome: string; eventId: string; receiptCount: number } };
    expect(repeat.result).toMatchObject({ outcome: "duplicate_ignored", eventId: body.result.eventId, receiptCount: 2 });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM task").n).toBe(tasks);

    // The other catalog fixture: an order-level conflict on the seeded order; again, a repeat is a duplicate.
    const amend = (await (await post({ fixture: "source-conflict-order-amend" })).json()) as { result: { outcome: string; previousVersion: number; version: number } };
    expect(amend.result).toMatchObject({ outcome: "applied", previousVersion: 1, version: 2 });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM task WHERE kind = 'source_conflict' AND entity_type = 'source_order' AND entity_id = 'ord_ord_77118' AND status = 'open'").n).toBe(1);
    const amendAgain = (await (await post({ fixture: "source-conflict-order-amend" })).json()) as { result: { outcome: string } };
    expect(amendAgain.result.outcome).toBe("duplicate_ignored");
  });

  it("a cross-origin request with the right token is refused (403) and imports nothing", async () => {
    enable();
    const before = events();
    const res = await post({ fixture: "source-conflict-patient" }, { [FIXTURE_TOKEN_HEADER]: TOKEN, origin: "http://evil.example", host: "localhost" });
    expect(res.status).toBe(403);
    expect(events()).toBe(before);
  });
});

