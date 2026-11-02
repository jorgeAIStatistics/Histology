/**
 * The backup manifest (Stage 6 Phase E1): the JSON file written next to every backup by scripts/backup.ts and read
 * by scripts/restore.ts and the health details (age of the newest backup).
 *
 * A manifest describes ONE backup file. It holds no secret and no patient data: table names and row counts, the
 * schema fingerprint, checksums, the audit chain head (seq, MAC, key id: a MAC reveals nothing without the key),
 * and the encryption parameters (algorithm, key id, IV, GCM tag; never the key).
 *
 * Read docs/release/backup-restore.md before relying on any of this.
 */
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FORMAT = "hlos.backup-manifest/1";
export const MANIFEST_SUFFIX = ".manifest.json";
/** Encrypted file layout: MAGIC (8 bytes) + IV (12 bytes) + AES-256-GCM ciphertext + tag (16 bytes). */
export const ENCRYPTED_SUFFIX = ".sqlite.enc";
export const PLAIN_SUFFIX = ".sqlite";
export const LABEL_UNENCRYPTED = "synthetic, unencrypted";
export const LABEL_ENCRYPTED = "encrypted (AES-256-GCM)";

export interface AuditHead {
  seq: number;
  mac: string;
  key_id: string;
}

export interface ManifestEncryptionNone {
  algorithm: "none";
  note: string;
}

export interface ManifestEncryptionGcm {
  algorithm: "aes-256-gcm";
  /** Names the key (HMAC of a fixed label under the key); never the key. */
  key_id: string;
  key_source: "HLOS_BACKUP_KEY";
  /** Hex, 12 bytes, random per file. Also in the file header. */
  iv: string;
  /** Hex, 16 bytes. Also the last 16 bytes of the file. */
  tag: string;
  tag_bytes: 16;
  layout: string;
  /** What the additional authenticated data binds (recomputed from this manifest at restore, never stored). */
  aad_binds: string[];
}

export interface BackupManifest {
  format: typeof MANIFEST_FORMAT;
  backup_id: string;
  /** Wall-clock time the snapshot completed (ISO). */
  created_at: string;
  label: typeof LABEL_UNENCRYPTED | typeof LABEL_ENCRYPTED;
  /** Runtime mode of the process that took the backup (demo | secured | locked). */
  mode: string;
  /** The database carried the synthetic seed marker and no linked sign-in identity. */
  synthetic: boolean;
  method: "sqlite-online-backup-api";
  app: { name: string; version: string | null; git_commit: string | null };
  /** The live database's file name only (never its directory). */
  source: { file_name: string };
  /** The backup file as stored (ciphertext when encrypted). */
  file: { name: string; bytes: number; sha256: string };
  /** The SQLite database image inside it (plaintext). */
  database: { bytes: number; sha256: string; page_size: number; page_count: number; journal_mode: string; integrity_check: string };
  schema: { fingerprint: string; objects: number; user_version: number };
  row_counts: Record<string, number>;
  audit: {
    head: AuditHead | null;
    events: number;
    seals: number;
    lab: string;
    /** The chain verified on the snapshot when the backup was taken (null: no usable audit key in that environment). */
    verified_at_backup: {
      ok: boolean;
      key_id: string;
      demo_key: boolean;
      checked: number;
      sealed_through: number;
      first_problem: { seq: number; kind: string } | null;
    } | null;
  };
  encryption: ManifestEncryptionNone | ManifestEncryptionGcm;
  notice: string;
}

export class ManifestError extends Error {}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Validates the shape a restore relies on. Throws ManifestError naming the first problem (field names only).
 * A missing GCM tag is reported by the restore itself (as a failed check), not here, so that it is visible.
 */
