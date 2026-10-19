// Stage 6 Phase B: sessions, the one guard, roles and the secured command path,
// with FAKE verified identities (no network: completeSignIn is the part of the
// OIDC callback that runs after the ID token was validated). The real code
// flow against a local provider is in oidc.test.ts. Synthetic data only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// next/headers outside a request: a per-test cookie jar and header set for page guards.
const page = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (page.cookies.has(name) ? { name, value: page.cookies.get(name)! } : undefined),
    has: (name: string) => page.cookies.has(name),
  }),
  headers: async () => page.headers,
}));

import { closeSharedDb, getDb, openDatabase, syntheticSeedAllowed, type DB } from "@/server/db/db";
import { SCHEMA_SQL } from "@/server/db/schema";
import { authSchemaSection } from "@/server/db/auth-schema";
import { seedDemo } from "@/server/seed/seed";
import "@/server/commands";
import { executeCommand, listCommands } from "@/server/commands/registry";
import { loadActor, makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { placeHold, releaseHold } from "@/server/domain/holds";
import { correctionHoldReason } from "@/server/domain/correction";
import { loadShellData } from "@/components/shell/server-data";
import { buildTestFixture } from "@/server/test-fixtures";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { BENCH_VIEWS, PERMISSIONS, ROLES, VIEW_PERMISSIONS, roleCan, rolesFor, type Permission } from "@/lib/roles";
import { isDemoMode, isSecuredMode, lockedReason, runtimeMode } from "@/server/runtime-mode";
import { authConfig } from "@/server/auth/config";
import { completeSignIn } from "@/server/auth/flow";
import { currentViewer, requireActor, requireApiActor, requireView, redirectTargetFor, resolveViewer } from "@/server/auth/guard";
import { createSession, hashSessionId, isReauthFresh, resolveSession, revokeSession, sessionPolicyFromEnv } from "@/server/auth/sessions";
import { createTransaction, consumeTransaction, safeReturnTo } from "@/server/auth/transactions";
import { deactivateStaff, linkIdentity, revokeSessions, setRole, unlinkIdentity } from "@/server/auth/admin";
import { POST as commandPOST } from "@/app/api/commands/[name]/route";
import { GET as liveGET } from "@/app/api/live/route";
import { GET as sessionGET } from "@/app/api/session/route";
import { POST as exportPOST } from "@/app/api/worklist/export/route";
import { GET as loginGET } from "@/app/api/auth/login/route";
import { GET as callbackGET } from "@/app/api/auth/callback/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as lockPOST } from "@/app/api/auth/lock/route";
import { GET as authSessionGET } from "@/app/api/auth/session/route";

const PUBLIC = "http://localhost:3999";
/** The issuer of the fake verified identities (no provider runs in this file). */
const IDP = "https://idp.synthetic.test";
const LAB = "lab:local";

const SECURED_ENV: Record<string, string> = {
  HLOS_MODE: "secured",
  HLOS_OIDC_ISSUER: "http://127.0.0.1:9/nothing-listens-here", // loopback discard port: discovery fails closed
  HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
  HLOS_OIDC_CLIENT_ID: "hlos-test-client",
  HLOS_OIDC_CLIENT_SECRET: crypto.randomBytes(24).toString("hex"),
  HLOS_PUBLIC_URL: PUBLIC,
  HLOS_LAB_ID: LAB,
  HLOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
};
const ENV_KEYS = [
  ...Object.keys(SECURED_ENV),
  "HLOS_OIDC_LAB_CLAIM",
  "HLOS_SESSION_IDLE_MIN",
  "HLOS_SESSION_MAX_HOURS",
  "HLOS_REAUTH_MAX_AGE_MIN",
  "HLOS_DB_PATH",
  "HLOS_SEED_SYNTHETIC",
];
const savedEnv: Record<string, string | undefined> = {};
let dir = "";
let template = "";
let fileNo = 0;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-auth-"));
  template = path.join(dir, "template.db");
  const t = openDatabase(template);
  seedDemo(t, { clockRunning: false });
  // Two synthetic staff members with the new roles.
  const add = t.prepare("INSERT INTO staff (id, display_name, short_name, role, initials) VALUES (?, ?, ?, ?, ?)");
  add.run("stf_labadmin", "Alex Rivera (synthetic admin)", "Alex", "lab_admin", "AR");
  add.run("stf_auditor", "Jordan Lee (synthetic auditor)", "Jordan", "auditor", "JL");
  t.close();
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, SECURED_ENV);
  closeSharedDb();
  const file = path.join(dir, `t${++fileNo}.db`);
  fs.copyFileSync(template, file);
  process.env.HLOS_DB_PATH = file;
  page.cookies.clear();
  for (const k of [...page.headers.keys()]) page.headers.delete(k);
});

