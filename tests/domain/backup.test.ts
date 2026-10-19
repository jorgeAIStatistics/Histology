import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { appendAnchor, demoAuditKey, readAnchorFile, verifyAuditChain } from "@/server/core/audit-seal";
import { linkIdentity } from "@/server/auth/admin";
import { audit } from "@/server/core/audit";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import {
  aadFor,
  auditHead,
  BackupRefused,
  checkRestoreTarget,
  createBackup,
  ENCRYPTION_MAGIC,
  findLatestManifest,
  LABEL_UNENCRYPTED,
  parseBackupKey,
  restoreBackup,
  schemaFingerprint,
  sha256File,
  tableRowCounts,
  type BackupKey,
  type BackupManifest,
  type CreateBackupResult,
  type RestoreReport,
} from "@/server/ops/backup";
import { all, one, run, STAFF } from "../helpers";

// Stage 6 Phase E1: backup and restore, proved by restoring. Every database here is the synthetic demo day in a
// temporary directory; nothing touches data/histology-lab-os.db. Tampering is done the way someone with the backup
// FILES would do it (flipping bytes, editing the manifest, truncating), never through the application.

const ROOT = path.resolve(import.meta.dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const DEMO = demoAuditKey();

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hlos-backup-test-")));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ORDER_B = "ord_ord_77121";
const PART_B = "ord_ord_77121_b";
const clarification = (n: number | string) => ({
  category: "laterality",
  refs: { sourceOrderId: ORDER_B, orderPartId: PART_B },
  subjectLabel: "Part B · ORD-77121",
  question: `Which side is correct for part B? (synthetic ${n})`,
  evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", requisition_value: null, source: "bottle label (staff entry)" }],
  priority: "high",
});

function newKey(): { hex: string; key: BackupKey } {
  const hex = crypto.randomBytes(32).toString("hex");
  const r = parseBackupKey(hex, {});
  if (!r.present || !r.ok) throw new Error("test key refused");
  return { hex, key: r.key };
}

const counts = (db: DB) =>
  one<{ events: number; seals: number; head: number }>(
    db,
    "SELECT (SELECT COUNT(*) FROM audit_event) events, (SELECT COUNT(*) FROM audit_seal) seals, (SELECT COALESCE(MAX(seq), 0) head FROM audit_event) head",
  );

let seq = 0;
/** A fresh synthetic database in its own directory, with a few commands run (receipts and audit events). */
function liveDb(commands = 3): { dir: string; file: string } {
  const dir = path.join(tmp, `case-${++seq}`);
  fs.mkdirSync(path.join(dir, "live"), { recursive: true });
  const file = path.join(dir, "live", "live.db");
  const db = openDatabase(file);
  seedDemo(db, { clockRunning: false });
  const before = counts(db).events;
  for (let i = 0; i < commands; i++) expect(run(db, STAFF.maya, "clarification.create", clarification(`seed-${i}`), `bk-test-${seq}-${i}`).ok).toBe(true);
  if (commands) {
    expect(counts(db).events).toBeGreaterThan(before); // the commands were audited (and sealed)
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM command_receipt WHERE idempotency_key LIKE ?", `bk-test-${seq}-%`).n).toBe(commands);
  }
  db.close();
  return { dir, file };
}

function readManifest(p: string): BackupManifest {
  return JSON.parse(fs.readFileSync(p, "utf8")) as BackupManifest;
}
function writeManifest(p: string, m: unknown): void {
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
}

/** A copy of a backup (file + manifest) in its own directory, for tampering. */
function copyBackup(b: CreateBackupResult, name: string): { file: string; manifest: string; dir: string } {
  const dir = path.join(tmp, `copy-${name}-${++seq}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, path.basename(b.filePath));
  const manifest = path.join(dir, path.basename(b.manifestPath));
  fs.copyFileSync(b.filePath, file);
  fs.copyFileSync(b.manifestPath, manifest);
  return { file, manifest, dir };
}

const statusOf = (r: RestoreReport, name: string) => r.checks.find((c) => c.name === name)?.result;

// ------------------------------------------------------------------ the full cycle

describe("backup and restore: a real cycle on synthetic data", () => {
  it("seed, commands, back up while another process writes, restore to a new path: every count, the schema and the audit chain match", async () => {
    const { dir, file } = liveDb(4);
    const anchors = path.join(tmp, `anchors-${seq}`, "anchors.jsonl");
    fs.mkdirSync(path.dirname(anchors));
    const live = openDatabase(file);
    try {
      appendAnchor(live, { key: DEMO, file: anchors }); // an anchor taken before the backup

      // Another process writes commands and audit events in a loop for the whole backup.
      const stop = path.join(dir, "stop");
      const times = path.join(dir, "times.json");
      const child = path.join(dir, "writer.ts");
      fs.writeFileSync(
        child,
        `import fs from "node:fs";
import { openDatabase } from ${JSON.stringify(path.join(ROOT, "src/server/db/db"))};
import { audit } from ${JSON.stringify(path.join(ROOT, "src/server/core/audit"))};
import { makeCtx, SYSTEM_ACTOR } from ${JSON.stringify(path.join(ROOT, "src/server/core/context"))};
import { executeCommand } from ${JSON.stringify(path.join(ROOT, "src/server/commands"))};
const db = openDatabase(process.env.HLOS_DB_PATH!);
const input = ${JSON.stringify(clarification("writer"))};
const sleep = new Int32Array(new SharedArrayBuffer(4));
const at: number[] = [];
let i = 0;
while (!fs.existsSync(${JSON.stringify(stop)}) && i < 4000) {
  if (!executeCommand(db, "stf_maya", "clarification.create", { ...input, question: "Which side is correct for part B? (writer " + i + ")" }).ok) throw new Error("command failed");
  audit(makeCtx(db, SYSTEM_ACTOR, "system", "writer-" + i), { action: "test.backup_writer", entityType: "test", entityId: "w-" + i, summary: "written during a backup" });
  at.push(Date.now());
  i++;
  if (i % 5 === 0) console.log("wrote " + i);
  Atomics.wait(sleep, 0, 0, 1);
}
db.close();
fs.writeFileSync(${JSON.stringify(times)}, JSON.stringify(at));
console.log("done " + i);
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
          if (/wrote (1\d|[2-9]\d)/.test(out)) (clearInterval(t), resolve());
          else if (proc.exitCode !== null) (clearInterval(t), reject(new Error(`writer exited early: ${err}`)));
        }, 5);
      });

      const { key } = newKey();
      const started = Date.now();
      const b = await createBackup({ dbPath: file, outDir: path.join(dir, "backups"), key, mode: "demo", projectRoot: ROOT });
      const finished = Date.now();
      // Let the writer go on for a few more writes, then stop it.
      const wrote = () => Math.max(0, ...[...out.matchAll(/wrote (\d+)/g)].map((x) => Number(x[1])));
      const atFinish = wrote();
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (wrote() >= atFinish + 10 || proc.exitCode !== null) (clearInterval(t), resolve());
        }, 5);
      });
      fs.writeFileSync(stop, "1");
      expect(await exited, err).toBe(0);
      const writes = JSON.parse(fs.readFileSync(times, "utf8")) as number[];
      // The writer really was writing while the backup ran, and kept writing after it.
      expect(writes.filter((t) => t >= started && t <= finished).length).toBeGreaterThan(0);
      expect(writes.filter((t) => t > finished).length).toBeGreaterThan(0);

      // The manifest.
      const m = b.manifest;
      expect(readManifest(b.manifestPath)).toEqual(m);
      expect(m).toMatchObject({ format: "hlos.backup-manifest/1", label: "encrypted (AES-256-GCM)", mode: "demo", synthetic: true, method: "sqlite-online-backup-api" });
      expect(m.app.name).toBe("histology-lab-os");
      expect(m.app.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(m.app.git_commit === null || /^[0-9a-f]{7,40}$/.test(m.app.git_commit)).toBe(true);
      expect(Date.parse(m.created_at)).toBeGreaterThanOrEqual(started - 1);
      expect(m.file.sha256).toBe((await sha256File(b.filePath)).sha256);
      expect(m.file.bytes).toBe(fs.statSync(b.filePath).size);
      expect(m.database).toMatchObject({ integrity_check: "ok", journal_mode: "delete" });
      expect(m.encryption).toMatchObject({ algorithm: "aes-256-gcm", key_id: key.id, key_source: "HLOS_BACKUP_KEY", tag_bytes: 16 });
      expect(m.audit.head).toMatchObject({ key_id: "demo-not-secret" });
      expect(m.audit.verified_at_backup).toMatchObject({ ok: true, demo_key: true, sealed_through: m.audit.head!.seq });
      expect(m.schema.fingerprint).toBe(schemaFingerprint(live).fingerprint);
      expect(fs.statSync(b.filePath).mode & 0o077).toBe(0);
      expect(fs.statSync(b.manifestPath).mode & 0o077).toBe(0);
      // No plaintext snapshot left behind anywhere (the live directory holds only the database and its WAL files).
      expect(fs.readdirSync(path.dirname(file)).filter((n) => !/^live\.db(-wal|-shm)?$/.test(n))).toEqual([]);
      expect(fs.readdirSync(path.dirname(b.filePath)).sort()).toEqual([path.basename(b.filePath), path.basename(b.manifestPath)].sort());

      // The live database moved on after the backup.
      appendAnchor(live, { key: DEMO, file: anchors }); // an anchor newer than the backup
      const after = counts(live);
      expect(after.events).toBeGreaterThan(m.audit.events);
      expect(readAnchorFile(anchors)).toHaveLength(2);

      // Restore into a new path and verify.
      const target = path.join(dir, "restore", "restored.db");
      const r = await restoreBackup({ source: b.manifestPath, target, liveDbPath: file, key, anchorsFile: anchors });
      expect(r.checks.filter((c) => c.result === "fail"), JSON.stringify(r.checks, null, 2)).toEqual([]);
      expect(r).toMatchObject({ ok: true, restored: true, backupId: m.backup_id, restoredHeadSeq: m.audit.head!.seq });
      expect(r.checks.map((c) => [c.name, c.result])).toEqual([
        ["manifest", "pass"],
        ["backup file", "pass"],
        ["decryption", "pass"],
        ["database checksum", "pass"],
        ["integrity_check", "pass"],
        ["foreign_key_check", "pass"],
        ["schema fingerprint", "pass"],
        ["row counts", "pass"],
        ["audit chain", "pass"],
        ["audit head", "pass"],
        ["audit anchors", "pass"],
      ]);
      expect(r.checks.find((c) => c.name === "audit anchors")!.detail).toMatch(/1 anchor\(s\) at or before .* 1 newer anchor\(s\)/);

      // Independently of the report: the restored file, opened on its own.
      const restored = new Database(target, { readonly: true, fileMustExist: true });
      try {
        expect(tableRowCounts(restored)).toEqual(m.row_counts);
        expect(schemaFingerprint(restored).fingerprint).toBe(m.schema.fingerprint);
        expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(restored.pragma("foreign_key_check")).toEqual([]);
        // Audit history continuity: the restored chain verifies, its head is the manifest's, and that head is the
        // live chain's seal at the same seq (the backup is a prefix of the live history).
        const v = verifyAuditChain(restored, { key: DEMO, anchors: readAnchorFile(anchors).filter((a) => a.seq <= m.audit.head!.seq) });
        expect(v).toMatchObject({ ok: true, sealedThrough: m.audit.head!.seq, checked: m.audit.events });
        expect(auditHead(restored)).toEqual(m.audit.head);
        const liveSeal = one<{ mac: string; key_id: string }>(live, "SELECT mac, key_id FROM audit_seal WHERE seq = ?", m.audit.head!.seq);
        expect(liveSeal).toEqual({ mac: m.audit.head!.mac, key_id: m.audit.head!.key_id });
        // The writer's events: some are in the backup, some only in the live database (lost by a restore).
        const inBackup = one<{ n: number }>(restored, "SELECT COUNT(*) n FROM audit_event WHERE action = 'test.backup_writer'").n;
        const inLive = one<{ n: number }>(live, "SELECT COUNT(*) n FROM audit_event WHERE action = 'test.backup_writer'").n;
        expect(inBackup).toBeGreaterThan(0);
        expect(inLive).toBeGreaterThan(inBackup);
        // Against the newest anchor, the restored chain is (correctly) reported as missing history.
        expect(verifyAuditChain(restored, { key: DEMO, anchors: readAnchorFile(anchors) }).firstProblem?.kind).toBe("anchor_mismatch");
      } finally {
        restored.close();
      }
      expect(verifyAuditChain(live, { key: DEMO }).ok).toBe(true); // the live chain is untouched

      // The restored database works: a new command's seal chains from the restored head.
      const reopened = openDatabase(target);
      try {
        audit(makeCtx(reopened, SYSTEM_ACTOR, "system", "after-restore"), { action: "test.after_restore", entityType: "test", entityId: "r1", summary: "written after the restore" });
        const next = one<{ prev_mac: string }>(reopened, "SELECT prev_mac FROM audit_seal WHERE seq > ? ORDER BY seq LIMIT 1", m.audit.head!.seq);
        expect(next.prev_mac).toBe(m.audit.head!.mac);
        expect(verifyAuditChain(reopened, { key: DEMO }).ok).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      live.close();
    }
  }, 120_000);

  it("demo mode on the synthetic database without a key: an unencrypted backup labelled 'synthetic, unencrypted' that restores and verifies", async () => {
    const { dir, file } = liveDb(1);
    const b = await createBackup({ dbPath: file, outDir: path.join(dir, "backups"), key: null, mode: "demo", projectRoot: ROOT });
    expect(b.manifest.label).toBe(LABEL_UNENCRYPTED);
    expect(b.manifest.label).toBe("synthetic, unencrypted");
    expect(b.manifest.encryption.algorithm).toBe("none");
    expect(b.filePath.endsWith(".sqlite")).toBe(true);
    expect(fs.readFileSync(b.filePath).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\u0000");
    const r = await restoreBackup({ source: b.filePath, target: path.join(dir, "r", "r.db"), liveDbPath: file, key: null });
    expect(r.ok).toBe(true);
    expect(statusOf(r, "decryption")).toBe("skip");
    expect(statusOf(r, "audit chain")).toBe("pass");
    expect(statusOf(r, "audit anchors")).toBe("skip");
    expect(findLatestManifest(path.join(dir, "backups"))?.manifest?.backup_id).toBe(b.manifest.backup_id);
  });
});

