/**
 * Health (Stage 6 Phase E2). Two views of one computation:
 *
 * - GET /api/health (no authentication, for a load balancer): ONLY { status, time }.
 * - GET /api/health/details (view.audit in secured mode: the laboratory administrator and the auditor; any demo role
 *   in demo mode): every check below, each { status, detail, measured_at } plus a few coarse numbers.
 *
 * Checks (status ok | warn | fail | unknown):
 *   process              uptime, resident memory and heap use (coarse). warn: heap above 90% of its limit.
 *   database             a timed read, and a write probe inside a transaction that is always rolled back
 *                        (BEGIN IMMEDIATE takes the write lock; nothing is committed). fail: either cannot run.
 *                        warn: the write lock stayed busy for more than 1 s, or a read took over 500 ms.
 *   audit_chain          the result and age of the LAST verification, cached per database in this process. A full
 *                        verification never runs inside a request: when the cached result is missing or older than
 *                        HLOS_HEALTH_AUDIT_VERIFY_MINUTES (default 15) one is started in the background (at most one
 *                        at a time). fail: the last verification found a problem; warn: no audit key, the anchor file
 *                        could not be used, or the result is older than twice the interval; unknown: not verified yet.
 *   receipt_maintenance  derived from the receipts themselves (works for the opportunistic run and the CLI alike):
 *                        warn when receipts expired more than a day ago are still not compacted, or tombstones are
 *                        more than a day past their retention, or HLOS_RECEIPT_TOMBSTONE_DAYS is invalid.
 *   integration_sources  each source's status and last success (application clock). warn: any source offline or degraded.
 *   import_failures      messages in the import failure queue. warn: one or more.
 *   backup               the newest manifest in the backup directory (HLOS_BACKUP_DIR or data/backups). warn: older
 *                        than HLOS_BACKUP_MAX_AGE_HOURS (default 26), unreadable, or (secured/locked) none found;
 *                        unknown: none found in demo mode.
 *
 * Overall (HEALTH_RULES):
 *   unavailable  the build is locked (it serves nothing), or the database check failed;
 *   degraded     any check is warn or fail (requests are still served);
 *   healthy      every check is ok or unknown.
 *
 * Never in any output: patient data, record content, credentials, cookies, tokens, keys or file paths. Source
 * names and ids are configuration (synthetic adapter names), not patient data. Error details are SQLite codes only.
 */
import v8 from "node:v8";
import type { DB } from "../db/db";
import { getDb } from "../db/db";
import { runtimeMode, type RuntimeMode } from "../runtime-mode";
import { activeAuditKey, anchorFileStatus, verifyAuditChain } from "../core/audit-seal";
import { readClock } from "../core/clock";
import { receiptTombstoneDays } from "../core/idempotency";
import { log } from "../core/log";
import { defaultBackupDir, findLatestManifest } from "./backup-manifest";

export type HealthStatus = "healthy" | "degraded" | "unavailable";
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface HealthCheck {
  status: CheckStatus;
  /** Plain words; no patient data, secrets or paths. */
  detail: string;
  measured_at: string;
  [extra: string]: unknown;
}

export interface HealthReport {
  status: HealthStatus;
  time: string;
  mode: RuntimeMode;
  checks: Record<string, HealthCheck>;
  rules: readonly string[];
}

export const HEALTH_RULES = [
  "unavailable: the build is locked (not configured, it serves nothing), or the database cannot be read or written.",
  "degraded: any check is warn or fail; the application still serves requests.",
  "healthy: every check is ok or unknown.",
] as const;

export const CHECK_NAMES = ["process", "database", "audit_chain", "receipt_maintenance", "integration_sources", "import_failures", "backup"] as const;

const DB_READ_WARN_MS = 500;
const WRITE_PROBE_BUSY_MS = 1000;
const HEAP_WARN = 0.9;
const DEFAULT_AUDIT_INTERVAL_MIN = 15;
const DEFAULT_BACKUP_MAX_AGE_H = 26;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_KEY = "ops:health_write_probe";

const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;
/** "0.4 ms", or "under 0.1 ms" for what rounds to zero. */
const ms = (n: number) => (n < 0.1 ? "under 0.1 ms" : `${n} ms`);

function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d{1,5}$/.test(raw)) return def;
  const n = Number(raw);
  return n >= min && n <= max ? n : def;
}

export function auditVerifyIntervalMs(): number {
  return intEnv("HLOS_HEALTH_AUDIT_VERIFY_MINUTES", DEFAULT_AUDIT_INTERVAL_MIN, 1, 1440) * 60_000;
}

