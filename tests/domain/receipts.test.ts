import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { executeCommand } from "@/server/commands";
import {
  compactExpiredReceipts,
  DEFAULT_TOMBSTONE_DAYS,
  ensureReceiptSchema,
  maybeRunReceiptMaintenance,
  OPPORTUNISTIC_INTERVAL_MS,
  purgeTombstones,
  RECEIPT_TTL_MS,
  receiptTombstoneDays,
  resetReceiptMaintenanceThrottle,
  runReceiptMaintenance,
} from "@/server/core/idempotency";
import { demoAuditKey, verifyAuditChain } from "@/server/core/audit-seal";
import { all, one, run, STAFF, testDb } from "../helpers";

// Stage 6 Phase C3: idempotency receipt maintenance. An expired receipt is compacted to a tombstone (its stored
// result cleared, its key kept and still refused); tombstones are purged after a retention. Synthetic data only.

const ROOT = path.resolve(import.meta.dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const DAY = 24 * 60 * 60 * 1000;
const ORDER_B = "ord_ord_77121";
const PART_B = "ord_ord_77121_b";
const input = (n = 0) => ({
  category: "laterality",
  refs: { sourceOrderId: ORDER_B, orderPartId: PART_B },
  subjectLabel: "Part B · ORD-77121",
  question: `Which side is correct for part B? (receipts ${n})`,
  evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", requisition_value: null, source: "bottle label (staff entry)" }],
  priority: "high",
});
/**
 * A command that does something visible EVERY time it runs (one worklist_snapshot row and one audit event; it
 * never de-duplicates), so "ran once" and "ran again" can be counted. Any bench role may run it.
 */
const SNAP = { view: "histotech", filters: {}, format: "csv" } as const;
const snapshots = (db: DB) => one<{ n: number }>(db, "SELECT COUNT(*) n FROM worklist_snapshot").n;
/** Audit events written under one correlation id: a command that ran writes at least one; a replay or a refusal of a key writes none of its own. */
const eventsOf = (db: DB, correlationId: string) => one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE correlation_id = ?", correlationId).n;
interface Receipt {
  idempotency_key: string;
  command: string;
  actor_id: string;
  scope: string;
  request_hash: string;
  result_json: string;
  correlation_id: string;
  at: string;
  created_at: string;
  expires_at: string;
  compacted_at: string | null;
}
const receipt = (db: DB, key: string) => one<Receipt | undefined>(db, "SELECT * FROM command_receipt WHERE idempotency_key = ?", key);
const receipts = (db: DB) => one<{ n: number; tombstones: number }>(db, "SELECT COUNT(*) n, COUNT(compacted_at) tombstones FROM command_receipt");

/** Receipts written the way executeCommand writes them, with a chosen expiry (synthetic results). */
function insertReceipts(db: DB, n: number, opts: { prefix: string; expiresAt: string; compacted?: boolean }): void {
  ensureReceiptSchema(db);
  const ins = db.prepare(
    `INSERT INTO command_receipt (idempotency_key, command, actor_id, scope, request_hash, result_json, correlation_id, at, created_at, expires_at, compacted_at)
     VALUES (?, 'clarification.create', 'stf_maya', 'lab:local', ?, ?, ?, '2026-10-14T15:00:00.000Z', ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(
        `${opts.prefix}-${i}`,
        crypto.createHash("sha256").update(`${opts.prefix}-${i}`).digest("hex"),
        opts.compacted ? "" : JSON.stringify({ clarificationId: `clr_synthetic_${i}` }),
        `corr-${opts.prefix}-${i}`,
        new Date(Date.parse(opts.expiresAt) - RECEIPT_TTL_MS).toISOString(),
        opts.expiresAt,
        opts.compacted ? opts.expiresAt : null,
      );
    }
  })();
}

/** Every audit row and seal, as text: "never touched" means byte-identical. */
const auditSnapshot = (db: DB) => JSON.stringify([all(db, "SELECT * FROM audit_event ORDER BY seq"), all(db, "SELECT * FROM audit_seal ORDER BY seq")]);

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-receipts-"));
  resetReceiptMaintenanceThrottle();
});
afterEach(() => {
  delete process.env.HLOS_RECEIPT_TOMBSTONE_DAYS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("compaction: an expired receipt becomes a tombstone that still refuses its key", () => {
  it("result cleared; key, owner, scope, command, fingerprint and expiry kept; a retry is refused (IDEMPOTENCY_EXPIRED) and never re-run", () => {
    const db = testDb();
    const first = run<{ snapshotId: string }>(db, STAFF.priya, "worklist.snapshot", SNAP, "receipt-key-0001");
    expect(first.ok).toBe(true);
    const before = receipt(db, "receipt-key-0001")!;
    expect(before.result_json).toContain("snapshotId");
    const count = snapshots(db);

    // Not expired yet: nothing to compact.
    expect(compactExpiredReceipts(db, Date.now()).processed).toBe(0);
    // A day later (the TTL): compacted.
    const later = Date.parse(before.expires_at) + 1000;
    expect(compactExpiredReceipts(db, later)).toMatchObject({ processed: 1, complete: true });
    const after = receipt(db, "receipt-key-0001")!;
    expect(after.result_json).toBe("");
    expect(after.compacted_at).toBe(new Date(later).toISOString());
    const kept = ["idempotency_key", "command", "actor_id", "scope", "request_hash", "correlation_id", "at", "created_at", "expires_at"] as const;
    for (const k of kept) expect(after[k], k).toBe(before[k]);

    // The retry happens on the real clock, before the stored expiry: the tombstone alone refuses it.
    const retry = executeCommand(db, STAFF.priya, "worklist.snapshot", SNAP, { idempotencyKey: "receipt-key-0001", correlationId: "req-retry-0001" });
    expect(retry.ok).toBe(false);
    expect(eventsOf(db, "req-retry-0001")).toBe(0);
    if (!retry.ok) expect(retry.error.code).toBe("IDEMPOTENCY_EXPIRED");
    expect(JSON.stringify(retry)).not.toContain(first.ok ? first.result.snapshotId : "x");
    expect(snapshots(db)).toBe(count);
    // Still owned: someone else's reuse is a conflict, as before.
    const other = run(db, STAFF.marcus, "worklist.snapshot", SNAP, "receipt-key-0001");
    expect(!other.ok && other.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(snapshots(db)).toBe(count);
  });

  it("receipts not yet expired, and receipts written before scoped receipts (no expiry), are left alone", () => {
    const db = testDb();
    const now = Date.now();
    insertReceipts(db, 3, { prefix: "live", expiresAt: new Date(now + DAY).toISOString() });
    insertReceipts(db, 2, { prefix: "expired", expiresAt: new Date(now - 1000).toISOString() });
    db.prepare("INSERT INTO command_receipt (idempotency_key, command, actor_id, result_json, at) VALUES ('legacy-0001', 'clarification.create', 'stf_maya', '{}', '2026-10-14T15:00:00.000Z')").run();
    expect(compactExpiredReceipts(db, now).processed).toBe(2);
    expect(all<{ idempotency_key: string }>(db, "SELECT idempotency_key FROM command_receipt WHERE compacted_at IS NOT NULL ORDER BY 1").map((r) => r.idempotency_key)).toEqual(["expired-0", "expired-1"]);
    expect(receipt(db, "legacy-0001")).toMatchObject({ result_json: "{}", compacted_at: null });
    expect(receipt(db, "live-0")?.compacted_at).toBeNull();
  });
});

describe("purge: tombstones are deleted only after the retention", () => {
  it("default 30 days after expiry (HLOS_RECEIPT_TOMBSTONE_DAYS); never a live receipt; afterwards the old key would run again (the residual risk)", () => {
    const db = testDb();
    expect(receiptTombstoneDays()).toBe(DEFAULT_TOMBSTONE_DAYS);
    expect(DEFAULT_TOMBSTONE_DAYS).toBe(30);
    expect(run(db, STAFF.priya, "worklist.snapshot", SNAP, "purge-key-0001").ok).toBe(true);
    const expiry = Date.parse(receipt(db, "purge-key-0001")!.expires_at);
    // A very old receipt that was never compacted is not a tombstone: the purge never deletes it.
    insertReceipts(db, 1, { prefix: "old-live", expiresAt: new Date(expiry - 400 * DAY).toISOString() });

    expect(purgeTombstones(db, expiry + 90 * DAY).processed).toBe(0); // nothing compacted yet: nothing to purge
    expect(receipt(db, "old-live-0")).toBeDefined();
    expect(compactExpiredReceipts(db, expiry).processed).toBe(2);
    // One minute short of 30 days after its expiry the new tombstone stays; the 400-day-old one goes.
    expect(purgeTombstones(db, expiry + 30 * DAY - 60_000).processed).toBe(1);
    expect(receipt(db, "old-live-0")).toBeUndefined();
    expect(receipt(db, "purge-key-0001")?.compacted_at).toBeTruthy();
    expect(purgeTombstones(db, expiry + 30 * DAY).processed).toBe(1);
    expect(receipt(db, "purge-key-0001")).toBeUndefined();

    // Residual risk, pinned: once the tombstone is gone the key is treated as new, and the command runs again.
    const count = snapshots(db);
    const again = executeCommand(db, STAFF.priya, "worklist.snapshot", SNAP, { idempotencyKey: "purge-key-0001", correlationId: "req-after-purge-0001" });
    expect(again.ok && !again.replayed).toBe(true);
    expect(eventsOf(db, "req-after-purge-0001")).toBeGreaterThan(0);
    expect(snapshots(db)).toBe(count + 1);
    expect(receipt(db, "purge-key-0001")).toMatchObject({ compacted_at: null, correlation_id: "req-after-purge-0001" });
  });

  it("HLOS_RECEIPT_TOMBSTONE_DAYS sets the retention; an invalid value purges nothing (fail safe)", () => {
    const db = testDb();
    const now = Date.now();
    insertReceipts(db, 4, { prefix: "tomb", expiresAt: new Date(now - 3 * DAY).toISOString(), compacted: true });
    process.env.HLOS_RECEIPT_TOMBSTONE_DAYS = "5";
    expect(purgeTombstones(db, now).processed).toBe(0);
    for (const bad of ["0", "abc", "-1", "3651", "1.5"]) {
      process.env.HLOS_RECEIPT_TOMBSTONE_DAYS = bad;
      expect(() => purgeTombstones(db, now), bad).toThrow(/HLOS_RECEIPT_TOMBSTONE_DAYS/);
      const r = runReceiptMaintenance(db, now);
      expect(r.purged).toBeNull();
      expect(r.purgeSkipped).toMatch(/Nothing was purged/);
      expect(receipts(db).tombstones).toBe(4);
    }
    process.env.HLOS_RECEIPT_TOMBSTONE_DAYS = "2";
    expect(purgeTombstones(db, now).processed).toBe(4);
  });
});

describe("bounded batches", () => {
  it("each batch is its own short transaction of at most `batch` rows; maxBatches bounds a run", () => {
    const db = testDb();
    const now = Date.now();
    insertReceipts(db, 250, { prefix: "bulk", expiresAt: new Date(now - DAY).toISOString() });
    const tx = vi.spyOn(db, "transaction");
    const one1 = compactExpiredReceipts(db, now, { batch: 100, maxBatches: 1 });
    expect(one1).toEqual({ processed: 100, batchSizes: [100], complete: false });
    expect(tx).toHaveBeenCalledTimes(1);
    const rest = compactExpiredReceipts(db, now, { batch: 100 });
    expect(rest).toEqual({ processed: 150, batchSizes: [100, 50], complete: true });
    expect(tx).toHaveBeenCalledTimes(3);
    expect(receipts(db).tombstones).toBe(250);

    const purged = purgeTombstones(db, now + 60 * DAY, { batch: 64 });
    expect(purged.batchSizes).toEqual([64, 64, 64, 58]);
    expect(purged.batchSizes.every((n) => n <= 64)).toBe(true);
    expect(tx).toHaveBeenCalledTimes(7);
    tx.mockRestore();

    for (const batch of [0, -1, 5001, 1.5]) expect(() => compactExpiredReceipts(db, now, { batch }), String(batch)).toThrow(RangeError);
    // Never inside another transaction (it would hold that transaction's write lock for the whole run).
    expect(() => db.transaction(() => compactExpiredReceipts(db, now))()).toThrow(/must not run inside another transaction/);
    expect(() => db.transaction(() => purgeTombstones(db, now, { retentionDays: 1 }))()).toThrow(/must not run inside another transaction/);
  });
});

describe("audit events are never touched", () => {
  it("compaction and purge leave every audit event and seal byte-identical, and the chain verifies", () => {
    const db = testDb();
    for (let i = 0; i < 5; i++) expect(run(db, STAFF.maya, "clarification.create", input(i), `audit-untouched-${i}`).ok).toBe(true);
    insertReceipts(db, 120, { prefix: "many", expiresAt: new Date(Date.now() - 40 * DAY).toISOString() });
    const before = auditSnapshot(db);
    const r = runReceiptMaintenance(db, Date.now() + 2 * DAY, { batch: 25 });
    expect(r.compacted.processed).toBe(125);
    expect(r.purged?.processed).toBe(120);
    expect(auditSnapshot(db)).toBe(before);
    expect(verifyAuditChain(db, { key: demoAuditKey() }).ok).toBe(true);
  });
});

describe("cleanup concurrent with mutations on another connection", () => {
  it("while another connection holds the write lock, cleanup changes nothing (and the opportunistic run gives up at once)", () => {
    const file = path.join(tmp, "lock.db");
    const seed = openDatabase(file);
    seedDemo(seed, { clockRunning: false });
    insertReceipts(seed, 10, { prefix: "exp", expiresAt: new Date(Date.now() - DAY).toISOString() });
    seed.close();
    const a = openDatabase(file);
    const b = openDatabase(file);
    try {
      a.pragma("busy_timeout = 50");
      b.prepare("BEGIN IMMEDIATE").run(); // a command mid-transaction on another connection
      expect(() => compactExpiredReceipts(a, Date.now())).toThrow(/database is locked|SQLITE_BUSY/i);
      const t0 = Date.now();
      expect(maybeRunReceiptMaintenance(a, Date.now())).toBeNull();
      expect(Date.now() - t0).toBeLessThan(40);
      expect(a.pragma("busy_timeout", { simple: true })).toBe(50); // restored
      b.prepare("ROLLBACK").run();
      expect(receipts(a).tombstones).toBe(0);
      expect(compactExpiredReceipts(a, Date.now()).processed).toBe(10);
    } finally {
      a.close();
      b.close();
    }
  });

  it("another process compacts and purges in small batches while this one runs keyed commands and replays: no receipt lost, nothing runs twice", async () => {
    const file = path.join(tmp, "concurrent.db");
    const seed = openDatabase(file);
    seedDemo(seed, { clockRunning: false });
    insertReceipts(seed, 600, { prefix: "old", expiresAt: new Date(Date.now() - 2 * DAY).toISOString() });
    seed.close();
    const go = path.join(tmp, "go");
    const child = path.join(tmp, "cleanup.ts");
    fs.writeFileSync(
      child,
      `import fs from "node:fs";
import { openDatabase } from ${JSON.stringify(path.join(ROOT, "src/server/db/db"))};
import { compactExpiredReceipts, purgeTombstones } from ${JSON.stringify(path.join(ROOT, "src/server/core/idempotency"))};
const db = openDatabase(process.env.HLOS_DB_PATH!);
const sleep = new Int32Array(new SharedArrayBuffer(4));
console.log("ready");
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(sleep, 0, 0, 2);
let compacted = 0, purged = 0, batches = 0;
for (;;) {
  const r = compactExpiredReceipts(db, Date.now(), { batch: 10, maxBatches: 1 });
  compacted += r.processed; batches++;
  Atomics.wait(sleep, 0, 0, 1);
  if (r.complete) break;
}
for (;;) {
  const r = purgeTombstones(db, Date.now() + 400 * 86400000, { batch: 10, maxBatches: 1, retentionDays: 30 });
  purged += r.processed; batches++;
  Atomics.wait(sleep, 0, 0, 1);
  if (r.complete) break;
}
db.close();
console.log(JSON.stringify({ compacted, purged, batches }));
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

    const db = openDatabase(file);
    try {
      const start = snapshots(db);
      const results = new Map<string, unknown>();
      fs.writeFileSync(go, "1");
      for (let i = 0; i < 40; i++) {
        const key = `concurrent-key-${String(i).padStart(4, "0")}`;
        const first = executeCommand<{ snapshotId: string }>(db, STAFF.priya, "worklist.snapshot", SNAP, { idempotencyKey: key, correlationId: `req-run-${i}` });
        expect(first.ok, JSON.stringify(first)).toBe(true);
        if (first.ok) results.set(key, first.result);
        await new Promise((r) => setTimeout(r, 2)); // let the other process take the write lock in between
        const replay = executeCommand(db, STAFF.priya, "worklist.snapshot", SNAP, { idempotencyKey: key, correlationId: `req-replay-${i}` });
        expect(replay.ok && replay.replayed).toBe(true);
        if (replay.ok) expect(replay.result).toEqual(results.get(key));
      }
      expect(await exited, err).toBe(0);
      const summary = JSON.parse(out.trim().split("\n").pop()!) as { compacted: number; purged: number; batches: number };
      // This process's own opportunistic run (one batch of up to 200, after a command committed) may have compacted
      // some first; the other process compacted the rest and purged them all.
      expect(summary.compacted).toBeGreaterThanOrEqual(400);
      expect(summary.compacted).toBeLessThanOrEqual(600);
      expect(summary.purged).toBe(600);
      expect(summary.batches).toBeGreaterThan(100);

      // Nothing ran twice; no live receipt was lost or emptied; every old receipt is gone.
      expect(snapshots(db)).toBe(start + 40);
      for (let i = 0; i < 40; i++) {
        expect(eventsOf(db, `req-run-${i}`), `run ${i}`).toBeGreaterThan(0);
        expect(eventsOf(db, `req-replay-${i}`), `replay ${i}`).toBe(0);
      }
      const live = all<Receipt>(db, "SELECT * FROM command_receipt WHERE idempotency_key LIKE 'concurrent-key-%' ORDER BY 1");
      expect(live).toHaveLength(40);
      for (const r of live) {
        expect(r.compacted_at).toBeNull();
        expect(JSON.parse(r.result_json)).toEqual(results.get(r.idempotency_key));
      }
      expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM command_receipt WHERE idempotency_key LIKE 'old-%'").n).toBe(0);
      expect(verifyAuditChain(db, { key: demoAuditKey() }).ok).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("opportunistic maintenance after a command commits", () => {
  it("runs after a committed command, at most once per 10 minutes per process, one bounded batch, never inside the command's transaction", () => {
    const db = testDb();
    insertReceipts(db, 250, { prefix: "stale", expiresAt: new Date(Date.now() - DAY).toISOString() });

    // Inside an outer transaction the command's commit is not real yet: no maintenance (and the throttle is not used up).
    db.transaction(() => expect(run(db, STAFF.maya, "clarification.create", input(1), "opp-key-0000").ok).toBe(true))();
    expect(receipts(db).tombstones).toBe(0);
    db.transaction(() => expect(maybeRunReceiptMaintenance(db)).toBeNull())();
    expect(receipts(db).tombstones).toBe(0);

    // A committed command: one batch of 200 compacted, in its own transaction after the commit.
    expect(run(db, STAFF.maya, "clarification.create", input(2), "opp-key-0001").ok).toBe(true);
    expect(receipts(db).tombstones).toBe(200);
    expect(receipt(db, "opp-key-0001")).toMatchObject({ compacted_at: null });
    expect(JSON.parse(receipt(db, "opp-key-0001")!.result_json)).toHaveProperty("clarificationId");

    // Within 10 minutes: not again.
    expect(run(db, STAFF.maya, "clarification.create", input(3), "opp-key-0002").ok).toBe(true);
    expect(receipts(db).tombstones).toBe(200);
    expect(maybeRunReceiptMaintenance(db, Date.now() + OPPORTUNISTIC_INTERVAL_MS - 60_000)).toBeNull();
    // After 10 minutes: the rest.
    expect(maybeRunReceiptMaintenance(db, Date.now() + OPPORTUNISTIC_INTERVAL_MS + 1000)?.compacted.processed).toBe(50);
    expect(receipts(db).tombstones).toBe(250);
    // The commands' own receipts still replay.
    const replay = run(db, STAFF.maya, "clarification.create", input(2), "opp-key-0001");
    expect(replay.ok && replay.replayed).toBe(true);
  });
});

describe("npm run maintenance (scripts/maintenance.ts)", () => {
  it("compacts and purges in batches, prints counts only, and refuses an invalid retention without purging", () => {
    const file = path.join(tmp, "cli.db");
    const db = openDatabase(file);
    seedDemo(db, { clockRunning: false });
    insertReceipts(db, 30, { prefix: "cli-expired", expiresAt: new Date(Date.now() - DAY).toISOString() });
    insertReceipts(db, 7, { prefix: "cli-tomb", expiresAt: new Date(Date.now() - 45 * DAY).toISOString(), compacted: true });
    db.close();
    const cli = (args: string[], env: Record<string, string | undefined> = {}) => {
      const r = spawnSync(TSX, ["scripts/maintenance.ts", ...args], { cwd: ROOT, env: { ...process.env, HLOS_DB_PATH: file, ...env }, encoding: "utf8", timeout: 60_000 });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const bad = cli([], { HLOS_RECEIPT_TOMBSTONE_DAYS: "zero" });
    expect(bad.code, bad.out).toBe(2);
    expect(bad.out).toMatch(/purge skipped: HLOS_RECEIPT_TOMBSTONE_DAYS must be/);
    const check = openDatabase(file);
    expect(receipts(check)).toMatchObject({ n: 37, tombstones: 37 }); // compacted, nothing purged
    check.close();

    const ok = cli(["--batch", "4"]);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toMatch(/compacted to tombstones: 0 in 1 batch/);
    expect(ok.out).toMatch(/tombstones purged: +7 in 2 batch\(es\) \(retention 30 days after expiry\)/);
    expect(ok.out).not.toMatch(/clr_synthetic|stf_maya/);
    const after = openDatabase(file);
    expect(receipts(after)).toMatchObject({ n: 30, tombstones: 30 });
    after.close();
    expect(cli(["--batch", "0"]).code).toBe(2);
    expect(cli(["--nonsense"]).code).toBe(2);
  }, 60_000);
});
