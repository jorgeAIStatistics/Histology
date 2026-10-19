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
 * - HLOS_OIDC_CLIENT_SECRET     client secret (client_secret_basic): at least 16 characters,
 *                               not weak, and not equal to HLOS_SESSION_SECRET or HLOS_AUDIT_KEY
 * - HLOS_PUBLIC_URL             public origin of this app, e.g. https://lab.example.org
 *                               (https; plain http only on a loopback host AND only when the
 *                               identity provider is on a loopback host too, i.e. a local
 *                               test setup: with a real provider it must be https); the
 *                               redirect URI is <HLOS_PUBLIC_URL>/api/auth/callback
 * - HLOS_LAB_ID                 the one laboratory this deployment serves (e.g. lab:local)
 * - HLOS_SESSION_SECRET         at least 32 bytes and not weak (see weakSecret); keys the
 *                               HMACs that bind a sign-in transaction to the browser that
 *                               started it
 * - HLOS_OIDC_LAB_CLAIM         optional: ID token claim that must contain HLOS_LAB_ID
 * - HLOS_SESSION_IDLE_MIN       optional, default 15 (1..240): idle lock
 * - HLOS_SESSION_MAX_HOURS      optional, default 12 (1..24): absolute session lifetime
 * - HLOS_REAUTH_MAX_AGE_MIN     optional, default 5 (1..60): freshness for sensitive commands
 * - HLOS_OIDC_ALLOW_INSECURE_LOOPBACK  optional, "1" allows an http issuer on 127.0.0.1/localhost/::1
 *                               (local tests with oidc-provider only)
 * - HLOS_AUDIT_KEY              at least 32 bytes and not weak; keys the HMAC chain that seals the audit
 *                               trail (src/server/core/audit-seal.ts) and the session
 *                               references on audit events. Must differ from
 *                               HLOS_SESSION_SECRET and from the public demo key.
 * - HLOS_AUDIT_KEY_ID           optional: a name for that key, recorded on every seal
 *                               (default: derived from the key, "k-" + 12 hex characters;
 *                               never the key itself)
 */
import { createHmac } from "node:crypto";

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
  /** HLOS_AUDIT_KEY and its id (audit seal and session references). */
  auditKey: AuditKeyConfig;
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

// ------------------------------------------------------------------ weak secrets (Stage 6 Phase C5)

/** Whole values (or a value made of one of them repeated) that are placeholders, never secrets. */
const PLACEHOLDER_SECRETS = ["changeme", "change-me", "change_me", "replaceme", "replace-me", "placeholder", "password", "secret", "example", "default", "test", "demo", "todo", "xxx", "abc", "123", "1234567890"];

/**
 * True when a secret is too weak to protect anything, whatever its length:
 * - fewer than 10 distinct characters ("x" * 64, "abcabc…", "00000000…", a short word repeated);
 * - a placeholder word, alone or repeated ("changemechangeme…", "secretsecret…");
 * - one character class only and fewer than 16 distinct characters (all digits, all one-case letters).
 * This is a floor against obvious mistakes, not an entropy measurement: generate secrets with
 * `openssl rand -hex 32` (64 hex characters, 16 distinct on average) and keep them in the secret store.
 * Never reports or logs the value.
 */
export function weakSecret(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  const distinct = new Set(v).size;
  if (distinct < 10) return true;
  const lower = v.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const p of PLACEHOLDER_SECRETS) {
    const q = p.replace(/[^a-z0-9]/g, "");
    if (q && lower.length && lower.replaceAll(q, "") === "") return true;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  if (classes === 1 && distinct < 16) return true;
  return false;
}

// ------------------------------------------------------------------ audit key

/**
 * The fixed, PUBLIC key that seals the synthetic demo's audit trail. It is in
 * the source code, so it proves nothing: anyone can recompute a seal made with
 * it. It exists so the demo shows the mechanism. Its id says so on every seal.
 * A secured build refuses it as HLOS_AUDIT_KEY.
 */
export const DEMO_AUDIT_KEY_ID = "demo-not-secret";
export const DEMO_AUDIT_KEY_TEXT = "hlos-public-demo-audit-key/NOT-A-SECRET/synthetic-demo-only/v1";

export interface AuditKeyConfig {
  /** Recorded on every seal; never the key. */
  id: string;
  key: Buffer;
  /** True only for the public demo key. */
  demo: boolean;
}

export type AuditKeyResult = { ok: true; key: AuditKeyConfig } | { ok: false; keys: string[] };

const AUDIT_KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
let derivedIdCache: { raw: string; id: string } | null = null;

function derivedKeyId(raw: string): string {
  if (derivedIdCache?.raw !== raw) {
    derivedIdCache = { raw, id: `k-${createHmac("sha256", Buffer.from(raw, "utf8")).update("hlos-audit-key-id/v1").digest("hex").slice(0, 12)}` };
  }
  return derivedIdCache.id;
}

