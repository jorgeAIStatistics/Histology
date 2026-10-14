import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";

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
  return db;
}

type GlobalWithDb = typeof globalThis & { __hlosDb?: DB; __hlosDbPath?: string };

/**
 * Shared connection for the Next.js server process. Seeds a reproducible demo
 * day the first time an empty database is opened.
 */
export function getDb(): DB {
  const g = globalThis as GlobalWithDb;
  const file = databasePath();
  if (g.__hlosDb && g.__hlosDbPath === file && g.__hlosDb.open) return g.__hlosDb;
  const db = openDatabase(file);
  const seeded = db.prepare("SELECT value FROM app_setting WHERE key='seeded_at'").get();
  if (!seeded) {
    // Lazy import keeps the seed out of client bundles and avoids cycles.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { seedDemo } = require("../seed/seed") as typeof import("../seed/seed");
    seedDemo(db);
  }
  g.__hlosDb = db;
  g.__hlosDbPath = file;
  return db;
}

/** Close and forget the shared connection (used by reset). */
export function closeSharedDb(): void {
  const g = globalThis as GlobalWithDb;
  if (g.__hlosDb?.open) g.__hlosDb.close();
  g.__hlosDb = undefined;
  g.__hlosDbPath = undefined;
}
