/**
 * Backup and restore (Stage 6 Phase E1). Used by scripts/backup.ts and scripts/restore.ts; read
 * docs/release/backup-restore.md before relying on any of this.
 *
 * BACKUP
 * - A consistent snapshot through SQLite's online backup API (better-sqlite3 `db.backup()`), copied in ONE step so a
 *   write from another connection in the middle cannot leave a mixed copy (the API restarts and copies everything in
 *   that one step). In WAL mode the snapshot holds only a read transaction: writers are never blocked.
 * - The snapshot is switched to journal_mode=DELETE (one self-contained file), checked (integrity_check), described
 *   (schema fingerprint, per-table row counts, audit chain head, audit verification) and hashed (SHA-256).
 * - With HLOS_BACKUP_KEY (32 bytes, hex or base64) it is encrypted with AES-256-GCM: a random 12-byte IV per file,
 *   the 16-byte tag at the end of the file and in the manifest, and additional authenticated data that binds the
 *   manifest's expectations (backup id, creation time, database checksum, schema fingerprint, row counts, audit
 *   head). Editing any of them in the manifest makes the tag fail. The plaintext snapshot is written only inside the
 *   live database's own directory (no new place holds plaintext), and removed afterwards (an ordinary removal, not
 *   secure erasure: data-protection.md section 7).
 * - Without a key it REFUSES, except in synthetic demo mode on the synthetic demo database, where the backup is
 *   written unencrypted and labelled "synthetic, unencrypted".
 * - Never inside the public directory, never in the database's own directory. Default: data/backups/ (gitignored)
 *   or HLOS_BACKUP_DIR; `--out <dir>` otherwise.
 *
 * RESTORE
 * - Only to a path where nothing exists yet (no file, no link, no -wal/-shm/-journal beside it), never the live
 *   database path or one of its companion files. The file is written to a temporary name in the target's directory
 *   and linked into place without overwriting anything.
 * - Checks, in order, stopping before anything is written when one of the first four fails: the manifest; the
 *   backup file's size and SHA-256; decryption (key id, the GCM tag in the file and in the manifest, the tag
 *   itself); the decrypted database's SHA-256. Then, on the restored file: integrity_check, foreign_key_check,
 *   schema fingerprint, row counts, the audit chain (verifyAuditChain with the key, and the anchors that are not
 *   newer than the backup), and the chain head against the manifest.
 */
import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/db";
import { AuditAnchorError, readAnchorFile, resolveAnchorPath, verifyAuditChain, type AuditAnchor } from "../core/audit-seal";
import { auditKeyFromEnv, demoAuditKey, DEMO_AUDIT_KEY_ID, type AuditKeyConfig } from "../auth/config";
import { canonicalJson, labScope } from "../core/idempotency";
import type { RuntimeMode } from "../runtime-mode";
import {
  ENCRYPTED_SUFFIX,
  LABEL_ENCRYPTED,
  LABEL_UNENCRYPTED,
  MANIFEST_FORMAT,
  MANIFEST_SUFFIX,
  ManifestError,
  manifestPathFor,
  parseManifest,
  PLAIN_SUFFIX,
  type AuditHead,
  type BackupManifest,
  type ManifestEncryptionGcm,
} from "./backup-manifest";

export * from "./backup-manifest";

/** A configuration or safety refusal: nothing was written (CLI exit code 2). */
export class BackupRefused extends Error {
  readonly exitCode = 2 as const;
}

export const BACKUP_KEY_ENV = "HLOS_BACKUP_KEY";
/** File header: 8 magic bytes, then the 12-byte IV. The 16-byte GCM tag is the last 16 bytes of the file. */
export const ENCRYPTION_MAGIC = Buffer.from("HLOSBK01", "ascii");
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const HEADER_BYTES = ENCRYPTION_MAGIC.length + IV_BYTES;
const LAYOUT = "magic 'HLOSBK01' (8 bytes) + IV (12 bytes) + AES-256-GCM ciphertext + tag (16 bytes)";
const AAD_BINDS = ["backup_id", "created_at", "database.bytes", "database.sha256", "schema.fingerprint", "row_counts", "audit.head"];

// ------------------------------------------------------------------ keys

export interface BackupKey {
  key: Buffer;
  /** "bk-" + 12 hex characters of an HMAC of a fixed label under the key: names the key, never reveals it. */
  id: string;
}

export type BackupKeyResult = { present: false } | { present: true; ok: true; key: BackupKey } | { present: true; ok: false; problem: string };

