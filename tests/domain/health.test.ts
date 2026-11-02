import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { closeSharedDb, getDb, openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { createSession, sessionPolicyFromEnv } from "@/server/auth/sessions";
import { linkIdentity } from "@/server/auth/admin";
import { runReceiptMaintenance } from "@/server/core/idempotency";
import { setLogSink, type LogLevel } from "@/server/core/log";
import { runtimeMode } from "@/server/runtime-mode";
import {
  CHECK_NAMES,
  computeHealth,
  lastAuditVerification,
  overallStatus,
  refreshAuditVerification,
  resetHealthState,
  type HealthCheck,
} from "@/server/ops/health";
import { withRequestLog } from "@/server/ops/request-log";
import { createBackup } from "@/server/ops/backup";
import { handleInboundRequest } from "@/server/integration/inbound";
import { GET as healthGET } from "@/app/api/health/route";
import { GET as detailsGET } from "@/app/api/health/details/route";
import { POST as commandPOST } from "@/app/api/commands/[name]/route";
import { GET as loginGET } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { GET as sessionGET } from "@/app/api/auth/session/route";
import { POST as inboundPOST, GET as inboundGET } from "@/app/api/integration/inbound/route";
import { all, one, STAFF } from "../helpers";

// Stage 6 Phase E2 (health) and E4 (one structured log line per API request). Synthetic data only, temporary
// databases only. The health answers and the log lines are scanned for cookies, tokens, keys, secrets, paths and
// synthetic patient details.

const ROOT = path.resolve(import.meta.dirname, "../..");
const PUBLIC = "http://localhost:3999";

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hlos-health-test-")));
});
afterAll(() => {
  closeSharedDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => resetHealthState());
afterEach(() => resetHealthState());

const securedEnv = (): Record<string, string> => ({
  HLOS_MODE: "secured",
  HLOS_OIDC_ISSUER: "http://127.0.0.1:9/nothing-listens-here",
  HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
  HLOS_OIDC_CLIENT_ID: "hlos-test-client",
  HLOS_OIDC_CLIENT_SECRET: crypto.randomBytes(24).toString("hex"),
  HLOS_PUBLIC_URL: PUBLIC,
  HLOS_LAB_ID: "lab:local",
  HLOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  HLOS_AUDIT_KEY: crypto.randomBytes(32).toString("hex"),
});
const ENV_KEYS = [
  ...Object.keys(securedEnv()),
  "HLOS_DB_PATH",
  "HLOS_BACKUP_DIR",
  "HLOS_BACKUP_KEY",
  "HLOS_AUDIT_ANCHOR_PATH",
  "HLOS_HEALTH_AUDIT_VERIFY_MINUTES",
  "HLOS_BACKUP_MAX_AGE_HOURS",
  "HLOS_RECEIPT_TOMBSTONE_DAYS",
  "HLOS_INTEGRATION_SIMULATOR",
  "HLOS_INTEGRATION_SIM_SECRET",
];

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  closeSharedDb();
  try {
    await fn();
  } finally {
    closeSharedDb();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

let n = 0;
/** A seeded synthetic database file in its own directory, plus an empty backup directory. */
function fixture(extra?: (db: DB) => void): { file: string; backups: string; dir: string } {
  const dir = path.join(tmp, `h-${++n}`);
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  fs.mkdirSync(path.join(dir, "backups"));
  const file = path.join(dir, "db", "health.db");
  const db = openDatabase(file);
  seedDemo(db, { clockRunning: false });
  extra?.(db);
  db.close();
  return { file, backups: path.join(dir, "backups"), dir };
}

const get = (url: string, headers: Record<string, string> = {}) => new Request(`${PUBLIC}${url}`, { headers: { host: new URL(PUBLIC).host, ...headers } });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Synthetic patient details, secrets and paths that must never appear in a health answer or a log line. */
function forbidden(db: DB, extra: string[] = []): string[] {
  const p = all<{ family_name: string; given_name: string; source_mrn: string; birth_date: string }>(db, "SELECT family_name, given_name, source_mrn, birth_date FROM patient_ref");
  const out = new Set<string>(extra.filter(Boolean));
  for (const r of p) for (const v of [r.family_name, `${r.given_name} ${r.family_name}`, r.source_mrn, r.birth_date]) if (v && v.length >= 5) out.add(v);
  out.add(tmp);
  for (const k of ["HLOS_SESSION_SECRET", "HLOS_AUDIT_KEY", "HLOS_OIDC_CLIENT_SECRET", "HLOS_BACKUP_KEY"]) if (process.env[k]) out.add(process.env[k]!);
  return [...out];
}

function expectClean(text: string, needles: string[]): void {
  for (const s of needles) expect(text.includes(s), `found: ${s.slice(0, 24)}`).toBe(false);
  expect(text).not.toMatch(/Bearer|eyJ[A-Za-z0-9_-]{8,}|hlos_session|__Host-|hlos_actor|set-cookie/i);
  expect(text).not.toMatch(/[0-9a-f]{32,}/i); // no MAC, hash, key or session id
  expect(text).not.toMatch(/\.db\b|\/Users\/|\/tmp\/|\/private\/|\/var\//); // no file path
}

function jsonKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => jsonKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), jsonKeys(x, out));
  return out;
}

