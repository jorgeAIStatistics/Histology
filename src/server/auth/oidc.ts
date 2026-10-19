/**
 * OpenID Connect relying party (openid-client 6, a certified RP library).
 * Authorization code flow with PKCE (S256), state and nonce. The application
 * never sees or handles a password.
 *
 * Exports:
 * - getOidcConfiguration(cfg)         issuer discovery, cached for 10 minutes per
 *                                     (issuer, client); a failure is NOT cached and
 *                                     throws OidcError("PROVIDER_UNAVAILABLE").
 * - buildAuthorizationRequest(cfg, { reauth })
 *                                     -> { url, state, nonce, codeVerifier }. Always sends
 *                                     max_age (so the provider must return auth_time);
 *                                     re-authentication adds prompt=login&max_age=0.
 * - exchangeCode(cfg, params, checks) -> VerifiedIdentity. Validates state, PKCE, the ID
 *                                     token (issuer, audience, expiry, nonce, auth_time against
 *                                     max_age, and its signature against the provider's JWKS:
 *                                     enableNonRepudiationChecks). Typed OidcError on failure.
 * - endSessionUrl(cfg)                the provider's end-session URL, or null when it does
 *                                     not advertise one (or cannot be reached).
 * - resetOidcCache()                  tests only.
 *
 * No token is stored or logged: only the verified claims needed to find the
 * linked staff member (iss, sub, auth_time, and the optional lab claim) leave
 * this module.
 */
import { createHash } from "node:crypto";
import * as client from "openid-client";
import type { AuthConfig } from "./config";

export type OidcErrorCode =
  /** Discovery or a token request could not reach the provider (network, timeout, 5xx, bad metadata). */
  | "PROVIDER_UNAVAILABLE"
  /** The provider answered the authorization request with an error (e.g. access_denied). */
  | "PROVIDER_ERROR"
  /** The token endpoint refused the code (invalid_grant, PKCE mismatch, client auth). */
  | "TOKEN_REJECTED"
  /** The ID token failed validation (nonce, issuer, audience, signature, expiry, auth_time). */
  | "ID_TOKEN_INVALID"
  /** The callback parameters were malformed (state mismatch, missing code, issuer mix-up). */
  | "CALLBACK_INVALID";

export class OidcError extends Error {
  readonly code: OidcErrorCode;
  constructor(code: OidcErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OidcError";
    this.code = code;
  }
}

export interface VerifiedIdentity {
  /** `iss` of the validated ID token. */
  issuer: string;
  /** `sub` of the validated ID token. */
  subject: string;
  /** `auth_time` (seconds since epoch). */
  authTime: number;
  /** All validated ID token claims (used only for the optional lab claim). */
  claims: Record<string, unknown>;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TIMEOUT_S = 10;

type CacheEntry = { config: client.Configuration; at: number };
type GlobalWithCache = typeof globalThis & { __hlosOidcCache?: Map<string, CacheEntry> };

function cache(): Map<string, CacheEntry> {
  const g = globalThis as GlobalWithCache;
  g.__hlosOidcCache ??= new Map();
  return g.__hlosOidcCache;
}

/** Tests only: forget every discovered configuration. */
export function resetOidcCache(): void {
  cache().clear();
}

function cacheKey(cfg: AuthConfig): string {
  // A Configuration belongs to one issuer, client and secret; the secret enters the key only as a hash.
  const secret = createHash("sha256").update(cfg.clientSecret).digest("hex");
  return [cfg.issuer.href, cfg.clientId, secret, cfg.allowInsecureLoopback ? "loopback" : "tls"].join("\n");
}

/** The provider could not be reached or answered outside the protocol (connection refused, DNS, TLS, timeout, 5xx, not JSON). */
function isUnavailable(e: unknown): boolean {
  if (e instanceof client.ClientError) {
    return ["OAUTH_TIMEOUT", "OAUTH_RESPONSE_IS_NOT_CONFORM", "OAUTH_RESPONSE_IS_NOT_JSON"].includes(e.code ?? "");
  }
  if (e instanceof TypeError && !(e as { code?: string }).code) return true; // fetch failed
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) return true;
  return false;
}

