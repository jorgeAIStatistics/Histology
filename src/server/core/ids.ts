import type { DB } from "../db/db";

/** Monotonic, deterministic counters (reproducible seeds; no randomness). */
export function nextSeq(db: DB, name: string, start = 1): number {
  const row = db.prepare("SELECT next_value FROM id_sequence WHERE name = ?").get(name) as
    | { next_value: number }
    | undefined;
  const value = row ? row.next_value : start;
  db.prepare(
    "INSERT INTO id_sequence(name, next_value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET next_value = excluded.next_value",
  ).run(name, value + 1);
  return value;
}

/** Internal row id, e.g. newId(db, 'clr') -> 'clr_000123'. */
export function newId(db: DB, prefix: string): string {
  return `${prefix}_${String(nextSeq(db, `id:${prefix}`)).padStart(6, "0")}`;
}

/** Human-facing display id, e.g. displayId(db, 'CLR', 4, 457) -> 'CLR-0457'. */
export function displayId(db: DB, prefix: string, width = 4, start = 1): string {
  return `${prefix}-${String(nextSeq(db, `display:${prefix}`, start)).padStart(width, "0")}`;
}