export function backupMaxAgeMs(): number {
  return intEnv("HLOS_BACKUP_MAX_AGE_HOURS", DEFAULT_BACKUP_MAX_AGE_H, 1, 24 * 365) * 3_600_000;
}

function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 120) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

function sqliteCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(code) ? code : "error";
}

// ------------------------------------------------------------------ audit verification cache

export interface AuditVerificationState {
  at: number;
  durationMs: number;
  ok: boolean;
  /** Why it could not run (no key, an error): verification did not happen. */
  unavailable: string | null;
  checked: number;
  sealedThrough: number;
  firstProblem: { seq: number; kind: string } | null;
  demoKey: boolean;
  anchorsChecked: number;
  anchorFileError: boolean;
}

type G = typeof globalThis & { __hlosHealthAudit?: Map<string, AuditVerificationState>; __hlosHealthAuditRunning?: Set<string> };

function cache(): Map<string, AuditVerificationState> {
  const g = globalThis as G;
  return (g.__hlosHealthAudit ??= new Map());
}
function running(): Set<string> {
  const g = globalThis as G;
  return (g.__hlosHealthAuditRunning ??= new Set());
}

/** Tests: forget every cached verification. */
export function resetHealthState(): void {
  cache().clear();
  running().clear();
}

export function lastAuditVerification(db: DB): AuditVerificationState | null {
  return cache().get(db.name) ?? null;
}

/** Runs one full verification now (with the configured anchors) and caches its result. Synchronous; never throws. */
export function refreshAuditVerification(db: DB, nowMs: () => number = Date.now): AuditVerificationState {
  const t0 = performance.now();
  const base = { at: nowMs(), checked: 0, sealedThrough: 0, firstProblem: null, demoKey: false, anchorsChecked: 0, anchorFileError: false };
  let state: AuditVerificationState;
  const key = activeAuditKey();
  if (!key) {
    state = { ...base, durationMs: 0, ok: false, unavailable: "no audit key is configured (HLOS_AUDIT_KEY)" };
  } else {
    try {
      const { status, anchors } = anchorFileStatus(db);
      const v = verifyAuditChain(db, { key, anchors });
      state = {
        ...base,
        durationMs: round1(performance.now() - t0),
        ok: v.ok && !status.error,
        unavailable: null,
        checked: v.checked,
        sealedThrough: v.sealedThrough,
        firstProblem: v.firstProblem ? { seq: v.firstProblem.seq, kind: v.firstProblem.kind } : null,
        demoKey: v.demoKey,
        anchorsChecked: v.anchorsChecked,
        anchorFileError: !!status.error,
      };
    } catch (e) {
      log("error", "health.audit_verification_failed", { error: e });
      state = { ...base, durationMs: round1(performance.now() - t0), ok: false, unavailable: `verification could not run (${sqliteCode(e)})` };
    }
  }
  cache().set(db.name, state);
  return state;
}

/** Starts a background verification when the cached one is missing or older than the interval (one at a time per database). */
export function scheduleAuditVerification(db: DB, nowMs: number = Date.now()): boolean {
  const last = cache().get(db.name);
  if (last && nowMs - last.at < auditVerifyIntervalMs() && nowMs >= last.at) return false;
  const name = db.name;
  if (running().has(name)) return false;
  running().add(name);
  const t = setTimeout(() => {
    try {
      if (db.open) refreshAuditVerification(db);
    } finally {
      running().delete(name);
    }
  }, 0);
  t.unref?.();
  return true;
}

// ------------------------------------------------------------------ checks

function processCheck(at: string): HealthCheck {
  const mem = process.memoryUsage();
  const limit = v8.getHeapStatistics().heap_size_limit || 1;
  const heapPct = Math.round((mem.heapUsed / limit) * 100);
  const rssMb = Math.round(mem.rss / (1024 * 1024));
  const uptimeS = Math.round(process.uptime());
  return {
    status: mem.heapUsed / limit >= HEAP_WARN ? "warn" : "ok",
    detail: `Running for ${duration(uptimeS * 1000)}; about ${rssMb} MB resident memory; JavaScript heap at ${heapPct}% of its limit.`,
    measured_at: at,
    uptime_seconds: uptimeS,
    rss_mb: rssMb,
    heap_used_percent: heapPct,
  };
}

const ROLLBACK = Symbol("health-probe-rollback");

