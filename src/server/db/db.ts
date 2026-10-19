import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";
import { ensureAuthSchema } from "./auth-schema";
import { ensureAuditSchema } from "./audit-schema";
import { isDemoMode } from "../runtime-mode";

export type DB = Database.Database;

const DEFAULT_PATH = path.join(process.cwd(), "data", "histology-lab-os.db");

export function databasePath(): string {
  return process.env.HLOS_DB_PATH || DEFAULT_PATH;
}

/** Open (and if needed create + migrate) a database at `file`. `:memory:` is allowed. */
export function openDatabase(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const hasSchema = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_setting'")
    .get();
  if (!hasSchema) db.exec(SCHEMA_SQL);
  // Additive sign-in/session tables for databases created before Stage 6 Phase B.
  ensureAuthSchema(db);
  // Additive audit seal table and traceability columns for databases created before Stage 6 Phase C.
  ensureAuditSchema(db);
  return db;
}

type GlobalWithDb = typeof globalThis & { __hlosDb?: DB; __hlosDbPath?: string };

/**
 * Whether getDb() may load the synthetic demo day into an empty database:
 * only in synthetic demo mode, or when HLOS_SEED_SYNTHETIC=1 is set
 * explicitly (a secured TEST environment). A secured or locked build never
 * seeds silently.
 */
export function syntheticSeedAllowed(): boolean {
  return isDemoMode() || process.env.HLOS_SEED_SYNTHETIC === "1";
}

/**
 * Shared connection for the Next.js server process. Seeds a reproducible demo
 * day the first time an empty database is opened, when syntheticSeedAllowed().
 */
export function getDb(): DB {
  const g = globalThis as GlobalWithDb;
  const file = databasePath();
  if (g.__hlosDb && g.__hlosDbPath === file && g.__hlosDb.open) return g.__hlosDb;
  // Outside demo mode a missing database is never created silently: an empty database would start with no staff, no
  // history and a healthy-looking status. Creating one is an explicit initialization step.
  if (!isDemoMode() && file !== ":memory:" && !fs.existsSync(file) && process.env.HLOS_SEED_SYNTHETIC !== "1" && process.env.HLOS_DB_ALLOW_CREATE !== "1") {
    throw new Error(`No database at ${file}. Outside demo mode an empty database is not created automatically; set HLOS_DB_ALLOW_CREATE=1 once to initialize it.`);
  }
  const db = openDatabase(file);
  const seeded = db.prepare("SELECT value FROM app_setting WHERE key='seeded_at'").get();
  if (!seeded && syntheticSeedAllowed()) {
    // Lazy import keeps the seed out of client bundles and avoids cycles.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { seedDemo } = require("../seed/seed") as typeof import("../seed/seed");
    seedDemo(db);
  }
  if (isDemoMode()) assertSyntheticForDemo(db, file);
  g.__hlosDb = db;
  g.__hlosDbPath = file;
  return db;
}

/**
 * Demo mode hands out identities through a cookie, so it must only ever serve the synthetic demo database. A database
 * without the synthetic seed marker, or with any linked sign-in identity (a secured deployment's database), is refused:
 * the process fails closed instead of exposing it through the demo role switch.
 */
export function assertSyntheticForDemo(db: DB, file = "the database"): void {
  const seeded = db.prepare("SELECT value FROM app_setting WHERE key = 'seeded_at'").get();
  const linked = db.prepare("SELECT 1 FROM staff_identity LIMIT 1").get();
  if (!seeded || linked) {
    db.close();
    throw new Error(
      `Demo mode refuses ${file}: it is not the synthetic demo database (${!seeded ? "no synthetic seed marker" : "it has linked sign-in identities"}). Start it in secured mode, or point HLOS_DB_PATH at a demo database.`,
    );
  }
}

/** Close and forget the shared connection (used by reset). */
export function closeSharedDb(): void {
  const g = globalThis as GlobalWithDb;
  if (g.__hlosDb?.open) g.__hlosDb.close();
  g.__hlosDb = undefined;
  g.__hlosDbPath = undefined;
}
