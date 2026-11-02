// Builds the database for the SECURED browser suite (playwright.secured.config.ts), before `next start`:
//   HLOS_DB_PATH=data/e2e-secured.db npx tsx tests/support/secured-db.ts
//
// - the reproducible synthetic lab day (the same seed HLOS_SEED_SYNTHETIC=1 loads), clock paused at 10:52 ET;
// - two synthetic TEST staff members with the roles no demo person holds: a laboratory administrator and an
//   auditor (neither has any clinical permission or bench view).
// Identity links are NOT made here: the web server command makes them with the admin CLI
// (scripts/admin.ts link-identity, audited), the only way anyone can ever sign in.
// Synthetic data only. Refuses any database path outside data/e2e-*.db so it can never touch the demo database.
import fs from "node:fs";
import path from "node:path";
import { databasePath, openDatabase } from "../../src/server/db/db";
import { seedDemo } from "../../src/server/seed/seed";

/** The synthetic test staff the secured suite signs in as (besides seeded Kim and Maya). Mirrored in tests/e2e-secured/support.ts. */
const TEST_STAFF = [
  { id: "stf_test_admin", name: "Alex Admin (test)", short: "Alex A.", role: "lab_admin", initials: "AA" },
  { id: "stf_test_auditor", name: "Robin Auditor (test)", short: "Robin A.", role: "auditor", initials: "RA" },
] as const;

const file = databasePath();
if (!/^e2e-[A-Za-z0-9_-]+\.db$/.test(path.basename(file)) || path.basename(path.dirname(path.resolve(file))) !== "data") {
  console.error(`secured-db: refusing ${file}; expected data/e2e-<tag>.db`);
  process.exit(1);
}
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
const db = openDatabase(file);
const r = seedDemo(db, { clockRunning: false });
const insert = db.prepare(
  "INSERT INTO staff (id, display_name, short_name, role, initials, color_token, active, lab_id) VALUES (?, ?, ?, ?, ?, NULL, 1, ?)",
);
const lab = process.env.HLOS_LAB_ID?.trim() || "lab:local";
for (const s of TEST_STAFF) insert.run(s.id, s.name, s.short, s.role, s.initials, lab);
db.close();
console.log(`secured-db: seeded ${file} (${r.cases} synthetic cases) and added ${TEST_STAFF.map((s) => `${s.id} (${s.role})`).join(", ")}.`);
