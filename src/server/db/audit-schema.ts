import type Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema";

type DB = Database.Database;

const MARKER = "-- ===== schema.audit.sql =====";
const ADD_COLUMN = /ALTER TABLE audit_event ADD COLUMN (\w+)[^;]*;/g;

/** The schema.audit.sql section of the generated schema module (single source of truth for the DDL). */
export function auditSchemaSection(): string {
  const start = SCHEMA_SQL.indexOf(MARKER);
  if (start < 0) throw new Error("schema.audit.sql is missing from the generated schema module: run `npm run schema`.");
  const rest = SCHEMA_SQL.slice(start + MARKER.length);
  const next = rest.indexOf("\n-- ===== ");
  return next < 0 ? rest : rest.slice(0, next);
}

const ensured = new WeakSet<DB>();

/**
 * Additive migration for databases created before Stage 6 Phase C: adds the
 * traceability columns of audit_event when they are missing, and creates the
 * append-only audit_seal table and its triggers (IF NOT EXISTS). Never
 * rewrites or deletes rows, and never seals anything (sealing needs the key:
 * src/server/core/audit-seal.ts). Called by openDatabase(), so every
 * connection (server, tests, CLIs) has the columns the audit path writes.
 */
export function ensureAuditSchema(db: DB): void {
  if (ensured.has(db)) return;
  const hasAudit = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_event'").get();
  if (!hasAudit) return; // not an application database (nothing to extend)
  const cols = new Set((db.prepare("PRAGMA table_info(audit_event)").all() as { name: string }[]).map((c) => c.name));
  const section = auditSchemaSection().replace(ADD_COLUMN, (stmt, name: string) => (cols.has(name) ? "" : stmt));
  db.exec(section);
  ensured.add(db);
}
