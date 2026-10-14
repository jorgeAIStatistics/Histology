import type { DB } from "../db/db";

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_setting WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string, at = new Date().toISOString()): void {
  db.prepare(
    "INSERT INTO app_setting(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, at);
}
