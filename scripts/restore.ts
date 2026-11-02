// Restore a backup into a NEW, isolated path and verify it (Stage 6 Phase E1).
//
//   npm run db:restore -- <backup file or manifest> --target <new path> [--anchors <anchor file>] [--json]
//
// - The target must not exist (nor a -wal/-shm/-journal beside it), and it is never the live database (HLOS_DB_PATH
//   or data/histology-lab-os.db) or one of its companion files. Nothing is ever overwritten. Point the application at
//   the restored file only after reviewing this report.
// - Encrypted backups need HLOS_BACKUP_KEY (the key they were made with). The audit chain is verified with the
//   PUBLIC demo key when the backup was sealed with it, otherwise with HLOS_AUDIT_KEY (its key id must match).
// - Anchors: --anchors <file>, else HLOS_AUDIT_ANCHOR_PATH when set. Anchors newer than the backup are reported (the
//   restore does not hold that history), not compared.
//
// Checks: manifest; backup file size and SHA-256; decryption (key id, GCM tag in file and manifest, the tag itself);
// database SHA-256; integrity_check; foreign_key_check; schema fingerprint; row counts; audit chain; audit head
// against the manifest; anchors. Prints counts, ids and checksum prefixes only: never a key or record content.
//
// Exit codes: 0 every check passed, 1 a check failed (mismatch, tampering, wrong key, truncation), 2 refused / usage
// / configuration (target exists or is the live database, no key, no manifest).
import { databasePath } from "../src/server/db/db";
import { backupKeyFromEnv, BackupRefused, restoreBackup, type RestoreReport } from "../src/server/ops/backup";

const USAGE = "Usage: db:restore <backup file or manifest> --target <new path> [--anchors <anchor file>] [--json]";

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function print(r: RestoreReport): void {
  const failed = r.checks.filter((c) => c.result === "fail").length;
  const passed = r.checks.filter((c) => c.result === "pass").length;
  console.log(`Restore verification: ${r.ok ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed, ${r.checks.length - passed - failed} skipped)`);
  console.log(`  backup:  ${r.backupId}, created ${r.createdAt} (${r.label})`);
  console.log(`  target:  ${r.target}${r.restored ? "" : " (nothing was written)"}`);
  for (const c of r.checks) console.log(`  [${c.result.toUpperCase()}] ${c.name.padEnd(18)} ${c.detail}`);
  if (r.ok) console.log("The restored database matches its manifest. It is NOT in use: point HLOS_DB_PATH at it only after review. It holds nothing written after the backup.");
  else if (r.restored) console.log("DO NOT USE the restored file: it was kept only for investigation.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let source: string | null = null;
  let target: string | null = null;
  let anchors: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--target" && args[i + 1]) target = args[++i];
    else if (a === "--anchors" && args[i + 1]) anchors = args[++i];
    else if (a === "--json") json = true;
    else if (!a.startsWith("--") && !source) source = a;
    else fail(USAGE);
  }
  if (!source || !target) fail(USAGE);
  const k = backupKeyFromEnv();
  if (k.present && !k.ok) fail(`Refused: ${k.problem} Nothing was restored.`);
  let r: RestoreReport;
  try {
    r = await restoreBackup({
      source,
      target,
      liveDbPath: databasePath(),
      key: k.present && k.ok ? k.key : null,
      anchorsFile: anchors ?? (process.env.HLOS_AUDIT_ANCHOR_PATH?.trim() || null),
    });
  } catch (e) {
    if (e instanceof BackupRefused) fail(e.message, 2);
    fail(`Restore failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
  if (json) console.log(JSON.stringify(r, null, 2));
  else print(r);
  if (!r.ok) process.exitCode = 1;
}

main();