afterEach(() => {
  closeSharedDb();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

const db = (): DB => getDb();
const cfg = () => {
  const c = authConfig();
  if (!c.ok) throw new Error(`test config invalid: ${c.keys.join(", ")}`);
  return c.config;
};
const count = (sql: string, ...p: unknown[]) => (db().prepare(sql).get(...p) as { n: number }).n;
const audits = (action?: string) => (action ? count("SELECT COUNT(*) n FROM audit_event WHERE action = ?", action) : count("SELECT COUNT(*) n FROM audit_event"));
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

function link(staffId: string, subject = `sub-${staffId}`): void {
  linkIdentity(db(), { operator: "test", correlationId: "test-link-0001" }, { staffId, issuer: IDP, subject, labId: LAB });
}

/** A fake VERIFIED identity signs in (the post-validation half of the OIDC callback). Returns the cookie value. */
function signIn(
  staffId: string,
  opts: { authTimeMs?: number; existingCookie?: string; reauth?: boolean; subject?: string; claims?: Record<string, unknown>; skipLink?: boolean } = {},
): string {
  const subject = opts.subject ?? `sub-${staffId}`;
  if (!opts.skipLink && !db().prepare("SELECT 1 FROM staff_identity WHERE issuer = ? AND subject = ? AND active = 1").get(IDP, subject)) link(staffId, subject);
  const out = completeSignIn(
    db(),
    { issuer: IDP, subject, authTime: Math.floor((opts.authTimeMs ?? Date.now()) / 1000), claims: { iss: IDP, sub: subject, ...(opts.claims ?? {}) } },
    // A browser that already holds a session signs in again only through a forced re-authentication (the login route decides).
    { cfg: cfg(), existingCookie: opts.existingCookie, reauth: opts.reauth ?? Boolean(opts.existingCookie), correlationId: "test-signin-0001" },
  );
  if (!out.ok) throw new Error(`sign-in denied: ${out.reason}`);
  return out.cookieValue;
}

const cookieHeader = (session?: string, extra = "") => [session ? `hlos_session=${session}` : "", extra].filter(Boolean).join("; ");

async function command(
  name: string,
  input: unknown,
  opts: { session?: string; actor?: string | null; extraCookie?: string; origin?: string | null; key?: string } = {},
): Promise<{ status: number; body: { ok: boolean; result?: unknown; error?: { code: string; message: string; details?: unknown } } }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? PUBLIC;
  headers.host = new URL(PUBLIC).host;
  const cookie = cookieHeader(opts.session, opts.extraCookie);
  if (cookie) headers.cookie = cookie;
  if (opts.actor) headers["x-hlos-actor"] = opts.actor;
  const res = await commandPOST(
    new Request(`${PUBLIC}/api/commands/${name}`, { method: "POST", headers, body: JSON.stringify({ input, idempotencyKey: opts.key ?? `t-${crypto.randomUUID()}` }) }),
    { params: Promise.resolve({ name }) },
  );
  return { status: res.status, body: (await res.json()) as never };
}

const get = (url: string, session?: string, extraCookie = "") => {
  const cookie = cookieHeader(session, extraCookie);
  return new Request(`${PUBLIC}${url}`, { headers: cookie ? { cookie } : {} });
};
const post = (url: string, body: unknown, opts: { session?: string; actor?: string; extraCookie?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", origin: PUBLIC, host: new URL(PUBLIC).host };
  const cookie = cookieHeader(opts.session, opts.extraCookie);
  if (cookie) headers.cookie = cookie;
  if (opts.actor) headers["x-hlos-actor"] = opts.actor;
  return new Request(`${PUBLIC}${url}`, { method: "POST", headers, body: JSON.stringify(body) });
};

/** The redirect target of a page guard (next/navigation's redirect throws with a digest). */
async function redirected(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    const m = digest.match(/^NEXT_REDIRECT;[a-z]+;([^;]+);/);
    if (!m) throw e;
    return m[1];
  }
}

const sessionRow = (cookie: string) =>
  db().prepare("SELECT * FROM auth_session WHERE id_hash = ?").get(hashSessionId(cookie)) as { last_activity_at: string; locked_at: string | null; revoked_at: string | null; revoked_reason: string | null; auth_time: string; expires_at: string };
const intakeItem = (displayId = "INT-1014-022") => db().prepare("SELECT id, version, notes FROM intake_item WHERE display_id = ?").get(displayId) as { id: string; version: number; notes: string | null };

// ------------------------------------------------------------------ modes and configuration

describe("runtime modes fail closed", () => {
  it("secured only with HLOS_MODE=secured and a valid configuration; anything else is locked (demo unchanged)", () => {
    expect(runtimeMode()).toBe("secured");
    expect(isSecuredMode()).toBe(true);
    expect(lockedReason()).toBeNull();

    process.env.HLOS_MODE = "demo";
    expect(runtimeMode()).toBe("demo");
    expect(isDemoMode()).toBe(true);
    delete process.env.HLOS_MODE; // vitest runs with NODE_ENV=test: unset is the locked mode, as before
    expect(runtimeMode()).toBe("locked");
    expect(lockedReason()).toEqual({ reason: "not_configured", keys: [] });
    for (const m of ["production", "pilot", "SECURE", "locked"]) {
      process.env.HLOS_MODE = m;
      expect(runtimeMode(), m).toBe("locked");
    }
  });

  it("each invalid or missing key falls back to locked and is named, never its value", () => {
    const cases: [string, string | undefined, string][] = [
      ["HLOS_OIDC_ISSUER", undefined, "HLOS_OIDC_ISSUER"],
      ["HLOS_OIDC_ISSUER", "http://idp.example.org", "HLOS_OIDC_ISSUER"], // http only on loopback
      ["HLOS_OIDC_ISSUER", "ftp://127.0.0.1", "HLOS_OIDC_ISSUER"],
      ["HLOS_OIDC_CLIENT_ID", undefined, "HLOS_OIDC_CLIENT_ID"],
      ["HLOS_OIDC_CLIENT_SECRET", "   ", "HLOS_OIDC_CLIENT_SECRET"],
      ["HLOS_PUBLIC_URL", "http://lab.example.org", "HLOS_PUBLIC_URL"], // cookies never cross a network in clear
      ["HLOS_PUBLIC_URL", "https://lab.example.org/sub/path", "HLOS_PUBLIC_URL"],
      ["HLOS_LAB_ID", "lab one", "HLOS_LAB_ID"],
      ["HLOS_SESSION_SECRET", "x".repeat(31), "HLOS_SESSION_SECRET"],
      ["HLOS_OIDC_LAB_CLAIM", "bad claim!", "HLOS_OIDC_LAB_CLAIM"],
      ["HLOS_SESSION_IDLE_MIN", "0", "HLOS_SESSION_IDLE_MIN"],
      ["HLOS_SESSION_MAX_HOURS", "abc", "HLOS_SESSION_MAX_HOURS"],
      ["HLOS_REAUTH_MAX_AGE_MIN", "999", "HLOS_REAUTH_MAX_AGE_MIN"],
    ];
    const reset = () => {
      for (const k of ["HLOS_OIDC_LAB_CLAIM", "HLOS_SESSION_IDLE_MIN", "HLOS_SESSION_MAX_HOURS", "HLOS_REAUTH_MAX_AGE_MIN"]) delete process.env[k];
      Object.assign(process.env, SECURED_ENV);
    };
    for (const [key, value, named] of cases) {
      reset();
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      expect(runtimeMode(), `${key}=${value}`).toBe("locked");
      const reason = lockedReason();
      expect(reason?.reason).toBe("auth_misconfigured");
      expect(reason?.keys).toEqual([named]);
      expect(JSON.stringify(reason)).not.toContain(SECURED_ENV.HLOS_SESSION_SECRET);
      expect(JSON.stringify(reason)).not.toContain(SECURED_ENV.HLOS_OIDC_CLIENT_SECRET);
    }
    // An http issuer is accepted only on a loopback host AND with the explicit flag.
    reset();
    delete process.env.HLOS_OIDC_ALLOW_INSECURE_LOOPBACK;
    expect(lockedReason()).toEqual({ reason: "auth_misconfigured", keys: ["HLOS_OIDC_ISSUER"] });
    reset();
    expect(cfg()).toMatchObject({ idleMinutes: 15, maxHours: 12, reauthMaxAgeMinutes: 5, labClaim: null, secureCookies: false, redirectUri: `${PUBLIC}/api/auth/callback` });
    process.env.HLOS_PUBLIC_URL = "https://lab.synthetic.test";
    expect(cfg().secureCookies).toBe(true);
  });

  it("getDb() seeds synthetic data only in demo mode or with HLOS_SEED_SYNTHETIC=1, never silently in secured or locked builds", () => {
    const fresh = (name: string) => {
      closeSharedDb();
      process.env.HLOS_DB_PATH = path.join(dir, `${name}-${++fileNo}.db`);
      return (getDb().prepare("SELECT COUNT(*) n FROM staff").get() as { n: number }).n;
    };
    // (The seed itself is loaded lazily through the server bundle; here the gate is checked directly.)
    expect(syntheticSeedAllowed()).toBe(false);
    expect(fresh("secured")).toBe(0);
    delete process.env.HLOS_MODE;
    expect(syntheticSeedAllowed()).toBe(false);
    expect(fresh("locked")).toBe(0);
    process.env.HLOS_MODE = "secured";
    process.env.HLOS_SEED_SYNTHETIC = "true"; // only the exact value "1" counts
    expect(syntheticSeedAllowed()).toBe(false);
    process.env.HLOS_SEED_SYNTHETIC = "1";
    expect(syntheticSeedAllowed()).toBe(true);
    delete process.env.HLOS_SEED_SYNTHETIC;
    process.env.HLOS_MODE = "demo";
    expect(syntheticSeedAllowed()).toBe(true);
  });

  it("an existing database gains staff.lab_id and the three auth tables additively, identical to a new one", () => {
    const legacyFile = path.join(dir, `legacy-${++fileNo}.db`);
    const raw = new Database(legacyFile);
    raw.exec(SCHEMA_SQL.replace(authSchemaSection(), "\n"));
    raw.prepare("INSERT INTO staff (id, display_name, short_name, role, initials) VALUES ('stf_old', 'Old Row (synthetic)', 'Old', 'accessioner', 'OR')").run();
    expect((raw.prepare("PRAGMA table_info(staff)").all() as { name: string }[]).some((c) => c.name === "lab_id")).toBe(false);
    raw.close();

    const migrated = openDatabase(legacyFile);
    const fresh = openDatabase(":memory:");
    const shape = (d: DB, t: string) => JSON.stringify(d.prepare(`PRAGMA table_info(${t})`).all());
    for (const t of ["staff", "staff_identity", "auth_session", "auth_transaction"]) expect(shape(migrated, t), t).toBe(shape(fresh, t));
    expect((migrated.prepare("SELECT lab_id FROM staff WHERE id = 'stf_old'").get() as { lab_id: string }).lab_id).toBe("lab:local");
    migrated.close();
    // Running it again is a no-op.
    const again = openDatabase(legacyFile);
    expect(shape(again, "staff")).toBe(shape(fresh, "staff"));
    again.close();
    fresh.close();
  });
});

// ------------------------------------------------------------------ sessions

describe("sessions: missing, expired, idle-locked, revoked", () => {
  it("no session: every read API and command is 401 SIGN_IN_REQUIRED with no data, and pages redirect to sign-in with the return path", async () => {
    const live = await liveGET(get("/api/live"));
    expect(live.status).toBe(401);
    const liveBody = JSON.stringify(await live.json());
    expect(liveBody).toContain("SIGN_IN_REQUIRED");
    expect(liveBody).not.toMatch(/auditSeq|worklistSeq|sources|clock/);
    expect((await sessionGET(get("/api/session"))).status).toBe(401);
    expect((await authSessionGET(get("/api/auth/session"))).status).toBe(401);
    const before = audits();
    const c = await command("clarification.create", {}, { actor: "stf_maya" });
    expect([c.status, c.body.error?.code]).toEqual([401, "SIGN_IN_REQUIRED"]);
    expect(audits()).toBe(before);

    page.headers.set("x-hlos-path", "/intake?item=INT-1014-022");
    expect(await redirected(() => requireView("view.intake"))).toBe(`/signin?${new URLSearchParams({ returnTo: "/intake?item=INT-1014-022" })}`);
    page.cookies.set("hlos_session", "not-a-real-session-id-not-a-real-session-i");
    expect(await redirected(() => requireActor())).toMatch(/^\/signin\?returnTo=/);
  });

  it("a valid session resolves the staff member fresh from the database; page loads and commands count as activity", async () => {
    const cookie = signIn("stf_maya");
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(isoAgo(5 * 60_000), hashSessionId(cookie));
    page.cookies.set("hlos_session", cookie);
    const actor = await requireView("view.intake");
    expect(actor).toEqual({ id: "stf_maya", name: "Maya Torres", role: "accessioner" });
    expect(Date.now() - Date.parse(sessionRow(cookie).last_activity_at)).toBeLessThan(5_000);
    // A Next.js prefetch is not activity.
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(isoAgo(5 * 60_000), hashSessionId(cookie));
    page.headers.set("next-router-prefetch", "1");
    await requireView("view.intake");
    expect(Date.now() - Date.parse(sessionRow(cookie).last_activity_at)).toBeGreaterThan(4 * 60_000);
  });

  it("a page rendered for a background refresh or client navigation (fetch, not a document load) is not activity; a full page load is", async () => {
    const cookie = signIn("stf_maya");
    const aged = isoAgo(5 * 60_000);
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(aged, hashSessionId(cookie));
    page.cookies.set("hlos_session", cookie);
    // What the browser sends with router.refresh() (LiveRefresh, when the counters move): the page renders, the idle clock stays.
    page.headers.set("sec-fetch-dest", "empty");
    page.headers.set("sec-fetch-mode", "cors");
    expect(await requireView("view.intake")).toMatchObject({ id: "stf_maya" });
    expect(await requireActor()).toMatchObject({ id: "stf_maya" });
    expect(sessionRow(cookie).last_activity_at).toBe(aged);
    // A server action is the person acting: it still counts.
    await currentViewer({ touch: true, view: "view.intake" });
    expect(Date.now() - Date.parse(sessionRow(cookie).last_activity_at)).toBeLessThan(5_000);
    // A full document load (the person opened or reloaded the page) counts.
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(aged, hashSessionId(cookie));
    page.headers.set("sec-fetch-dest", "document");
    page.headers.set("sec-fetch-mode", "navigate");
    await requireView("view.intake");
    expect(Date.now() - Date.parse(sessionRow(cookie).last_activity_at)).toBeLessThan(5_000);
  });

  it("past its absolute expiry: 401 SESSION_EXPIRED for APIs and commands (nothing recorded), sign-in with reason=expired for pages", async () => {
    const cookie = signIn("stf_maya");
    db().prepare("UPDATE auth_session SET expires_at = ? WHERE id_hash = ?").run(isoAgo(1000), hashSessionId(cookie));
    const before = { audit: audits(), clr: count("SELECT COUNT(*) n FROM clarification") };
    const c = await command("intake.updateItem", { intakeItemId: intakeItem().id, expectedVersion: intakeItem().version, patch: { notes: "late" } }, { session: cookie, actor: "stf_maya" });
    expect([c.status, c.body.error?.code]).toEqual([401, "SESSION_EXPIRED"]);
    expect({ audit: audits(), clr: count("SELECT COUNT(*) n FROM clarification") }).toEqual(before);
    expect(intakeItem().notes).not.toBe("late");
    expect((await liveGET(get("/api/live", cookie))).status).toBe(401);
    page.cookies.set("hlos_session", cookie);
    page.headers.set("x-hlos-path", "/worklist");
    expect(await redirected(() => requireView("view.worklist"))).toBe("/signin?returnTo=%2Fworklist&reason=expired");
    // The default lifetime is 12 hours.
    const fresh = signIn("stf_kim");
    expect(Date.parse(sessionRow(fresh).expires_at) - Date.now()).toBeGreaterThan(12 * 3_600_000 - 10_000);
  });

  it("idle for the window: locked (persisted), 401 SESSION_LOCKED; polling /api/live never counts as activity, a command does", async () => {
    const cookie = signIn("stf_maya");
    const policy = sessionPolicyFromEnv()!;
    const now = Date.now();
    // 10 minutes in: polling works but does not move the idle clock.
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(new Date(now - 10 * 60_000).toISOString(), hashSessionId(cookie));
    expect((await liveGET(get("/api/live", cookie))).status).toBe(200);
    expect((await authSessionGET(get("/api/auth/session", cookie))).status).toBe(200);
    expect(Date.parse(sessionRow(cookie).last_activity_at)).toBe(now - 10 * 60_000);
    // 16 minutes later without user activity: locked, and it stays locked.
    const r = resolveSession(db(), cookie, { touch: false, policy, now: now + 6 * 60_000 });
    expect(r).toMatchObject({ ok: false, reason: "idle_locked" });
    expect(sessionRow(cookie).locked_at).not.toBeNull();
    const live = await liveGET(get("/api/live", cookie));
    expect(live.status).toBe(401);
    expect(((await live.json()) as { error: { code: string } }).error.code).toBe("SESSION_LOCKED");
    const c = await command("intake.updateItem", { intakeItemId: intakeItem().id, expectedVersion: intakeItem().version, patch: { notes: "x" } }, { session: cookie, actor: "stf_maya" });
    expect([c.status, c.body.error?.code]).toEqual([401, "SESSION_LOCKED"]);
    // The lock screen learns only that it is locked: no actor, no lab data.
    const info = (await (await authSessionGET(get("/api/auth/session", cookie))).json()) as { result: Record<string, unknown> };
    expect(info.result).toMatchObject({ signedIn: true, locked: true, actor: null });
    expect(JSON.stringify(info)).not.toMatch(/Maya|stf_maya|accessioner/);
    page.cookies.set("hlos_session", cookie);
    expect(await redirected(() => requireView("view.intake"))).toMatch(/^\/signin\?returnTo=%2F&reason=locked$/);

    // A command is activity: another session, touched at 10 min, is still open at 20 min.
    const kim = signIn("stf_kim");
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(new Date(now - 10 * 60_000).toISOString(), hashSessionId(kim));
    const ok = await command("worklist.saveFilter", { name: "Mine (synthetic)", view: "histotech", filters: {} }, { session: kim, actor: "stf_kim" });
    expect(ok.status).toBe(200);
    expect(resolveSession(db(), kim, { touch: false, policy, now: now + 10 * 60_000 }).ok).toBe(true);
  });

  it("manual lock, then the same person signs in again: unlocked, same session, new auth_time", async () => {
    const cookie = signIn("stf_kim", { authTimeMs: Date.now() - 30 * 60_000 });
    const lock = await lockPOST(post("/api/auth/lock", {}, { session: cookie }));
    expect(lock.status).toBe(200);
    expect(sessionRow(cookie).locked_at).not.toBeNull();
    expect(audits("auth.locked")).toBe(1);
    expect((await liveGET(get("/api/live", cookie))).status).toBe(401);
    // A sign-in that did not force a fresh authentication (provider single sign-on) cannot unlock it.
    expect(() => signIn("stf_kim", { existingCookie: cookie, reauth: false })).toThrow("reauth_not_fresh");
    expect(sessionRow(cookie).locked_at).not.toBeNull();
    expect(audits("auth.denied")).toBe(1);
    const again = signIn("stf_kim", { existingCookie: cookie });
    expect(again).toBe(cookie);
    expect(sessionRow(cookie).locked_at).toBeNull();
    expect(Date.now() - Date.parse(sessionRow(cookie).auth_time)).toBeLessThan(5_000);
    expect((await liveGET(get("/api/live", cookie))).status).toBe(200);
  });

  it("revoked (sign-out, admin revoke): 401 SIGN_IN_REQUIRED; sign-out clears the cookie and is audited", async () => {
    const cookie = signIn("stf_maya");
    const out = await logoutPOST(post("/api/auth/logout", {}, { session: cookie }));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^hlos_session=; Path=\/; SameSite=Lax; HttpOnly; Max-Age=0/);
    const body = (await out.json()) as { result: { signedOut: boolean; endSessionUrl: string | null } };
    expect(body.result.signedOut).toBe(true);
    expect(body.result.endSessionUrl).toBeNull(); // the (unreachable) provider advertises nothing: local sign-out still completes
    expect(sessionRow(cookie)).toMatchObject({ revoked_reason: "signed_out" });
    expect(audits("auth.signed_out")).toBe(1);
    const c = await command("worklist.saveFilter", { name: "x", view: "histotech", filters: {} }, { session: cookie, actor: "stf_maya" });
    expect([c.status, c.body.error?.code]).toEqual([401, "SIGN_IN_REQUIRED"]);

    // A sign-out from another site is refused (same-origin check), and so is one without Origin or Sec-Fetch-Site.
    const other = signIn("stf_kim");
    const cross = new Request(`${PUBLIC}/api/auth/logout`, { method: "POST", headers: { origin: "https://evil.example", cookie: cookieHeader(other) } });
    expect((await logoutPOST(cross)).status).toBe(403);
    const bare = new Request(`${PUBLIC}/api/auth/logout`, { method: "POST", headers: { cookie: cookieHeader(other) } });
    expect((await logoutPOST(bare)).status).toBe(403);
    expect(sessionRow(other).revoked_at).toBeNull();

    const n = revokeSessions(db(), { operator: "test", correlationId: "test-admin-0001" }, { staffId: "stf_kim" });
    expect(n.sessionsRevoked).toBe(1);
    expect((await liveGET(get("/api/live", other))).status).toBe(401);
    expect(audits("admin.revoke_sessions")).toBe(1);
  });

  it("the session id is 256 random bits and only its SHA-256 is stored", () => {
    const cookie = signIn("stf_maya");
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(cookie, "base64url")).toHaveLength(32);
    const row = sessionRow(cookie) as unknown as Record<string, unknown>;
    expect(row.id_hash).toBe(crypto.createHash("sha256").update(cookie).digest("hex"));
    for (const table of ["auth_session", "audit_event", "auth_transaction", "command_receipt", "app_setting"]) {
      expect(JSON.stringify(db().prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(cookie);
    }
    expect(createSession(db(), { staffId: "stf_kim", labId: LAB, issuer: IDP, subject: "sub-x", authTimeMs: Date.now() }, sessionPolicyFromEnv()!).cookieValue).not.toBe(cookie);
  });
});

// ------------------------------------------------------------------ staff changes mid-session

describe("staff changes apply to the next request", () => {
  it("a staff member deactivated mid-session is refused (403) at once, and the session is revoked", async () => {
    const cookie = signIn("stf_maya");
    expect((await liveGET(get("/api/live", cookie))).status).toBe(200);
    deactivateStaff(db(), { operator: "test", correlationId: "test-admin-0002" }, { staffId: "stf_maya" });
    const live = await liveGET(get("/api/live", cookie));
    expect(live.status).toBe(401); // deactivate-staff revoked every session
    // Deactivated directly in the table (no revoke): the guard itself refuses and revokes.
    const luis = signIn("stf_luis");
    db().prepare("UPDATE staff SET active = 0 WHERE id = 'stf_luis'").run();
    const c = await command("intake.updateItem", { intakeItemId: intakeItem().id, expectedVersion: intakeItem().version, patch: { notes: "after" } }, { session: luis, actor: "stf_luis" });
    expect([c.status, c.body.error?.code, (c.body.error?.details as { reason: string }).reason]).toEqual([403, "FORBIDDEN", "staff_inactive"]);
    expect(sessionRow(luis).revoked_reason).toBe("staff_inactive");
    page.cookies.set("hlos_session", luis);
    expect(await redirected(() => requireView("view.intake"))).toBe("/signin?returnTo=%2F"); // revoked now
  });

  it("a role changed mid-session applies on the next request (commands and views)", async () => {
    const cookie = signIn("stf_maya");
    const item = intakeItem();
    const ok = await command("intake.updateItem", { intakeItemId: item.id, expectedVersion: item.version, patch: { notes: "Maya (synthetic)" } }, { session: cookie, actor: "stf_maya" });
    expect(ok.status).toBe(200);
    setRole(db(), { operator: "test", correlationId: "test-admin-0003" }, { staffId: "stf_maya", role: "director" });
    const after = intakeItem();
    const refused = await command("intake.updateItem", { intakeItemId: after.id, expectedVersion: after.version, patch: { notes: "again" } }, { session: cookie, actor: "stf_maya" });
    expect([refused.status, refused.body.error?.code]).toEqual([403, "FORBIDDEN"]);
    expect(intakeItem().notes).toBe("Maya (synthetic)");
    setRole(db(), { operator: "test", correlationId: "test-admin-0004" }, { staffId: "stf_maya", role: "lab_admin" });
    page.cookies.set("hlos_session", cookie);
    expect(await redirected(() => requireView("view.intake"))).toBe("/forbidden");
    expect(audits("admin.set_role")).toBe(2);
  });

  it("an identity unlinked mid-session ends the session", async () => {
    const cookie = signIn("stf_maya");
    unlinkIdentity(db(), { operator: "test", correlationId: "test-admin-0005" }, { issuer: IDP, subject: "sub-stf_maya", labId: LAB });
    expect((await liveGET(get("/api/live", cookie))).status).toBe(401);
    expect(sessionRow(cookie).revoked_reason).toBe("identity_unlinked");
  });

  it("wrong lab: a session of another lab, a staff member of another lab, or a deployment switched to another lab is refused", async () => {
    const a = signIn("stf_maya");
    db().prepare("UPDATE auth_session SET lab_id = 'lab:other' WHERE id_hash = ?").run(hashSessionId(a));
    const r1 = await liveGET(get("/api/live", a));
    expect(r1.status).toBe(403);
    expect(JSON.stringify(await r1.json())).toContain("wrong_lab");

    const b = signIn("stf_kim");
    db().prepare("UPDATE staff SET lab_id = 'lab:other' WHERE id = 'stf_kim'").run();
    expect((await liveGET(get("/api/live", b))).status).toBe(403);
    expect(sessionRow(b).revoked_reason).toBe("wrong_lab");

    const c = signIn("stf_luis");
    process.env.HLOS_LAB_ID = "lab:elsewhere";
    expect((await liveGET(get("/api/live", c))).status).toBe(403);
    page.cookies.set("hlos_session", c);
    process.env.HLOS_LAB_ID = LAB;
    expect(await redirected(() => requireActor())).toBe("/signin?returnTo=%2F"); // revoked on the refused request
  });
});

// ------------------------------------------------------------------ sign-in decisions (post-verification)

describe("sign-in after a verified identity: links only, lab claim, hand-over", () => {
  it("an unlinked subject, an inactive staff member and a missing lab claim are denied, audited without the subject, and get no session", () => {
    const sessions = () => count("SELECT COUNT(*) n FROM auth_session");
    const deny = (identity: { subject: string; claims?: Record<string, unknown> }) =>
      completeSignIn(
        db(),
        { issuer: IDP, subject: identity.subject, authTime: Math.floor(Date.now() / 1000), claims: { sub: identity.subject, ...(identity.claims ?? {}) } },
        { cfg: cfg(), correlationId: "test-deny-0001" },
      );
    expect(deny({ subject: "sub-nobody" })).toEqual({ ok: false, reason: "unlinked" });
    link("stf_luis");
    db().prepare("UPDATE staff SET active = 0 WHERE id = 'stf_luis'").run();
    expect(deny({ subject: "sub-stf_luis" })).toEqual({ ok: false, reason: "inactive" });
    process.env.HLOS_OIDC_LAB_CLAIM = "hlos_labs";
    link("stf_kim");
    expect(deny({ subject: "sub-stf_kim", claims: { hlos_labs: ["lab:other"] } })).toEqual({ ok: false, reason: "wrong_lab" });
    expect(deny({ subject: "sub-stf_kim" })).toEqual({ ok: false, reason: "wrong_lab" });
    expect(sessions()).toBe(0);
    const rows = db().prepare("SELECT origin, actor_id, reason, after_json FROM audit_event WHERE action = 'auth.denied' ORDER BY seq").all() as { origin: string; reason: string; after_json: string }[];
    expect(rows.map((r) => r.reason)).toEqual(["unlinked", "inactive", "wrong_lab", "wrong_lab"]);
    for (const r of rows) {
      expect(r.origin).toBe("system");
      expect(r.after_json).not.toMatch(/sub-nobody|sub-stf_/);
      expect(r.after_json).toMatch(/sub-sha256:[0-9a-f]{16}/);
    }
    // With the lab in the claim (string or array) the same person signs in.
    expect(typeof signIn("stf_kim", { claims: { hlos_labs: "lab:local" } })).toBe("string");
    expect(typeof signIn("stf_kim", { claims: { hlos_labs: ["lab:x", "lab:local"] } })).toBe("string");
  });

  it("an auth_time more than a minute in the future is refused: a provider clock running ahead cannot stretch the re-authentication window", () => {
    expect(() => signIn("stf_kim", { authTimeMs: Date.now() + 60 * 60_000 })).toThrow("sign-in denied: token_invalid");
    expect(count("SELECT COUNT(*) n FROM auth_session")).toBe(0);
    expect(audits("auth.denied")).toBe(1);
    // Ordinary clock skew (under a minute) is accepted.
    const cookie = signIn("stf_kim", { authTimeMs: Date.now() + 30_000 });
    expect(sessionRow(cookie).revoked_at).toBeNull();
  });

  it("a different person signing in on the same browser revokes the previous session (workstation hand-over)", async () => {
    const maya = signIn("stf_maya");
    const kim = signIn("stf_kim", { existingCookie: maya });
    expect(kim).not.toBe(maya);
    expect(sessionRow(maya).revoked_reason).toBe("handover");
    expect((await liveGET(get("/api/live", maya))).status).toBe(401);
    expect((await liveGET(get("/api/live", kim))).status).toBe(200);
    expect(audits("auth.handover")).toBe(1);
    expect(audits("auth.signed_in")).toBe(2);
  });

  it("one transaction is consumed exactly once and expires after 10 minutes", () => {
    createTransaction(db(), { state: "state-aaaa", nonce: "n", codeVerifier: "v", returnTo: "//evil.example", reauth: false });
    expect((db().prepare("SELECT return_to FROM auth_transaction WHERE state = 'state-aaaa'").get() as { return_to: string }).return_to).toBe("/");
    expect(consumeTransaction(db(), "state-aaaa").ok).toBe(true);
    expect(consumeTransaction(db(), "state-aaaa")).toEqual({ ok: false, reason: "consumed" });
    expect(consumeTransaction(db(), "state-unknown")).toEqual({ ok: false, reason: "unknown" });
    createTransaction(db(), { state: "state-bbbb", nonce: "n", codeVerifier: "v", returnTo: "/intake", reauth: false }, Date.now() - 11 * 60_000);
    expect(consumeTransaction(db(), "state-bbbb")).toEqual({ ok: false, reason: "expired" });
  });

  it("returnTo: open-redirect attempts are refused; only a same-origin application path survives", () => {
    const attacks = [
      "https://evil.example/",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\\/evil.example",
      "http:/evil.example",
      "javascript:alert(1)",
      "/\r\nLocation: https://evil.example",
      "/\tevil",
      "evil.example",
      "/api/auth/login?returnTo=//evil.example",
      "/signin?returnTo=//evil.example",
      "/locked",
      "x".repeat(10) + "/" + "y".repeat(600),
      "",
      null,
      undefined,
      42,
      { toString: () => "/intake" },
    ];
    for (const a of attacks) expect(safeReturnTo(a), JSON.stringify(String(a))).toBe("/");
    // %0d%0a stays percent-encoded in a path, so the header cannot be split; but it is still a same-origin path.
    expect(safeReturnTo("/intake%0d%0a")).toBe("/intake%0d%0a");
    expect(safeReturnTo("/intake?item=INT-1014-022")).toBe("/intake?item=INT-1014-022");
    expect(safeReturnTo("/cases/D26-04804?tab=history#top")).toBe("/cases/D26-04804?tab=history#top");
    expect(safeReturnTo("  /worklist  ")).toBe("/worklist");
    // Page redirects re-validate whatever the header says.
    const fail = { ok: false as const, mode: "secured" as const, status: 401 as const, code: "SIGN_IN_REQUIRED" as const, reason: "missing" as const, message: "" };
    expect(redirectTargetFor(fail, "//evil.example")).toBe("/signin?returnTo=%2F");
    expect(redirectTargetFor(fail, "https://evil.example")).toBe("/signin?returnTo=%2F");
  });
});

// ------------------------------------------------------------------ the command path in secured mode

describe("secured commands: actor from the session only, actor header, re-authentication", () => {
  it("a forged demo cookie is ignored: no session is 401, and with a session the actor is the session's staff member", async () => {
    const forged = "hlos_actor=stf_tanya";
    const none = await command("hold.place", {}, { extraCookie: forged, actor: "stf_tanya" });
    expect([none.status, none.body.error?.code]).toEqual([401, "SIGN_IN_REQUIRED"]);
    expect((await sessionGET(get("/api/session", undefined, forged))).status).toBe(401);
    page.cookies.set("hlos_actor", "stf_tanya");
    expect(await redirected(() => requireView("view.operations"))).toMatch(/^\/signin/);

    const maya = signIn("stf_maya");
    const who = (await (await sessionGET(get("/api/session", maya, forged))).json()) as { actor: { id: string } };
    expect(who.actor.id).toBe("stf_maya");
    const item = intakeItem();
    const ok = await command("intake.updateItem", { intakeItemId: item.id, expectedVersion: item.version, patch: { notes: "by Maya (synthetic)" } }, { session: maya, actor: "stf_maya", extraCookie: forged });
    expect(ok.status).toBe(200);
    expect((db().prepare("SELECT actor_id FROM audit_event ORDER BY seq DESC LIMIT 1").get() as { actor_id: string }).actor_id).toBe("stf_maya");
    // A supervisor-only command stays refused for Maya whatever the demo cookie says.
    const sup = await command("integration.retryEvent", {}, { session: maya, actor: "stf_maya", extraCookie: forged });
    expect([sup.status, sup.body.error?.code]).toEqual([403, "FORBIDDEN"]);
    // Asking to act as the supervisor named by the forged cookie is a mismatch.
    const asTanya = await command("intake.updateItem", { intakeItemId: item.id, expectedVersion: item.version + 1, patch: { notes: "as Tanya" } }, { session: maya, actor: "stf_tanya", extraCookie: forged });
    expect([asTanya.status, asTanya.body.error?.code]).toEqual([409, "ACTOR_MISMATCH"]);
  });

  it("X-HLOS-Actor must equal the session's staff member: otherwise 409 ACTOR_MISMATCH, nothing recorded, no activity", async () => {
    const luis = signIn("stf_luis");
    const aged = isoAgo(5 * 60_000);
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(aged, hashSessionId(luis));
    const snapshot = () => ({ audit: audits(), receipts: count("SELECT COUNT(*) n FROM command_receipt"), item: intakeItem() });
    const before = snapshot();
    // The page was rendered for Maya (or for nobody), but Luis is signed in now.
    for (const actor of [null, "", "stf_maya", "STF_LUIS", "stf_luis_x"]) {
      const r = await command("intake.updateItem", { intakeItemId: before.item.id, expectedVersion: before.item.version, patch: { notes: "wrong person" } }, { session: luis, actor });
      expect([r.status, r.body.error?.code], String(actor)).toEqual([409, "ACTOR_MISMATCH"]);
    }
    const csv = await exportPOST(post("/api/worklist/export", { view: "histotech", filters: {} }, { session: luis, actor: "stf_maya" }));
    expect(csv.status).toBe(409);
    expect(snapshot()).toEqual(before);
    expect(sessionRow(luis).last_activity_at).toBe(aged);
    // The right header goes through (and counts as activity).
    const ok = await command("intake.updateItem", { intakeItemId: before.item.id, expectedVersion: before.item.version, patch: { notes: "Luis (synthetic)" } }, { session: luis, actor: "stf_luis" });
    expect(ok.status).toBe(200);
    expect(sessionRow(luis).last_activity_at).not.toBe(aged);
    // executeCommand itself refuses a session that is not the actor's, and a secured user request without one.
    const direct = executeCommand(db(), "stf_maya", "intake.updateItem", {}, { auth: { sessionIdHash: hashSessionId(luis), staffId: "stf_luis", authTime: new Date().toISOString() } });
    expect(!direct.ok && direct.error.code).toBe("ACTOR_MISMATCH");
    const noAuth = executeCommand(db(), "stf_maya", "intake.updateItem", {});
    expect(!noAuth.ok && noAuth.error.code).toBe("SIGN_IN_REQUIRED");
  });

  it("re-authentication: a sensitive command with a stale sign-in is 401 REAUTH_REQUIRED (nothing recorded); after signing in again it runs", async () => {
    const kim = signIn("stf_kim", { authTimeMs: Date.now() - 10 * 60_000 });
    const item = intakeItem();
    // Not sensitive: placing a hold works with an older sign-in.
    const placed = await command(
      "hold.place",
      { scope: { type: "intake_item", id: item.id }, scopeLabel: "INT-1014-022 (synthetic)", blocks: ["accession_request"], reasonText: "Synthetic test hold" },
      { session: kim, actor: "stf_kim" },
    );
    expect(placed.status).toBe(200);
    const hold = placed.body.result as { holdId: string; version: number };
    const released = () => count("SELECT COUNT(*) n FROM audit_event WHERE action = 'hold.released' AND entity_id = ?", hold.holdId);
    const key = "reauth-release-0001";
    const stale = await command("hold.release", { holdId: hold.holdId, expectedVersion: hold.version, reason: "Synthetic: resolved" }, { session: kim, actor: "stf_kim", key });
    expect([stale.status, stale.body.error?.code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect((db().prepare("SELECT status FROM hold WHERE id = ?").get(hold.holdId) as { status: string }).status).toBe("active");
    expect(released()).toBe(0);
    expect(count("SELECT COUNT(*) n FROM command_receipt WHERE idempotency_key = ?", key)).toBe(0);

    // "Confirm it's you": the same person signs in again (same session, fresh auth_time).
    expect(signIn("stf_kim", { existingCookie: kim })).toBe(kim);
    const fresh = await command("hold.release", { holdId: hold.holdId, expectedVersion: hold.version, reason: "Synthetic: resolved" }, { session: kim, actor: "stf_kim", key });
    expect(fresh.status).toBe(200);
    expect(released()).toBe(1);
    expect(isReauthFresh(sessionRow(kim).auth_time, sessionPolicyFromEnv()!)).toBe(true);
    expect(isReauthFresh(sessionRow(kim).auth_time, sessionPolicyFromEnv()!, Date.now() + 6 * 60_000)).toBe(false);
  });

  it("the sensitive commands are exactly the decisions the design names", () => {
    const flagged = Object.fromEntries(listCommands().filter((c) => c.sensitive).map((c) => [c.name, c.sensitive]));
    expect(flagged).toEqual({
      "clarification.resolve": "conditional", // identity questions (and resolutions that also release holds)
      "correction.close": "conditional", // closing a review that releases its holds, or an identity discrepancy
      "gross.approve": true,
      "hold.release": true,
      "intake.acceptDiscrepancy": true,
      "related.review": true,
      "routing.override": true,
      "sourceConflict.review": true,
      "tray.releaseWithExceptions": true,
    });
  });

  it("closing a correction review that releases holds, or an identity discrepancy, needs a recent sign-in; releaseHold itself refuses a stale one", async () => {
    // Every command that can reach releaseHold() is sensitive (always or for those inputs).
    const flags = Object.fromEntries(listCommands().map((c) => [c.name, c.sensitive]));
    expect([flags["hold.release"], flags["clarification.resolve"], flags["correction.close"]]).toEqual([true, "conditional", "conditional"]);

    const kim = signIn("stf_kim", { authTimeMs: Date.now() - 60 * 60_000 });
    const acc = db().prepare("SELECT id, accession_number FROM accession ORDER BY id LIMIT 1").get() as { id: string; accession_number: string };
    const open = async (kind: string) => {
      const r = await command("correction.open", { accessionId: acc.id, kind, description: `Synthetic ${kind} (test)` }, { session: kim, actor: "stf_kim" });
      expect(r.status, kind).toBe(200);
      return (r.body.result as { correctionId: string }).correctionId;
    };
    const site = await open("site_discrepancy");
    // The hold a source amendment places for the review (linked through its reason code).
    const hold = db().transaction(() =>
      placeHold(makeCtx(db(), SYSTEM_ACTOR, "system", "test-hold-0001"), {
        scope: { type: "accession", id: acc.id },
        scopeLabel: `${acc.accession_number} (synthetic)`,
        blocks: ["print"],
        reasonCode: correctionHoldReason(site),
        reasonText: "Synthetic source amendment",
        accessionId: acc.id,
      }),
    )();
    const holdRow = () => db().prepare("SELECT status, released_by FROM hold WHERE id = ?").get(hold.id) as { status: string; released_by: string | null };
    const correction = (id: string) => db().prepare("SELECT status, version FROM correction_review WHERE id = ?").get(id) as { status: string; version: number };
    const closed = () => audits("correction.closed");

    // Stale sign-in: closing (which would release the hold) is refused, nothing recorded.
    const before = { audit: audits(), closed: closed() };
    const stale = await command("correction.close", { correctionId: site, outcome: "closed_no_change", note: "Synthetic: no change", expectedVersion: 1 }, { session: kim, actor: "stf_kim" });
    expect([stale.status, stale.body.error?.code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect(holdRow()).toEqual({ status: "active", released_by: null });
    expect(correction(site).status).toBe("open");
    expect(audits()).toBe(before.audit);
    // An identity discrepancy is an identity decision, even with no hold.
    const identity = await open("identity_discrepancy");
    const idStale = await command("correction.close", { correctionId: identity, outcome: "closed_corrected_in_source", note: "Synthetic", expectedVersion: 1 }, { session: kim, actor: "stf_kim" });
    expect([idStale.status, idStale.body.error?.code]).toEqual([401, "REAUTH_REQUIRED"]);
    expect(correction(identity).status).toBe("open");
    // A referral to the source process keeps the hold and decides nothing: not sensitive.
    const referred = await command("correction.close", { correctionId: site, outcome: "referred_to_source_process", note: "Synthetic: referred", expectedVersion: 1 }, { session: kim, actor: "stf_kim" });
    expect(referred.status).toBe(200);
    expect(holdRow().status).toBe("active");

    // Defence in depth: releaseHold refuses a stale secured sign-in whichever command reached it.
    const staleCtx = { ...makeCtx(db(), loadActor(db(), "stf_kim"), "user", "test-direct-0001"), reauthFresh: false };
    let code: string | null = null;
    try {
      db().transaction(() => releaseHold(staleCtx, hold.id, "Synthetic: direct"))();
    } catch (e) {
      code = (e as { code?: string }).code ?? null;
    }
    expect(code).toBe("REAUTH_REQUIRED");
    expect(holdRow().status).toBe("active");

    // "Confirm it's you", then the same close releases the hold as Kim.
    expect(signIn("stf_kim", { existingCookie: kim })).toBe(kim);
    const fresh = await command("correction.close", { correctionId: site, outcome: "closed_no_change", note: "Synthetic: no change", expectedVersion: correction(site).version }, { session: kim, actor: "stf_kim" });
    expect(fresh.status).toBe(200);
    expect(holdRow()).toEqual({ status: "released", released_by: "stf_kim" });
    expect(closed()).toBe(before.closed + 1);
  });

  it("presenter commands are refused in secured mode, for every role (audited as denied, nothing changes)", async () => {
    const tanya = signIn("stf_tanya");
    const presenter = listCommands().filter((c) => c.audience === "presenter");
    expect(presenter.length).toBeGreaterThan(5);
    const clock = db().prepare("SELECT value FROM app_setting WHERE key = 'clock_anchor_demo'").get();
    const denied = audits("command.denied");
    for (const c of presenter) {
      const r = await command(c.name, c.name === "demo.setClock" ? { advanceMinutes: 30 } : {}, { session: tanya, actor: "stf_tanya" });
      expect([r.status, r.body.error?.code], c.name).toEqual([403, "FORBIDDEN"]);
    }
    expect(audits("command.denied")).toBe(denied + presenter.length);
    expect(db().prepare("SELECT value FROM app_setting WHERE key = 'clock_anchor_demo'").get()).toEqual(clock);
  });

  it("concurrent updates by two sessions: optimistic versioning, the second gets 409 CONFLICT", async () => {
    const maya = signIn("stf_maya");
    const luis = signIn("stf_luis");
    const seen = intakeItem();
    const first = await command("intake.updateItem", { intakeItemId: seen.id, expectedVersion: seen.version, patch: { notes: "Maya: requisition checked (synthetic)" } }, { session: maya, actor: "stf_maya" });
    const second = await command("intake.updateItem", { intakeItemId: seen.id, expectedVersion: seen.version, patch: { notes: "Luis: my note (synthetic)" } }, { session: luis, actor: "stf_luis" });
    expect(first.status).toBe(200);
    expect([second.status, second.body.error?.code]).toEqual([409, "CONFLICT"]);
    expect(intakeItem()).toMatchObject({ version: seen.version + 1, notes: "Maya: requisition checked (synthetic)" });
  });

  it("idempotency keeps working, owned by the session's staff member", async () => {
    const maya = signIn("stf_maya");
    const luis = signIn("stf_luis");
    const key = "secured-key-0001";
    const input = { name: "Mine (synthetic)", view: "histotech", filters: {} };
    const a = await command("worklist.saveFilter", input, { session: maya, actor: "stf_maya", key });
    const again = await command("worklist.saveFilter", input, { session: maya, actor: "stf_maya", key });
    expect(a.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, replayed: true, result: a.body.result });
    expect((db().prepare("SELECT actor_id FROM command_receipt WHERE idempotency_key = ?").get(key) as { actor_id: string }).actor_id).toBe("stf_maya");
    const stolen = await command("worklist.saveFilter", input, { session: luis, actor: "stf_luis", key });
    expect([stolen.status, stolen.body.error?.code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
  });
});

// ------------------------------------------------------------------ locked mode

describe("locked mode", () => {
  it("every API returns 401 with no data, even with a valid session and a demo cookie; pages redirect to /locked", async () => {
    const maya = signIn("stf_maya");
    const extra = "hlos_actor=stf_tanya";
    for (const setup of [() => delete process.env.HLOS_MODE, () => delete process.env.HLOS_SESSION_SECRET, () => (process.env.HLOS_MODE = "production")]) {
      Object.assign(process.env, SECURED_ENV);
      setup();
      expect(runtimeMode()).toBe("locked");
      const responses: [string, Response][] = [
        ["live", await liveGET(get("/api/live", maya, extra))],
        ["session", await sessionGET(get("/api/session", maya, extra))],
        ["auth/session", await authSessionGET(get("/api/auth/session", maya, extra))],
        ["auth/login", await loginGET(get("/api/auth/login?returnTo=/intake", maya, extra))],
        ["auth/callback", await callbackGET(get("/api/auth/callback?code=abc&state=def", maya, extra))],
        ["auth/logout", await logoutPOST(post("/api/auth/logout", {}, { session: maya, extraCookie: extra }))],
        ["auth/lock", await lockPOST(post("/api/auth/lock", {}, { session: maya, extraCookie: extra }))],
        ["worklist/export", await exportPOST(post("/api/worklist/export", { view: "histotech", filters: {} }, { session: maya, actor: "stf_maya", extraCookie: extra }))],
        [
          "commands",
          await commandPOST(post("/api/commands/worklist.saveFilter", { input: { name: "x", view: "histotech", filters: {} } }, { session: maya, actor: "stf_maya", extraCookie: extra }), {
            params: Promise.resolve({ name: "worklist.saveFilter" }),
          }),
        ],
      ];
      for (const [name, res] of responses) {
        expect(res.status, name).toBe(401);
        const text = await res.text();
        expect(JSON.parse(text), name).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
        expect(text, name).not.toMatch(/auditSeq|worklistSeq|"actor"|Maya|Tanya|stf_|INT-|D26-|csv/i);
      }
      page.cookies.set("hlos_session", maya);
      page.cookies.set("hlos_actor", "stf_tanya");
      expect(await redirected(() => requireView("view.intake"))).toBe("/locked");
      expect(await redirected(() => requireActor())).toBe("/locked");
    }
  });
});

// ------------------------------------------------------------------ roles

describe("roles: lab_admin and auditor have no clinical permission and no bench view", () => {
  const clinical = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => !p.startsWith("view."));

  it("the matrix: every pre-Stage-6 role keeps every bench view; admin and auditor get only their views; identity.resolve is lead and supervisor", () => {
    const existing = ROLES.filter((r) => r !== "lab_admin" && r !== "auditor");
    for (const role of existing) for (const v of BENCH_VIEWS) expect(roleCan(role, v), `${role} ${v}`).toBe(true);
    for (const role of ["lab_admin", "auditor"] as const) {
      for (const p of clinical) expect(roleCan(role, p), `${role} ${p}`).toBe(false);
      for (const v of BENCH_VIEWS) expect(roleCan(role, v), `${role} ${v}`).toBe(false);
    }
    expect(VIEW_PERMISSIONS.filter((v) => roleCan("lab_admin", v))).toEqual(["view.audit", "view.admin"]);
    expect(VIEW_PERMISSIONS.filter((v) => roleCan("auditor", v))).toEqual(["view.audit"]);
    expect([...rolesFor("identity.resolve")]).toEqual(["accessioning_lead", "supervisor"]);
  });

  for (const who of ["stf_labadmin", "stf_auditor"] as const) {
    it(`${who}: every clinical command is 403 before its input is read, every bench page is 403, nothing changes`, async () => {
      const cookie = signIn(who);
      const lab = listCommands().filter((c) => c.audience === "lab");
      expect(lab.length).toBeGreaterThan(50);
      const tables = ["clarification", "hold", "intake_item", "task", "command_receipt", "worklist_change", "print_job"];
      const snapshot = () => Object.fromEntries(tables.map((t) => [t, count(`SELECT COUNT(*) n FROM ${t}`)]));
      const before = snapshot();
      const deniedBefore = audits("command.denied");
      for (const c of lab) {
        const r = await command(c.name, {}, { session: cookie, actor: who });
        expect([r.status, r.body.error?.code], c.name).toEqual([403, "FORBIDDEN"]);
      }
      expect(snapshot()).toEqual(before);
      expect(audits("command.denied")).toBe(deniedBefore + lab.length);
      for (const v of BENCH_VIEWS) {
        page.cookies.set("hlos_session", cookie);
        expect(await redirected(() => requireView(v)), v).toBe("/forbidden");
        const api = resolveViewer({ sessionCookie: cookie, demoActorId: "" }, { touch: false, view: v });
        expect(!api.ok && [api.status, api.code, api.reason]).toEqual([403, "FORBIDDEN", "view_denied"]);
      }
      const csv = await exportPOST(post("/api/worklist/export", { view: "histotech", filters: {} }, { session: cookie, actor: who }));
      expect(csv.status).toBe(403);
      expect(await csv.text()).not.toMatch(/D26-|INT-/);
      expect(await requireView("view.audit")).toMatchObject({ id: who });
    });
  }

  it("lab_admin and auditor get no bench data from the shell or /api/live: no counts, clock or source health", async () => {
    for (const who of ["stf_labadmin", "stf_auditor"] as const) {
      const cookie = signIn(who);
      const live = await liveGET(get("/api/live", cookie));
      expect(live.status, who).toBe(403);
      const text = JSON.stringify(await live.json());
      expect(text).toContain("FORBIDDEN");
      expect(text).not.toMatch(/auditSeq|worklistSeq|sources|clock|tenant/);
      page.cookies.set("hlos_session", cookie);
      const shell = await loadShellData();
      expect(shell, who).toMatchObject({
        signedIn: true,
        actor: { id: who },
        counts: { intake: null, clarifications: null, materials: null, operations: null },
        live: { auditSeq: 0, worklistSeq: 0, sources: [] },
      });
      expect(shell.live.clock.anchorDemo).toBe("");
    }
    // A bench role still gets them.
    const maya = signIn("stf_maya");
    page.cookies.set("hlos_session", maya);
    const shell = await loadShellData();
    expect(shell.counts.clarifications).toBeGreaterThan(0);
    expect(shell.live.sources.length).toBeGreaterThan(0);
    expect((await liveGET(get("/api/live", maya))).status).toBe(200);
  });

  it("identity.resolve is needed for sourceConflict.review, on top of clarification.resolve", async () => {
    process.env.HLOS_MODE = "demo";
    const d = db();
    const fixture = buildTestFixture(d, "source-conflict-patient");
    d.transaction(() => importSourceMessage(makeCtx(d, SYSTEM_ACTOR, "import", "test-fixture-0001"), fixture.sourceId, fixture.message, { via: "sync" }))();
    const task = d.prepare("SELECT id, version FROM task WHERE kind = 'source_conflict' AND status = 'open' ORDER BY created_at DESC LIMIT 1").get() as { id: string; version: number };
    const input = { taskId: task.id, expectedVersion: task.version, decision: "details_on_file_confirmed", reason: "Office confirmed the details on file (synthetic)" };
    // Give accessioners clarification.resolve for this test only: identity.resolve must still refuse them.
    const resolvers = PERMISSIONS["clarification.resolve"] as unknown as string[];
    resolvers.push("accessioner");
    try {
      const maya = executeCommand(d, "stf_maya", "sourceConflict.review", input);
      expect(!maya.ok && maya.error.code).toBe("FORBIDDEN");
      expect(!maya.ok && maya.error.message).toMatch(/cannot decide patient identity and source-conflict questions/);
      expect((d.prepare("SELECT status FROM task WHERE id = ?").get(task.id) as { status: string }).status).toBe("open");
    } finally {
      resolvers.pop();
    }
    expect(executeCommand(d, "stf_kim", "sourceConflict.review", input).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ proxy and headers

describe("proxy (optimistic) and security headers", () => {
  it("locked: every page redirects to /locked; secured: no cookie -> /signin with the path; demo: design previews stay bare", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const req = (p: string, cookie?: string) => new NextRequest(`${PUBLIC}${p}`, { headers: cookie ? { cookie } : {} });
    delete process.env.HLOS_MODE;
    for (const p of ["/", "/intake?item=INT-1014-022", "/cases/D26-04804", "/demo", "/signin"]) {
      const r = proxy(req(p));
      expect([r.status, r.headers.get("location")], p).toEqual([307, `${PUBLIC}/locked`]);
    }
    expect(proxy(req("/locked")).headers.get("x-middleware-request-x-hlos-bare")).toBe("1");
    Object.assign(process.env, SECURED_ENV);
    const noCookie = proxy(req("/worklist?view=histotech"));
    expect([noCookie.status, noCookie.headers.get("location")]).toEqual([307, `${PUBLIC}/signin?returnTo=%2Fworklist%3Fview%3Dhistotech`]);
    const withCookie = proxy(req("/worklist", "hlos_session=abc"));
    expect(withCookie.headers.get("location")).toBeNull();
    expect(withCookie.headers.get("x-middleware-request-x-hlos-path")).toBe("/worklist");
    expect(proxy(req("/signin")).headers.get("x-middleware-request-x-hlos-bare")).toBe("1");
    expect(proxy(req("/concepts/intake-a")).status).toBe(404);
    process.env.HLOS_MODE = "demo";
    expect(proxy(req("/concepts/intake-a")).headers.get("x-middleware-request-x-hlos-bare")).toBe("1");
    expect(proxy(req("/intake")).headers.get("x-middleware-request-x-hlos-bare")).toBeNull();
  });

  it("next.config sends nosniff, a referrer policy and frame-ancestors 'none' everywhere; HSTS only for an https public URL", async () => {
    const load = async () => {
      vi.resetModules();
      const mod = (await import("../../next.config")) as { default: { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> } };
      const rules = await mod.default.headers();
      expect(rules[0].source).toBe("/:path*");
      return Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
    };
    const plain = await load();
    expect(plain).toMatchObject({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": "frame-ancestors 'none'" });
    expect(plain["Strict-Transport-Security"]).toBeUndefined();
    process.env.HLOS_PUBLIC_URL = "https://lab.synthetic.test";
    expect((await load())["Strict-Transport-Security"]).toMatch(/^max-age=\d+/);
  });
});

// ------------------------------------------------------------------ demo mode unchanged

describe("demo mode is unchanged", () => {
  it("the guard returns the demo role from the cookie (default actor otherwise) and never needs a session", async () => {
    process.env.HLOS_MODE = "demo";
    page.cookies.set("hlos_actor", "stf_tanya");
    expect(await requireView("view.operations")).toMatchObject({ id: "stf_tanya", role: "supervisor" });
    page.cookies.set("hlos_actor", "stf_nobody");
    expect(await requireActor()).toMatchObject({ id: "stf_maya" });
    const g = requireApiActor(get("/api/live", undefined, "hlos_actor=stf_kim"), { touch: true });
    expect(g.ok && [g.mode, g.actor.id, g.auth]).toEqual(["demo", "stf_kim", null]);
    expect((await authSessionGET(get("/api/auth/session"))).status).toBe(200);
    expect((await loginGET(get("/api/auth/login"))).status).toBe(404);
    // Sensitive flags are ignored in the demo (there is no sign-in to refresh).
    const item = intakeItem();
    const placed = executeCommand<{ holdId: string; version: number }>(db(), "stf_kim", "hold.place", {
      scope: { type: "intake_item", id: item.id }, scopeLabel: "INT-1014-022 (synthetic)", blocks: ["accession_request"], reasonText: "Synthetic test hold",
    });
    expect(placed.ok).toBe(true);
    if (placed.ok) expect(executeCommand(db(), "stf_kim", "hold.release", { holdId: placed.result.holdId, expectedVersion: placed.result.version, reason: "Synthetic" }).ok).toBe(true);
    // revokeSession is harmless on an unknown hash
    expect(revokeSession(db(), "0".repeat(64), "test")).toBe(false);
  });
});