export function databaseCheck(db: DB, at: string): HealthCheck {
  let readMs: number;
  try {
    const t0 = performance.now();
    db.prepare("SELECT COUNT(*) AS n FROM app_setting").get();
    readMs = round1(performance.now() - t0);
  } catch (e) {
    return { status: "fail", detail: `The database could not be read (${sqliteCode(e)}).`, measured_at: at };
  }
  if (db.inTransaction) {
    return { status: "unknown", detail: `A read took ${ms(readMs)}; the write probe was skipped (a transaction is open on this connection).`, measured_at: at, read_ms: readMs };
  }
  const previous = db.pragma("busy_timeout", { simple: true }) as number;
  let writeMs: number;
  try {
    db.pragma(`busy_timeout = ${WRITE_PROBE_BUSY_MS}`);
    const t0 = performance.now();
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO app_setting (key, value, updated_at) VALUES (?, 'probe', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(PROBE_KEY, at);
        throw ROLLBACK;
      }).immediate();
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    writeMs = round1(performance.now() - t0);
  } catch (e) {
    const code = sqliteCode(e);
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
      return {
        status: "warn",
        detail: `A read took ${ms(readMs)}, but the write lock stayed busy for more than ${WRITE_PROBE_BUSY_MS / 1000} s: writes are waiting.`,
        measured_at: at,
        read_ms: readMs,
      };
    }
    return { status: "fail", detail: `A read took ${ms(readMs)}, but a write could not be made (${code}).`, measured_at: at, read_ms: readMs };
  } finally {
    try {
      db.pragma(`busy_timeout = ${Number.isFinite(previous) ? previous : 5000}`);
    } catch {
      /* closing */
    }
  }
  const slow = readMs > DB_READ_WARN_MS;
  return {
    status: slow ? "warn" : "ok",
    detail: `A read took ${ms(readMs)}; a write probe (rolled back, nothing kept) took ${ms(writeMs)}.${slow ? " Reads are slow." : ""}`,
    measured_at: at,
    read_ms: readMs,
    write_probe_ms: writeMs,
  };
}

function auditCheck(db: DB, nowMs: number, at: string): HealthCheck {
  const s = lastAuditVerification(db);
  const interval = auditVerifyIntervalMs();
  if (!s) {
    return {
      status: "unknown",
      detail: `Not verified yet by this process; a verification runs in the background (at most every ${interval / 60_000} min). Run npm run audit:verify for an immediate result.`,
      measured_at: at,
    };
  }
  const ageMs = Math.max(0, nowMs - s.at);
  const common = { measured_at: at, verified_at: iso(s.at), age_minutes: Math.floor(ageMs / 60_000), duration_ms: s.durationMs };
  if (s.unavailable) return { status: "warn", detail: `The audit chain could not be verified: ${s.unavailable}.`, ...common };
  const demo = s.demoKey ? " Sealed with the PUBLIC demo key: this proves nothing." : "";
  if (!s.ok) {
    const what = s.firstProblem ? `${s.firstProblem.kind} at seq ${s.firstProblem.seq}` : "the anchor file could not be used";
    return {
      status: s.firstProblem ? "fail" : "warn",
      detail: `The last verification (${duration(ageMs)} ago) did NOT pass: ${what}. Run npm run audit:verify and follow the runbook.${demo}`,
      ...common,
      ok: false,
      sealed_through: s.sealedThrough,
      first_problem: s.firstProblem,
      anchors_checked: s.anchorsChecked,
      demo_key: s.demoKey,
    };
  }
  const stale = ageMs > 2 * interval;
  return {
    status: stale ? "warn" : "ok",
    detail: `Verified ${duration(ageMs)} ago: ${s.checked} events intact through seq ${s.sealedThrough}, ${s.anchorsChecked} anchor(s) checked.${stale ? " The result is stale." : ""}${demo}`,
    ...common,
    ok: true,
    sealed_through: s.sealedThrough,
    first_problem: null,
    anchors_checked: s.anchorsChecked,
    demo_key: s.demoKey,
  };
}

