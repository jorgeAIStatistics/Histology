import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { closeSharedDb, getDb, openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { defineCommand } from "@/server/commands/registry";
import { audit } from "@/server/core/audit";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import {
  activeAuditKey,
  appendAnchor,
  AUDIT_COLUMNS,
  AuditAnchorError,
  auditReport,
  canonicalEvent,
  computeMac,
  demoAuditKey,
  exportAnchor,
  genesisMac,
  readAnchorFile,
  sealPending,
  verifyAuditChain,
  type AuditKeyConfig,
} from "@/server/core/audit-seal";
import { auditKeyFromEnv, DEMO_AUDIT_KEY_TEXT } from "@/server/auth/config";
import { lockedReason, runtimeMode } from "@/server/runtime-mode";
import { createSession, sessionPolicyFromEnv } from "@/server/auth/sessions";
import { linkIdentity } from "@/server/auth/admin";
import { POST as verifyPOST } from "@/app/api/audit/verify/route";
import { all, one, run, STAFF, testDb } from "../helpers";

// Stage 6 Phase C1: the tamper-evident audit seal. Every tamper below is made the way someone with write access to
// the database FILE would make it (dropping the append-only triggers, turning foreign keys off, editing rows
// directly), never through the application. Synthetic data only.

const ROOT = path.resolve(import.meta.dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const DEMO = demoAuditKey();
const EVENT_TRIGGERS = ["audit_event_no_update", "audit_event_no_delete"];
const SEAL_TRIGGERS = ["audit_seal_no_update", "audit_seal_no_delete", "audit_seal_in_order"];

const ORDER_B = "ord_ord_77121";
const PART_B = "ord_ord_77121_b";
const clarification = (n: number) => ({
  category: "laterality",
  refs: { sourceOrderId: ORDER_B, orderPartId: PART_B },
  subjectLabel: "Part B · ORD-77121",
  question: `Which side is correct for part B? (synthetic ${n})`,
  evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", requisition_value: null, source: "bottle label (staff entry)" }],
  priority: "high",
});

const counts = (db: DB) => one<{ events: number; seals: number; head: number }>(
  db,
  "SELECT (SELECT COUNT(*) FROM audit_event) events, (SELECT COUNT(*) FROM audit_seal) seals, (SELECT COALESCE(MAX(seq), 0) FROM audit_event) head",
);
const dropTriggers = (db: DB, names: string[]) => {
  for (const n of names) db.exec(`DROP TRIGGER IF EXISTS ${n}`);
};
const verify = (db: DB, key: AuditKeyConfig = DEMO, anchors?: Parameters<typeof verifyAuditChain>[1]["anchors"]) => verifyAuditChain(db, { key, anchors });

/** Recompute the seals from `fromSeq` to the end with `key` (labelled `keyId`), the way someone with the file and a key would. */
function resealFrom(db: DB, fromSeq: number, key: Buffer, keyId: string): void {
  dropTriggers(db, SEAL_TRIGGERS);
  const before = db.prepare("SELECT mac FROM audit_seal WHERE seq < ? ORDER BY seq DESC LIMIT 1").get(fromSeq) as { mac: string } | undefined;
  let prev = before?.mac ?? genesisMac(db);
  const rows = db.prepare(`SELECT ${AUDIT_COLUMNS.join(", ")} FROM audit_event WHERE seq >= ? ORDER BY seq`).all(fromSeq) as Record<string, unknown>[];
  const update = db.prepare("UPDATE audit_seal SET prev_mac = ?, mac = ?, key_id = ? WHERE seq = ?");
  for (const r of rows) {
    const mac = computeMac(key, prev, canonicalEvent(r));
    update.run(prev, mac, keyId, r.seq);
    prev = mac;
  }
}

/** A seeded database with some live activity on top of the seed. */
function busyDb(): DB {
  const db = testDb();
  for (let i = 0; i < 6; i++) expect(run(db, STAFF.maya, "clarification.create", clarification(i)).ok).toBe(true);
  return db;
}

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-seal-"));
});
afterEach(() => {
  closeSharedDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ sealing

describe("sealing: every event, in seq order, in the same transaction", () => {
  it("the seeded day (direct inserts) is sealed under the labelled PUBLIC demo key, chained from the lab's genesis", () => {
    const db = testDb();
    const c = counts(db);
    expect(c.events).toBeGreaterThan(50);
    expect(c.seals).toBe(c.events);
    const seals = all<{ seq: number; event_id: string; prev_mac: string; mac: string; key_id: string }>(db, "SELECT * FROM audit_seal ORDER BY seq");
    expect(seals[0].prev_mac).toBe("genesis:lab:local");
    for (let i = 1; i < seals.length; i++) expect(seals[i].prev_mac).toBe(seals[i - 1].mac);
    expect(new Set(seals.map((s) => s.key_id))).toEqual(new Set(["demo-not-secret"]));
    expect(DEMO).toMatchObject({ id: "demo-not-secret", demo: true });
    const v = verify(db);
    expect(v).toMatchObject({ ok: true, checked: c.events, sealedThrough: c.head, firstProblem: null, demoKey: true, keyId: "demo-not-secret" });
  });

  it("each command's events are sealed inside its own transaction; a rolled-back command leaves neither event nor seal", () => {
    defineCommand({
      name: "test.auditThenFail",
      description: "test only",
      permission: null,
      input: z.object({}),
      run: (ctx) => {
        audit(ctx, { action: "test.written_then_rolled_back", entityType: "test", entityId: "t1", summary: "rolled back" });
        throw new Error("INVARIANT: fails after auditing");
      },
    });
    const db = testDb();
    for (let i = 0; i < 5; i++) {
      expect(run(db, STAFF.maya, "clarification.create", clarification(i)).ok).toBe(true);
      const c = counts(db);
      expect(c.seals, "no event is ever left unsealed after a command").toBe(c.events);
    }
    const before = counts(db);
    expect(run(db, STAFF.maya, "test.auditThenFail", {}).ok).toBe(false);
    expect(counts(db)).toEqual(before);
    expect(verify(db).ok).toBe(true);
  });

  it("audit() outside any transaction seals in its own IMMEDIATE transaction", () => {
    const db = testDb();
    expect(db.inTransaction).toBe(false);
    audit(makeCtx(db, SYSTEM_ACTOR, "system", "seal-outside-tx"), { action: "test.outside", entityType: "test", entityId: "t2", summary: "outside a transaction" });
    const last = one<{ seq: number; id: string }>(db, "SELECT seq, id FROM audit_event ORDER BY seq DESC LIMIT 1");
    expect(one<{ event_id: string }>(db, "SELECT event_id FROM audit_seal WHERE seq = ?", last.seq).event_id).toBe(last.id);
    expect(verify(db).ok).toBe(true);
  });

  it("a clean chain verifies after many commands from two connections and two processes on one database file", async () => {
    const file = path.join(tmp, "two.db");
    const seed = openDatabase(file);
    seedDemo(seed, { clockRunning: false });
    seed.close();
    const a = openDatabase(file);
    const b = openDatabase(file);
    try {
      // Two connections, alternating.
      for (let i = 0; i < 20; i++) expect(run(i % 2 ? a : b, STAFF.maya, "clarification.create", clarification(i)).ok).toBe(true);

      // Another process writes at the same time: commands and direct audit() calls outside any transaction.
      const go = path.join(tmp, "go");
      const child = path.join(tmp, "child.ts");
      fs.writeFileSync(
        child,
        `import fs from "node:fs";
import { openDatabase } from ${JSON.stringify(path.join(ROOT, "src/server/db/db"))};
import { audit } from ${JSON.stringify(path.join(ROOT, "src/server/core/audit"))};
import { makeCtx, SYSTEM_ACTOR } from ${JSON.stringify(path.join(ROOT, "src/server/core/context"))};
import { executeCommand } from ${JSON.stringify(path.join(ROOT, "src/server/commands"))};
const db = openDatabase(process.env.HLOS_DB_PATH!);
const input = ${JSON.stringify(clarification(999))};
console.log("ready");
const sleep = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 2);
let ok = 0;
for (let i = 0; i < 40; i++) {
  if (executeCommand(db, "stf_maya", "clarification.create", { ...input, question: "Which side is correct for part B? (another process " + i + ")" }).ok) ok++;
  audit(makeCtx(db, SYSTEM_ACTOR, "system", "child-" + i), { action: "test.child_process", entityType: "test", entityId: "child-" + i, summary: "written by another process" });
  Atomics.wait(sleep, 0, 0, 1); // let the other process take the write lock too
}
db.close();
console.log("done " + ok);
`,
      );
      const proc = spawn(TSX, [child], { cwd: ROOT, env: { ...process.env, HLOS_MODE: "demo", HLOS_DB_PATH: file }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out += String(d)));
      proc.stderr.on("data", (d) => (err += String(d)));
      const exited = new Promise<number | null>((resolve) => proc.on("close", resolve));
      await new Promise<void>((resolve, reject) => {
        const t = setInterval(() => {
          if (out.includes("ready")) (clearInterval(t), resolve());
          else if (proc.exitCode !== null) (clearInterval(t), reject(new Error(`child exited early: ${err}`)));
        }, 10);
      });
      fs.writeFileSync(go, "1");
      for (let i = 0; i < 40; i++) {
        expect(run(i % 2 ? a : b, STAFF.maya, "clarification.create", clarification(100 + i)).ok).toBe(true);
        audit(makeCtx(a, SYSTEM_ACTOR, "system", `parent-${i}`), { action: "test.parent_process", entityType: "test", entityId: `parent-${i}`, summary: "written by this process" });
        // SQLite's busy handler is not fair: without a pause one process would take every write in turn.
        await new Promise((r) => setTimeout(r, 2));
      }
      expect(await exited, err).toBe(0);
      expect(out).toContain("done 40");

      const c = counts(a);
      expect(one<{ n: number }>(a, "SELECT COUNT(*) n FROM audit_event WHERE action = 'test.child_process'").n).toBe(40);
      expect(one<{ n: number }>(a, "SELECT COUNT(*) n FROM audit_event WHERE action = 'test.parent_process'").n).toBe(40);
      expect(c.seals).toBe(c.events);
      for (const conn of [a, b]) expect(verify(conn)).toMatchObject({ ok: true, checked: c.events, sealedThrough: c.head, firstProblem: null });
    } finally {
      a.close();
      b.close();
    }
  }, 60_000);

  it("the canonical form covers every audit_event column, in a fixed order", () => {
    const db = testDb();
    const cols = all<{ name: string }>(db, "PRAGMA table_info(audit_event)").map((c) => c.name);
    expect([...cols].sort()).toEqual([...AUDIT_COLUMNS].sort());
    expect(AUDIT_COLUMNS.slice(-3)).toEqual(["permission", "session_ref", "source_ref"]);
    const row = one<Record<string, unknown>>(db, "SELECT * FROM audit_event ORDER BY seq LIMIT 1");
    expect(JSON.parse(canonicalEvent(row))).toEqual(AUDIT_COLUMNS.map((c) => row[c] ?? null));
  });

  it("the application cannot update, delete or back-fill a seal (triggers)", () => {
    const db = testDb();
    const last = one<{ seq: number }>(db, "SELECT MAX(seq) seq FROM audit_seal").seq;
    expect(() => db.prepare("UPDATE audit_seal SET mac = 'x' WHERE seq = ?").run(last)).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_seal WHERE seq = ?").run(last)).toThrow(/append-only/);
    expect(() => db.prepare("INSERT INTO audit_seal (seq, event_id, prev_mac, mac, key_id, sealed_at) VALUES (?, 'x', 'p', 'm', 'k', 't')").run(last - 1)).toThrow();
  });

  it("locked without a key: events stay unsealed (reported), and the next write with a key seals them in seq order", () => {
    const db = testDb();
    const saved = { mode: process.env.HLOS_MODE, key: process.env.HLOS_AUDIT_KEY };
    try {
      process.env.HLOS_MODE = "locked";
      delete process.env.HLOS_AUDIT_KEY;
      expect(activeAuditKey()).toBeNull();
      audit(makeCtx(db, SYSTEM_ACTOR, "system", "locked-1"), { action: "test.locked", entityType: "test", entityId: "l1", summary: "no key" });
      audit(makeCtx(db, SYSTEM_ACTOR, "system", "locked-2"), { action: "test.locked", entityType: "test", entityId: "l2", summary: "no key" });
      const c = counts(db);
      expect(c.seals).toBe(c.events - 2);
      expect(verify(db).firstProblem).toMatchObject({ seq: c.head - 1, kind: "unsealed_tail" });
    } finally {
      for (const [k, v] of [["HLOS_MODE", saved.mode], ["HLOS_AUDIT_KEY", saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(sealPending(db)).toMatchObject({ sealed: 2 });
    expect(verify(db).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ tampering

describe("tampering by someone with file access is detected", () => {
  it("an edited event: event_modified at its seq", () => {
    const db = busyDb();
    const mid = Math.floor(counts(db).head / 2);
    dropTriggers(db, EVENT_TRIGGERS);
    db.prepare("UPDATE audit_event SET reason = 'edited afterwards' WHERE seq = ?").run(mid);
    expect(verify(db)).toMatchObject({ ok: false, checked: mid - 1, sealedThrough: mid - 1, firstProblem: { seq: mid, kind: "event_modified" } });
  });

  it("an edit of any single column is detected (every column is covered)", () => {
    for (const col of AUDIT_COLUMNS.filter((c) => c !== "seq" && c !== "id")) {
      const db = busyDb();
      const target = counts(db).head - 2;
      dropTriggers(db, EVENT_TRIGGERS);
      db.prepare(`UPDATE audit_event SET ${col} = COALESCE(${col}, '') || 'x' WHERE seq = ?`).run(target);
      expect(verify(db).firstProblem, col).toMatchObject({ seq: target, kind: "event_modified" });
    }
  });

  it("a deleted event: event_missing (and with its seal also deleted: chain_broken at the next event)", () => {
    const db = busyDb();
    const mid = Math.floor(counts(db).head / 2);
    dropTriggers(db, EVENT_TRIGGERS);
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM audit_event WHERE seq = ?").run(mid);
    expect(verify(db).firstProblem).toMatchObject({ seq: mid, kind: "event_missing" });

    dropTriggers(db, SEAL_TRIGGERS);
    db.prepare("DELETE FROM audit_seal WHERE seq = ?").run(mid);
    expect(verify(db).firstProblem).toMatchObject({ seq: mid + 1, kind: "chain_broken" });
  });

  it("swapped rows: reordered", () => {
    const db = busyDb();
    const head = counts(db).head;
    const [x, y] = [head - 5, head - 2];
    dropTriggers(db, EVENT_TRIGGERS);
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE audit_event SET seq = -1 WHERE seq = ?").run(x);
    db.prepare("UPDATE audit_event SET seq = ? WHERE seq = ?").run(x, y);
    db.prepare("UPDATE audit_event SET seq = ? WHERE seq = -1").run(y);
    expect(verify(db).firstProblem).toMatchObject({ seq: x, kind: "reordered" });

    // The same rows swapped together with their seals: the links no longer hold.
    const db2 = busyDb();
    dropTriggers(db2, [...EVENT_TRIGGERS, ...SEAL_TRIGGERS]);
    db2.pragma("foreign_keys = OFF");
    for (const t of ["audit_event", "audit_seal"]) {
      db2.prepare(`UPDATE ${t} SET seq = -1 WHERE seq = ?`).run(x);
      db2.prepare(`UPDATE ${t} SET seq = ? WHERE seq = ?`).run(x, y);
      db2.prepare(`UPDATE ${t} SET seq = ? WHERE seq = -1`).run(y);
    }
    expect(verify(db2).firstProblem).toMatchObject({ seq: x, kind: "chain_broken" });
  });

  it("a forged seal without the key: seal_forged, whether one seal or the whole rest of the chain was recomputed", () => {
    const wrong = crypto.randomBytes(32);
    const db = busyDb();
    const target = counts(db).head - 4;
    dropTriggers(db, [...EVENT_TRIGGERS, ...SEAL_TRIGGERS]);
    db.prepare("UPDATE audit_event SET summary = 'rewritten' WHERE seq = ?").run(target);
    const prev = one<{ prev_mac: string }>(db, "SELECT prev_mac FROM audit_seal WHERE seq = ?", target).prev_mac;
    const row = one<Record<string, unknown>>(db, `SELECT ${AUDIT_COLUMNS.join(", ")} FROM audit_event WHERE seq = ?`, target);
    db.prepare("UPDATE audit_seal SET mac = ? WHERE seq = ?").run(computeMac(wrong, prev, canonicalEvent(row)), target);
    expect(verify(db).firstProblem).toMatchObject({ seq: target, kind: "seal_forged" });

    const db2 = busyDb();
    dropTriggers(db2, EVENT_TRIGGERS);
    db2.prepare("UPDATE audit_event SET summary = 'rewritten' WHERE seq = ?").run(target);
    resealFrom(db2, target, wrong, DEMO.id); // a consistent chain, under the wrong key, with the right key id copied
    expect(verify(db2).firstProblem).toMatchObject({ seq: target, kind: "seal_forged" });
  });

  it("a seal removed in the middle is seal_missing; a row slipped in at the end without a seal is unsealed_tail", () => {
    const db = busyDb();
    const target = counts(db).head - 3;
    dropTriggers(db, SEAL_TRIGGERS);
    db.prepare("DELETE FROM audit_seal WHERE seq = ?").run(target);
    expect(verify(db).firstProblem).toMatchObject({ seq: target, kind: "seal_missing" });

    const db2 = busyDb();
    db2.prepare(
      `INSERT INTO audit_event (id, at, recorded_at, actor_id, actor_role, origin, action, entity_type, entity_id, summary, correlation_id)
       VALUES ('aud_slipped_in', '2026-10-14T15:00:00.000Z', '2026-10-14T15:00:00.000Z', 'stf_kim', 'accessioning_lead', 'user', 'hold.released', 'hold', 'h1', 'slipped in', 'x')`,
    ).run();
    const head = counts(db2).head;
    expect(verify(db2)).toMatchObject({ ok: false, sealedThrough: head - 1, firstProblem: { seq: head, kind: "unsealed_tail" } });
  });

  it("the newest events deleted with their seals: event_missing (autoincrement tripwire), and only an anchor catches it once the counter is reset too", () => {
    const db = busyDb();
    const anchorFile = path.join(tmp, "anchors", "a.jsonl");
    fs.mkdirSync(path.dirname(anchorFile));
    appendAnchor(db, { key: DEMO, file: anchorFile });
    const head = counts(db).head;
    dropTriggers(db, [...EVENT_TRIGGERS, ...SEAL_TRIGGERS]);
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM audit_seal WHERE seq > ?").run(head - 3);
    db.prepare("DELETE FROM audit_event WHERE seq > ?").run(head - 3);
    expect(verify(db).firstProblem).toMatchObject({ seq: head - 2, kind: "event_missing" });
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_event'").run(head - 3);
    expect(verify(db).ok).toBe(true); // the limitation: a clean truncation is invisible without an anchor
    expect(verify(db, DEMO, readAnchorFile(anchorFile)).firstProblem).toMatchObject({ seq: head, kind: "anchor_mismatch" });
  });

  it("an insider WITH the key rewrites history: invisible without anchors, caught by an anchor exported before the rewrite, invisible after the newest anchor", () => {
    const db = busyDb();
    const anchorFile = path.join(tmp, "elsewhere", "anchors.jsonl");
    fs.mkdirSync(path.dirname(anchorFile));
    const { anchor } = appendAnchor(db, { key: DEMO, file: anchorFile });
    for (let i = 0; i < 3; i++) expect(run(db, STAFF.maya, "clarification.create", clarification(50 + i)).ok).toBe(true);
    const anchors = readAnchorFile(anchorFile);
    expect(anchors).toEqual([anchor]);
    expect(Object.keys(anchor).sort()).toEqual(["at", "key_id", "lab", "mac", "seq"]);
    expect(verify(db, DEMO, anchors)).toMatchObject({ ok: true, anchorsChecked: 1 });

    const target = anchor.seq - 10;
    dropTriggers(db, EVENT_TRIGGERS);
    db.prepare("UPDATE audit_event SET reason = 'history rewritten by an insider' WHERE seq = ?").run(target);
    resealFrom(db, target, DEMO.key, DEMO.id);
    expect(verify(db).ok).toBe(true); // a database-only chain cannot see this
    expect(verify(db, DEMO, anchors)).toMatchObject({ ok: false, firstProblem: { seq: anchor.seq, kind: "anchor_mismatch" } });

    // After the newest anchor, the same rewrite is NOT detected (documented limitation).
    const db2 = busyDb();
    const file2 = path.join(tmp, "elsewhere", "anchors2.jsonl");
    const { anchor: a2 } = appendAnchor(db2, { key: DEMO, file: file2 });
    for (let i = 0; i < 3; i++) expect(run(db2, STAFF.maya, "clarification.create", clarification(60 + i)).ok).toBe(true);
    dropTriggers(db2, EVENT_TRIGGERS);
    db2.prepare("UPDATE audit_event SET reason = 'rewritten after the anchor' WHERE seq = ?").run(a2.seq + 1);
    resealFrom(db2, a2.seq + 1, DEMO.key, DEMO.id);
    expect(verify(db2, DEMO, readAnchorFile(file2)).ok).toBe(true);
  });

  it("verifying with another key reports seal_forged at the first seal and names both key ids", () => {
    const db = testDb();
    const other: AuditKeyConfig = { id: "k-other", key: crypto.randomBytes(32), demo: false };
    const v = verify(db, other);
    expect(v.firstProblem).toMatchObject({ seq: 1, kind: "seal_forged" });
    expect(v.firstProblem?.detail).toContain("demo-not-secret");
    expect(v.firstProblem?.detail).toContain("k-other");
  });
});

// ------------------------------------------------------------------ anchors

describe("anchors", () => {
  it("need HLOS_AUDIT_ANCHOR_PATH outside the database's directory, and are only written for a chain that verifies", () => {
    const dbDir = path.join(tmp, "db");
    fs.mkdirSync(path.join(dbDir, "sub"), { recursive: true });
    const file = path.join(dbDir, "lab.db");
    const db = openDatabase(file);
    seedDemo(db, { clockRunning: false });
    const saved = process.env.HLOS_AUDIT_ANCHOR_PATH;
    try {
      delete process.env.HLOS_AUDIT_ANCHOR_PATH;
      expect(() => appendAnchor(db, { key: DEMO })).toThrow(/HLOS_AUDIT_ANCHOR_PATH is not set/);
      for (const inside of [path.join(dbDir, "a.jsonl"), path.join(dbDir, "sub", "a.jsonl"), path.join(dbDir, "missing", "deeper", "a.jsonl")]) {
        expect(() => appendAnchor(db, { key: DEMO, file: inside }), inside).toThrow(/inside the database's directory/);
      }
      // A symbolic link that leads back into the database's directory is refused too.
      fs.symlinkSync(dbDir, path.join(tmp, "link"));
      expect(() => appendAnchor(db, { key: DEMO, file: path.join(tmp, "link", "a.jsonl") })).toThrow(/inside the database's directory/);

      const outside = path.join(tmp, "anchors.jsonl");
      process.env.HLOS_AUDIT_ANCHOR_PATH = outside;
      const r = appendAnchor(db, { key: DEMO });
      expect(r.anchor).toEqual(readAnchorFile(outside)[0]);
      expect(r.anchor).toMatchObject({ lab: "lab:local", seq: counts(db).head, key_id: "demo-not-secret" });
      expect(r.anchor.mac).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readFileSync(outside, "utf8").trim().split("\n")).toHaveLength(1);

      // A chain that does not verify is never anchored.
      dropTriggers(db, EVENT_TRIGGERS);
      db.prepare("UPDATE audit_event SET summary = 'x' WHERE seq = 3").run();
      expect(() => appendAnchor(db, { key: DEMO })).toThrow(AuditAnchorError);
      expect(readAnchorFile(outside)).toHaveLength(1);
      // A malformed anchor file fails closed.
      fs.appendFileSync(outside, "not json\n");
      expect(() => readAnchorFile(outside)).toThrow(/malformed line \(2\)/);
      expect(auditReport(db, DEMO)).toMatchObject({ ok: false, anchorFile: { configured: true, error: expect.stringMatching(/malformed/) } });
    } finally {
      if (saved === undefined) delete process.env.HLOS_AUDIT_ANCHOR_PATH;
      else process.env.HLOS_AUDIT_ANCHOR_PATH = saved;
      db.close();
    }
  });

  it("exportAnchor gives the chain head", () => {
    const db = testDb();
    const head = one<{ seq: number; mac: string; key_id: string }>(db, "SELECT seq, mac, key_id FROM audit_seal ORDER BY seq DESC LIMIT 1");
    expect(exportAnchor(db)).toMatchObject({ lab: "lab:local", seq: head.seq, mac: head.mac, key_id: head.key_id });
  });
});

// ------------------------------------------------------------------ keys and modes

const PUBLIC = "http://localhost:3999";
const securedEnv = (): Record<string, string> => ({
  HLOS_MODE: "secured",
  HLOS_OIDC_ISSUER: "http://127.0.0.1:9/nothing-listens-here",
  HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
  HLOS_OIDC_CLIENT_ID: "hlos-test-client",
  HLOS_OIDC_CLIENT_SECRET: crypto.randomBytes(24).toString("hex"),
  HLOS_PUBLIC_URL: PUBLIC,
  HLOS_LAB_ID: "lab:local",
  HLOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  HLOS_AUDIT_KEY: crypto.randomBytes(32).toString("hex"),
});
const ENV_KEYS = [...Object.keys(securedEnv()), "HLOS_AUDIT_KEY_ID", "HLOS_DB_PATH", "HLOS_AUDIT_ANCHOR_PATH"];

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("keys and modes", () => {
  it("secured mode without a valid HLOS_AUDIT_KEY is locked, naming the key and never its value", () => {
    const env = securedEnv();
    withEnv(env, () => expect(runtimeMode()).toBe("secured"));
    const cases: [string, string | undefined, string][] = [
      ["HLOS_AUDIT_KEY", undefined, "HLOS_AUDIT_KEY"],
      ["HLOS_AUDIT_KEY", "x".repeat(31), "HLOS_AUDIT_KEY"],
      ["HLOS_AUDIT_KEY", env.HLOS_SESSION_SECRET, "HLOS_AUDIT_KEY"], // one secret, one purpose
      ["HLOS_AUDIT_KEY", DEMO_AUDIT_KEY_TEXT, "HLOS_AUDIT_KEY"], // the public demo key is never a real key
      ["HLOS_AUDIT_KEY_ID", "has spaces", "HLOS_AUDIT_KEY_ID"],
      ["HLOS_AUDIT_KEY_ID", "demo-not-secret", "HLOS_AUDIT_KEY_ID"],
    ];
    for (const [key, value, named] of cases) {
      withEnv({ ...env, [key]: value }, () => {
        expect(runtimeMode(), `${key}=${value}`).toBe("locked");
        const reason = lockedReason();
        expect(reason).toEqual({ reason: "auth_misconfigured", keys: [named] });
        expect(JSON.stringify(reason)).not.toContain(env.HLOS_AUDIT_KEY);
        if (value) expect(JSON.stringify(reason)).not.toContain(value);
      });
    }
  });

  it("the key id is recorded on every seal, never the key; a deployment can name its key", () => {
    const env = securedEnv();
    withEnv(env, () => {
      const k = auditKeyFromEnv();
      expect(k.ok && k.key.id).toMatch(/^k-[0-9a-f]{12}$/);
      expect(activeAuditKey()?.id).toBe(k.ok ? k.key.id : null);
      const db = testDb(); // seeded in secured mode: sealed with HLOS_AUDIT_KEY
      expect(all<{ key_id: string }>(db, "SELECT DISTINCT key_id FROM audit_seal")).toEqual([{ key_id: k.ok ? k.key.id : "" }]);
      expect(JSON.stringify(all(db, "SELECT * FROM audit_seal"))).not.toContain(env.HLOS_AUDIT_KEY);
      expect(verifyAuditChain(db, { key: activeAuditKey()! }).ok).toBe(true);
      expect(verifyAuditChain(db, { key: DEMO }).firstProblem).toMatchObject({ seq: 1, kind: "seal_forged" });
    });
    withEnv({ ...env, HLOS_AUDIT_KEY_ID: "lab-local-2026-10" }, () => expect(activeAuditKey()?.id).toBe("lab-local-2026-10"));
  });
});

// ------------------------------------------------------------------ CLI and API

describe("npm run audit:verify / audit:anchor (scripts/audit.ts)", () => {
  const cli = (args: string[], env: Record<string, string | undefined>) => {
    const r = spawnSync(TSX, ["scripts/audit.ts", ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("prints a summary with no event content, exits 0 when intact, 1 on a problem, 2 without a usable key or anchor path", () => {
    const dbDir = path.join(tmp, "db");
    fs.mkdirSync(dbDir);
    const file = path.join(dbDir, "cli.db");
    const db = openDatabase(file);
    seedDemo(db, { clockRunning: false });
    const summaries = all<{ summary: string }>(db, "SELECT summary FROM audit_event").map((r) => r.summary);
    const demo = { HLOS_MODE: "demo", HLOS_DB_PATH: file, HLOS_AUDIT_ANCHOR_PATH: undefined };

    const ok = cli(["verify"], demo);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toMatch(/Audit chain: VERIFIED/);
    expect(ok.out).toMatch(/demo-not-secret \(the PUBLIC demo key: these seals prove nothing\)/);

    const anchors = path.join(tmp, "anchors.jsonl");
    expect(cli(["anchor"], { ...demo, HLOS_AUDIT_ANCHOR_PATH: path.join(dbDir, "a.jsonl") }).code).toBe(2);
    const anchored = cli(["anchor"], { ...demo, HLOS_AUDIT_ANCHOR_PATH: anchors });
    expect(anchored.code, anchored.out).toBe(0);
    expect(readAnchorFile(anchors)).toHaveLength(1);

    const marker = "SYNTHETIC-PATIENT-NAME-MUST-NOT-PRINT";
    dropTriggers(db, EVENT_TRIGGERS);
    db.prepare("UPDATE audit_event SET summary = ? WHERE seq = 7").run(marker);
    db.close();
    const bad = cli(["verify"], { ...demo, HLOS_AUDIT_ANCHOR_PATH: anchors });
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toMatch(/FAILED at seq 7: event_modified/);
    const json = cli(["verify", "--json"], demo);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, firstProblem: { seq: 7, kind: "event_modified" } });
    for (const out of [ok.out, anchored.out, bad.out, json.out]) {
      expect(out).not.toContain(marker);
      for (const s of summaries) if (s.length > 12) expect(out).not.toContain(s);
    }

    const noKey = cli(["verify"], { HLOS_MODE: "locked", HLOS_DB_PATH: file, HLOS_AUDIT_KEY: undefined });
    expect(noKey.code).toBe(2);
    expect(noKey.out).toMatch(/HLOS_AUDIT_KEY is missing or invalid/);
    expect(cli(["verify"], { ...demo, HLOS_DB_PATH: path.join(tmp, "nope.db") }).code).toBe(2);
    expect(fs.existsSync(path.join(tmp, "nope.db"))).toBe(false); // verification never creates a database
  }, 120_000);
});

describe("POST /api/audit/verify", () => {
  const request = (opts: { cookie?: string; actor?: string; origin?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", origin: opts.origin ?? PUBLIC, host: new URL(PUBLIC).host };
    if (opts.cookie) headers.cookie = `hlos_session=${opts.cookie}`;
    if (opts.actor) headers["x-hlos-actor"] = opts.actor;
    return new Request(`${PUBLIC}/api/audit/verify`, { method: "POST", headers, body: "{}" });
  };

  it("secured: the auditor gets the verification and an evidence object with no event content, and the run is audited; other roles 403, no session 401", async () => {
    const file = path.join(tmp, "api.db");
    await withEnvAsync({ ...securedEnv(), HLOS_DB_PATH: file }, async () => {
      const db0 = openDatabase(file);
      seedDemo(db0, { clockRunning: false });
      db0.prepare("INSERT INTO staff (id, display_name, short_name, role, initials) VALUES ('stf_aud', 'Robin Auditor (synthetic)', 'Robin', 'auditor', 'RA')").run();
      db0.close();
      const db = getDb();
      const policy = sessionPolicyFromEnv()!;
      const signIn = (staffId: string) => {
        linkIdentity(db, { operator: "test", correlationId: "seal-test-link" }, { staffId, issuer: "https://idp.synthetic.test", subject: `sub-${staffId}`, labId: "lab:local" });
        return createSession(db, { staffId, labId: "lab:local", issuer: "https://idp.synthetic.test", subject: `sub-${staffId}`, authTimeMs: Date.now() }, policy).cookieValue;
      };
      const auditor = signIn("stf_aud");
      const maya = signIn("stf_maya");

      expect((await verifyPOST(request())).status).toBe(401);
      expect((await verifyPOST(request({ cookie: maya, actor: "stf_maya" }))).status).toBe(403);
      expect((await verifyPOST(request({ cookie: auditor, actor: "stf_maya" }))).status).toBe(409); // the page's actor must be the session's
      expect((await verifyPOST(request({ cookie: auditor, actor: "stf_aud", origin: "http://evil.example" }))).status).toBe(403);

      const before = counts(db);
      const res = await verifyPOST(request({ cookie: auditor, actor: "stf_aud" }));
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { ok: boolean; result: { ok: boolean; verification: { ok: boolean; checked: number; keyId: string; demoKey: boolean }; evidence: Record<string, unknown> } };
      expect(body.result).toMatchObject({ ok: true, verification: { ok: true, checked: before.events, keyId: activeAuditKey()!.id, demoKey: false } });
      expect(body.result.evidence).toMatchObject({ format: "hlos.audit-evidence/1", head: { seq: before.head }, ranges: [{ fromSeq: 1, toSeq: before.head, events: before.events }] });
      for (const r of all<{ summary: string }>(db, "SELECT summary FROM audit_event")) {
        if (r.summary.length > 12) expect(text).not.toContain(r.summary);
      }
      expect(text).not.toMatch(/Kettering|1974-07-2|503277/);

      const run1 = one<{ action: string; actor_id: string; permission: string; session_ref: string; after_json: string }>(db, "SELECT * FROM audit_event ORDER BY seq DESC LIMIT 1");
      expect(run1).toMatchObject({ action: "audit.verified", actor_id: "stf_aud", permission: "view.audit" });
      expect(run1.session_ref).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.parse(run1.after_json)).toMatchObject({ ok: true, checked: before.events });
      expect(verifyAuditChain(db, { key: activeAuditKey()! }).ok).toBe(true);
    });
  });

  it("demo: no demo role holds view.audit (403); the page and API exist only for the administrator and the auditor", async () => {
    const file = path.join(tmp, "demo.db");
    await withEnvAsync({ HLOS_MODE: "demo", HLOS_DB_PATH: file }, async () => {
      const db = openDatabase(file);
      seedDemo(db, { clockRunning: false });
      db.close();
      const res = await verifyPOST(new Request("http://localhost/api/audit/verify", { method: "POST", headers: { cookie: `hlos_actor=${STAFF.tanya}` }, body: "{}" }));
      expect(res.status).toBe(403);
    });
  });
});

async function withEnvAsync(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  closeSharedDb();
  try {
    await fn();
  } finally {
    closeSharedDb();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
