// Stage 6 Phase B: the REAL OpenID Connect authorization code flow (PKCE, state,
// nonce) against oidc-provider (a certified OpenID provider implementation)
// running in-process on a random loopback port. The relying-party side is the
// application's own route handlers (/api/auth/login and /api/auth/callback);
// the browser is fetch with manual redirects and a small cookie jar; the person
// signs in through the provider's development login form. Synthetic data only:
// nothing leaves 127.0.0.1 / localhost and no credential is real.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { closeSharedDb, getDb, openDatabase } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { authConfig } from "@/server/auth/config";
import { linkIdentity } from "@/server/auth/admin";
import { buildAuthorizationRequest, endSessionUrl, getOidcConfiguration, OidcError, resetOidcCache } from "@/server/auth/oidc";
import { hashSessionId, resolveSession, sessionPolicyFromEnv } from "@/server/auth/sessions";
import { GET as loginGET } from "@/app/api/auth/login/route";
import { GET as callbackGET } from "@/app/api/auth/callback/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as lockPOST } from "@/app/api/auth/lock/route";
import { FLOW_DENIAL_WINDOW_MS, handleCallback, handleLogin } from "@/server/auth/flow";

const PUBLIC = "http://localhost:3999";
const CLIENT_ID = "hlos-synthetic-client";
const CLIENT_SECRET = crypto.randomBytes(32).toString("hex"); // generated per run, never a real credential
const LAB = "lab:local";

/** Test logins at the provider (the development login form's "login" is the subject) and their lab claim. */
const ACCOUNTS: Record<string, { labs: string[] }> = {
  "synthetic-kim": { labs: [LAB] },
  "synthetic-maya": { labs: ["lab:other", LAB] },
  "synthetic-stranger": { labs: [LAB] }, // never linked to a staff member
  "synthetic-otherlab": { labs: ["lab:other"] }, // linked, but the lab claim names another lab
};
const LINKS: Record<string, string> = { "synthetic-kim": "stf_kim", "synthetic-maya": "stf_maya", "synthetic-otherlab": "stf_luis" };

let server: http.Server;
let issuer = "";
let deadIssuer = "";
let dir = "";
let template = "";
let n = 0;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HLOS_MODE", "HLOS_OIDC_ISSUER", "HLOS_OIDC_ALLOW_INSECURE_LOOPBACK", "HLOS_OIDC_CLIENT_ID", "HLOS_OIDC_CLIENT_SECRET", "HLOS_PUBLIC_URL",
  "HLOS_LAB_ID", "HLOS_SESSION_SECRET", "HLOS_OIDC_LAB_CLAIM", "HLOS_DB_PATH", "HLOS_SEED_SYNTHETIC",
];

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // A port that refuses connections: a closed server's port on 127.0.0.1.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  deadIssuer = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise<void>((r) => probe.close(() => r()));

  let handler: http.RequestListener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  server = http.createServer((req, res) => {
    if (corruptIdTokenSignature && req.method === "POST" && req.url?.startsWith("/token")) corruptIdTokenInResponse(res);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // @ts-expect-error -- oidc-provider ships no type declarations (test-only development dependency)
  const { default: Provider } = await import("oidc-provider");
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: [`${PUBLIC}/api/auth/callback`],
        post_logout_redirect_uris: [`${PUBLIC}/signed-out`],
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
    ],
    // Maps a test login to its subject and claims; unknown logins have no account.
    findAccount: async (_ctx: unknown, sub: string) =>
      ACCOUNTS[sub] ? { accountId: sub, claims: async () => ({ sub, hlos_labs: ACCOUNTS[sub].labs }) } : undefined,
    claims: { openid: ["sub", "hlos_labs"] },
    conformIdTokenClaims: false, // the lab claim travels in the ID token
    cookies: { keys: [crypto.randomBytes(32).toString("hex")] },
    features: { devInteractions: { enabled: true } },
    pkce: { required: () => true },
    // First-party client: no consent screen (the grant covers openid and the lab claim).
    loadExistingGrant: async (ctx: { oidc: { provider: { Grant: new (a: object) => GrantLike }; client: { clientId: string }; session: { accountId: string } } }) => {
      const grant = new ctx.oidc.provider.Grant({ clientId: ctx.oidc.client.clientId, accountId: ctx.oidc.session.accountId });
      grant.addOIDCScope("openid");
      grant.addOIDCClaims(["sub", "hlos_labs"]);
      await grant.save();
      return grant;
    },
  });
  handler = provider.callback();

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-oidc-"));
  template = path.join(dir, "template.db");
  const t = openDatabase(template);
  seedDemo(t, { clockRunning: false });
  t.close();
}, 30_000);