// ------------------------------------------------------------------ tampering

describe("restore detects tampering, the wrong key, a missing tag and truncation (nothing is restored)", () => {
  let b: CreateBackupResult;
  let key: BackupKey;
  let live: string;
  beforeAll(async () => {
    const l = liveDb(2);
    live = l.file;
    key = newKey().key;
    b = await createBackup({ dbPath: live, outDir: path.join(l.dir, "backups"), key, mode: "demo", projectRoot: ROOT });
  });

  const restoreCopy = async (c: { manifest: string }, k: BackupKey | null = key) => {
    const target = path.join(tmp, `t-${++seq}`, "r.db");
    const r = await restoreBackup({ source: c.manifest, target, liveDbPath: live, key: k });
    expect(r.ok).toBe(false);
    expect(r.restored).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    const parent = path.dirname(target);
    expect(fs.existsSync(parent) ? fs.readdirSync(parent) : []).toEqual([]); // no temporary file left either
    return r;
  };
  const failed = (r: RestoreReport) => r.checks.find((c) => c.result === "fail")!;

  it("the untouched copy restores (control)", async () => {
    const c = copyBackup(b, "control");
    const r = await restoreBackup({ source: c.manifest, target: path.join(c.dir, "ok.db"), liveDbPath: live, key });
    expect(r.ok).toBe(true);
  });

  it("one flipped byte: the file checksum fails; with the checksum forged too, the GCM tag fails", async () => {
    const c = copyBackup(b, "flip");
    const buf = fs.readFileSync(c.file);
    buf[Math.floor(buf.length / 2)] ^= 0x01;
    fs.writeFileSync(c.file, buf);
    const r1 = await restoreCopy(c);
    expect(failed(r1)).toMatchObject({ name: "backup file" });
    expect(failed(r1).detail).toMatch(/does not match the manifest/);

    const m = readManifest(c.manifest);
    m.file.sha256 = (await sha256File(c.file)).sha256;
    writeManifest(c.manifest, m);
    const r2 = await restoreCopy(c);
    expect(failed(r2)).toMatchObject({ name: "decryption" });
    expect(failed(r2).detail).toMatch(/AES-256-GCM authentication failed/);
  });

  it("the wrong key is refused by its key id; with the key id forged to match, the GCM tag fails", async () => {
    const wrong = newKey().key;
    const c = copyBackup(b, "wrong-key");
    const r1 = await restoreCopy(c, wrong);
    expect(failed(r1)).toMatchObject({ name: "decryption" });
    expect(failed(r1).detail).toMatch(new RegExp(`Wrong key: HLOS_BACKUP_KEY is key ${wrong.id}, but this backup was encrypted with key ${key.id}`));

    const m = readManifest(c.manifest);
    (m.encryption as { key_id: string }).key_id = wrong.id;
    writeManifest(c.manifest, m);
    const r2 = await restoreCopy(c, wrong);
    expect(failed(r2).detail).toMatch(/AES-256-GCM authentication failed/);
  });

  it("a missing tag: none in the manifest is refused; a file cut before its tag is caught", async () => {
    const c = copyBackup(b, "no-tag");
    const m = readManifest(c.manifest);
    delete (m.encryption as { tag?: string }).tag;
    writeManifest(c.manifest, m);
    const r1 = await restoreCopy(c);
    expect(failed(r1).detail).toMatch(/no GCM authentication tag/);

    const c2 = copyBackup(b, "cut-tag");
    const buf = fs.readFileSync(c2.file);
    fs.writeFileSync(c2.file, buf.subarray(0, buf.length - 16));
    const r2 = await restoreCopy(c2);
    expect(failed(r2)).toMatchObject({ name: "backup file" });
    // Even with the size and checksum forged in the manifest, the last 16 bytes are no longer the tag.
    const m2 = readManifest(c2.manifest);
    const s = await sha256File(c2.file);
    m2.file.sha256 = s.sha256;
    m2.file.bytes = s.bytes;
    writeManifest(c2.manifest, m2);
    const r3 = await restoreCopy(c2);
    expect(failed(r3)).toMatchObject({ name: "decryption" });
    expect(failed(r3).detail).toMatch(/tag at the end of the file does not match/);
  });

  it("a truncated file is caught (size), and a file shorter than its header is refused", async () => {
    const c = copyBackup(b, "truncated");
    const buf = fs.readFileSync(c.file);
    fs.writeFileSync(c.file, buf.subarray(0, Math.floor(buf.length / 2)));
    const r = await restoreCopy(c);
    expect(failed(r)).toMatchObject({ name: "backup file" });
    expect(failed(r).detail).toMatch(/truncated or altered/);

    const c2 = copyBackup(b, "stub");
    fs.writeFileSync(c2.file, ENCRYPTION_MAGIC);
    const m = readManifest(c2.manifest);
    const s = await sha256File(c2.file);
    m.file.sha256 = s.sha256;
    m.file.bytes = s.bytes;
    writeManifest(c2.manifest, m);
    const r2 = await restoreCopy(c2);
    expect(failed(r2).detail).toMatch(/too short/);
  });

  it("an edited manifest expectation (a row count, the audit head) breaks the tag: the manifest cannot be rewritten to match", async () => {
    const c = copyBackup(b, "edit-counts");
    const m = readManifest(c.manifest);
    m.row_counts.audit_event += 1;
    writeManifest(c.manifest, m);
    const r = await restoreCopy(c);
    expect(failed(r).detail).toMatch(/AES-256-GCM authentication failed/);
    expect(aadFor(m).equals(aadFor(b.manifest))).toBe(false);

    const c2 = copyBackup(b, "edit-head");
    const m2 = readManifest(c2.manifest);
    m2.audit.head!.seq -= 1;
    writeManifest(c2.manifest, m2);
    expect(failed(await restoreCopy(c2)).detail).toMatch(/AES-256-GCM authentication failed/);
  });

  it("a missing or malformed manifest is refused before anything is written", async () => {
    const c = copyBackup(b, "no-manifest");
    fs.rmSync(c.manifest);
    await expect(restoreBackup({ source: c.file, target: path.join(c.dir, "x.db"), liveDbPath: live, key })).rejects.toThrow(BackupRefused);
    const c2 = copyBackup(b, "bad-manifest");
    fs.writeFileSync(c2.manifest, "{ not json");
    await expect(restoreBackup({ source: c2.manifest, target: path.join(c2.dir, "x.db"), liveDbPath: live, key })).rejects.toThrow(/not valid JSON/);
    expect(fs.existsSync(path.join(c2.dir, "x.db"))).toBe(false);
  });

  it("an encrypted backup restored without HLOS_BACKUP_KEY is refused", async () => {
    const c = copyBackup(b, "no-key");
    await expect(restoreBackup({ source: c.manifest, target: path.join(c.dir, "x.db"), liveDbPath: live, key: null })).rejects.toThrow(/this backup is encrypted; set HLOS_BACKUP_KEY/);
  });
});