export function backupKeyId(key: Buffer): string {
  return `bk-${createHmac("sha256", key).update("hlos-backup-key-id/v1").digest("hex").slice(0, 12)}`;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * HLOS_BACKUP_KEY: exactly 32 bytes, as 64 hex characters or base64 (standard or URL-safe). Refused when it looks
 * weak (fewer than 16 distinct bytes) or is the same secret as the audit key, the session secret or the OIDC client
 * secret (one secret, one purpose: whoever holds a backup and its key must not also get the audit key). Problems name
 * the variable, never its value.
 */
export function parseBackupKey(raw: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): BackupKeyResult {
  const v = (raw ?? "").trim();
  if (!v) return { present: false };
  let key: Buffer | null = null;
  if (HEX64.test(v)) key = Buffer.from(v, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v, "base64");
    if (b.length === 32) key = b;
  }
  if (!key) {
    return { present: true, ok: false, problem: `${BACKUP_KEY_ENV} must be exactly 32 bytes, written as 64 hex characters or as base64 (generate one with: openssl rand -hex 32).` };
  }
  if (new Set(key).size < 16) {
    return { present: true, ok: false, problem: `${BACKUP_KEY_ENV} looks weak (too few distinct bytes). Generate one with: openssl rand -hex 32.` };
  }
  for (const other of ["HLOS_AUDIT_KEY", "HLOS_SESSION_SECRET", "HLOS_OIDC_CLIENT_SECRET"]) {
    const o = env[other]?.trim();
    if (!o) continue;
    if (o === v || Buffer.from(o, "utf8").equals(key) || (HEX64.test(o) && Buffer.from(o, "hex").equals(key))) {
      return { present: true, ok: false, problem: `${BACKUP_KEY_ENV} must not be the same secret as ${other}: keep the backup key and the audit key apart.` };
    }
  }
  return { present: true, ok: true, key: { key, id: backupKeyId(key) } };
}

export function backupKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): BackupKeyResult {
  return parseBackupKey(env[BACKUP_KEY_ENV], env);
}

/**
 * The audit key that verifies a chain sealed under `keyId`: the public demo key for "demo-not-secret", otherwise
 * HLOS_AUDIT_KEY when it is valid and has that id.
 */
export function auditKeyFor(keyId: string | null | undefined): { key: AuditKeyConfig | null; problem: string | null } {
  if (!keyId) return { key: null, problem: "Nothing is sealed, so there is no key to verify with." };
  if (keyId === DEMO_AUDIT_KEY_ID) return { key: demoAuditKey(), problem: null };
  const k = auditKeyFromEnv();
  if (!k.ok) return { key: null, problem: `HLOS_AUDIT_KEY is missing or invalid, and the audit chain was sealed with key ${keyId}.` };
  if (k.key.id !== keyId) return { key: null, problem: `HLOS_AUDIT_KEY has key id ${k.key.id}, but the audit chain was sealed with key ${keyId}.` };
  return { key: k.key, problem: null };
}

// ------------------------------------------------------------------ describing a database

/** SHA-256 over every schema object (type, name, table, normalized SQL), in a fixed order. SQLite's internal tables are left out. */
export function schemaFingerprint(db: DB): { fingerprint: string; objects: number } {
  const rows = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const h = createHash("sha256");
  for (const r of rows) h.update(JSON.stringify([r.type, r.name, r.tbl_name, (r.sql ?? "").replace(/\s+/g, " ").trim()])).update("\n");
  return { fingerprint: h.digest("hex"), objects: rows.length };
}

/** Row count of every table (SQLite's internal tables left out), by name. */
export function tableRowCounts(db: DB): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .all() as { name: string }[];
  const out: Record<string, number> = {};
  for (const t of tables) out[t.name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n;
  return out;
}