/** The public demo audit key (synthetic demo only). */
export function demoAuditKey(): AuditKeyConfig {
  return { id: DEMO_AUDIT_KEY_ID, key: Buffer.from(DEMO_AUDIT_KEY_TEXT, "utf8"), demo: true };
}

/**
 * HLOS_AUDIT_KEY (and HLOS_AUDIT_KEY_ID) from the environment. `{ ok: false,
 * keys }` names what is missing or invalid, never a value. Invalid: missing,
 * shorter than 32 bytes, equal to the public demo key, or equal to
 * HLOS_SESSION_SECRET (each secret keys one thing only).
 */
export function auditKeyFromEnv(): AuditKeyResult {
  const bad: string[] = [];
  const raw = process.env.HLOS_AUDIT_KEY ?? "";
  if (Buffer.byteLength(raw, "utf8") < 32 || raw === DEMO_AUDIT_KEY_TEXT || raw === (process.env.HLOS_SESSION_SECRET ?? "") || weakSecret(raw)) {
    bad.push("HLOS_AUDIT_KEY");
  }
  const givenId = env("HLOS_AUDIT_KEY_ID");
  if (givenId !== undefined && (!AUDIT_KEY_ID.test(givenId) || givenId === DEMO_AUDIT_KEY_ID)) bad.push("HLOS_AUDIT_KEY_ID");
  if (bad.length) return { ok: false, keys: bad };
  return { ok: true, key: { id: givenId ?? derivedKeyId(raw), key: Buffer.from(raw, "utf8"), demo: false } };
}

/**
 * Validates the OIDC, session and audit-key environment. `{ ok: false, keys }`
 * names every missing or invalid key (sorted, never a value).
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
  // Missing, short, weak, or the same value as another secret (each secret keys one thing only).
  if (
    !clientSecret.trim() ||
    clientSecret.trim().length < 16 ||
    weakSecret(clientSecret) ||
    clientSecret === (process.env.HLOS_SESSION_SECRET ?? "") ||
    clientSecret === (process.env.HLOS_AUDIT_KEY ?? "")
  ) {
    bad.push("HLOS_OIDC_CLIENT_SECRET");
  }

  let publicOrigin = "";
  let secureCookies = false;
  try {
    const raw = env("HLOS_PUBLIC_URL");
    if (!raw) throw new Error("missing");
    const u = new URL(raw);
    const https = u.protocol === "https:";
    // Plain http only on a loopback host: a session cookie must never cross a network unencrypted.
    if (!(https || (u.protocol === "http:" && isLoopbackHost(u.hostname)))) throw new Error("invalid");
    // ... and only for a local test setup, where the identity provider is on this machine too (Stage 6 Phase C5).
    // With a real provider the browser reaches the app over a network, through a TLS-terminating proxy, so the
    // public origin is https (Secure, __Host- cookies; HSTS). A loopback http origin behind such a proxy would
    // send the session cookie without the Secure attribute. An invalid issuer is reported on its own.
    if (!https && issuer && !isLoopbackHost(issuer.hostname)) throw new Error("http public URL with a non-loopback identity provider");
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error("invalid");
    publicOrigin = u.origin;
    secureCookies = https;
  } catch {
    bad.push("HLOS_PUBLIC_URL");
  }

  const labId = env("HLOS_LAB_ID");
  if (!labId || !LAB_ID.test(labId)) bad.push("HLOS_LAB_ID");

  const sessionSecret = process.env.HLOS_SESSION_SECRET ?? "";
  if (Buffer.byteLength(sessionSecret, "utf8") < 32 || weakSecret(sessionSecret)) bad.push("HLOS_SESSION_SECRET");

  const labClaim = env("HLOS_OIDC_LAB_CLAIM") ?? null;
  if (labClaim !== null && !CLAIM_NAME.test(labClaim)) bad.push("HLOS_OIDC_LAB_CLAIM");

  const idleMinutes = intIn("HLOS_SESSION_IDLE_MIN", 15, 1, 240, bad);
  const maxHours = intIn("HLOS_SESSION_MAX_HOURS", 12, 1, 24, bad);
  const reauthMaxAgeMinutes = intIn("HLOS_REAUTH_MAX_AGE_MIN", 5, 1, 60, bad);

  // A secured build seals its audit trail with its own key: without one it is locked.
  const audit = auditKeyFromEnv();
  if (!audit.ok) bad.push(...audit.keys);

  if (bad.length || !issuer || !clientId || !labId || !audit.ok) return { ok: false, keys: [...new Set(bad)].sort() };
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
      auditKey: audit.key,
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