function captureLogs(): { lines: { level: LogLevel; obj: Record<string, unknown>; raw: string }[]; restore: () => void } {
  const lines: { level: LogLevel; obj: Record<string, unknown>; raw: string }[] = [];
  const restore = setLogSink((level, line) => lines.push({ level, obj: JSON.parse(line) as Record<string, unknown>, raw: line }));
  return { lines, restore };
}
const requestLines = (c: ReturnType<typeof captureLogs>) => c.lines.filter((l) => l.obj.event === "http.request");

// ------------------------------------------------------------------ GET /api/health

describe("GET /api/health (no authentication)", () => {
  it("answers ONLY { status, time }: healthy on a fresh synthetic database, 200", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      const res = await healthGET(get("/api/health"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["status", "time"]);
      expect(body.status).toBe("healthy");
      expect(Date.parse(String(body.time))).not.toBeNaN();
    });
  });

  it("locked build: 503 unavailable, and no database is opened or created", async () => {
    const file = path.join(tmp, "locked-never-created.db");
    await withEnv({ HLOS_MODE: "locked", HLOS_DB_PATH: file }, async () => {
      expect(runtimeMode()).toBe("locked");
      const res = await healthGET(get("/api/health"));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "unavailable", time: expect.any(String) });
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it("a database that cannot be opened: 503 unavailable (and the details answer 503 without details)", async () => {
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: "/dev/null/hlos-health.db" }, async () => {
      const res = await healthGET(get("/api/health"));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { status: string }).status).toBe("unavailable");
      const d = await detailsGET(get("/api/health/details"));
      expect(d.status).toBe(503);
      expect(Object.keys((await d.json()) as object).sort()).toEqual(["status", "time"]);
    });
  });

  it("degraded (still 200) when a check warns: another connection holds the write lock for more than a second", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      getDb();
      const other = new Database(f.file);
      other.exec("BEGIN IMMEDIATE");
      try {
        const res = await healthGET(get("/api/health"));
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe("degraded");
        const h = computeHealth();
        expect(h.checks.database).toMatchObject({ status: "warn" });
        expect(h.checks.database.detail).toMatch(/write lock stayed busy/);
      } finally {
        other.exec("ROLLBACK");
        other.close();
      }
      expect(computeHealth().checks.database.status).toBe("ok");
      expect((getDb().pragma("busy_timeout", { simple: true }) as number)).toBe(5000); // restored after the probe
    });
  });
});

// ------------------------------------------------------------------ GET /api/health/details