export function parseManifest(raw: string): BackupManifest {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ManifestError("The manifest is not valid JSON.");
  }
  if (!isObj(v)) throw new ManifestError("The manifest is not a JSON object.");
  if (v.format !== MANIFEST_FORMAT) throw new ManifestError(`The manifest format is not ${MANIFEST_FORMAT}.`);
  const need = (cond: boolean, field: string) => {
    if (!cond) throw new ManifestError(`The manifest field ${field} is missing or malformed.`);
  };
  need(typeof v.backup_id === "string" && /^[A-Za-z0-9._-]{8,100}$/.test(v.backup_id), "backup_id");
  need(typeof v.created_at === "string" && !Number.isNaN(Date.parse(v.created_at)), "created_at");
  const file = v.file as Record<string, unknown>;
  need(isObj(file) && typeof file.name === "string" && path.basename(file.name) === file.name && isInt(file.bytes) && typeof file.sha256 === "string" && HEX(64).test(file.sha256), "file");
  const db = v.database as Record<string, unknown>;
  need(isObj(db) && isInt(db.bytes) && typeof db.sha256 === "string" && HEX(64).test(db.sha256), "database");
  const schema = v.schema as Record<string, unknown>;
  need(isObj(schema) && typeof schema.fingerprint === "string" && HEX(64).test(schema.fingerprint), "schema");
  need(isObj(v.row_counts) && Object.values(v.row_counts).every(isInt), "row_counts");
  const audit = v.audit as Record<string, unknown>;
  need(isObj(audit), "audit");
  const head = audit.head as Record<string, unknown> | null;
  need(
    head === null || (isObj(head) && isInt(head.seq) && typeof head.mac === "string" && HEX(64).test(head.mac) && typeof head.key_id === "string" && head.key_id.length > 0),
    "audit.head",
  );
  const enc = v.encryption as Record<string, unknown>;
  need(isObj(enc) && (enc.algorithm === "none" || enc.algorithm === "aes-256-gcm"), "encryption.algorithm");
  if (enc.algorithm === "aes-256-gcm") {
    need(typeof enc.key_id === "string" && /^bk-[0-9a-f]{12}$/.test(enc.key_id), "encryption.key_id");
    need(typeof enc.iv === "string" && HEX(24).test(enc.iv), "encryption.iv");
  }
  return v as unknown as BackupManifest;
}

/** The manifest path for a backup file or manifest path (`x.sqlite.enc`, `x.sqlite` or `x.manifest.json`). */
export function manifestPathFor(given: string): string {
  const p = path.resolve(given);
  if (p.endsWith(MANIFEST_SUFFIX)) return p;
  for (const suffix of [ENCRYPTED_SUFFIX, PLAIN_SUFFIX]) {
    if (p.endsWith(suffix)) return p.slice(0, -suffix.length) + MANIFEST_SUFFIX;
  }
  return p + MANIFEST_SUFFIX;
}

/** Default backup directory: HLOS_BACKUP_DIR, else data/backups under the working directory (gitignored). */
export function defaultBackupDir(): string {
  // turbopackIgnore: a runtime directory, not a source file; without it the build traces the whole project.
  const env = process.env.HLOS_BACKUP_DIR?.trim();
  if (env) return path.resolve(/* turbopackIgnore: true */ env);
  return path.join(/* turbopackIgnore: true */ process.cwd(), "data", "backups");
}

export interface LatestBackup {
  /** The newest readable manifest; null when every manifest found was unreadable. */
  manifest: BackupManifest | null;
  /** Manifests found in the directory (readable or not). */
  found: number;
  /** Manifests that could not be read or parsed. */
  unreadable: number;
}

/**
 * The newest readable manifest in `dir` (by created_at), or null when the directory has no manifest at all.
 * Reads at most `limit` manifests (newest file names first: names start with the UTC time). Never throws.
 */
export function findLatestManifest(dir: string, limit = 50): LatestBackup | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(MANIFEST_SUFFIX) && !n.startsWith("."));
  } catch {
    return null;
  }
  names.sort().reverse();
  let best: BackupManifest | null = null;
  let unreadable = 0;
  for (const n of names.slice(0, limit)) {
    try {
      const m = parseManifest(fs.readFileSync(path.join(dir, n), "utf8"));
      if (!best || Date.parse(m.created_at) > Date.parse(best.created_at)) best = m;
    } catch {
      unreadable += 1;
    }
  }
  if (!names.length) return null;
  return { manifest: best, found: names.length, unreadable };
}
