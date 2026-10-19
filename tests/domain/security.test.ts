import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { executeCommand } from "@/server/commands";
import { defineCommand } from "@/server/commands/registry";
import { RECEIPT_TTL_MS, canonicalJson, requestFingerprint } from "@/server/core/idempotency";
import { setSetting } from "@/server/core/settings";
import { all, one, run, STAFF, testDb } from "../helpers";

// Stage 5, Phase A1: scoped idempotency, the internal actor, and the demo/locked gate.
// Every case uses clarification.create on the synthetic hero order (a command with a
// visible side effect: one new clarification row and one audit event).

const ORDER_B = "ord_ord_77121";
const PART_B = "ord_ord_77121_b";
const input = (question = "Which side is correct for part B?") => ({
  category: "laterality",
  refs: { sourceOrderId: ORDER_B, orderPartId: PART_B },
  subjectLabel: "Part B · ORD-77121",
  question,
  evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", requisition_value: null, source: "bottle label (staff entry)" }],
  priority: "high",
});
const clarifications = (db: DB) => one<{ n: number }>(db, "SELECT COUNT(*) n FROM clarification").n;
const auditCount = (db: DB, action?: string) =>
  action ? one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE action = ?", action).n : one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event").n;
const KEY = "ui-test-key-0001";

// Records calls to the simulated-source pump (the only writer behind GET /api/live).
const pumpCalls: number[] = [];
vi.mock("@/server/sim/pump", async (orig) => {
  const real = await orig<typeof import("@/server/sim/pump")>();
  return { ...real, pumpSources: (...args: Parameters<typeof real.pumpSources>) => (pumpCalls.push(1), real.pumpSources(...args)) };
});

const savedMode = process.env.HLOS_MODE;
afterEach(() => {
  process.env.HLOS_MODE = savedMode;
});

