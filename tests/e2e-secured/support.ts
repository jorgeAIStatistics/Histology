// Shared helpers for the SECURED browser suite (tests/e2e-secured, playwright.secured.config.ts). Not a spec file.
// Everything signs in the way a person would: the app's sign-in page, then the local oidc-provider's development
// login form with a synthetic test login (its password field takes any value; nothing here is a credential).
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/** Synthetic test logins at the local provider (tests/support/oidc-provider.mjs) and who they are linked to. */
export const LOGIN = {
  kim: "kim", // stf_kim, Kim Nguyen, accessioning lead
  maya: "maya", // stf_maya, Maya Torres, accessioner
  admin: "admin", // stf_test_admin, laboratory administrator (no bench view)
  auditor: "auditor", // stf_test_auditor, auditor (no bench view)
  stranger: "stranger", // not linked to anyone
  otherlab: "otherlab", // linked to stf_luis, but the lab claim names another laboratory
} as const;

export const ISSUER = process.env.E2E_SECURED_ISSUER ?? "";
export const DOWN_URL = process.env.E2E_SECURED_DOWN_URL ?? "";

/**
 * Patient and record details of the seeded identity case (INT-1014-022, CLR-0453) as the bench shows them.
 * None may be anywhere in the DOM of a page that must show no data.
 */
export const DATA_MARKERS = ["Kettering", "1974-07-2", "503277"] as const;

/** Seeded at the 10:52 starting state: an intake item with a patient identity question (CLR-0453, hold H-0088). */
export const ITEM = "INT-1014-022";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Requests a page tried to send off this machine (aborted before they left); every test ends by checking it is empty. */
const blocked: string[] = [];

/** Nothing a page asks for may leave this machine: any http(s) request to another host is aborted before it is sent. */
export async function loopbackOnly(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => (url.protocol === "http:" || url.protocol === "https:") && !LOOPBACK.has(url.hostname),
    (route) => {
      blocked.push(new URL(route.request().url()).origin);
      return route.abort("blockedbyclient");
    },
  );
}

