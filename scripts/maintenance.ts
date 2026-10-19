// Idempotency receipt maintenance (Stage 6 Phase C3). Safe to run while the application is running: every batch
// is its own short IMMEDIATE transaction, and audit events are never touched.
//
//   npm run maintenance                     compact expired receipts to tombstones, then purge old tombstones
//   npm run maintenance -- --batch 200      rows per batch (1..5000, default 500)
//
// - Compaction: a receipt past its expiry keeps its key, owner, scope, command, fingerprint and expiry, and loses
//   its stored result; the key is still refused (IDEMPOTENCY_EXPIRED) and never re-run.
// - Purge: tombstones whose expiry is older than HLOS_RECEIPT_TOMBSTONE_DAYS (default 30) are deleted. RESIDUAL
//   RISK: a key older than that would then be treated as new. An invalid HLOS_RECEIPT_TOMBSTONE_DAYS skips the
//   purge (nothing is deleted) and exits 2.
//
// Database: HLOS_DB_PATH (default data/histology-lab-os.db); it must already exist. Prints counts only.
// Exit codes: 0 done, 2 configuration or usage error, 1 any other failure.
import fs from "node:fs";
import { databasePath, openDatabase } from "../src/server/db/db";
import { runReceiptMaintenance } from "../src/server/core/idempotency";

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function main(): void {
  const args = process.argv.slice(2);
  let batch: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch" && /^\d{1,4}$/.test(args[i + 1] ?? "")) {
      batch = Number(args[++i]);
    } else {
      fail("Usage: maintenance [--batch <1..5000>]");
    }
  }
  const file = databasePath();
  if (file === ":memory:" || !fs.existsSync(file)) fail(`No database at ${file} (set HLOS_DB_PATH). Nothing was changed.`);
  const db = openDatabase(file);
  try {
    const t0 = Date.now();
    const r = runReceiptMaintenance(db, Date.now(), { batch });
    console.log(`Receipt maintenance on ${file} (${Date.now() - t0} ms):`);
    console.log(`  compacted to tombstones: ${r.compacted.processed} in ${r.compacted.batchSizes.length} batch(es)`);
    if (r.purged) {
      console.log(`  tombstones purged:       ${r.purged.processed} in ${r.purged.batchSizes.length} batch(es) (retention ${r.retentionDays} days after expiry)`);
    } else {
      fail(`  purge skipped: ${r.purgeSkipped}`);
    }
  } catch (e) {
    fail(`Receipt maintenance failed: ${e instanceof Error ? e.message : String(e)}`, e instanceof RangeError ? 2 : 1);
  } finally {
    if (db.open) db.close();
  }
}

main();
