import type { DB } from "../db/db";
import { DomainError } from "./errors";

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Optimistic concurrency: update a row only if its version still matches what
 * the user saw. A stale update raises CONFLICT with the current row so the UI
 * can show what changed instead of overwriting a colleague's work.
 */
export function updateVersioned(
  db: DB,
  table: string,
  id: string,
  expectedVersion: number | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!SAFE_IDENT.test(table)) throw new Error(`bad table ${table}`);
  const keys = Object.keys(fields);
  for (const k of keys) if (!SAFE_IDENT.test(k)) throw new Error(`bad column ${k}`);
  const current = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!current) throw new DomainError("NOT_FOUND", `${table} ${id} was not found`);
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new DomainError(
      "CONFLICT",
      `This ${table.replace(/_/g, " ")} was changed by someone else (you had version ${expectedVersion}, current is ${current.version}). Review the latest version before saving.`,
      { table, id, expectedVersion, currentVersion: current.version, current },
    );
  }
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  const sql = `UPDATE ${table} SET ${sets}${sets ? ", " : ""}version = version + 1 WHERE id = @__id AND version = @__v`;
  const params: Record<string, unknown> = { __id: id, __v: current.version };
  for (const k of keys) {
    const v = fields[k];
    params[k] = v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v;
  }
  const res = db.prepare(sql).run(params);
  if (res.changes !== 1) {
    throw new DomainError("CONFLICT", `This ${table} was changed concurrently. Reload and try again.`, { table, id });
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
}