/** Test-only tampering at the provider: the token response's ID token gets a broken signature. */
let corruptIdTokenSignature = false;

function corruptIdTokenInResponse(res: http.ServerResponse): void {
  const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return end(chunk, ...rest);
    const body = JSON.parse(chunk.toString()) as { id_token?: string };
    if (body.id_token) {
      const [header, payload, signature] = body.id_token.split(".");
      body.id_token = [header, payload, `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`].join(".");
    }
    const out = JSON.stringify(body);
    if (!res.headersSent) res.setHeader("content-length", Buffer.byteLength(out));
    return end(out, ...rest);
  }) as typeof res.end;
}

interface GrantLike {
  addOIDCScope(scope: string): void;
  addOIDCClaims(claims: string[]): void;
  save(): Promise<string>;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    HLOS_MODE: "secured",
    HLOS_OIDC_ISSUER: issuer,
    HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
    HLOS_OIDC_CLIENT_ID: CLIENT_ID,
    HLOS_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    HLOS_PUBLIC_URL: PUBLIC,
    HLOS_LAB_ID: LAB,
    HLOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    HLOS_OIDC_LAB_CLAIM: "hlos_labs",
  });
  resetOidcCache();
  closeSharedDb();
  const file = path.join(dir, `t${++n}.db`);
  fs.copyFileSync(template, file);
  process.env.HLOS_DB_PATH = file;
  for (const [subject, staffId] of Object.entries(LINKS)) {
    linkIdentity(getDb(), { operator: "test", correlationId: "oidc-test-link" }, { staffId, issuer, subject, labId: LAB });
  }
});

