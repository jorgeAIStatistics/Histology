import { createHash } from "node:crypto";
import type { DB } from "../db/db";
import { DomainError } from "./errors";

/**
 * Scoped idempotency for commands (one key per user intent).
 *
 * A key is owned by the actor and laboratory scope that first used it, and is
 * bound to one command and one canonical request. A repeat with the same key:
 * - same actor, same scope, same command, same canonical input, not expired:
 *   returns the stored result without running the command again (after the
 *   caller re-checks the actor's permission);
 * - anything else: refused (IDEMPOTENCY_CONFLICT or IDEMPOTENCY_EXPIRED) and
 *   the stored result is never returned. Possessing a key is not authorization.
 *
 * The lookup, the command and the receipt insert run in one IMMEDIATE
 * transaction (see registry.ts), so two requests with the same key, from two
 * processes or two connections, cannot both execute: the second one waits for
 * the write lock, then sees the receipt.
 */

/** Receipts are honored for this long (wall clock). After that the key is refused, never re-run. */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new DomainError("VALIDATION", "Idempotency key must be 1 to 200 characters: letters, digits, dot, underscore, colon or dash.");
  }
}

/** JSON with object keys sorted at every level; undefined members dropped. Stable for equal values. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/** SHA-256 of the command name and its validated, canonical input. */
export function requestFingerprint(command: string, input: unknown): string {
  return createHash("sha256").update(command).update("\n").update(canonicalJson(input)).digest("hex");
}

/** Laboratory scope a key belongs to. One local laboratory in this demo; stored so a multi-site build cannot cross sites. */
export function labScope(db: DB): string {
  const row = db.prepare("SELECT value FROM app_setting WHERE key = 'lab_scope'").get() as { value: string } | undefined;
  return row?.value || "lab:local";
}

export interface ReceiptRow {
  idempotency_key: string;
  command: string;
  actor_id: string | null;
  scope: string | null;
  request_hash: string | null;
  result_json: string;
  correlation_id: string | null;
  expires_at: string | null;
}

const ensured = new WeakSet<DB>();

/** Additive migration for databases created before scoped receipts (columns only; never rewrites rows). */
export function ensureReceiptSchema(db: DB): void {
  if (ensured.has(db)) return;
  const cols = new Set((db.prepare("PRAGMA table_info(command_receipt)").all() as { name: string }[]).map((c) => c.name));
  const add: [string, string][] = [
    ["scope", "TEXT"],
    ["request_hash", "TEXT"],
    ["correlation_id", "TEXT"],
    ["created_at", "TEXT"],
    ["expires_at", "TEXT"],
  ];
  for (const [name, type] of add) if (!cols.has(name)) db.exec(`ALTER TABLE command_receipt ADD COLUMN ${name} ${type}`);
  ensured.add(db);
}

export function findReceipt(db: DB, key: string): ReceiptRow | undefined {
  return db
    .prepare(
      "SELECT idempotency_key, command, actor_id, scope, request_hash, result_json, correlation_id, expires_at FROM command_receipt WHERE idempotency_key = ?",
    )
    .get(key) as ReceiptRow | undefined;
}

/**
 * Decide what a repeated key may do. Throws for every case except an exact,
 * owned, unexpired repeat. Messages never reveal the earlier request.
 */
export function checkRepeat(
  prior: ReceiptRow,
  attempt: { command: string; actorId: string; scope: string; fingerprint: string; nowMs: number },
): void {
  if (prior.actor_id !== attempt.actorId || (prior.scope ?? "") !== attempt.scope) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key cannot be used for this request. Start the action again (a new key is created per action).", {
      reason: "not_owner",
    });
  }
  if (prior.command !== attempt.command || !prior.request_hash || prior.request_hash !== attempt.fingerprint) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used for a different request. Nothing was changed; start the action again.",
      { reason: prior.command !== attempt.command ? "different_command" : prior.request_hash ? "different_payload" : "unverifiable_receipt" },
    );
  }
  if (prior.expires_at && Date.parse(prior.expires_at) <= attempt.nowMs) {
    throw new DomainError("IDEMPOTENCY_EXPIRED", "This idempotency key has expired. The original action is in the record's history; nothing was run again.", {
      reason: "expired",
    });
  }
}

export function insertReceipt(
  db: DB,
  row: { key: string; command: string; actorId: string; scope: string; fingerprint: string; result: unknown; correlationId: string; at: string; nowMs: number },
): void {
  db.prepare(
    `INSERT INTO command_receipt (idempotency_key, command, actor_id, scope, request_hash, result_json, correlation_id, at, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.key,
    row.command,
    row.actorId,
    row.scope,
    row.fingerprint,
    JSON.stringify(row.result ?? null),
    row.correlationId,
    row.at,
    new Date(row.nowMs).toISOString(),
    new Date(row.nowMs + RECEIPT_TTL_MS).toISOString(),
  );
}
