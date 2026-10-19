/**
 * OIDC / session configuration for the "secured" runtime mode.
 *
 * Pure environment parsing: no database, no network, no Next.js imports, so it
 * is safe to call from src/proxy.ts, next.config.ts-adjacent code, route
 * handlers and tests. Read on every call (never cached) so tests can switch
 * the environment per case.
 *
 * `authConfig()` returns either a validated configuration or the NAMES of the
 * environment keys that are missing or invalid. It never returns, logs or
 * echoes a secret value.
 *
 * Environment (all required unless marked optional):
 * - HLOS_OIDC_ISSUER            issuer URL; https, or http on a loopback host
 *                               only when HLOS_OIDC_ALLOW_INSECURE_LOOPBACK=1
 * - HLOS_OIDC_CLIENT_ID         client id registered at the provider
 * - HLOS_OIDC_CLIENT_SECRET     client secret (client_secret_basic)
 * - HLOS_PUBLIC_URL             public origin of this app, e.g. https://lab.example.org
 *                               (https, or http on a loopback host); the redirect URI
 *                               is <HLOS_PUBLIC_URL>/api/auth/callback
 * - HLOS_LAB_ID                 the one laboratory this deployment serves (e.g. lab:local)
 * - HLOS_SESSION_SECRET         at least 32 bytes; keys the HMACs that bind a sign-in
 *                               transaction to the browser that started it
 * - HLOS_OIDC_LAB_CLAIM         optional: ID token claim that must contain HLOS_LAB_ID
 * - HLOS_SESSION_IDLE_MIN       optional, default 15 (1..240): idle lock
 * - HLOS_SESSION_MAX_HOURS      optional, default 12 (1..24): absolute session lifetime
 * - HLOS_REAUTH_MAX_AGE_MIN     optional, default 5 (1..60): freshness for sensitive commands
 * - HLOS_OIDC_ALLOW_INSECURE_LOOPBACK  optional, "1" allows an http issuer on 127.0.0.1/localhost/::1
 *                               (local tests with oidc-provider only)
 */

export interface AuthConfig {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  /** Public origin, no trailing slash, e.g. "https://lab.example.org". */
  publicOrigin: string;
  /** <publicOrigin>/api/auth/callback */
  redirectUri: string;
  /** <publicOrigin>/signed-out (post-logout redirect at the provider). */
  postLogoutRedirectUri: string;
  labId: string;
  sessionSecret: string;
  labClaim: string | null;
  idleMinutes: number;
  maxHours: number;
  reauthMaxAgeMinutes: number;
  /** http issuer on a loopback host is allowed (HLOS_OIDC_ALLOW_INSECURE_LOOPBACK=1). */
  allowInsecureLoopback: boolean;
  /** True when HLOS_PUBLIC_URL is https: cookies get Secure and the __Host- prefix. */
  secureCookies: boolean;
}

export type AuthConfigResult = { ok: true; config: AuthConfig } | { ok: false; keys: string[] };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

const LAB_ID = /^[A-Za-z0-9:._-]{1,100}$/;
const CLAIM_NAME = /^[A-Za-z0-9:._/-]{1,200}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,500}$/; // visible ASCII, no spaces

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function intIn(name: string, fallback: number, min: number, max: number, bad: string[]): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  if (!/^\d{1,6}$/.test(raw)) {
    bad.push(name);
    return fallback;
  }
  const n = Number(raw);
  if (n < min || n > max) {
    bad.push(name);
    return fallback;
  }
  return n;
}

/**
 * Validates the OIDC and session environment. `{ ok: false, keys }` names
 * every missing or invalid key (sorted, never a value).
 */
export function authConfig(): AuthConfigResult {
  const bad: string[] = [];
  const allowInsecureLoopback = env("HLOS_OIDC_ALLOW_INSECURE_LOOPBACK") === "1";

  let issuer: URL | null = null;
  const rawIssuer = env("HLOS_OIDC_ISSUER");
  try {
    if (!rawIssuer) throw new Error("missing");
    const u = new URL(rawIssuer);
    const okProtocol = u.protocol === "https:" || (u.protocol === "http:" && allowInsecureLoopback && isLoopbackHost(u.hostname));
    if (!okProtocol || u.username || u.password || u.search || u.hash) throw new Error("invalid");
    issuer = u;
  } catch {
    bad.push("HLOS_OIDC_ISSUER");
  }

  const clientId = env("HLOS_OIDC_CLIENT_ID");
  if (!clientId || !CLIENT_ID.test(clientId)) bad.push("HLOS_OIDC_CLIENT_ID");
  const clientSecret = process.env.HLOS_OIDC_CLIENT_SECRET ?? "";
  if (!clientSecret.trim()) bad.push("HLOS_OIDC_CLIENT_SECRET");

  let publicOrigin = "";
  let secureCookies = false;
  try {
    const raw = env("HLOS_PUBLIC_URL");
    if (!raw) throw new Error("missing");
    const u = new URL(raw);
    const https = u.protocol === "https:";
    // Plain http only on a loopback host: a session cookie must never cross a network unencrypted.
    if (!(https || (u.protocol === "http:" && isLoopbackHost(u.hostname)))) throw new Error("invalid");
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error("invalid");
    publicOrigin = u.origin;
    secureCookies = https;
  } catch {
    bad.push("HLOS_PUBLIC_URL");
  }

  const labId = env("HLOS_LAB_ID");
  if (!labId || !LAB_ID.test(labId)) bad.push("HLOS_LAB_ID");

  const sessionSecret = process.env.HLOS_SESSION_SECRET ?? "";
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) bad.push("HLOS_SESSION_SECRET");

  const labClaim = env("HLOS_OIDC_LAB_CLAIM") ?? null;
  if (labClaim !== null && !CLAIM_NAME.test(labClaim)) bad.push("HLOS_OIDC_LAB_CLAIM");

  const idleMinutes = intIn("HLOS_SESSION_IDLE_MIN", 15, 1, 240, bad);
  const maxHours = intIn("HLOS_SESSION_MAX_HOURS", 12, 1, 24, bad);
  const reauthMaxAgeMinutes = intIn("HLOS_REAUTH_MAX_AGE_MIN", 5, 1, 60, bad);

  if (bad.length || !issuer || !clientId || !labId) return { ok: false, keys: [...new Set(bad)].sort() };
  return {
    ok: true,
    config: {
      issuer,
      clientId,
      clientSecret,
      publicOrigin,
      redirectUri: `${publicOrigin}/api/auth/callback`,
      postLogoutRedirectUri: `${publicOrigin}/signed-out`,
      labId,
      sessionSecret,
      labClaim,
      idleMinutes,
      maxHours,
      reauthMaxAgeMinutes,
      allowInsecureLoopback,
      secureCookies,
    },
  };
}

/** Cookie names. With https the __Host- prefix pins the cookie to this exact origin (Secure, Path=/, no Domain). */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-hlos_session" : "hlos_session";
}

/** Short-lived cookie that binds a sign-in transaction (state) to the browser that started it (login CSRF defence). */
export function transactionCookieName(secure: boolean): string {
  return secure ? "__Host-hlos_auth_tx" : "hlos_auth_tx";
}

/** Both possible session cookie names: the proxy's optimistic check accepts either. */
export const SESSION_COOKIE_NAMES = ["__Host-hlos_session", "hlos_session"] as const;