// ------------------------------------------------------------------ targets, refusals, plaintext

describe("restore targets and backup refusals", () => {
  it("a restore over an existing path is refused and the existing file is untouched; so are companions, links and the live database", async () => {
    const { dir, file } = liveDb(0);
    const b = await createBackup({ dbPath: file, outDir: path.join(dir, "backups"), key: null, mode: "demo", projectRoot: ROOT });
    const existing = path.join(dir, "existing.db");
    fs.writeFileSync(existing, "an existing file that must survive");
    const before = fs.readFileSync(existing);
    await expect(restoreBackup({ source: b.manifestPath, target: existing, liveDbPath: file, key: null })).rejects.toThrow(/already exists at the target path/);
    expect(fs.readFileSync(existing).equals(before)).toBe(true);

    // The live database itself (exists), its WAL path (may not exist yet), and a target named like the live path.
    await expect(restoreBackup({ source: b.manifestPath, target: file, liveDbPath: file, key: null })).rejects.toThrow(/the target is the live database/);
    await expect(restoreBackup({ source: b.manifestPath, target: `${file}-journal`, liveDbPath: file, key: null })).rejects.toThrow(/the target is the live database/);
    const notYet = path.join(dir, "not-yet", "live.db");
    expect(() => checkRestoreTarget(notYet, notYet)).toThrow(/the target is the live database/);

    // A stale -wal beside a new target would be mixed into it.
    const t = path.join(dir, "fresh.db");
    fs.writeFileSync(`${t}-wal`, "stale");
    await expect(restoreBackup({ source: b.manifestPath, target: t, liveDbPath: file, key: null })).rejects.toThrow(/-wal file already exists/);
    expect(fs.existsSync(t)).toBe(false);

    // A dangling symbolic link is "something at the target path" too (writing through it would land elsewhere).
    const link = path.join(dir, "link.db");
    fs.symlinkSync(path.join(dir, "elsewhere.db"), link);
    await expect(restoreBackup({ source: b.manifestPath, target: link, liveDbPath: file, key: null })).rejects.toThrow(/already exists/);
    expect(fs.existsSync(path.join(dir, "elsewhere.db"))).toBe(false);
  });

  it("an encrypted backup contains no plaintext synthetic patient name or MRN (the unencrypted form does: the control)", async () => {
    const { dir, file } = liveDb(0);
    const db = openDatabase(file);
    const patients = all<{ family_name: string; given_name: string; source_mrn: string }>(db, "SELECT family_name, given_name, source_mrn FROM patient_ref");
    db.close();
    const needles = [...new Set(patients.flatMap((p) => [p.family_name, `${p.given_name} ${p.family_name}`, p.source_mrn]).filter((s) => s.length >= 5))];
    expect(needles.length).toBeGreaterThan(10);
    const plain = await createBackup({ dbPath: file, outDir: path.join(dir, "plain"), key: null, mode: "demo", projectRoot: ROOT });
    const enc = await createBackup({ dbPath: file, outDir: path.join(dir, "enc"), key: newKey().key, mode: "demo", projectRoot: ROOT });
    const p = fs.readFileSync(plain.filePath);
    const e = fs.readFileSync(enc.filePath);
    expect(needles.filter((n) => p.includes(Buffer.from(n, "utf8"))).length).toBeGreaterThan(10); // the control: plaintext is there
    for (const n of needles) {
      expect(e.includes(Buffer.from(n, "utf8")), n).toBe(false);
      expect(e.includes(Buffer.from(n, "utf16le")), n).toBe(false);
    }
    expect(e.includes(Buffer.from("SQLite format 3", "latin1"))).toBe(false);
    const manifestText = fs.readFileSync(enc.manifestPath, "utf8");
    for (const n of needles) expect(manifestText).not.toContain(n);
  });

  it("refuses without a key in secured or locked mode, and in demo mode for a database that is not the synthetic one", async () => {
    const { dir, file } = liveDb(0);
    const out = path.join(dir, "backups");
    await expect(createBackup({ dbPath: file, outDir: out, key: null, mode: "secured", projectRoot: ROOT })).rejects.toThrow(/secured mode requires HLOS_BACKUP_KEY/);
    await expect(createBackup({ dbPath: file, outDir: out, key: null, mode: "locked", projectRoot: ROOT })).rejects.toThrow(/HLOS_BACKUP_KEY is required outside the synthetic demo/);
    const db = openDatabase(file);
    linkIdentity(db, { operator: "test", correlationId: "backup-test-link" }, { staffId: "stf_maya", issuer: "https://idp.synthetic.test", subject: "sub-maya", labId: "lab:local" });
    db.close();
    await expect(createBackup({ dbPath: file, outDir: out, key: null, mode: "demo", projectRoot: ROOT })).rejects.toThrow(/not the synthetic demo database/);
    expect(fs.existsSync(out)).toBe(false); // refused before anything was written
    // With a key, any mode backs up.
    const ok = await createBackup({ dbPath: file, outDir: out, key: newKey().key, mode: "secured", projectRoot: ROOT });
    expect(ok.manifest).toMatchObject({ mode: "secured", synthetic: false, label: "encrypted (AES-256-GCM)" });
  });

  it("never writes into the public directory or the database's own directory; a missing database is refused", async () => {
    const { dir, file } = liveDb(0);
    const fakeRoot = path.join(dir, "project");
    fs.mkdirSync(path.join(fakeRoot, "public"), { recursive: true });
    await expect(createBackup({ dbPath: file, outDir: path.join(fakeRoot, "public", "b"), key: null, mode: "demo", projectRoot: fakeRoot })).rejects.toThrow(/inside the public directory/);
    await expect(createBackup({ dbPath: file, outDir: path.dirname(file), key: null, mode: "demo", projectRoot: ROOT })).rejects.toThrow(/the database's own directory/);
    await expect(createBackup({ dbPath: path.join(dir, "nope.db"), outDir: path.join(dir, "b"), key: null, mode: "demo", projectRoot: ROOT })).rejects.toThrow(/No database at/);
    expect(fs.existsSync(path.join(dir, "nope.db"))).toBe(false); // a backup never creates a database
    expect(fs.existsSync(path.join(fakeRoot, "public", "b"))).toBe(false);
  });

  it("HLOS_BACKUP_KEY: 32 bytes as hex or base64; short, weak or reused secrets are refused, naming the variable only", () => {
    const raw = crypto.randomBytes(32);
    const hex = parseBackupKey(raw.toString("hex"), {});
    const b64 = parseBackupKey(raw.toString("base64"), {});
    const b64url = parseBackupKey(raw.toString("base64url"), {});
    for (const r of [hex, b64, b64url]) expect(r.present && r.ok && r.key.key.equals(raw)).toBe(true);
    expect(hex.present && hex.ok && hex.key.id).toMatch(/^bk-[0-9a-f]{12}$/);
    expect(parseBackupKey(undefined, {})).toEqual({ present: false });
    const bad: [string, Record<string, string>, RegExp][] = [
      [crypto.randomBytes(16).toString("hex"), {}, /exactly 32 bytes/],
      ["not a key at all", {}, /exactly 32 bytes/],
      ["00".repeat(32), {}, /looks weak/],
      ["ab".repeat(16) + "cd".repeat(16), {}, /looks weak/],
      [raw.toString("hex"), { HLOS_AUDIT_KEY: raw.toString("hex") }, /same secret as HLOS_AUDIT_KEY/],
      [raw.toString("base64"), { HLOS_SESSION_SECRET: raw.toString("hex") }, /same secret as HLOS_SESSION_SECRET/],
    ];
    for (const [value, env, re] of bad) {
      const r = parseBackupKey(value, env);
      expect(r.present && !r.ok && r.problem, value).toMatch(re);
      expect(JSON.stringify(r)).not.toContain(value);
    }
  });
});

// ------------------------------------------------------------------ the npm scripts

describe("npm run db:backup / db:restore (scripts/backup.ts, scripts/restore.ts)", () => {
  const cli = (script: string, args: string[], env: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
    const r = spawnSync(TSX, [`scripts/${script}.ts`, ...args], { cwd: ROOT, env: merged as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("back up, restore and verify through the scripts; exit codes 0, 1 (tampered) and 2 (refused); no key or record content printed", () => {
    const { dir, file } = liveDb(1);
    const { hex } = newKey();
    const out = path.join(dir, "backups");
    const env = { HLOS_MODE: "demo", HLOS_DB_PATH: file, HLOS_BACKUP_KEY: hex, HLOS_AUDIT_ANCHOR_PATH: undefined };

    const b = cli("backup", ["--out", out], env);
    expect(b.code, b.out).toBe(0);
    expect(b.out).toMatch(/ENCRYPTED \(AES-256-GCM\)/);
    const manifestPath = fs.readdirSync(out).find((n) => n.endsWith(".manifest.json"))!;
    const manifest = path.join(out, manifestPath);

    const r = cli("restore", [manifest, "--target", path.join(dir, "r", "restored.db")], env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Restore verification: PASSED/);
    expect(r.out).toMatch(/\[PASS\] audit head/);

    const again = cli("restore", [manifest, "--target", path.join(dir, "r", "restored.db")], env);
    expect(again.code).toBe(2);
    expect(again.out).toMatch(/already exists at the target path/);
    const onLive = cli("restore", [manifest, "--target", file], env);
    expect(onLive.code).toBe(2);
    expect(onLive.out).toMatch(/the target is the live database/);

    const encFile = path.join(out, manifestPath.replace(".manifest.json", ".sqlite.enc"));
    const buf = fs.readFileSync(encFile);
    buf[100] ^= 0xff;
    fs.writeFileSync(encFile, buf);
    const tampered = cli("restore", [encFile, "--target", path.join(dir, "r", "tampered.db")], env);
    expect(tampered.code, tampered.out).toBe(1);
    expect(tampered.out).toMatch(/\[FAIL\] backup file/);
    expect(fs.existsSync(path.join(dir, "r", "tampered.db"))).toBe(false);

    const db = openDatabase(file);
    const names = all<{ family_name: string }>(db, "SELECT family_name FROM patient_ref").map((p) => p.family_name);
    db.close();
    for (const o of [b.out, r.out, again.out, onLive.out, tampered.out]) {
      expect(o).not.toContain(hex);
      for (const n of names) if (n.length >= 5) expect(o).not.toContain(n);
    }
  }, 120_000);

  it("secured mode without HLOS_BACKUP_KEY refuses (exit 2); an invalid key is refused naming the variable only", () => {
    const { dir, file } = liveDb(0);
    const secured = {
      HLOS_MODE: "secured",
      HLOS_OIDC_ISSUER: "http://127.0.0.1:9/nothing-listens-here",
      HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
      HLOS_OIDC_CLIENT_ID: "hlos-test-client",
      HLOS_OIDC_CLIENT_SECRET: crypto.randomBytes(24).toString("hex"),
      HLOS_PUBLIC_URL: "http://localhost:3999",
      HLOS_LAB_ID: "lab:local",
      HLOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
      HLOS_AUDIT_KEY: crypto.randomBytes(32).toString("hex"),
      HLOS_DB_PATH: file,
      HLOS_BACKUP_KEY: undefined,
    };
    const out = path.join(dir, "backups");
    const r = cli("backup", ["--out", out], secured);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/secured mode requires HLOS_BACKUP_KEY/);
    expect(fs.existsSync(out)).toBe(false);
    const short = "f".repeat(20);
    const r2 = cli("backup", ["--out", out], { ...secured, HLOS_BACKUP_KEY: short });
    expect(r2.code).toBe(2);
    expect(r2.out).toMatch(/HLOS_BACKUP_KEY must be exactly 32 bytes/);
    expect(r2.out).not.toContain(short);
    for (const o of [r.out, r2.out]) {
      expect(o).not.toContain(secured.HLOS_AUDIT_KEY);
      expect(o).not.toContain(secured.HLOS_SESSION_SECRET);
    }
  }, 60_000);
});
