import { createHash } from "node:crypto";
import type { DB } from "../db/db";
import { DomainError } from "./errors";
import { log } from "./log";

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
 *
 * Maintenance (Stage 6 Phase C3), so receipts do not grow without bound and
 * stored results do not outlive their use:
 * - compactExpiredReceipts: a receipt past expires_at becomes a TOMBSTONE. Its
 *   stored result is cleared (result_json = '') and compacted_at is set; the
 *   key, owner, scope, command, fingerprint and expiry are kept, so a retried
 *   old key is still refused (IDEMPOTENCY_EXPIRED) and never re-run.
 * - purgeTombstones: a tombstone whose expiry is older than the retention
 *   (HLOS_RECEIPT_TOMBSTONE_DAYS, default 30) is deleted. RESIDUAL RISK: after
 *   that, the same key would be treated as new and run again. Clients create a
 *   fresh key per user intent and retry within seconds, so a key older than
 *   the TTL plus the retention is not expected; nothing enforces that.
 * Both work in bounded batches, each batch in its own short IMMEDIATE
 * transaction, never inside a command's transaction. They run opportunistically
 * after a command commits (at most once per 10 minutes per process, one batch
 * each) and through `npm run maintenance` (scripts/maintenance.ts). Neither
 * ever touches audit events.
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
  /** Set when the receipt was compacted to a tombstone (result cleared); the key stays refused. */
  compacted_at: string | null;
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
    ["compacted_at", "TEXT"],
  ];
  for (const [name, type] of add) if (!cols.has(name)) db.exec(`ALTER TABLE command_receipt ADD COLUMN ${name} ${type}`);
  // Maintenance finds expired receipts and old tombstones without scanning the table.
  db.exec("CREATE INDEX IF NOT EXISTS idx_command_receipt_maintenance ON command_receipt(compacted_at, expires_at)");
  ensured.add(db);
}