describe("GET /api/health/details", () => {
  it("demo: any demo role gets every check ({ status, detail, measured_at }); no PHI, secret, cookie or path in the answer", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      for (const who of [STAFF.maya, STAFF.director, STAFF.tanya]) {
        const cookie = `hlos_actor=${who}`;
        const res = await detailsGET(get("/api/health/details", { cookie }));
        expect(res.status, who).toBe(200);
        const text = await res.text();
        const body = JSON.parse(text) as { status: string; mode: string; checks: Record<string, HealthCheck>; rules: string[] };
        expect(body.mode).toBe("demo");
        expect(Object.keys(body.checks).sort()).toEqual([...CHECK_NAMES].sort());
        for (const [name, c] of Object.entries(body.checks)) {
          expect(["ok", "warn", "fail", "unknown"], name).toContain(c.status);
          expect(typeof c.detail, name).toBe("string");
          expect(c.detail.length, name).toBeGreaterThan(10);
          expect(Date.parse(c.measured_at), name).not.toBeNaN();
        }
        expect(body.rules).toHaveLength(3);
        expectClean(text, [...forbidden(getDb()), cookie]);
        expect(jsonKeys(body).filter((k) => /token|secret|passw|cookie|session|^key$|_key$|path|file/i.test(k))).toEqual([]);
      }
    });
  });

  it("secured: no session 401, a bench role 403, the auditor and the laboratory administrator 200; locked 401", async () => {
    const f = fixture((db) => {
      db.prepare("INSERT INTO staff (id, display_name, short_name, role, initials) VALUES ('stf_aud', 'Robin Auditor (synthetic)', 'Robin', 'auditor', 'RA')").run();
      db.prepare("INSERT INTO staff (id, display_name, short_name, role, initials) VALUES ('stf_adm', 'Alex Admin (synthetic)', 'Alex', 'lab_admin', 'AA')").run();
    });
    const env = securedEnv();
    await withEnv({ ...env, HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      expect(runtimeMode()).toBe("secured");
      const db = getDb();
      const policy = sessionPolicyFromEnv()!;
      const signIn = (staffId: string) => {
        linkIdentity(db, { operator: "test", correlationId: "health-test-link" }, { staffId, issuer: "https://idp.synthetic.test", subject: `sub-${staffId}`, labId: "lab:local" });
        return createSession(db, { staffId, labId: "lab:local", issuer: "https://idp.synthetic.test", subject: `sub-${staffId}`, authTimeMs: Date.now() }, policy).cookieValue;
      };
      const cookies = { maya: signIn(STAFF.maya), tanya: signIn(STAFF.tanya), auditor: signIn("stf_aud"), admin: signIn("stf_adm") };
      const as = (c?: string) => get("/api/health/details", c ? { cookie: `hlos_session=${c}` } : {});

      expect((await detailsGET(as())).status).toBe(401);
      expect((await detailsGET(get("/api/health/details", { cookie: `hlos_actor=${STAFF.tanya}` }))).status).toBe(401); // the demo cookie means nothing here
      expect((await detailsGET(as(cookies.maya))).status).toBe(403);
      expect((await detailsGET(as(cookies.tanya))).status).toBe(403); // even the supervisor: health is view.audit
      for (const c of [cookies.auditor, cookies.admin]) {
        const res = await detailsGET(as(c));
        expect(res.status).toBe(200);
        const text = await res.text();
        const body = JSON.parse(text) as { mode: string; checks: Record<string, HealthCheck> };
        expect(body.mode).toBe("secured");
        // No backup is recorded: in secured mode that is a warning, not an unknown.
        expect(body.checks.backup).toMatchObject({ status: "warn" });
        expectClean(text, [...forbidden(db, Object.values(cookies)), ...Object.values(env).filter((v) => v.length >= 24)]);
      }
      const forbiddenBody = await (await detailsGET(as(cookies.maya))).text();
      expect(forbiddenBody).not.toMatch(/checks|database|audit_chain/);

      // The public endpoint needs no session, and says nothing more in secured mode.
      const pub = await healthGET(get("/api/health"));
      expect(Object.keys((await pub.json()) as object).sort()).toEqual(["status", "time"]);
    });
    await withEnv({ ...env, HLOS_AUDIT_KEY: undefined, HLOS_DB_PATH: f.file }, async () => {
      expect(runtimeMode()).toBe("locked");
      expect((await detailsGET(get("/api/health/details"))).status).toBe(401);
      expect((await healthGET(get("/api/health"))).status).toBe(503);
    });
  });

  it("the write probe is rolled back: no setting row, no audit event, no change", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      const db = getDb();
      const before = one<{ e: number; s: number; t: number }>(db, "SELECT (SELECT COUNT(*) FROM audit_event) e, (SELECT COUNT(*) FROM app_setting) s, total_changes() t");
      const h = computeHealth();
      expect(h.checks.database).toMatchObject({ status: "ok", read_ms: expect.any(Number), write_probe_ms: expect.any(Number) });
      expect(one(db, "SELECT COUNT(*) n FROM app_setting WHERE key = 'ops:health_write_probe'")).toEqual({ n: 0 });
      const after = one<{ e: number; s: number }>(db, "SELECT (SELECT COUNT(*) FROM audit_event) e, (SELECT COUNT(*) FROM app_setting) s");
      expect(after).toEqual({ e: before.e, s: before.s });
    });
  });
});