/** Discovers the provider (cached). Throws OidcError("PROVIDER_UNAVAILABLE") when it cannot. */
export async function getOidcConfiguration(cfg: AuthConfig): Promise<client.Configuration> {
  const key = cacheKey(cfg);
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.config;
  try {
    const config = await client.discovery(cfg.issuer, cfg.clientId, cfg.clientSecret, client.ClientSecretBasic(cfg.clientSecret), {
      timeout: DISCOVERY_TIMEOUT_S,
      // Plain http only for a loopback issuer with HLOS_OIDC_ALLOW_INSECURE_LOOPBACK=1 (local tests); authConfig()
      // refuses an http issuer anywhere else, so production always talks TLS to the provider.
      ...(cfg.allowInsecureLoopback && cfg.issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : {}),
    });
    // Verify the ID token's signature against the provider's published keys (jwks_uri), not only its claims:
    // integrity then does not rest on the transport alone (the loopback test mode has no TLS).
    client.enableNonRepudiationChecks(config);
    cache().set(key, { config, at: Date.now() });
    return config;
  } catch (e) {
    cache().delete(key);
    throw new OidcError("PROVIDER_UNAVAILABLE", "The identity provider could not be reached or did not describe itself correctly.", { cause: e });
  }
}

/** A new authorization request (PKCE S256, state, nonce). Re-authentication forces a fresh login. */
export async function buildAuthorizationRequest(cfg: AuthConfig, opts: { reauth: boolean }): Promise<AuthorizationRequest> {
  const config = await getOidcConfiguration(cfg);
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const params: Record<string, string> = {
    redirect_uri: cfg.redirectUri,
    scope: "openid",
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
    // max_age obliges the provider to return auth_time; the session never outlives it anyway.
    max_age: opts.reauth ? "0" : String(cfg.maxHours * 3600),
  };
  if (opts.reauth) params.prompt = "login";
  return { url: client.buildAuthorizationUrl(config, params), state, nonce, codeVerifier };
}

/** The max_age a transaction's ID token is checked against. */
export function maxAgeFor(cfg: AuthConfig, reauth: boolean): number {
  return reauth ? 0 : cfg.maxHours * 3600;
}

/**
 * Exchanges the authorization code and validates the ID token. `params` are
 * the callback's query parameters; the redirect URI is rebuilt from
 * HLOS_PUBLIC_URL (never from the Host header).
 */
export async function exchangeCode(
  cfg: AuthConfig,
  params: URLSearchParams,
  checks: { state: string; nonce: string; codeVerifier: string; maxAge: number },
): Promise<VerifiedIdentity> {
  const config = await getOidcConfiguration(cfg);
  const currentUrl = new URL(cfg.redirectUri);
  currentUrl.search = params.toString();
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      maxAge: checks.maxAge,
      idTokenExpected: true,
    });
  } catch (e) {
    throw classify(e);
  }
  const claims = tokens.claims();
  if (!claims) throw new OidcError("ID_TOKEN_INVALID", "The provider returned no ID token.");
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.iss !== "string") {
    throw new OidcError("ID_TOKEN_INVALID", "The ID token has no subject or issuer.");
  }
  if (typeof claims.auth_time !== "number" || !Number.isFinite(claims.auth_time)) {
    throw new OidcError("ID_TOKEN_INVALID", "The ID token has no auth_time.");
  }
  return { issuer: claims.iss, subject: claims.sub, authTime: claims.auth_time, claims: { ...claims } };
}

function classify(e: unknown): OidcError {
  if (e instanceof OidcError) return e;
  if (e instanceof client.AuthorizationResponseError) {
    return new OidcError("PROVIDER_ERROR", "The identity provider refused the sign-in.", { cause: e });
  }
  if (e instanceof client.ResponseBodyError || e instanceof client.WWWAuthenticateChallengeError) {
    return new OidcError("TOKEN_REJECTED", "The identity provider refused the authorization code.", { cause: e });
  }
  if (isUnavailable(e)) return new OidcError("PROVIDER_UNAVAILABLE", "The identity provider could not be reached.", { cause: e });
  if (e instanceof client.ClientError) {
    const detail = e.cause instanceof Error ? e.cause.message : e.message;
    if (e.code === "OAUTH_INVALID_RESPONSE" && /"(state|code|iss)"/.test(detail)) {
      return new OidcError("CALLBACK_INVALID", "The sign-in response was not valid.", { cause: e });
    }
  }
  // Nonce, issuer, audience, signature, expiry or auth_time: the ID token is not accepted.
  return new OidcError("ID_TOKEN_INVALID", "The identity token did not pass validation.", { cause: e });
}

/** The provider's end-session URL (RP-initiated logout), or null when it advertises none or cannot be reached. */
export async function endSessionUrl(cfg: AuthConfig): Promise<string | null> {
  try {
    const config = await getOidcConfiguration(cfg);
    if (!config.serverMetadata().end_session_endpoint) return null;
    return client
      .buildEndSessionUrl(config, { client_id: cfg.clientId, post_logout_redirect_uri: cfg.postLogoutRedirectUri })
      .toString();
  } catch {
    return null;
  }
}