export function findReceipt(db: DB, key: string): ReceiptRow | undefined {
  return db
    .prepare(
      "SELECT idempotency_key, command, actor_id, scope, request_hash, result_json, correlation_id, expires_at, compacted_at FROM command_receipt WHERE idempotency_key = ?",
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
  // A tombstone (compacted after expiry) is always expired, whatever its expiry says.
  if (prior.compacted_at || (prior.expires_at && Date.parse(prior.expires_at) <= attempt.nowMs)) {
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

// ------------------------------------------------------------------ maintenance (Stage 6 Phase C3)

export const DEFAULT_TOMBSTONE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH = 5000;

export interface MaintenanceStep {
  /** Rows changed (compacted or purged). */
  processed: number;
  /** Rows changed by each batch, in order (each at most `batch`). */
  batchSizes: number[];
  /** True when the last batch found fewer rows than `batch` (nothing left). */
  complete: boolean;
}

export interface BatchOptions {
  /** Rows per batch (1..5000, default 500). Each batch is one short IMMEDIATE transaction. */
  batch?: number;
  /** Stop after this many batches (default: until done). */
  maxBatches?: number;
}

function batchSize(n: number | undefined): number {
  const b = n ?? 500;
  if (!Number.isInteger(b) || b < 1 || b > MAX_BATCH) throw new RangeError(`batch must be a whole number from 1 to ${MAX_BATCH}`);
  return b;
}

function inBatches(db: DB, opts: BatchOptions, step: (limit: number) => number): MaintenanceStep {
  if (db.inTransaction) throw new Error("Receipt maintenance must not run inside another transaction (it would hold that transaction's lock).");
  ensureReceiptSchema(db);
  const limit = batchSize(opts.batch);
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  const out: MaintenanceStep = { processed: 0, batchSizes: [], complete: false };
  while (out.batchSizes.length < maxBatches) {
    const n = db.transaction(() => step(limit)).immediate();
    out.batchSizes.push(n);
    out.processed += n;
    if (n < limit) {
      out.complete = true;
      break;
    }
  }
  return out;
}

/**
 * Receipts whose expires_at is at or before `nowMs` become tombstones: the
 * stored result is cleared and compacted_at is set; key, owner, scope,
 * command, fingerprint, correlation id and expiry are kept, so the key is
 * still refused (IDEMPOTENCY_EXPIRED) and never re-run. Receipts without an
 * expiry (written before scoped receipts) are left as they are: they are
 * refused anyway (no fingerprint). Never touches audit events.
 */
export function compactExpiredReceipts(db: DB, nowMs: number, opts: BatchOptions = {}): MaintenanceStep {
  const nowIso = new Date(nowMs).toISOString();
  return inBatches(db, opts, (limit) =>
    db
      .prepare(
        `UPDATE command_receipt SET result_json = '', compacted_at = ?
          WHERE rowid IN (SELECT rowid FROM command_receipt
                           WHERE compacted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
                           ORDER BY expires_at LIMIT ?)`,
      )
      .run(nowIso, nowIso, limit).changes,
  );
}

/** HLOS_RECEIPT_TOMBSTONE_DAYS (whole days, 1..3650; default 30). Throws, naming the key, when it is invalid. */
export function receiptTombstoneDays(): number {
  const raw = process.env.HLOS_RECEIPT_TOMBSTONE_DAYS?.trim();
  if (!raw) return DEFAULT_TOMBSTONE_DAYS;
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= 3650)) throw new RangeError("HLOS_RECEIPT_TOMBSTONE_DAYS must be a whole number of days from 1 to 3650. Nothing was purged.");
  return n;
}

/**
 * Deletes tombstones whose expiry is more than `retentionDays` before `nowMs`.
 * Only tombstones (already compacted) are deleted, never a live receipt.
 * RESIDUAL RISK: once a key's tombstone is purged, that key would be treated
 * as new. Never touches audit events.
 */
export function purgeTombstones(db: DB, nowMs: number, opts: BatchOptions & { retentionDays?: number } = {}): MaintenanceStep {
  const days = opts.retentionDays ?? receiptTombstoneDays();
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new RangeError("retentionDays must be a whole number of days from 1 to 3650. Nothing was purged.");
  const cutoff = new Date(nowMs - days * DAY_MS).toISOString();
  return inBatches(db, opts, (limit) =>
    db
      .prepare(
        `DELETE FROM command_receipt
          WHERE rowid IN (SELECT rowid FROM command_receipt
                           WHERE compacted_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?
                           ORDER BY expires_at LIMIT ?)`,
      )
      .run(cutoff, limit).changes,
  );
}

export interface MaintenanceResult {
  compacted: MaintenanceStep;
  purged: MaintenanceStep | null;
  /** Why the purge did not run (an invalid HLOS_RECEIPT_TOMBSTONE_DAYS), if it did not. */
  purgeSkipped: string | null;
  retentionDays: number | null;
}

/** Compaction, then the purge. An invalid retention setting skips the purge (fail safe: nothing is deleted). */
export function runReceiptMaintenance(db: DB, nowMs: number, opts: BatchOptions & { retentionDays?: number } = {}): MaintenanceResult {
  const compacted = compactExpiredReceipts(db, nowMs, opts);
  let days: number;
  try {
    days = opts.retentionDays ?? receiptTombstoneDays();
  } catch (e) {
    return { compacted, purged: null, purgeSkipped: e instanceof Error ? e.message : String(e), retentionDays: null };
  }
  return { compacted, purged: purgeTombstones(db, nowMs, { ...opts, retentionDays: days }), purgeSkipped: null, retentionDays: days };
}

/** At most one opportunistic run per this interval, per process. */
export const OPPORTUNISTIC_INTERVAL_MS = 10 * 60 * 1000;
const OPPORTUNISTIC_BATCH = 200;
let lastOpportunisticMs: number | null = null;

/** Tests: forget when the opportunistic maintenance last ran in this process. */
export function resetReceiptMaintenanceThrottle(): void {
  lastOpportunisticMs = null;
}

/**
 * Called after a command COMMITS (registry.ts), never inside its transaction.
 * At most once per 10 minutes per process; one bounded batch of compaction and
 * one of purge, each in its own short transaction, without waiting for a busy
 * write lock (another writer simply means "next time"). Never throws: a
 * failure is logged and the command's response is unaffected. Returns what it
 * did, or null when it did not run.
 */
export function maybeRunReceiptMaintenance(db: DB, nowMs: number = Date.now()): MaintenanceResult | null {
  if (db.inTransaction) return null;
  if (lastOpportunisticMs !== null && nowMs - lastOpportunisticMs < OPPORTUNISTIC_INTERVAL_MS && nowMs >= lastOpportunisticMs) return null;
  lastOpportunisticMs = nowMs;
  const previousTimeout = db.pragma("busy_timeout", { simple: true }) as number;
  try {
    db.pragma("busy_timeout = 0");
    return runReceiptMaintenance(db, nowMs, { batch: OPPORTUNISTIC_BATCH, maxBatches: 1 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/database is locked|SQLITE_BUSY/i.test(message)) log("error", "receipts.maintenance_failed", { error: e });
    return null;
  } finally {
    try {
      db.pragma(`busy_timeout = ${Number.isFinite(previousTimeout) ? previousTimeout : 5000}`);
    } catch {
      /* the connection is closing */
    }
  }
}