// ------------------------------------------------------------------ the checks and the rules

describe("health checks", () => {
  it("the audit chain is verified in the background, cached, and never inside the request; a tampered chain is a failure", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups, HLOS_HEALTH_AUDIT_VERIFY_MINUTES: "1" }, async () => {
      const db = getDb();
      // No result yet: unknown (does not degrade), and the request itself did not verify anything.
      const first = computeHealth({ scheduleAudit: false });
      expect(first.checks.audit_chain.status).toBe("unknown");
      expect(lastAuditVerification(db)).toBeNull();
      expect(first.status).toBe("healthy");

      // The route schedules one background run; the answer it gave still had no result.
      const res = await detailsGET(get("/api/health/details"));
      expect(((await res.json()) as { checks: Record<string, HealthCheck> }).checks.audit_chain.status).toBe("unknown");
      await tick();
      const cached = lastAuditVerification(db)!;
      expect(cached).toMatchObject({ ok: true, demoKey: true, unavailable: null });
      const c = computeHealth().checks.audit_chain;
      expect(c).toMatchObject({ status: "ok", ok: true, sealed_through: cached.sealedThrough, verified_at: new Date(cached.at).toISOString(), demo_key: true });
      expect(c.detail).toMatch(/PUBLIC demo key/);

      // Within the interval: no new run.
      await detailsGET(get("/api/health/details"));
      await tick();
      expect(lastAuditVerification(db)!.at).toBe(cached.at);
      // Older than twice the interval: stale (warn) until the next background run replaces it.
      const later = Date.now() + 3 * 60_000;
      expect(computeHealth({ now: () => later }).checks.audit_chain.status).toBe("warn");

      // Tamper with an event the way someone with the file would; the next verification fails.
      db.exec("DROP TRIGGER IF EXISTS audit_event_no_update");
      db.prepare("UPDATE audit_event SET summary = 'edited' WHERE seq = 5").run();
      refreshAuditVerification(db);
      const h = computeHealth();
      expect(h.checks.audit_chain).toMatchObject({ status: "fail", ok: false, first_problem: { seq: 5, kind: "event_modified" } });
      expect(h.status).toBe("degraded");
      expect(((await (await healthGET(get("/api/health"))).json()) as { status: string }).status).toBe("degraded");
    });
  });

  it("receipt maintenance: receipts expired over a day ago and not compacted warn; after maintenance it is ok and the last compaction is reported", async () => {
    const f = fixture((db) => {
      const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
      db.prepare(
        `INSERT INTO command_receipt (idempotency_key, command, actor_id, scope, request_hash, result_json, correlation_id, at, created_at, expires_at)
         VALUES ('health-old-key', 'clarification.create', 'stf_maya', 'lab:local', 'x', '{}', 'c-old', ?, ?, ?)`,
      ).run(old, old, old);
    });
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      const db = getDb();
      const before = computeHealth();
      expect(before.checks.receipt_maintenance).toMatchObject({ status: "warn", overdue_receipts: 1 });
      expect(before.checks.receipt_maintenance.detail).toMatch(/npm run maintenance/);
      expect(before.status).toBe("degraded");
      runReceiptMaintenance(db, Date.now(), { retentionDays: 30 });
      const after = computeHealth();
      expect(after.checks.receipt_maintenance).toMatchObject({ status: "ok", overdue_receipts: 0, last_compaction_at: expect.any(String) });
      process.env.HLOS_RECEIPT_TOMBSTONE_DAYS = "nonsense";
      expect(computeHealth().checks.receipt_maintenance.status).toBe("warn");
    });
  });

  it("integration sources and the import failure queue", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      const db = getDb();
      const ok = computeHealth();
      expect(ok.checks.integration_sources.status).toBe("ok");
      const sources = ok.checks.integration_sources.sources as { id: string; state: string; last_success_age_minutes: number | null }[];
      expect(sources.map((s) => s.id)).toEqual(all<{ id: string }>(db, "SELECT id FROM integration_source ORDER BY id").map((r) => r.id));
      expect(sources.every((s) => s.state === "connected" && s.last_success_age_minutes !== null)).toBe(true);
      expect(ok.checks.import_failures).toMatchObject({ status: "ok", count: 0 });

      db.prepare("UPDATE integration_source SET status = 'offline', last_error = 'synthetic outage for Patient Kettering 1974-07-21' WHERE id = 'src_ema'").run();
      const msg = one<{ id: string; message_id: string; payload: string }>(db, "SELECT id, message_id, payload FROM integration_event LIMIT 1");
      db.prepare(
        "INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, received_at, outcome, detail, payload) VALUES ('ie_health_failed', 'src_ema', 'msg-health-1', 'order.upsert', 'k', ?, 'failed', 'payload unreadable', ?)",
      ).run(new Date().toISOString(), msg?.payload ?? "{}");
      const bad = computeHealth();
      expect(bad.checks.integration_sources.status).toBe("warn");
      expect(bad.checks.integration_sources.detail).toMatch(/src_ema offline/);
      expect(bad.checks.import_failures).toMatchObject({ status: "warn", count: 1 });
      expect(bad.status).toBe("degraded");
      const text = JSON.stringify(bad);
      expect(text).not.toMatch(/Kettering|1974-07-21|synthetic outage|payload unreadable/); // last_error and detail are never echoed
    });
  });

  it("backup age from the newest manifest: ok when recent, warn when older than HLOS_BACKUP_MAX_AGE_HOURS; unknown in demo when none", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      expect(computeHealth().checks.backup.status).toBe("unknown");
      const b = await createBackup({ dbPath: f.file, outDir: f.backups, key: null, mode: "demo", projectRoot: ROOT });
      const h = computeHealth();
      expect(h.checks.backup).toMatchObject({ status: "ok", created_at: b.manifest.created_at, age_hours: 0, encrypted: false });
      expect(h.checks.backup.detail).toMatch(/synthetic, unencrypted/);
      expect(JSON.stringify(h.checks.backup)).not.toMatch(/hlos-backup-|backups/); // no file name, no path
      const m = JSON.parse(fs.readFileSync(b.manifestPath, "utf8")) as { created_at: string };
      m.created_at = new Date(Date.now() - 3 * 86_400_000).toISOString();
      fs.writeFileSync(b.manifestPath, JSON.stringify(m));
      expect(computeHealth().checks.backup).toMatchObject({ status: "warn", age_hours: 72 });
      process.env.HLOS_BACKUP_MAX_AGE_HOURS = "100";
      expect(computeHealth().checks.backup.status).toBe("ok");
    });
  });

  it("the rules: locked or a failed database -> unavailable; any warn or fail -> degraded; otherwise healthy (unknown does not degrade)", () => {
    const c = (status: HealthCheck["status"]): HealthCheck => ({ status, detail: "x", measured_at: "t" });
    expect(overallStatus("demo", { database: c("ok"), a: c("ok"), b: c("unknown") })).toBe("healthy");
    expect(overallStatus("demo", { database: c("ok"), a: c("warn") })).toBe("degraded");
    expect(overallStatus("secured", { database: c("ok"), a: c("fail") })).toBe("degraded");
    expect(overallStatus("demo", { database: c("fail"), a: c("ok") })).toBe("unavailable");
    expect(overallStatus("locked", { database: c("ok") })).toBe("unavailable");
  });
});

