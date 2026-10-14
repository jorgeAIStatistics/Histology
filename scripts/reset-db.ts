// Reset the local demo database to the reproducible synthetic lab day.
//   npm run db:reset            (clock running from 10:52 ET)
//   npm run db:reset -- --paused
import fs from "node:fs";
import { databasePath, openDatabase } from "../src/server/db/db";
import { seedDemo } from "../src/server/seed/seed";

const file = databasePath();
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(file + suffix);
  } catch {
    /* not present */
  }
}
const db = openDatabase(file);
const t0 = Date.now();
const r = seedDemo(db, { clockRunning: !process.argv.includes("--paused") });
db.close();
console.log(`Seeded synthetic demo day into ${file} in ${Date.now() - t0} ms: ${r.cases} active cases, ${r.slides} synthetic slides.`);
