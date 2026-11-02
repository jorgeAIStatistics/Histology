import type Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema";

type DB = Database.Database;

const MARKER = "-- ===== schema.auth.sql =====";
const ALTER_LAB_ID = /ALTER TABLE staff ADD COLUMN lab_id[^;]*;/;

/** The schema.auth.sql section of the generated schema module (single source of truth for the DDL). */
export function authSchemaSection(): string {
  const start = SCHEMA_SQL.indexOf(MARKER);
  if (start < 0) throw new Error("schema.auth.sql is missing from the generated schema module: run `npm run schema`.");
  const rest = SCHEMA_SQL.slice(start + MARKER.length);
  const next = rest.indexOf("\n-- ===== ");
  return next < 0 ? rest : rest.slice(0, next);
}

const ensured = new WeakSet<DB>();

/**
 * Additive migration for databases created before Stage 6 Phase B: adds
 * staff.lab_id when it is missing and creates staff_identity, auth_session and
 * auth_transaction (IF NOT EXISTS). Never rewrites or deletes rows. Called by
 * openDatabase(), so every connection (server, tests, admin CLI) has them.
 */
export function ensureAuthSchema(db: DB): void {
  if (ensured.has(db)) return;
  const hasStaff = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff'").get();
  if (!hasStaff) return; // not an application database (nothing to extend)
  const cols = new Set((db.prepare("PRAGMA table_info(staff)").all() as { name: string }[]).map((c) => c.name));
  const section = authSchemaSection();
  db.exec(cols.has("lab_id") ? section.replace(ALTER_LAB_ID, "") : section);
  ensured.add(db);
}