// ------------------------------------------------------------------ E4: one structured line per API request

describe("request log (one http.request line per API request)", () => {
  it("commands: method, route template, status, duration, correlation id (= X-Correlation-Id), actor id and command; never the query, input, cookie or a name", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      const cap = captureLogs();
      try {
        const question = "Which side is correct for part B? (synthetic log probe 4711)";
        const body = JSON.stringify({
          input: {
            category: "laterality",
            refs: { sourceOrderId: "ord_ord_77121", orderPartId: "ord_ord_77121_b" },
            subjectLabel: "Part B · ORD-77121",
            question,
            evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", requisition_value: null, source: "bottle label (staff entry)" }],
            priority: "high",
          },
          idempotencyKey: "log-probe-key-0001",
        });
        const req = new Request(`${PUBLIC}/api/commands/clarification.create?patient=Kettering&token=abc123secret`, {
          method: "POST",
          headers: { host: new URL(PUBLIC).host, cookie: `hlos_actor=${STAFF.maya}`, "content-type": "application/json" },
          body,
        });
        const res = await commandPOST(req, { params: Promise.resolve({ name: "clarification.create" }) });
        expect(res.status).toBe(200);
        const lines = requestLines(cap);
        expect(lines).toHaveLength(1);
        const l = lines[0];
        expect(l.level).toBe("info");
        expect(l.obj).toMatchObject({ event: "http.request", method: "POST", route: "/api/commands/[name]", status: 200, actorId: STAFF.maya, command: "clarification.create" });
        expect(typeof l.obj.durationMs).toBe("number");
        expect(l.obj.correlationId).toBe(res.headers.get("x-correlation-id"));
        // The correlation id reached the audit trail too.
        expect(one<{ n: number }>(getDb(), "SELECT COUNT(*) n FROM audit_event WHERE correlation_id = ?", l.obj.correlationId).n).toBeGreaterThan(0);
        expect(Object.keys(l.obj).sort()).toEqual(["actorId", "command", "correlationId", "durationMs", "event", "level", "method", "route", "status", "ts"]);
        expect(l.raw).not.toMatch(/Kettering|abc123secret|token=|patient=|log probe 4711|hlos_actor|Maya|Torres|log-probe-key/);

        // A refused command: status and error code; an unknown command name is never echoed.
        const unkeyed = JSON.stringify({ input: (JSON.parse(body) as { input: unknown }).input });
        await commandPOST(
          new Request(`${PUBLIC}/api/commands/clarification.create`, { method: "POST", headers: { host: new URL(PUBLIC).host, cookie: `hlos_actor=${STAFF.director}` }, body: unkeyed }),
          { params: Promise.resolve({ name: "clarification.create" }) },
        );
        await commandPOST(new Request(`${PUBLIC}/api/commands/x`, { method: "POST", headers: { host: new URL(PUBLIC).host, "x-request-id": "given-request-id-0001" }, body: "{}" }), {
          params: Promise.resolve({ name: "drop.table<script>" }),
        });
        const [, refused, unknown] = requestLines(cap);
        expect(refused.obj).toMatchObject({ status: 403, code: "FORBIDDEN", actorId: STAFF.director });
        expect(unknown.obj).toMatchObject({ command: "unknown", correlationId: "given-request-id-0001" });
        expect(unknown.raw).not.toContain("script");
      } finally {
        cap.restore();
      }
    });
  });

  it("auth routes (secured): the route template only (no code, state or returnTo), the session's staff id resolved before sign-out, never the cookie", async () => {
    const f = fixture();
    await withEnv({ ...securedEnv(), HLOS_DB_PATH: f.file }, async () => {
      const db = getDb();
      linkIdentity(db, { operator: "test", correlationId: "log-test-link" }, { staffId: STAFF.tanya, issuer: "https://idp.synthetic.test", subject: "sub-tanya", labId: "lab:local" });
      const cookie = createSession(db, { staffId: STAFF.tanya, labId: "lab:local", issuer: "https://idp.synthetic.test", subject: "sub-tanya", authTimeMs: Date.now() }, sessionPolicyFromEnv()!).cookieValue;
      const cap = captureLogs();
      try {
        const login = await loginGET(get("/api/auth/login?returnTo=%2Fintake%3Fpatient%3DKettering&code=SECRETCODE123&state=STATE456"));
        expect(login.status).toBeGreaterThanOrEqual(300);
        const session = await sessionGET(get("/api/auth/session", { cookie: `hlos_session=${cookie}` }));
        expect(session.status).toBe(200);
        const out = await logoutPOST(
          new Request(`${PUBLIC}/api/auth/logout`, { method: "POST", headers: { host: new URL(PUBLIC).host, origin: PUBLIC, cookie: `hlos_session=${cookie}` } }),
        );
        expect(out.status).toBe(200);
        const after = await sessionGET(get("/api/auth/session", { cookie: `hlos_session=${cookie}` }));
        expect(after.status).toBe(401);
        const lines = requestLines(cap);
        expect(lines.map((l) => [l.obj.route, l.obj.status, l.obj.actorId])).toEqual([
          ["/api/auth/login", login.status, null],
          ["/api/auth/session", 200, STAFF.tanya],
          ["/api/auth/logout", 200, STAFF.tanya],
          ["/api/auth/session", 401, null],
        ]);
        expect(lines[3].obj.code).toBe("SIGN_IN_REQUIRED");
        for (const l of lines) {
          expect(l.raw).not.toContain(cookie);
          expect(l.raw).not.toMatch(/SECRETCODE123|STATE456|returnTo|Kettering|intake|Tanya|Okafor/);
          expectClean(l.raw, forbidden(db, [cookie]));
        }
      } finally {
        cap.restore();
      }
    });
  });

  it("integration inbound: one line, and the gated 404 is byte-for-byte the handler's own (the response is never changed)", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file }, async () => {
      const cap = captureLogs();
      try {
        const mk = (method: string) => new Request(`${PUBLIC}/api/integration/inbound?x=1`, { method, headers: { host: new URL(PUBLIC).host, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
        const wrapped = await inboundPOST(mk("POST"));
        const direct = await handleInboundRequest(mk("POST"));
        expect(wrapped.status).toBe(404);
        expect(await wrapped.text()).toBe(await direct.text());
        expect([...wrapped.headers.entries()].sort()).toEqual([...direct.headers.entries()].sort());
        await inboundGET(mk("GET"));
        const lines = requestLines(cap);
        expect(lines.map((l) => [l.obj.method, l.obj.route, l.obj.status, l.obj.actorId])).toEqual([
          ["POST", "/api/integration/inbound", 404, null],
          ["GET", "/api/integration/inbound", 404, null],
        ]);
      } finally {
        cap.restore();
      }
    });
  });

  it("health routes log too (the details line names the actor); a thrown handler logs one error line and rethrows", async () => {
    const f = fixture();
    await withEnv({ HLOS_MODE: "demo", HLOS_DB_PATH: f.file, HLOS_BACKUP_DIR: f.backups }, async () => {
      const cap = captureLogs();
      try {
        await healthGET(get("/api/health"));
        await detailsGET(get("/api/health/details", { cookie: `hlos_actor=${STAFF.priya}` }));
        const boom = withRequestLog("/api/test/boom", () => {
          throw new Error("synthetic failure, MRN 503277");
        });
        await expect(boom(new Request(`${PUBLIC}/api/test/boom?mrn=503277`))).rejects.toThrow(/synthetic failure/);
        const lines = requestLines(cap);
        expect(lines.map((l) => [l.level, l.obj.route, l.obj.status, l.obj.actorId])).toEqual([
          ["info", "/api/health", 200, null],
          ["info", "/api/health/details", 200, STAFF.priya],
          ["error", "/api/test/boom", 500, null],
        ]);
        expect(lines[2].obj.error).toMatchObject({ name: "Error" });
        expect(lines[2].raw).not.toMatch(/503277|mrn=/);
      } finally {
        cap.restore();
      }
    });
  });
});