function receiptCheck(db: DB, nowMs: number, at: string): HealthCheck {
  const cols = new Set((db.prepare("PRAGMA table_info(command_receipt)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("expires_at")) {
    return { status: "ok", detail: "No scoped receipt has been written yet, so there is nothing to maintain.", measured_at: at, last_compaction_at: null, overdue_receipts: 0 };
  }
  // compacted_at is added by the first maintenance or keyed command (ensureReceiptSchema); without it nothing was compacted.
  const compacted = cols.has("compacted_at") ? "compacted_at" : "NULL";
  let retentionDays: number | null = null;
  let retentionProblem = false;
  try {
    retentionDays = receiptTombstoneDays();
  } catch {
    retentionProblem = true;
  }
  const r = db
    .prepare(
      `SELECT (SELECT MAX(${compacted}) FROM command_receipt) AS last_compacted,
              (SELECT COUNT(*) FROM command_receipt WHERE ${compacted} IS NULL AND expires_at IS NOT NULL AND expires_at <= ?) AS overdue,
              (SELECT COUNT(*) FROM command_receipt WHERE ${compacted} IS NULL AND expires_at IS NOT NULL AND expires_at <= ?) AS awaiting,
              (SELECT COUNT(*) FROM command_receipt WHERE ${compacted} IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?) AS tombstones_overdue`,
    )
    .get(iso(nowMs - DAY_MS), iso(nowMs), iso(nowMs - ((retentionDays ?? 3650) + 1) * DAY_MS)) as {
    last_compacted: string | null;
    overdue: number;
    awaiting: number;
    tombstones_overdue: number;
  };
  const last = r.last_compacted ? `the last compaction was ${duration(Math.max(0, nowMs - Date.parse(r.last_compacted)))} ago` : "nothing has been compacted yet";
  const extras = { measured_at: at, last_compaction_at: r.last_compacted, overdue_receipts: r.overdue, awaiting_receipts: r.awaiting, overdue_tombstones: r.tombstones_overdue };
  if (retentionProblem) {
    return { status: "warn", detail: `HLOS_RECEIPT_TOMBSTONE_DAYS is invalid, so the tombstone purge is skipped; ${last}.`, ...extras };
  }
  if (r.overdue > 0 || r.tombstones_overdue > 0) {
    const parts: string[] = [];
    if (r.overdue) parts.push(`${r.overdue} receipt(s) expired more than a day ago are not compacted`);
    if (r.tombstones_overdue) parts.push(`${r.tombstones_overdue} tombstone(s) are more than a day past their ${retentionDays}-day retention`);
    return { status: "warn", detail: `Receipt maintenance has not run for over a day: ${parts.join("; ")}; ${last}. Run npm run maintenance.`, ...extras };
  }
  return {
    status: "ok",
    detail: `Up to date: ${r.awaiting} receipt(s) expired within the last day await the next run; ${last} (the time of the last compaction, not of the last run).`,
    ...extras,
  };
}

function integrationCheck(db: DB, at: string): HealthCheck {
  const rows = db.prepare("SELECT id, name, status, last_success_at FROM integration_source ORDER BY id").all() as {
    id: string;
    name: string;
    status: string;
    last_success_at: string | null;
  }[];
  if (!rows.length) return { status: "unknown", detail: "No integration source is configured.", measured_at: at, sources: [] };
  const appNow = Date.parse(readClock(db).now);
  const sources = rows.map((r) => {
    const age = r.last_success_at ? Math.max(0, Math.floor((appNow - Date.parse(r.last_success_at)) / 60_000)) : null;
    const status: CheckStatus = r.status === "connected" ? "ok" : r.status === "offline" || r.status === "degraded" ? "warn" : "unknown";
    const known = ["connected", "offline", "degraded"].includes(r.status) ? r.status : "unknown";
    return {
      id: r.id,
      name: r.name,
      status,
      state: known,
      last_success_at: r.last_success_at,
      last_success_age_minutes: age,
      detail: `${known}; last success ${age === null ? "never recorded" : `${age} min ago`} (application clock).`,
    };
  });
  const bad = sources.filter((s) => s.status === "warn");
  return {
    status: bad.length ? "warn" : "ok",
    detail: bad.length
      ? `${bad.length} of ${sources.length} source(s) need attention: ${bad.map((s) => `${s.id} ${s.state}`).join(", ")}. Times are on the application clock (the demo clock in synthetic demo mode).`
      : `All ${sources.length} source(s) connected. Times are on the application clock (the demo clock in synthetic demo mode).`,
    measured_at: at,
    sources,
  };
}

function importFailuresCheck(db: DB, at: string): HealthCheck {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM integration_event WHERE outcome = 'failed'").get() as { n: number }).n;
  return {
    status: n ? "warn" : "ok",
    detail: n
      ? `${n} message(s) in the import failure queue: nothing was applied from them. Review and retry them from the Operations screen.`
      : "The import failure queue is empty.",
    measured_at: at,
    count: n,
  };
}

function backupCheck(mode: RuntimeMode, nowMs: number, at: string, dir: string): HealthCheck {
  const latest = findLatestManifest(dir);
  if (!latest) {
    return mode === "demo"
      ? { status: "unknown", detail: "No backup manifest was found in the backup directory.", measured_at: at }
      : { status: "warn", detail: "No backup manifest was found in the backup directory: no backup is recorded here. Run npm run db:backup.", measured_at: at };
  }
  if (!latest.manifest) {
    return { status: "warn", detail: `${latest.found} backup manifest(s) found, none readable.`, measured_at: at, unreadable: latest.unreadable };
  }
  const m = latest.manifest;
  const ageMs = Math.max(0, nowMs - Date.parse(m.created_at));
  const maxAge = backupMaxAgeMs();
  const old = ageMs > maxAge;
  return {
    status: old || latest.unreadable ? "warn" : "ok",
    detail:
      `The newest backup was taken ${duration(ageMs)} ago (${m.label}).` +
      (old ? ` That is older than ${maxAge / 3_600_000} h.` : "") +
      (latest.unreadable ? ` ${latest.unreadable} other manifest(s) could not be read.` : "") +
      " Its age says nothing about whether it restores: run the restore drill.",
    measured_at: at,
    created_at: m.created_at,
    age_hours: Math.floor(ageMs / 3_600_000),
    encrypted: m.encryption.algorithm !== "none",
  };
}

// ------------------------------------------------------------------ overall

export function overallStatus(mode: RuntimeMode, checks: Record<string, HealthCheck>): HealthStatus {
  if (mode === "locked" || checks.database?.status === "fail") return "unavailable";
  return Object.values(checks).some((c) => c.status === "warn" || c.status === "fail") ? "degraded" : "healthy";
}

export interface ComputeHealthOptions {
  /** The database (tests); default the shared connection. */
  db?: () => DB;
  now?: () => number;
  /** Start a background audit verification when the cached one is stale (the routes do). */
  scheduleAudit?: boolean;
  backupDir?: string;
}

/** Every check and the overall status. Never throws. */
export function computeHealth(opts: ComputeHealthOptions = {}): HealthReport {
  const nowMs = (opts.now ?? Date.now)();
  const at = iso(nowMs);
  const mode = runtimeMode();
  const checks: Record<string, HealthCheck> = { process: processCheck(at) };
  const notChecked = (why: string): HealthCheck => ({ status: "unknown", detail: `Not checked: ${why}.`, measured_at: at });

  if (mode === "locked") {
    checks.database = { status: "unknown", detail: "Not checked: this build is locked (not configured) and serves nothing.", measured_at: at };
    for (const n of CHECK_NAMES.slice(2)) checks[n] = notChecked("this build is locked");
    return { status: "unavailable", time: at, mode, checks, rules: HEALTH_RULES };
  }

  let db: DB | null = null;
  try {
    db = (opts.db ?? getDb)();
  } catch (e) {
    log("error", "health.database_open_failed", { error: e });
    checks.database = { status: "fail", detail: `The database could not be opened (${sqliteCode(e)}).`, measured_at: at };
  }
  if (db) checks.database = databaseCheck(db, at);
  const usable = db && checks.database.status !== "fail" ? db : null;

  const guarded = (name: string, fn: (d: DB) => HealthCheck) => {
    if (!usable) {
      checks[name] = notChecked("the database is not available");
      return;
    }
    try {
      checks[name] = fn(usable);
    } catch (e) {
      log("error", "health.check_failed", { check: name, error: e });
      checks[name] = { status: "unknown", detail: `The check could not run (${sqliteCode(e)}).`, measured_at: at };
    }
  };
  guarded("audit_chain", (d) => auditCheck(d, nowMs, at));
  guarded("receipt_maintenance", (d) => receiptCheck(d, nowMs, at));
  guarded("integration_sources", (d) => integrationCheck(d, at));
  guarded("import_failures", (d) => importFailuresCheck(d, at));
  try {
    checks.backup = backupCheck(mode, nowMs, at, opts.backupDir ?? defaultBackupDir());
  } catch (e) {
    checks.backup = { status: "unknown", detail: `The check could not run (${sqliteCode(e)}).`, measured_at: at };
  }
  if (usable && opts.scheduleAudit) scheduleAuditVerification(usable, nowMs);
  return { status: overallStatus(mode, checks), time: at, mode, checks, rules: HEALTH_RULES };
}

/** HTTP status for a health status: 503 only when unavailable (a load balancer keeps sending traffic while degraded). */
export function httpStatusForHealth(s: HealthStatus): number {
  return s === "unavailable" ? 503 : 200;
}