afterEach(() => {
  closeSharedDb();
  resetOidcCache();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ a tiny browser

class Jar {
  private store = new Map<string, Map<string, string>>();
  set(url: string, headers: Headers): void {
    const host = new URL(url).host;
    const jar = this.store.get(host) ?? new Map<string, string>();
    for (const line of headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || (/^\s*expires=/i.test(a) && Date.parse(a.split("=")[1]) < Date.now()));
      if (!value || expired) jar.delete(name);
      else jar.set(name, value);
    }
    this.store.set(host, jar);
  }
  header(url: string): string {
    const jar = this.store.get(new URL(url).host);
    return jar ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : "";
  }
  get(url: string, name: string): string | undefined {
    return this.store.get(new URL(url).host)?.get(name);
  }
}

/** One browser hop to the provider. */
async function hop(jar: Jar, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header(url);
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.set(url, res.headers);
  return res;
}

/** One browser hop to this application (its route handlers, called directly). */
async function app(jar: Jar, handler: (req: Request) => Promise<Response>, url: string): Promise<Response> {
  const cookie = jar.header(url);
  const res = await handler(new Request(url, { headers: cookie ? { cookie } : {} }));
  jar.set(url, res.headers);
  return res;
}

const loc = (res: Response, base: string) => new URL(res.headers.get("location")!, base).toString();

interface FlowResult {
  /** The authorization URL the application sent the browser to. */
  authUrl: URL;
  /** The callback URL the provider sent the browser back to. */
  callbackUrl: string;
  /** The application's final answer to the callback. */
  final: Response;
  jar: Jar;
  /** The browser-binding cookie as it was before the callback consumed it. */
  txCookie: string | undefined;
  /** The provider showed its login form (the person had to authenticate), rather than signing in on its own session. */
  loginForm: boolean;
}

/**
 * Drives the whole flow: /api/auth/login -> provider -> dev login form ->
 * provider -> /api/auth/callback. `tamper` may rewrite the authorization URL
 * before the browser follows it; `abort` cancels at the provider.
 */
async function signInFlow(
  login: string,
  opts: { jar?: Jar; returnTo?: string; reauth?: boolean; tamper?: (u: URL) => void; abort?: boolean; stopAtCallback?: boolean; appNow?: number } = {},
): Promise<FlowResult> {
  const jar = opts.jar ?? new Jar();
  // appNow: the application's clock for this sign-in (the provider keeps the real one).
  const loginRoute = opts.appNow === undefined ? loginGET : (req: Request) => handleLogin(req, { now: opts.appNow });
  const callbackRoute = opts.appNow === undefined ? callbackGET : (req: Request) => handleCallback(req, { now: opts.appNow });
  let loginForm = false;
  const start = await app(jar, loginRoute, `${PUBLIC}/api/auth/login?returnTo=${encodeURIComponent(opts.returnTo ?? "/intake")}${opts.reauth ? "&reauth=1" : ""}`);
  expect(start.status).toBe(303);
  const authUrl = new URL(start.headers.get("location")!);
  expect(authUrl.origin).toBe(issuer);
  opts.tamper?.(authUrl);

  let res = await hop(jar, authUrl.toString());
  let url = authUrl.toString();
  for (let i = 0; i < 10; i++) {
    if (res.status === 200) {
      // The provider's self-submitting form (for example ending its own session for the previous account when
      // another person signs in): a browser runs its script and posts the hidden fields.
      const html = await res.text();
      const action = html.match(/<form method="post" action="([^"]+)">/)?.[1];
      expect(action, `provider hop ${i}: ${url} answered 200 without a self-submitting form`).toBeTruthy();
      const fields = new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]));
      url = new URL(action!.replace(/&amp;/g, "&"), url).toString();
      res = await hop(jar, url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: fields.toString() });
      continue;
    }
    expect([302, 303], `provider hop ${i}: ${url}`).toContain(res.status);
    const next = loc(res, url);
    if (next.startsWith(`${PUBLIC}/`)) {
      const txCookie = jar.get(PUBLIC, "hlos_auth_tx");
      if (opts.stopAtCallback) return { authUrl, callbackUrl: next, final: new Response(null, { status: 599 }), jar, txCookie, loginForm };
      const final = await app(jar, callbackRoute, next);
      return { authUrl, callbackUrl: next, final, jar, txCookie, loginForm };
    }
    url = next;
    if (/\/interaction\/[^/]+$/.test(new URL(url).pathname)) {
      const form = await hop(jar, url);
      expect(form.status).toBe(200);
      const html = await form.text();
      expect(html).toContain('name="login"');
      loginForm = true;
      if (opts.abort) {
        res = await hop(jar, `${url}/abort`);
      } else {
        // The provider's development login form; the password is a fixed test value it does not check.
        res = await hop(jar, url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ prompt: "login", login, password: "synthetic-test-only" }).toString(),
        });
      }
    } else {
      res = await hop(jar, url);
    }
  }
  throw new Error("the flow did not come back to the application");
}

const db = () => getDb();
const sessions = () => db().prepare("SELECT staff_id, issuer, subject, auth_time, locked_at, revoked_at FROM auth_session ORDER BY created_at").all() as {
  staff_id: string; issuer: string; subject: string; auth_time: string; locked_at: string | null; revoked_at: string | null;
}[];
const denials = () => (db().prepare("SELECT reason, after_json FROM audit_event WHERE action = 'auth.denied' ORDER BY seq").all() as { reason: string; after_json: string }[]);

// ------------------------------------------------------------------ the flow

