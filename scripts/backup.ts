// Online backup of the database (Stage 6 Phase E1). Safe while the application is running: SQLite's online backup
// API copies a consistent snapshot in one step and, in WAL mode, never blocks writers.
//
//   npm run db:backup                     back up HLOS_DB_PATH into data/backups/ (or HLOS_BACKUP_DIR)
//   npm run db:backup -- --out <dir>      into <dir> (never the public directory, never the database's own directory)
//   npm run db:backup -- --json           print the manifest summary as JSON
//
// Encryption: AES-256-GCM with HLOS_BACKUP_KEY (32 bytes as 64 hex characters or base64; e.g. openssl rand -hex 32).
// Without a key the backup is REFUSED, except in synthetic demo mode (HLOS_MODE=demo) on the synthetic demo
// database, where it is written unencrypted and labelled "synthetic, unencrypted".
//
// Writes <id>.sqlite.enc (or <id>.sqlite) and <id>.manifest.json: creation time, app version and git commit, schema
// fingerprint, per-table row counts, SHA-256 of the file and of the database image, the audit chain head (seq, MAC,
// key id), the audit verification at backup time, and the encryption parameters (never the key).
// Prints paths, counts, checksums and key ids only: never a key, a secret or record content.
//
// A backup is proved only by restoring it: npm run db:restore -- <manifest> --target <new path>.
// Exit codes: 0 done, 1 the snapshot failed its integrity check (written, flagged), 2 refused / usage / configuration.
import { databasePath } from "../src/server/db/db";
import { runtimeMode } from "../src/server/runtime-mode";
import { backupKeyFromEnv, BackupRefused, createBackup, defaultBackupDir } from "../src/server/ops/backup";

const USAGE = "Usage: db:backup [--out <dir>] [--json]";

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let out: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1] && !args[i + 1].startsWith("--")) out = args[++i];
    else if (args[i] === "--json") json = true;
    else fail(USAGE);
  }
  const k = backupKeyFromEnv();
  if (k.present && !k.ok) fail(`Refused: ${k.problem} Nothing was backed up.`);
  const mode = runtimeMode();
  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof createBackup>>;
  try {
    r = await createBackup({ dbPath: databasePath(), outDir: out ?? defaultBackupDir(), key: k.present && k.ok ? k.key : null, mode });
  } catch (e) {
    if (e instanceof BackupRefused) fail(e.message, 2);
    fail(`Backup failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
  const m = r.manifest;
  const rows = Object.values(m.row_counts).reduce((a, b) => a + b, 0);
  const integrityOk = m.database.integrity_check === "ok";
  if (json) {
    console.log(
      JSON.stringify(
        {
          backup_id: m.backup_id,
          created_at: m.created_at,
          label: m.label,
          file: r.filePath,
          manifest: r.manifestPath,
          bytes: m.file.bytes,
          sha256: m.file.sha256,
          tables: Object.keys(m.row_counts).length,
          rows,
          audit_head: m.audit.head ? { seq: m.audit.head.seq, key_id: m.audit.head.key_id } : null,
          audit_verified_at_backup: m.audit.verified_at_backup?.ok ?? null,
          integrity_check: m.database.integrity_check,
          key_id: m.encryption.algorithm === "aes-256-gcm" ? m.encryption.key_id : null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Backup ${m.backup_id} (${Date.now() - t0} ms): ${m.label.toUpperCase()}`);
    console.log(`  database:        ${databasePath()} (${mode} mode${m.synthetic ? ", synthetic demo data" : ""})`);
    console.log(`  backup file:     ${r.filePath}`);
    console.log(`  manifest:        ${r.manifestPath}`);
    console.log(`  size:            ${m.file.bytes} bytes, SHA-256 ${m.file.sha256}`);
    console.log(`  database image:  ${m.database.bytes} bytes, SHA-256 ${m.database.sha256}, integrity_check ${m.database.integrity_check}`);
    console.log(`  schema:          ${m.schema.objects} objects, fingerprint ${m.schema.fingerprint.slice(0, 16)}…`);
    console.log(`  rows:            ${rows} in ${Object.keys(m.row_counts).length} tables`);
    if (m.audit.head) {
      const v = m.audit.verified_at_backup;
      const verified = v ? (v.ok ? `verified (${v.checked} events)` : `NOT verified: ${v.first_problem?.kind} at seq ${v.first_problem?.seq}`) : "not verified (no audit key here)";
      console.log(`  audit head:      seq ${m.audit.head.seq}, key ${m.audit.head.key_id}${m.audit.head.key_id === "demo-not-secret" ? " (PUBLIC demo key)" : ""}; ${verified}`);
    } else {
      console.log("  audit head:      nothing sealed");
    }
    if (m.encryption.algorithm === "aes-256-gcm") console.log(`  encryption:      AES-256-GCM, key id ${m.encryption.key_id}, random IV, tag stored`);
    else console.log("  encryption:      NONE (synthetic demo database only)");
    console.log("Prove it: npm run db:restore -- <manifest> --target <new path>. A restore loses everything written after the backup.");
  }
  if (!integrityOk) fail(`WARNING: the snapshot failed integrity_check (${m.database.integrity_check}). It was kept and flagged in its manifest; investigate the live database.`, 1);
}

main();