function hasTable(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** The newest seal: { seq, mac, key_id }, or null when nothing is sealed. */
export function auditHead(db: DB): AuditHead | null {
  if (!hasTable(db, "audit_seal")) return null;
  const r = db.prepare("SELECT seq, mac, key_id FROM audit_seal ORDER BY seq DESC LIMIT 1").get() as AuditHead | undefined;
  return r ? { seq: r.seq, mac: r.mac, key_id: r.key_id } : null;
}

/** The synthetic demo database: the seed marker is present and no sign-in identity is linked (same rule as assertSyntheticForDemo). */
export function isSyntheticDemoDb(db: DB): boolean {
  const seeded = hasTable(db, "app_setting") && !!db.prepare("SELECT 1 FROM app_setting WHERE key = 'seeded_at'").get();
  const linked = hasTable(db, "staff_identity") && !!db.prepare("SELECT 1 FROM staff_identity LIMIT 1").get();
  return seeded && !linked;
}

function integrityCheck(db: DB): { ok: boolean; text: string } {
  const rows = (db.pragma("integrity_check") as { integrity_check: string }[]).map((r) => r.integrity_check);
  if (rows.length === 1 && rows[0] === "ok") return { ok: true, text: "ok" };
  return { ok: false, text: `${rows.length} problem(s) reported` };
}

// ------------------------------------------------------------------ files

function sha256Buffer(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    h.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: h.digest("hex"), bytes };
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

function writeFileAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    writeAll(fd, Buffer.from(text, "utf8"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** The real path of `p`, with symbolic links resolved for the part that exists. */
function realPathLoose(p: string): string {
  let dir = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.join(dir, ...rest.reverse());
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/** The additional authenticated data: binds the manifest's expectations to the ciphertext. */
export function aadFor(m: Pick<BackupManifest, "backup_id" | "created_at" | "database" | "schema" | "row_counts" | "audit">): Buffer {
  const expectations = {
    backup_id: m.backup_id,
    created_at: m.created_at,
    database: { bytes: m.database.bytes, sha256: m.database.sha256 },
    schema_fingerprint: m.schema.fingerprint,
    row_counts: m.row_counts,
    audit_head: m.audit.head ?? null,
  };
  return Buffer.from(`hlos.backup/1\n${m.backup_id}\n${sha256Buffer(canonicalJson(expectations))}`, "utf8");
}

async function encryptFile(src: string, dst: string, key: Buffer, iv: Buffer, aad: Buffer): Promise<{ sha256: string; bytes: number; tag: string }> {
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const hash = createHash("sha256");
  let bytes = 0;
  const fd = fs.openSync(dst, "wx", 0o600);
  try {
    const write = (buf: Buffer) => {
      if (!buf.length) return;
      writeAll(fd, buf);
      hash.update(buf);
      bytes += buf.length;
    };
    write(ENCRYPTION_MAGIC);
    write(iv);
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 1 << 20 })) write(cipher.update(chunk as Buffer));
    write(cipher.final());
    const tag = cipher.getAuthTag();
    write(tag);
    fs.fsyncSync(fd);
    return { sha256: hash.digest("hex"), bytes, tag: tag.toString("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

function gitCommit(root: string): string | null {
  const given = process.env.HLOS_GIT_COMMIT?.trim();
  if (given && /^[0-9a-f]{7,40}$/i.test(given)) return given.toLowerCase();
  try {
    const out = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function appInfo(root: string): BackupManifest["app"] {
  let name = "histology-lab-os";
  let version: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (typeof pkg.name === "string") name = pkg.name;
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    /* unknown version */
  }
  return { name, version, git_commit: gitCommit(root) };
}

// ------------------------------------------------------------------ backup

export interface CreateBackupOptions {
  /** The live database file. */
  dbPath: string;
  /** Where the backup and its manifest go (created when missing, mode 0700). */
  outDir: string;
  /** null: no HLOS_BACKUP_KEY (refused unless synthetic demo). */
  key: BackupKey | null;
  /** The runtime mode of this process (labels and the refusal rule). */
  mode: RuntimeMode;
  /** For the public-directory rule, package.json and the git commit. Default: the working directory. */
  projectRoot?: string;
}

export interface CreateBackupResult {
  manifest: BackupManifest;
  manifestPath: string;
  filePath: string;
}

/** Refuses an output directory inside the public directory or equal to the database's own directory. */
export function checkBackupDir(outDir: string, dbPath: string, projectRoot: string = process.cwd()): string {
  const out = path.resolve(outDir);
  const realOut = realPathLoose(out);
  const pub = realPathLoose(path.join(projectRoot, "public"));
  if (within(realOut, pub)) {
    throw new BackupRefused("Refused: the backup directory is inside the public directory, which the web server serves. Use data/backups/ (the default) or another --out directory.");
  }
  if (realOut === realPathLoose(path.dirname(path.resolve(dbPath)))) {
    throw new BackupRefused("Refused: the backup directory is the database's own directory. Use data/backups/ (the default) or another --out directory.");
  }
  return out;
}

interface Inspected {
  database: Omit<BackupManifest["database"], "bytes" | "sha256">;
  schema: BackupManifest["schema"];
  row_counts: Record<string, number>;
  audit: BackupManifest["audit"];
  integrityOk: boolean;
}

/** Switches the snapshot to one self-contained file and describes it. Runs on the snapshot only, never the live database. */
function inspectSnapshot(file: string): Inspected {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma("journal_mode = DELETE");
    const integrity = integrityCheck(db);
    const fp = schemaFingerprint(db);
    const head = auditHead(db);
    const counts = hasTable(db, "audit_event")
      ? (db.prepare("SELECT (SELECT COUNT(*) FROM audit_event) AS events, (SELECT COUNT(*) FROM audit_seal) AS seals").get() as { events: number; seals: number })
      : { events: 0, seals: 0 };
    let verified: BackupManifest["audit"]["verified_at_backup"] = null;
    const ak = auditKeyFor(head?.key_id);
    if (ak.key) {
      const v = verifyAuditChain(db, { key: ak.key });
      verified = {
        ok: v.ok,
        key_id: v.keyId,
        demo_key: v.demoKey,
        checked: v.checked,
        sealed_through: v.sealedThrough,
        first_problem: v.firstProblem ? { seq: v.firstProblem.seq, kind: v.firstProblem.kind } : null,
      };
    }
    return {
      database: {
        page_size: db.pragma("page_size", { simple: true }) as number,
        page_count: db.pragma("page_count", { simple: true }) as number,
        journal_mode: String(db.pragma("journal_mode", { simple: true })),
        integrity_check: integrity.text,
      },
      schema: { fingerprint: fp.fingerprint, objects: fp.objects, user_version: db.pragma("user_version", { simple: true }) as number },
      row_counts: tableRowCounts(db),
      audit: { head, events: counts.events, seals: counts.seals, lab: labScope(db), verified_at_backup: verified },
      integrityOk: integrity.ok,
    };
  } finally {
    db.close();
  }
}

/**
 * Takes one backup. Throws BackupRefused (nothing written) for a missing database, a refused directory, or a missing
 * key outside the synthetic demo. The manifest records integrity_check; a snapshot that fails it is still written
 * (it may be the best copy there is) and `manifest.database.integrity_check` says so: the CLI then exits 1.
 */
export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const root = path.resolve(opts.projectRoot ?? process.cwd());
  if (opts.dbPath === ":memory:") throw new BackupRefused("An in-memory database cannot be backed up.");
  const dbPath = path.resolve(opts.dbPath);
  if (!fs.existsSync(dbPath)) throw new BackupRefused(`No database at ${dbPath} (set HLOS_DB_PATH). Nothing was backed up.`);
  const outDir = checkBackupDir(opts.outDir, dbPath, root);

  const src = new Database(dbPath, { fileMustExist: true });
  const cleanup: string[] = [];
  let snapDir: string | null = null;
  try {
    src.pragma("busy_timeout = 5000");
    if (!hasTable(src, "app_setting")) throw new BackupRefused("Refused: this file is not a Histology Lab OS database. Nothing was backed up.");
    const synthetic = isSyntheticDemoDb(src);
    const encrypt = opts.key !== null;
    if (!encrypt) {
      if (opts.mode === "secured") {
        throw new BackupRefused(`Refused: secured mode requires ${BACKUP_KEY_ENV} (32 bytes, hex or base64). A backup holds every record in plain form. Nothing was backed up.`);
      }
      if (opts.mode !== "demo") {
        throw new BackupRefused(`Refused: ${BACKUP_KEY_ENV} is required outside the synthetic demo (HLOS_MODE is not demo). Nothing was backed up.`);
      }
      if (!synthetic) {
        throw new BackupRefused(
          `Refused: this is not the synthetic demo database (no synthetic seed marker, or a linked sign-in identity). An unencrypted backup is allowed only for the synthetic demo; set ${BACKUP_KEY_ENV}. Nothing was backed up.`,
        );
      }
    }

    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const backupId = `hlos-backup-${stamp}-${randomBytes(3).toString("hex")}`;
    const fileName = backupId + (encrypt ? ENCRYPTED_SUFFIX : PLAIN_SUFFIX);
    const filePath = path.join(outDir, fileName);
    const manifestPath = path.join(outDir, backupId + MANIFEST_SUFFIX);

    // Plaintext never goes anywhere new: an encrypted backup's snapshot is made in the live database's own directory
    // (already holding the same data in plain form) and removed after encryption; only ciphertext reaches outDir.
    let snapPath: string;
    if (encrypt) {
      snapDir = fs.mkdtempSync(path.join(path.dirname(dbPath), ".hlos-backup-"));
      fs.chmodSync(snapDir, 0o700);
      snapPath = path.join(snapDir, "snapshot.sqlite");
    } else {
      snapPath = path.join(outDir, `.${backupId}.partial`);
      cleanup.push(snapPath);
    }
    // One step: every remaining page in a single backup_step() call (consistent; restarts inside that step if
    // another connection wrote after the first, page-count step).
    await src.backup(snapPath, { progress: () => 0x7fffffff });
    const createdAt = new Date().toISOString();
    src.close();
    fs.chmodSync(snapPath, 0o600);

    const inspected = inspectSnapshot(snapPath);
    const plain = await sha256File(snapPath);
    const described = {
      backup_id: backupId,
      created_at: createdAt,
      database: { bytes: plain.bytes, sha256: plain.sha256, ...inspected.database },
      schema: inspected.schema,
      row_counts: inspected.row_counts,
      audit: inspected.audit,
    };

    let file: BackupManifest["file"];
    let encryption: BackupManifest["encryption"];
    if (encrypt) {
      const iv = randomBytes(IV_BYTES);
      const tmpOut = path.join(outDir, `.${fileName}.partial`);
      cleanup.push(tmpOut);
      const r = await encryptFile(snapPath, tmpOut, opts.key!.key, iv, aadFor(described));
      fs.renameSync(tmpOut, filePath);
      file = { name: fileName, bytes: r.bytes, sha256: r.sha256 };
      encryption = {
        algorithm: "aes-256-gcm",
        key_id: opts.key!.id,
        key_source: "HLOS_BACKUP_KEY",
        iv: iv.toString("hex"),
        tag: r.tag,
        tag_bytes: TAG_BYTES,
        layout: LAYOUT,
        aad_binds: AAD_BINDS,
      } satisfies ManifestEncryptionGcm;
    } else {
      fs.renameSync(snapPath, filePath);
      file = { name: fileName, bytes: plain.bytes, sha256: plain.sha256 };
      encryption = { algorithm: "none", note: "Synthetic demo database: NOT encrypted. An unencrypted backup is refused for any other database and in secured mode." };
    }

    const manifest: BackupManifest = {
      format: MANIFEST_FORMAT,
      backup_id: backupId,
      created_at: createdAt,
      label: encrypt ? LABEL_ENCRYPTED : LABEL_UNENCRYPTED,
      mode: opts.mode,
      synthetic,
      method: "sqlite-online-backup-api",
      app: appInfo(root),
      source: { file_name: path.basename(dbPath) },
      file,
      database: described.database,
      schema: described.schema,
      row_counts: described.row_counts,
      audit: described.audit,
      encryption,
      notice:
        "Restore only into a new path: npm run db:restore -- <this manifest or the backup file> --target <new path>. A restore loses everything written after created_at. " +
        (encrypt ? "Keep HLOS_BACKUP_KEY and HLOS_AUDIT_KEY apart from this backup." : "Synthetic, unencrypted: never use this form for real data."),
    };
    writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, manifestPath, filePath };
  } finally {
    if (src.open) src.close();
    for (const p of cleanup) fs.rmSync(p, { force: true });
    if (snapDir) fs.rmSync(snapDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ restore

export type CheckResult = "pass" | "fail" | "skip";

export interface RestoreCheck {
  name: string;
  result: CheckResult;
  /** Plain words: counts, ids, checksums prefixes. No record content, no key. */
  detail: string;
}

export interface RestoreReport {
  ok: boolean;
  backupId: string;
  createdAt: string;
  label: string;
  target: string;
  /** The target file was written (it is kept even when a later check fails, for investigation: do not use it then). */
  restored: boolean;
  checks: RestoreCheck[];
  /** The restored audit chain head (seq), when verified. */
  restoredHeadSeq: number | null;
}

export interface RestoreOptions {
  /** The backup file or its manifest. */
  source: string;
  /** A new path: nothing may exist there. */
  target: string;
  /** The live database path (refused as a target, with its -wal/-shm/-journal). */
  liveDbPath: string;
  /** HLOS_BACKUP_KEY (required for an encrypted backup). */
  key: BackupKey | null;
  /** An anchor file to verify the restored chain against (anchors newer than the backup are reported, not used). */
  anchorsFile?: string | null;
}

const COMPANIONS = ["-wal", "-shm", "-journal"];

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Refuses a target that exists (anything at all, or a companion file) or is the live database or one of its companions. */
export function checkRestoreTarget(target: string, liveDbPath: string): string {
  const t = path.resolve(target);
  const live = path.resolve(liveDbPath);
  const liveForms = new Set<string>();
  for (const base of [live, realPathLoose(live)]) {
    liveForms.add(base);
    for (const c of COMPANIONS) liveForms.add(base + c);
  }
  if (liveForms.has(t) || liveForms.has(realPathLoose(t))) {
    throw new BackupRefused("Refused: the target is the live database (or one of its -wal/-shm/-journal files). Restore into a new, isolated path.");
  }
  if (lexists(t)) throw new BackupRefused("Refused: something already exists at the target path. A restore never overwrites anything; choose a new path.");
  for (const c of COMPANIONS) {
    if (lexists(t + c)) throw new BackupRefused(`Refused: a ${c} file already exists beside the target path; SQLite would mix it into the restored database. Choose a new path.`);
  }
  return t;
}

function shortHash(h: string): string {
  return `${h.slice(0, 12)}…`;
}

/** Decrypts into `dst` (created, must not exist) and returns the plaintext SHA-256; throws when the tag does not verify. */
async function decryptInto(src: string, dst: string, key: Buffer, iv: Buffer, tag: Buffer, aad: Buffer, size: number): Promise<{ sha256: string; bytes: number }> {
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const hash = createHash("sha256");
  let bytes = 0;
  const fd = fs.openSync(dst, "wx", 0o600);
  try {
    const write = (buf: Buffer) => {
      if (!buf.length) return;
      writeAll(fd, buf);
      hash.update(buf);
      bytes += buf.length;
    };
    const end = size - TAG_BYTES - 1;
    if (end >= HEADER_BYTES) {
      for await (const chunk of fs.createReadStream(src, { start: HEADER_BYTES, end, highWaterMark: 1 << 20 })) write(decipher.update(chunk as Buffer));
    }
    write(decipher.final()); // throws when the tag does not verify
    fs.fsyncSync(fd);
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

async function copyInto(src: string, dst: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const fd = fs.openSync(dst, "wx", 0o600);
  try {
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 1 << 20 })) {
      writeAll(fd, chunk as Buffer);
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    fs.fsyncSync(fd);
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

/** Puts `tmp` at `target` without ever overwriting: a hard link (fails if the target appeared), else an exclusive copy. */
function placeNoClobber(tmp: string, target: string): void {
  try {
    fs.linkSync(tmp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new BackupRefused("Refused: something appeared at the target path during the restore. Nothing was overwritten.");
    fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL);
  }
  fs.rmSync(tmp, { force: true });
}

/**
 * Restores a backup into a NEW path and verifies it. Throws BackupRefused (nothing written) for a missing or
 * malformed manifest, a target that exists or is the live database, a missing backup key, or an audit key that
 * cannot verify this backup's chain. Every other problem is a failed check in the report (`ok: false`).
 */
export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const manifestPath = manifestPathFor(opts.source);
  let manifest: BackupManifest;
  try {
    manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    if (e instanceof ManifestError) throw new BackupRefused(`Refused: ${e.message} Nothing was restored.`);
    throw new BackupRefused("Refused: the manifest could not be read (it must sit beside the backup file, named <backup id>.manifest.json). Nothing was restored.");
  }
  const target = checkRestoreTarget(opts.target, opts.liveDbPath);
  const encrypted = manifest.encryption.algorithm === "aes-256-gcm";
  if (encrypted && !opts.key) throw new BackupRefused(`Refused: this backup is encrypted; set ${BACKUP_KEY_ENV} to the key it was made with (key id ${(manifest.encryption as ManifestEncryptionGcm).key_id}). Nothing was restored.`);
  const head = manifest.audit.head;
  const auditKey = head ? auditKeyFor(head.key_id) : { key: null, problem: null };
  if (head && !auditKey.key) throw new BackupRefused(`Refused: the restored audit chain could not be verified. ${auditKey.problem} Nothing was restored.`);

  const checks: RestoreCheck[] = [];
  const report = (restored: boolean, restoredHeadSeq: number | null = null): RestoreReport => ({
    ok: checks.every((c) => c.result !== "fail"),
    backupId: manifest.backup_id,
    createdAt: manifest.created_at,
    label: manifest.label,
    target,
    restored,
    checks,
    restoredHeadSeq,
  });
  const pass = (name: string, detail: string) => checks.push({ name, result: "pass", detail });
  const fail = (name: string, detail: string) => checks.push({ name, result: "fail", detail });
  const skip = (name: string, detail: string) => checks.push({ name, result: "skip", detail });

  pass("manifest", `${manifest.backup_id}, created ${manifest.created_at}, ${manifest.label}.`);

  // 1. The backup file as stored.
  const filePath = path.join(path.dirname(manifestPath), manifest.file.name);
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    fail("backup file", `The backup file ${manifest.file.name} is missing beside its manifest.`);
    return report(false);
  }
  if (size !== manifest.file.bytes) {
    fail("backup file", `The file is ${size} bytes; the manifest says ${manifest.file.bytes}: it was truncated or altered.`);
    return report(false);
  }
  const stored = await sha256File(filePath);
  if (stored.sha256 !== manifest.file.sha256) {
    fail("backup file", `SHA-256 ${shortHash(stored.sha256)} does not match the manifest (${shortHash(manifest.file.sha256)}): the file was altered or damaged.`);
    return report(false);
  }
  pass("backup file", `${size} bytes, SHA-256 ${shortHash(stored.sha256)} matches the manifest.`);

  // 2. Decryption (or a plain copy) into a temporary file beside the target.
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.restoring-${randomBytes(4).toString("hex")}`);
  let plain: { sha256: string; bytes: number };
  try {
    if (encrypted) {
      const enc = manifest.encryption as ManifestEncryptionGcm;
      if (typeof enc.tag !== "string" || !/^[0-9a-f]{32}$/.test(enc.tag)) {
        fail("decryption", "The manifest carries no GCM authentication tag: refusing to decrypt unauthenticated data.");
        return report(false);
      }
      if (opts.key!.id !== enc.key_id) {
        fail("decryption", `Wrong key: ${BACKUP_KEY_ENV} is key ${opts.key!.id}, but this backup was encrypted with key ${enc.key_id}.`);
        return report(false);
      }
      if (size < HEADER_BYTES + TAG_BYTES) {
        fail("decryption", "The file is too short to hold the header and the authentication tag: it was truncated.");
        return report(false);
      }
      const fd = fs.openSync(filePath, "r");
      const header = Buffer.alloc(HEADER_BYTES);
      const fileTag = Buffer.alloc(TAG_BYTES);
      try {
        fs.readSync(fd, header, 0, HEADER_BYTES, 0);
        fs.readSync(fd, fileTag, 0, TAG_BYTES, size - TAG_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      if (!header.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
        fail("decryption", "The file does not start with the backup header: it is not an encrypted backup of this format.");
        return report(false);
      }
      const iv = header.subarray(ENCRYPTION_MAGIC.length);
      if (iv.toString("hex") !== enc.iv) {
        fail("decryption", "The IV in the file does not match the manifest.");
        return report(false);
      }
      if (fileTag.toString("hex") !== enc.tag) {
        fail("decryption", "The authentication tag at the end of the file does not match the manifest: the file was truncated or altered.");
        return report(false);
      }
      try {
        plain = await decryptInto(filePath, tmp, opts.key!.key, iv, fileTag, aadFor(manifest), size);
      } catch {
        fs.rmSync(tmp, { force: true });
        fail("decryption", "AES-256-GCM authentication failed: the ciphertext, the manifest's recorded expectations or the key do not match. Nothing was restored.");
        return report(false);
      }
      pass("decryption", `AES-256-GCM tag verified with key ${enc.key_id}; the manifest's expectations are authenticated.`);
    } else {
      plain = await copyInto(filePath, tmp);
      skip("decryption", "Not encrypted (synthetic, unencrypted demo backup): nothing authenticates this file and its manifest together.");
    }

    // 3. The database image.
    if (plain.sha256 !== manifest.database.sha256 || plain.bytes !== manifest.database.bytes) {
      fs.rmSync(tmp, { force: true });
      fail("database checksum", `The database image (${plain.bytes} bytes, SHA-256 ${shortHash(plain.sha256)}) does not match the manifest. Nothing was restored.`);
      return report(false);
    }
    pass("database checksum", `${plain.bytes} bytes, SHA-256 ${shortHash(plain.sha256)} matches the manifest.`);
    placeNoClobber(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  // 4. Verify the restored file.
  const db = new Database(target, { fileMustExist: true });
  let restoredHeadSeq: number | null = null;
  try {
    const integrity = integrityCheck(db);
    if (integrity.ok) pass("integrity_check", "ok");
    else fail("integrity_check", integrity.text);

    const fk = db.pragma("foreign_key_check") as { table: string }[];
    if (!fk.length) pass("foreign_key_check", "no violations");
    else fail("foreign_key_check", `${fk.length} violation(s) in: ${[...new Set(fk.map((r) => r.table))].slice(0, 8).join(", ")}`);

    // Before anything else opens the schema: the fingerprint of the file exactly as restored.
    const fp = schemaFingerprint(db);
    if (fp.fingerprint === manifest.schema.fingerprint) pass("schema fingerprint", `${fp.objects} schema objects, ${shortHash(fp.fingerprint)} matches the manifest.`);
    else fail("schema fingerprint", `${shortHash(fp.fingerprint)} does not match the manifest (${shortHash(manifest.schema.fingerprint)}).`);

    const counts = tableRowCounts(db);
    const names = new Set([...Object.keys(counts), ...Object.keys(manifest.row_counts)]);
    const diffs: string[] = [];
    for (const n of [...names].sort()) {
      if (counts[n] !== manifest.row_counts[n]) diffs.push(`${n}: restored ${counts[n] ?? "missing"}, manifest ${manifest.row_counts[n] ?? "missing"}`);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!diffs.length) pass("row counts", `${Object.keys(counts).length} tables, ${total} rows, every count equal to the manifest.`);
    else fail("row counts", `${diffs.length} table(s) differ: ${diffs.slice(0, 5).join("; ")}`);

    // Anchors: those at or before the backup's head must match; newer ones describe history this backup does not hold.
    let anchors: AuditAnchor[] = [];
    let newer = 0;
    let anchorProblem: string | null = null;
    if (opts.anchorsFile) {
      try {
        const all = readAnchorFile(resolveAnchorPath(db, opts.anchorsFile));
        const limit = head?.seq ?? 0;
        anchors = all.filter((a) => a.seq <= limit);
        newer = all.length - anchors.length;
      } catch (e) {
        anchorProblem = e instanceof AuditAnchorError ? e.message : "The anchor file could not be used.";
      }
    }

    if (!head) {
      const events = hasTable(db, "audit_event") ? (db.prepare("SELECT COUNT(*) AS n FROM audit_event").get() as { n: number }).n : 0;
      if (events === 0) skip("audit chain", "The backup holds no audit event.");
      else fail("audit chain", `The backup holds ${events} audit event(s) and no seal: nothing vouches for them.`);
    } else {
      const v = verifyAuditChain(db, { key: auditKey.key!, anchors });
      const demoNote = v.demoKey ? " (the PUBLIC demo key: these seals prove nothing)" : "";
      if (v.ok) pass("audit chain", `${v.checked} events verified with key ${v.keyId}${demoNote}, sealed through seq ${v.sealedThrough}.`);
      else fail("audit chain", `Failed at seq ${v.firstProblem?.seq}: ${v.firstProblem?.kind}. ${v.firstProblem?.detail ?? ""}`.trim());

      const restoredHead = auditHead(db);
      restoredHeadSeq = restoredHead?.seq ?? null;
      if (restoredHead && restoredHead.seq === head.seq && restoredHead.mac === head.mac && restoredHead.key_id === head.key_id && v.ok && v.sealedThrough === head.seq) {
        pass("audit head", `seq ${head.seq}, MAC ${shortHash(head.mac)}, key ${head.key_id}: equal to the manifest.`);
      } else {
        fail("audit head", `The restored head (seq ${restoredHead?.seq ?? "none"}) does not equal the manifest's (seq ${head.seq}) or does not verify.`);
      }
    }

    if (!opts.anchorsFile) {
      skip("audit anchors", "No anchor file given (--anchors or HLOS_AUDIT_ANCHOR_PATH): a rewrite made with the audit key would not be detected.");
    } else if (anchorProblem) {
      fail("audit anchors", anchorProblem);
    } else {
      const newerNote = newer ? ` ${newer} newer anchor(s) vouch for history after this backup, which a restore loses.` : "";
      const failedHere = checks.some((c) => c.name === "audit chain" && c.result === "fail");
      if (failedHere) fail("audit anchors", `${anchors.length} anchor(s) at or before the backup's head were compared; see the audit chain result.${newerNote}`);
      else pass("audit anchors", `${anchors.length} anchor(s) at or before the backup's head match the restored chain.${newerNote}`);
    }
  } finally {
    db.close();
  }
  return report(true, restoredHeadSeq);
}