describe("idempotency: a key is owned by one actor, scope, command and request", () => {
  it("same actor, same request: the retry returns the stored result and changes nothing", () => {
    const db = testDb();
    const before = clarifications(db);
    const first = run<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", input(), KEY);
    expect(first.ok).toBe(true);
    const audits = auditCount(db);
    const again = run<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", input(), KEY);
    expect(again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(again.replayed).toBe(true);
      expect(again.result).toEqual(first.result);
    }
    expect(clarifications(db)).toBe(before + 1);
    expect(auditCount(db)).toBe(audits);
  });

  it("key order and absent members do not change the fingerprint; a changed value does", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalJson({ a: { d: 2 }, b: 1 }));
    expect(requestFingerprint("x", { a: 1 })).toBe(requestFingerprint("x", { a: 1 }));
    expect(requestFingerprint("x", { a: 1 })).not.toBe(requestFingerprint("x", { a: 2 }));
    expect(requestFingerprint("x", { a: 1 })).not.toBe(requestFingerprint("y", { a: 1 }));
  });

  it("same key, different payload: refused, nothing runs, the stored result is not disclosed", () => {
    const db = testDb();
    must1(db);
    const count = clarifications(db);
    const res = run(db, STAFF.maya, "clarification.create", input("A different question"), KEY);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(JSON.stringify(res)).not.toContain("clarificationId");
    }
    expect(clarifications(db)).toBe(count);
    expect(auditCount(db, "command.idempotency_rejected")).toBe(1);
  });

  it("same key, another command: refused", () => {
    const db = testDb();
    must1(db);
    const res = run(db, STAFF.maya, "worklist.saveFilter", { name: "x", view: "histotech", filters: {} }, KEY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("same key and payload from another actor: refused without the result (possessing a key is not authorization)", () => {
    const db = testDb();
    must1(db);
    const count = clarifications(db);
    for (const other of [STAFF.luis, STAFF.kim, STAFF.director]) {
      const res = run(db, other, "clarification.create", input(), KEY);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("IDEMPOTENCY_CONFLICT");
        expect(res.error.message).not.toMatch(/CLR-|clarification id/i);
        expect(res.error.details).toEqual({ reason: "not_owner" });
      }
    }
    expect(clarifications(db)).toBe(count);
    expect(auditCount(db, "command.idempotency_rejected")).toBe(3);
  });

  it("another laboratory scope: refused", () => {
    const db = testDb();
    must1(db);
    setSetting(db, "lab_scope", "lab:other-site");
    const res = run(db, STAFF.maya, "clarification.create", input(), KEY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("the owner who has since lost the permission cannot read the stored result", () => {
    const db = testDb();
    must1(db);
    db.prepare("UPDATE staff SET role = 'director' WHERE id = ?").run(STAFF.maya);
    const res = run(db, STAFF.maya, "clarification.create", input(), KEY);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("FORBIDDEN");
      expect(JSON.stringify(res)).not.toContain("clarificationId");
    }
  });

  it("an expired key is refused and never re-run", () => {
    const db = testDb();
    must1(db);
    const count = clarifications(db);
    db.prepare("UPDATE command_receipt SET expires_at = ? WHERE idempotency_key = ?").run(new Date(Date.now() - 1000).toISOString(), KEY);
    const res = run(db, STAFF.maya, "clarification.create", input(), KEY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("IDEMPOTENCY_EXPIRED");
    expect(clarifications(db)).toBe(count);
  });

  it("a receipt written before scoped receipts (no fingerprint) cannot be replayed", () => {
    const db = testDb();
    db.prepare("INSERT INTO command_receipt (idempotency_key, command, actor_id, result_json, at) VALUES (?, ?, ?, ?, ?)").run(
      "legacy-key-0001", "clarification.create", STAFF.maya, JSON.stringify({ clarificationId: "secret" }), "2026-10-14T15:00:00.000Z",
    );
    const res = run(db, STAFF.maya, "clarification.create", input(), "legacy-key-0001");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(JSON.stringify(res)).not.toContain("secret");
  });

  it("receipts record owner, scope, fingerprint, correlation and a bounded lifetime", () => {
    const db = testDb();
    const res = executeCommand(db, STAFF.maya, "clarification.create", input(), { idempotencyKey: KEY, correlationId: "req-test-0001" });
    expect(res.ok).toBe(true);
    const r = one<{ actor_id: string; scope: string; request_hash: string; correlation_id: string; created_at: string; expires_at: string }>(
      db, "SELECT * FROM command_receipt WHERE idempotency_key = ?", KEY,
    );
    expect(r.actor_id).toBe(STAFF.maya);
    expect(r.scope).toBe("lab:local");
    expect(r.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(r.expires_at) - Date.parse(r.created_at)).toBe(RECEIPT_TTL_MS);
    // The receipt and every audit event of the request share the request's correlation id.
    expect(r.correlation_id).toBe("req-test-0001");
    expect(all<{ correlation_id: string }>(db, "SELECT correlation_id FROM audit_event WHERE correlation_id = 'req-test-0001'").length).toBeGreaterThan(0);
  });

  it("malformed keys are refused, never truncated into another key", () => {
    const db = testDb();
    for (const bad of ["x".repeat(201), "has space key", "semi;colon;key", "quote\"key"]) {
      const res = run(db, STAFF.maya, "clarification.create", input(), bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION");
    }
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM command_receipt").n).toBe(0);
  });
});

describe("idempotency: failures and concurrency", () => {
  it("a handler that fails part-way leaves no writes and no receipt; the same key then runs once", () => {
    let fail = true;
    defineCommand({
      name: "test.partialWrite",
      description: "test only",
      permission: null,
      input: z.object({ v: z.string() }),
      run: (ctx, i) => {
        ctx.db.prepare("INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)").run(`test_${i.v}`, "written", ctx.now);
        if (fail) throw new Error("INVARIANT: interrupted after the first write");
        return { wrote: i.v };
      },
    });
    const db = testDb();
    const first = run(db, STAFF.maya, "test.partialWrite", { v: "a" }, "partial-key-1");
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.message).toBe("interrupted after the first write");
    expect(one(db, "SELECT value FROM app_setting WHERE key = 'test_a'")).toBeUndefined();
    expect(one(db, "SELECT 1 FROM command_receipt WHERE idempotency_key = 'partial-key-1'")).toBeUndefined();
    fail = false;
    const second = run(db, STAFF.maya, "test.partialWrite", { v: "a" }, "partial-key-1");
    expect(second.ok && !second.replayed).toBe(true);
    const third = run(db, STAFF.maya, "test.partialWrite", { v: "a" }, "partial-key-1");
    expect(third.ok && third.replayed).toBe(true);
    expect(all(db, "SELECT 1 FROM app_setting WHERE key = 'test_a'")).toHaveLength(1);
  });

  it("two connections, one key: the lookup and the write share one write lock, so the request runs once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-idem-"));
    const file = path.join(dir, "db.sqlite");
    const seedConn = openDatabase(file);
    seedDemo(seedConn, { clockRunning: false });
    seedConn.close();
    const a = openDatabase(file);
    const b = openDatabase(file);
    a.pragma("busy_timeout = 50");
    try {
      const start = clarifications(a);
      // Connection B holds the write lock (another request mid-transaction).
      b.prepare("BEGIN IMMEDIATE").run();
      const blocked = run(a, STAFF.maya, "clarification.create", input(), KEY);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.code).toBe("CONFLICT");
      expect(clarifications(b)).toBe(start); // nothing was written by A
      b.prepare("ROLLBACK").run();

      const onA = run(a, STAFF.maya, "clarification.create", input(), KEY);
      const onB = run(b, STAFF.maya, "clarification.create", input(), KEY);
      expect(onA.ok && !onA.replayed).toBe(true);
      expect(onB.ok && onB.replayed).toBe(true);
      expect(clarifications(a)).toBe(start + 1);
    } finally {
      a.close();
      b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("actors and modes", () => {
  it("a user request can never act as the internal system actor", () => {
    const db = testDb();
    const res = executeCommand(db, "system", "clarification.create", input());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    expect(clarifications(db)).toBe(one<{ n: number }>(db, "SELECT COUNT(*) n FROM clarification").n);
  });

  it("an unknown or inactive staff id is refused", () => {
    const db = testDb();
    for (const who of ["stf_nobody", "admin", "root"]) {
      const res = executeCommand(db, who, "clarification.create", input());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    }
  });

  it("outside synthetic demo mode every user command is refused (no identity provider exists)", () => {
    const db = testDb();
    const count = clarifications(db);
    for (const mode of ["production", "locked", "pilot"]) {
      process.env.HLOS_MODE = mode;
      const res = executeCommand(db, STAFF.tanya, "clarification.create", input());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("AUTH_REQUIRED");
    }
    expect(clarifications(db)).toBe(count);
  });

  it("HTTP: a locked build refuses commands (401), the role switch (403) and the demo reset (404)", async () => {
    process.env.HLOS_MODE = "locked";
    const { POST: command } = await import("@/app/api/commands/[name]/route");
    const { POST: session } = await import("@/app/api/session/route");
    const { POST: reset } = await import("@/app/api/demo/reset/route");
    const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", cookie: "hlos_actor=stf_tanya" }, body: JSON.stringify(body) });
    const c = await command(new Request("http://localhost/api/commands/clarification.create", json({ input: input(), idempotencyKey: KEY })), {
      params: Promise.resolve({ name: "clarification.create" }),
    });
    expect(c.status).toBe(401);
    expect(((await c.json()) as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
    const s = await session(new Request("http://localhost/api/session", json({ staffId: "stf_tanya" })));
    expect(s.status).toBe(403);
    const r = await reset(new Request("http://localhost/api/demo/reset", json({ confirm: true })));
    expect(r.status).toBe(404);
  });

  it("HTTP in demo mode: the actor comes from the demo cookie and the response carries the correlation id", async () => {
    const { actorIdFromRequest, correlationIdFor } = await import("@/server/session");
    const req = (cookie: string, rid?: string) => new Request("http://localhost/x", { headers: { cookie, ...(rid ? { "x-request-id": rid } : {}) } });
    expect(actorIdFromRequest(req("a=1; hlos_actor=stf_kim"))).toBe("stf_kim");
    expect(actorIdFromRequest(req("hlos_actor=../../etc"))).toBe("stf_maya");
    expect(correlationIdFor(req("", "req-abcdef12"))).toBe("req-abcdef12");
    expect(correlationIdFor(req("", "bad id"))).toMatch(/^req-[0-9a-f-]{36}$/);
  });
});

function must1(db: DB) {
  const r = run(db, STAFF.maya, "clarification.create", input(), KEY);
  expect(r.ok).toBe(true);
}

describe("presenter controls and read-only GETs", () => {
  it("a presenter control is recorded with origin 'demo' whoever presses it, never as a laboratory action", () => {
    const db = testDb();
    const res = executeCommand(db, STAFF.director, "demo.setClock", { advanceMinutes: 5 });
    expect(res.ok).toBe(true);
    const row = one<{ origin: string; actor_id: string }>(db, "SELECT origin, actor_id FROM audit_event ORDER BY seq DESC LIMIT 1");
    expect(row.origin).toBe("demo");
    expect(row.actor_id).toBe(STAFF.director);
    // A laboratory command by the same read-only role is still refused.
    const lab = executeCommand(db, STAFF.director, "clarification.create", input());
    expect(lab.ok).toBe(false);
    if (!lab.ok) expect(lab.error.code).toBe("FORBIDDEN");
  });

  it("GET /api/live never runs the simulated sources outside demo mode, and does in demo mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-live-"));
    const savedDb = process.env.HLOS_DB_PATH;
    process.env.HLOS_DB_PATH = path.join(dir, "live.sqlite");
    const seeded = openDatabase(process.env.HLOS_DB_PATH);
    seedDemo(seeded, { clockRunning: false });
    seeded.close();
    try {
      const { GET } = await import("@/app/api/live/route");
      pumpCalls.length = 0;
      process.env.HLOS_MODE = "locked";
      expect((await GET()).status).toBe(200);
      expect(pumpCalls).toHaveLength(0);
      process.env.HLOS_MODE = "demo";
      await GET();
      expect(pumpCalls).toHaveLength(1);
    } finally {
      const { closeSharedDb } = await import("@/server/db/db");
      closeSharedDb();
      process.env.HLOS_DB_PATH = savedDb;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