describe("OIDC authorization code flow with PKCE against a local oidc-provider", () => {
  it("a linked subject gets a session: PKCE S256, state, nonce and max_age are sent; the cookie is HttpOnly and SameSite=Lax", async () => {
    const r = await signInFlow("synthetic-kim", { returnTo: "/intake?item=INT-1014-022" });
    const p = r.authUrl.searchParams;
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(`${PUBLIC}/api/auth/callback`);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toBeTruthy();
    expect(p.get("nonce")).toBeTruthy();
    // Every sign-in forces a fresh authentication at the provider (a shared workstation never rides on SSO).
    expect(p.get("max_age")).toBe("0");
    expect(p.get("prompt")).toBe("login");
    expect(r.loginForm).toBe(true);
    // The PKCE verifier stays on the server: only its S256 challenge was sent.
    const verifier = (db().prepare("SELECT code_verifier FROM auth_transaction").get() as { code_verifier: string }).code_verifier;
    expect(r.authUrl.toString()).not.toContain(verifier);
    expect(p.get("code_challenge")).toBe(crypto.createHash("sha256").update(verifier).digest("base64url"));

    expect(r.final.status).toBe(303);
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/intake?item=INT-1014-022`);
    const setCookies = r.final.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith("hlos_session="))!;
    expect(session).toMatch(/; Path=\/; SameSite=Lax; HttpOnly$/);
    expect(setCookies.some((c) => /^hlos_auth_tx=; .*Max-Age=0/.test(c))).toBe(true);

    const value = r.jar.get(PUBLIC, "hlos_session")!;
    const resolved = resolveSession(db(), value, { touch: false, policy: sessionPolicyFromEnv()! });
    expect(resolved.ok && resolved.staff).toEqual({ id: "stf_kim", name: "Kim Nguyen", role: "accessioning_lead" });
    expect(sessions()).toEqual([expect.objectContaining({ staff_id: "stf_kim", issuer, subject: "synthetic-kim", revoked_at: null })]);
    expect(Math.abs(Date.parse(sessions()[0].auth_time) - Date.now())).toBeLessThan(60_000);
    expect(db().prepare("SELECT COUNT(*) n FROM audit_event WHERE action = 'auth.signed_in' AND actor_id = 'stf_kim'").get()).toEqual({ n: 1 });
    // The transaction is consumed, and nothing token-like was kept or audited.
    expect(db().prepare("SELECT consumed_at FROM auth_transaction").all()).toEqual([{ consumed_at: expect.any(String) }]);
    const auditText = JSON.stringify(db().prepare("SELECT * FROM audit_event WHERE action LIKE 'auth.%'").all());
    const code = new URL(r.callbackUrl).searchParams.get("code")!;
    for (const secret of [code, value, p.get("state")!, p.get("nonce")!, "synthetic-kim"]) expect(auditText).not.toContain(secret);
  });

  it("an unlinked subject is denied: no session, audited, a plain no-access page", async () => {
    const r = await signInFlow("synthetic-stranger");
    expect(r.final.status).toBe(303);
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/no-access?reason=unlinked`);
    expect(r.jar.get(PUBLIC, "hlos_session")).toBeUndefined();
    expect(sessions()).toEqual([]);
    expect(denials().map((d) => d.reason)).toEqual(["unlinked"]);
    expect(denials()[0].after_json).not.toContain("synthetic-stranger");
  });

  it("a wrong lab claim is denied, even for a linked subject", async () => {
    const r = await signInFlow("synthetic-otherlab");
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/no-access?reason=wrong_lab`);
    expect(sessions()).toEqual([]);
    expect(denials().map((d) => d.reason)).toEqual(["wrong_lab"]);
    // A claim listing several labs including this one is accepted.
    const ok = await signInFlow("synthetic-maya");
    expect(ok.final.headers.get("location")).toBe(`${PUBLIC}/intake`);
    expect(sessions().map((s) => s.staff_id)).toEqual(["stf_maya"]);
  });

  it("a replayed state (callback URL used twice) is refused; one session only", async () => {
    const r = await signInFlow("synthetic-kim");
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/intake`);
    // Replay with the original binding cookie, so only the one-time transaction can refuse it.
    const replay = await callbackGET(new Request(r.callbackUrl, { headers: { cookie: `hlos_auth_tx=${r.txCookie}` } }));
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe(`${PUBLIC}/signin?error=bad_state&returnTo=%2F`);
    expect(replay.headers.getSetCookie().some((c) => c.startsWith("hlos_session=") && !c.startsWith("hlos_session=;"))).toBe(false);
    expect(sessions()).toHaveLength(1);
    expect(denials().map((d) => [d.reason, JSON.parse(d.after_json).detail])).toEqual([["bad_state", "consumed"]]);
    // A callback from a browser that did not start the sign-in (login CSRF) is refused before the transaction
    // is touched; the browser that did start it can still finish.
    const r2 = await signInFlow("synthetic-maya", { stopAtCallback: true });
    const foreign = await callbackGET(new Request(r2.callbackUrl, { headers: { cookie: "hlos_auth_tx=forged-binding-value" } }));
    expect(foreign.headers.get("location")).toBe(`${PUBLIC}/signin?error=bad_state&returnTo=%2F`);
    const legit = await app(r2.jar, callbackGET, r2.callbackUrl);
    expect(legit.headers.get("location")).toBe(`${PUBLIC}/intake`);
    expect(sessions().map((x) => x.staff_id)).toEqual(["stf_kim", "stf_maya"]);
    expect(denials().map((d) => JSON.parse(d.after_json).detail)).toEqual(["consumed", "browser_binding"]);
  });

  it("a nonce mismatch is refused (the ID token does not belong to this transaction)", async () => {
    const r = await signInFlow("synthetic-kim", { tamper: (u) => u.searchParams.set("nonce", crypto.randomBytes(16).toString("base64url")) });
    expect(r.final.status).toBe(303);
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/signin?error=token_invalid&returnTo=%2Fintake`);
    expect(r.jar.get(PUBLIC, "hlos_session")).toBeUndefined();
    expect(sessions()).toEqual([]);
    expect(denials().map((d) => [d.reason, JSON.parse(d.after_json).detail])).toEqual([["token_invalid", "ID_TOKEN_INVALID"]]);
  });

  it("a PKCE verifier that does not match is refused by the provider", async () => {
    const r = await signInFlow("synthetic-kim", {
      tamper: (u) => u.searchParams.set("code_challenge", crypto.createHash("sha256").update("another verifier").digest("base64url")),
    });
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/signin?error=token_invalid&returnTo=%2Fintake`);
    expect(sessions()).toEqual([]);
    expect(denials().map((d) => JSON.parse(d.after_json).detail)).toEqual(["TOKEN_REJECTED"]);
  });

  it("the person cancelling at the provider is a provider error: no session", async () => {
    const r = await signInFlow("synthetic-kim", { abort: true });
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/signin?error=provider_error&returnTo=%2Fintake`);
    expect(sessions()).toEqual([]);
    expect(denials().map((d) => [d.reason, JSON.parse(d.after_json).detail])).toEqual([["provider_error", "access_denied"]]);
  });

  it("re-authentication forces a fresh login (prompt=login, max_age=0) and continues the session under a new id with a new auth_time", async () => {
    const first = await signInFlow("synthetic-kim");
    const cookie = first.jar.get(PUBLIC, "hlos_session")!;
    db().prepare("UPDATE auth_session SET auth_time = ?, locked_at = ? WHERE id_hash = ?").run(
      new Date(Date.now() - 30 * 60_000).toISOString(), new Date().toISOString(), hashSessionId(cookie),
    );
    // An existing session in this browser makes any sign-in a re-authentication.
    const again = await signInFlow("synthetic-kim", { jar: first.jar });
    expect(again.authUrl.searchParams.get("prompt")).toBe("login");
    expect(again.authUrl.searchParams.get("max_age")).toBe("0");
    expect(again.final.headers.get("location")).toBe(`${PUBLIC}/intake`);
    // Session id rotation: the callback sets a NEW cookie; the old id is revoked ("rotated"), the session goes on.
    const renewed = again.jar.get(PUBLIC, "hlos_session")!;
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(cookie);
    const row = (c: string) => db().prepare("SELECT staff_id, created_at, expires_at, auth_time, locked_at, revoked_reason FROM auth_session WHERE id_hash = ?").get(hashSessionId(c)) as {
      staff_id: string; created_at: string; expires_at: string; auth_time: string; locked_at: string | null; revoked_reason: string | null;
    };
    expect(sessions()).toHaveLength(2);
    expect(row(cookie).revoked_reason).toBe("rotated");
    const s = row(renewed);
    expect(s).toMatchObject({ staff_id: "stf_kim", locked_at: null, revoked_reason: null, created_at: row(cookie).created_at, expires_at: row(cookie).expires_at });
    expect(Date.now() - Date.parse(s.auth_time)).toBeLessThan(60_000);
    // A different person on the same browser: hand-over, the previous session is revoked.
    const other = await signInFlow("synthetic-maya", { jar: again.jar });
    const maya = other.jar.get(PUBLIC, "hlos_session")!;
    expect([cookie, renewed]).not.toContain(maya);
    expect(row(renewed).revoked_reason).toBe("handover");
    expect(row(maya)).toMatchObject({ staff_id: "stf_maya", revoked_reason: null });
  });

  it("sign-out revokes the session and returns the provider's end-session URL", async () => {
    const r = await signInFlow("synthetic-kim");
    const cookie = r.jar.get(PUBLIC, "hlos_session")!;
    const out = await logoutPOST(new Request(`${PUBLIC}/api/auth/logout`, { method: "POST", headers: { origin: PUBLIC, cookie: `hlos_session=${cookie}` } }));
    expect(out.status).toBe(200);
    const body = (await out.json()) as { result: { signedOut: boolean; endSessionUrl: string } };
    expect(body.result.signedOut).toBe(true);
    const end = new URL(body.result.endSessionUrl);
    expect(end.origin).toBe(issuer);
    expect(end.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(end.searchParams.get("post_logout_redirect_uri")).toBe(`${PUBLIC}/signed-out`);
    expect(sessions()[0].revoked_at).not.toBeNull();
  });
});

describe("review fixes: no sign-in on a provider session, signature verified, no anonymous audit growth", () => {
  const sameOriginPost = (url: string, jar: Jar) =>
    new Request(`${PUBLIC}${url}`, { method: "POST", headers: { origin: PUBLIC, cookie: jar.header(PUBLIC), "content-type": "application/json" }, body: "{}" });

  it("lock, then sign-out with the provider's logout declined: the provider's session signs nobody in, the login form is shown again", async () => {
    const first = await signInFlow("synthetic-kim");
    expect(first.loginForm).toBe(true);
    expect(first.final.headers.get("location")).toBe(`${PUBLIC}/intake`);
    expect((await lockPOST(sameOriginPost("/api/auth/lock", first.jar))).status).toBe(200);
    const out = await logoutPOST(sameOriginPost("/api/auth/logout", first.jar));
    first.jar.set(PUBLIC, out.headers);
    expect(first.jar.get(PUBLIC, "hlos_session")).toBeUndefined();
    // The provider's end-session URL is offered, but the person at the keyboard declines it: the provider still
    // holds Kim's single-sign-on session in this browser.
    const body = (await out.json()) as { result: { signedOut: boolean; endSessionUrl: string | null } };
    expect(body.result.signedOut).toBe(true);
    expect(new URL(body.result.endSessionUrl!).origin).toBe(issuer);

    // Control: a provider that ignored prompt=login (the request rewritten without it) does reuse that session
    // (no login form), and five minutes later on the application's clock the callback still refuses it.
    const sso = await signInFlow("synthetic-kim", {
      jar: first.jar,
      appNow: Date.now() + 5 * 60_000,
      tamper: (u) => {
        u.searchParams.delete("prompt");
        u.searchParams.set("max_age", String(12 * 3600));
      },
    });
    expect(sso.loginForm).toBe(false);
    expect(sso.final.headers.get("location")).toBe(`${PUBLIC}/signin?error=reauth_not_fresh&returnTo=%2Fintake`);
    expect(sso.jar.get(PUBLIC, "hlos_session")).toBeUndefined();

    // "Sign in again" as the application sends it: prompt=login&max_age=0, so the provider asks who it is.
    const again = await signInFlow("synthetic-kim", { jar: first.jar });
    expect(again.authUrl.searchParams.get("prompt")).toBe("login");
    expect(again.authUrl.searchParams.get("max_age")).toBe("0");
    expect(again.loginForm).toBe(true);
    expect(again.final.headers.get("location")).toBe(`${PUBLIC}/intake`);
    expect(sessions().map((x) => [x.staff_id, x.revoked_at === null])).toEqual([
      ["stf_kim", false],
      ["stf_kim", true],
    ]);
    expect(Date.now() - Date.parse(sessions()[1].auth_time)).toBeLessThan(60_000);
    expect(denials().map((d) => d.reason)).toEqual(["reauth_not_fresh"]);
  });

  it("the ID token's signature is verified against the provider's keys: a token with a broken signature is refused", async () => {
    corruptIdTokenSignature = true;
    let r: FlowResult;
    try {
      r = await signInFlow("synthetic-kim");
    } finally {
      corruptIdTokenSignature = false;
    }
    expect(r.loginForm).toBe(true);
    expect(r.final.headers.get("location")).toBe(`${PUBLIC}/signin?error=token_invalid&returnTo=%2Fintake`);
    expect(r.jar.get(PUBLIC, "hlos_session")).toBeUndefined();
    expect(sessions()).toEqual([]);
    expect(denials().map((d) => [d.reason, JSON.parse(d.after_json).detail])).toEqual([["token_invalid", "ID_TOKEN_INVALID"]]);
    // The same flow with the token untouched signs in.
    expect((await signInFlow("synthetic-kim")).final.headers.get("location")).toBe(`${PUBLIC}/intake`);
  });

  it("anonymous requests do not grow the audit trail: no audit without a sign-in in progress, repeated flow denials aggregated per minute", async () => {
    const auditRows = () => (db().prepare("SELECT COUNT(*) n FROM audit_event").get() as { n: number }).n;
    const before = auditRows();
    // 50 callbacks with no sign-in started in this browser (no binding cookie): plain page, nothing audited.
    for (let i = 0; i < 50; i++) {
      const res = await callbackGET(new Request(`${PUBLIC}/api/auth/callback?state=x${i}&code=y${i}`));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${PUBLIC}/signin?error=bad_state&returnTo=%2F`);
      expect(res.headers.getSetCookie().some((c) => c.startsWith("hlos_session=") && !c.startsWith("hlos_session=;"))).toBe(false);
    }
    expect(auditRows()).toBe(before);

    // 50 callbacks carrying a forged binding cookie within one minute: one auth.denied; the next window's event counts the rest.
    const t0 = Date.now();
    const forged = (i: number, now: number) =>
      handleCallback(new Request(`${PUBLIC}/api/auth/callback?state=x${i}&code=y`, { headers: { cookie: "hlos_auth_tx=forged-binding-value" } }), { now });
    for (let i = 0; i < 50; i++) expect((await forged(i, t0 + i * 1000)).headers.get("location")).toBe(`${PUBLIC}/signin?error=bad_state&returnTo=%2F`);
    expect(denials().map((d) => JSON.parse(d.after_json))).toEqual([{ reason: "bad_state", detail: "browser_binding" }]);
    await forged(99, t0 + FLOW_DENIAL_WINDOW_MS + 1);
    expect(denials().map((d) => JSON.parse(d.after_json))).toEqual([
      { reason: "bad_state", detail: "browser_binding" },
      { reason: "bad_state", detail: "browser_binding", suppressed: 49 },
    ]);
    expect(auditRows()).toBe(before + 2);

    // The provider unreachable at login, 20 times within a minute: one audit event.
    process.env.HLOS_OIDC_ISSUER = deadIssuer;
    resetOidcCache();
    for (let i = 0; i < 20; i++) {
      const res = await handleLogin(new Request(`${PUBLIC}/api/auth/login?returnTo=%2Fworklist`), { now: t0 + i * 1000 });
      expect(res.headers.get("location")).toBe(`${PUBLIC}/signin?error=provider_unavailable&returnTo=%2Fworklist`);
    }
    expect(denials().filter((d) => d.reason === "provider_unavailable")).toHaveLength(1);
    expect(auditRows()).toBe(before + 3);
  });
});