/** `test` with the loopback guard on the test's own browser context; a test fails if any page even tried another host. */
export const test = base.extend<{ loopback: void }>({
  loopback: [
    async ({ context }, use) => {
      blocked.length = 0;
      await loopbackOnly(context);
      await use();
      expect(blocked, "requests to a host other than this machine (aborted)").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Another browser (its own cookies: another workstation), with the same loopback guard. Close it when done. */
export async function newWorkstation(browser: Browser): Promise<BrowserContext> {
  const use = test.info().project.use;
  const context = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport ?? { width: 1366, height: 768 } });
  await loopbackOnly(context);
  return context;
}

export function re(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** At the provider's development login form: the synthetic login, a fixed test password (not checked), submit. */
export async function providerLogin(page: Page, login: string): Promise<void> {
  await page.waitForURL((u) => u.origin === ISSUER && u.pathname.startsWith("/interaction/"));
  await page.locator('input[name="login"]').fill(login);
  await page.locator('input[name="password"]').fill("synthetic-test-only");
  await page.getByRole("button", { name: "Sign-in" }).click();
}

/**
 * Opens `path` with no session: the app sends the browser to its sign-in page, then to the provider; signs in as
 * `login` and waits until the browser is back on this application.
 */
export async function signIn(page: Page, login: string, path = `/intake?item=${ITEM}`): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/signin\?/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in with your organization account" }).click();
  await providerLogin(page, login);
  const app = new URL(test.info().project.use.baseURL!).origin;
  await page.waitForURL((u) => u.origin === app && !u.pathname.startsWith("/api/"));
}

/** The top bar's session group (secured mode). */
export function sessionGroup(page: Page) {
  return page.getByRole("banner").getByRole("group", { name: "Session" });
}

/** The whole serialized DOM (scripts included) holds none of the seeded record's details. */
export async function expectNoLabData(page: Page, extra: string[] = []): Promise<void> {
  const html = await page.content();
  for (const marker of [...DATA_MARKERS, ...extra]) expect(html, `"${marker}" must not be in the DOM`).not.toContain(marker);
}

// ------------------------------------------------------------------ the suite's database (read, and aging a session)

let handle: Database.Database | null = null;

/** The secured suite's database (data/e2e-<tag>.db), opened next to the running server (SQLite WAL). */
export function db(): Database.Database {
  if (handle?.open) return handle;
  const file = process.env.E2E_SECURED_DB;
  if (!file || !/(^|\/)data\/e2e-[A-Za-z0-9_-]+\.db$/.test(file)) throw new Error("E2E_SECURED_DB is not the secured suite's database");
  handle = new Database(path.resolve(file));
  handle.pragma("busy_timeout = 5000");
  return handle;
}

/** The browser's session cookie value (HttpOnly; read through the context, as an attacker on the page could not). */
export async function sessionCookie(context: BrowserContext): Promise<string> {
  const c = (await context.cookies()).find((x) => x.name === "hlos_session");
  expect(c, "a session cookie is set").toBeTruthy();
  return c!.value;
}

/** The auth_session row of this browser's session (only its SHA-256 is stored). */
export async function sessionRow(context: BrowserContext): Promise<{ id_hash: string; staff_id: string; auth_time: string; locked_at: string | null; revoked_at: string | null; revoked_reason: string | null }> {
  const hash = crypto.createHash("sha256").update(await sessionCookie(context)).digest("hex");
  const row = db().prepare("SELECT id_hash, staff_id, auth_time, locked_at, revoked_at, revoked_reason FROM auth_session WHERE id_hash = ?").get(hash) as
    | { id_hash: string; staff_id: string; auth_time: string; locked_at: string | null; revoked_at: string | null; revoked_reason: string | null }
    | undefined;
  expect(row, "the session is in the database").toBeTruthy();
  return row!;
}

/** Time travel for the server: the last sign-in at the provider happened `minutes` ago (re-authentication window). */
export async function ageLastSignIn(context: BrowserContext, minutes: number): Promise<void> {
  const row = await sessionRow(context);
  db().prepare("UPDATE auth_session SET auth_time = ? WHERE id_hash = ?").run(new Date(Date.now() - minutes * 60_000).toISOString(), row.id_hash);
}

/** Time travel for the server: the session reached its absolute expiry a minute ago. */
export async function expireSession(context: BrowserContext): Promise<void> {
  const row = await sessionRow(context);
  db().prepare("UPDATE auth_session SET expires_at = ? WHERE id_hash = ?").run(new Date(Date.now() - 60_000).toISOString(), row.id_hash);
}

/** Highest audit sequence number now (to check that nothing was recorded after it). */
export function auditHead(): number {
  return (db().prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM audit_event").get() as { n: number }).n;
}

/** Audit events after `seq` (action and actor), excluding sign-in bookkeeping (auth.*). */
export function labEventsSince(seq: number): { action: string; actor_id: string | null }[] {
  return db().prepare("SELECT action, actor_id FROM audit_event WHERE seq > ? AND action NOT LIKE 'auth.%' ORDER BY seq").all(seq) as { action: string; actor_id: string | null }[];
}

/** POST a command from inside the page (same origin, the page's cookies) with an explicit X-HLOS-Actor. */
export async function postCommand(page: Page, name: string, input: unknown, actor: string | null): Promise<{ status: number; body: { ok: boolean; error?: { code: string; message: string } } }> {
  return page.evaluate(
    async ({ name, input, actor }) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (actor) headers["X-HLOS-Actor"] = actor;
      const res = await fetch(`/api/commands/${name}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input, idempotencyKey: `e2e-secured-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}` }),
      });
      return { status: res.status, body: await res.json() };
    },
    { name, input, actor },
  );
}