describe("provider unavailable", () => {
  it("fails closed with PROVIDER_UNAVAILABLE: the module throws the typed error and sign-in lands on a plain page, audited", async () => {
    process.env.HLOS_OIDC_ISSUER = deadIssuer;
    const c = authConfig();
    if (!c.ok) throw new Error("config");
    await expect(getOidcConfiguration(c.config)).rejects.toMatchObject({ name: "OidcError", code: "PROVIDER_UNAVAILABLE" });
    const err = await buildAuthorizationRequest(c.config, { reauth: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OidcError);
    expect((err as OidcError).code).toBe("PROVIDER_UNAVAILABLE");
    expect(await endSessionUrl(c.config)).toBeNull();

    const res = await loginGET(new Request(`${PUBLIC}/api/auth/login?returnTo=%2Fworklist`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PUBLIC}/signin?error=provider_unavailable&returnTo=%2Fworklist`);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) n FROM auth_transaction").get()).toEqual({ n: 0 });
    expect(denials().map((d) => [d.reason, JSON.parse(d.after_json).detail])).toEqual([["provider_unavailable", "PROVIDER_UNAVAILABLE"]]);
    expect(sessions()).toEqual([]);
  });

  it("the provider going away between login and callback also fails closed", async () => {
    // Start against the live provider (discovery cached), then point the callback's token request at a dead one.
    const jar = new Jar();
    const start = await app(jar, loginGET, `${PUBLIC}/api/auth/login?returnTo=%2Fintake`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    process.env.HLOS_OIDC_ISSUER = deadIssuer;
    resetOidcCache();
    const res = await app(jar, callbackGET, `${PUBLIC}/api/auth/callback?code=synthetic-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(issuer)}`);
    expect(res.headers.get("location")).toBe(`${PUBLIC}/signin?error=provider_unavailable&returnTo=%2Fintake`);
    expect(sessions()).toEqual([]);
  });
});
