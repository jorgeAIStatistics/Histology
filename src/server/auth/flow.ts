/**
 * Sign-in, sign-out, lock and session-status handlers for the secured mode,
 * written as plain Request -> Response functions so the route files under
 * src/app/api/auth/* stay one line and tests can drive them directly.
 *
 *   GET  /api/auth/login?returnTo=/path[&reauth=1]  handleLogin
 *        Creates a one-time transaction (state, nonce, PKCE verifier; 10 min),
 *        binds it to this browser (HttpOnly cookie with an HMAC of the state)
 *        and redirects (303) to the provider. EVERY sign-in forces a fresh
 *        authentication (prompt=login&max_age=0; `reauth=1` is accepted and
 *        changes nothing): a provider single-sign-on session left behind by the
 *        previous person (after a lock, a sign-out whose provider logout was
 *        declined, or an expired session) never opens this workstation on its
 *        own. Provider unreachable -> 303 /signin?error=provider_unavailable
 *        (audited auth.denied, rate-limited, see auditFlowDenial).
 *   GET  /api/auth/callback                         handleCallback
 *        Consumes the transaction once, checks the browser binding, exchanges
 *        the code (PKCE) and validates the ID token, then refuses an auth_time
 *        older than the transaction (reauth_not_fresh), then completeSignIn().
 *        Success -> 303 to returnTo with the session cookie. Denials are
 *        audited (auth.denied, no tokens or patient data; a callback without
 *        this browser's binding cookie is only logged, and repeated flow-level
 *        denials are aggregated per minute) and land on a plain page:
 *        /no-access?reason=unlinked|inactive|wrong_lab, or
 *        /signin?error=bad_state|provider_error|provider_unavailable|token_invalid|reauth_not_fresh.
 *   POST /api/auth/logout                           handleLogout (same-origin)
 *        Revokes this session, clears the cookie, audits auth.signed_out and
 *        returns { ok: true, result: { signedOut, endSessionUrl } }.
 *   POST /api/auth/lock                             handleLock (same-origin)
 *        Locks this session: { ok: true, result: { locked: true } }.
 *   GET  /api/auth/session                          handleSessionInfo
 *        Who is signed in, lock state, expiry and re-authentication freshness
 *        (no patient data). Never counts as activity.
 *   POST /api/auth/activity                         handleActivity (same-origin)
 *        Real user input on an open page that caused no request (the client
 *        sends it at most about once a minute while the person works).
 *
 * In demo mode these routes do not exist (404); in a locked build they answer
 * 401 AUTH_REQUIRED with no data.
 */
import type { DB } from "../db/db";
import { getDb } from "../db/db";
import { runtimeMode } from "../runtime-mode";
import { correlationIdFor } from "../session";
import { auditAuth, subjectRef } from "./audit";
import { authConfig, sessionCookieName, transactionCookieName, type AuthConfig } from "./config";
import { clearCookie, readCookie, serializeCookie } from "./cookies";
import { guardFailureResponse, requireSameOrigin, sessionFailure } from "./guard";
import { buildAuthorizationRequest, endSessionUrl, exchangeCode, maxAgeFor, OidcError, type VerifiedIdentity } from "./oidc";
import {
  createSession,
  isReauthFresh,
  lockSession,
  peekSession,
  reauthFreshUntil,
  resolveSession,
  revokeSession,
  unlockAfterReauth,
  type SessionPolicy,
} from "./sessions";
import { consumeTransaction, createTransaction, safeReturnTo, TRANSACTION_TTL_MS, txBindingMatches, txBindingValue } from "./transactions";
import { log } from "../core/log";

/** Why a sign-in was refused. Shown to the person as a plain page; recorded as auth.denied. */
export type DenyReason =
  | "unlinked" // no active staff_identity link for (lab, issuer, subject)
  | "inactive" // the linked staff member is not active
  | "wrong_lab" // the lab claim does not contain HLOS_LAB_ID, or the staff member belongs to another lab
  | "bad_state" // unknown, replayed or expired transaction, or a callback started in another browser
  | "provider_error" // the provider answered with an error (e.g. the person cancelled)
  | "provider_unavailable" // the provider could not be reached
  | "token_invalid" // code exchange refused or ID token failed validation (nonce, signature, issuer, audience, expiry)
  | "reauth_not_fresh"; // a re-authentication that did not actually authenticate again

const NO_ACCESS_REASONS: readonly DenyReason[] = ["unlinked", "inactive", "wrong_lab"];

export function denialPagePath(reason: DenyReason, returnTo = "/"): string {
  if (NO_ACCESS_REASONS.includes(reason)) return `/no-access?${new URLSearchParams({ reason })}`;
  return `/signin?${new URLSearchParams({ error: reason, returnTo: safeReturnTo(returnTo) })}`;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function policyOf(cfg: AuthConfig): SessionPolicy {
  return { labId: cfg.labId, idleMinutes: cfg.idleMinutes, maxHours: cfg.maxHours, reauthMaxAgeMinutes: cfg.reauthMaxAgeMinutes };
}

/** demo: the route does not exist (404). locked: 401 with no data. Returns null in secured mode. */
function modeRefusal(): Response | null {
  const mode = runtimeMode();
  if (mode === "secured") return null;
  if (mode === "demo") {
    return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "Sign-in is not used in the synthetic demo." } }, { status: 404, headers: NO_STORE });
  }
  return guardFailureResponse({ ok: false, mode: "locked", status: 401, code: "AUTH_REQUIRED", reason: "not_configured", message: "Sign-in is not configured for this build." });
}

function securedConfig(): AuthConfig {
  const cfg = authConfig();
  if (!cfg.ok) throw new Error("secured mode without a valid configuration"); // unreachable: runtimeMode() checked it
  return cfg.config;
}

function redirectTo(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, ...NO_STORE });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}

// ------------------------------------------------------------------ completeSignIn (no network)

export interface CompleteSignInOptions {
  cfg: Pick<AuthConfig, "labId" | "labClaim" | "sessionSecret" | "idleMinutes" | "maxHours" | "reauthMaxAgeMinutes">;
  /** The session cookie this browser already holds, if any. */
  existingCookie?: string;
  /**
   * The sign-in forced a fresh authentication (prompt=login&max_age=0). Only
   * such a sign-in may unlock a locked session; any other one is refused
   * (reauth_not_fresh) so a provider single-sign-on session cannot unlock a
   * workstation without the person authenticating again.
   */
  reauth?: boolean;
  userAgent?: string | null;
  correlationId: string;
  now?: number;
}

export type SignInOutcome =
  | { ok: true; cookieValue: string; staffId: string; kind: "signed_in" | "reauthenticated" | "handover" }
  | { ok: false; reason: DenyReason };

/** Whether the configured lab claim contains HLOS_LAB_ID (string, or array of strings). */
export function labClaimAllows(claims: Record<string, unknown>, claimName: string, labId: string): boolean {
  const v = claims[claimName];
  if (typeof v === "string") return v === labId || v.split(/[\s,]+/).includes(labId);
  if (Array.isArray(v)) return v.some((x) => x === labId);
  return false;
}

/**
 * Everything after the ID token was verified: the lab claim, the identity
 * link (never created here), the staff member's status and lab, and the
 * session (new, re-authenticated, or a hand-over that revokes the previous
 * person's session). Audits the outcome. Exported for tests with fake
 * verified identities.
 */
export function completeSignIn(db: DB, identity: VerifiedIdentity, opts: CompleteSignInOptions): SignInOutcome {
  const now = opts.now ?? Date.now();
  const { cfg } = opts;
  const policy = policyOf(cfg as AuthConfig);
  const sub = subjectRef(identity.subject);
  const deny = (reason: DenyReason, staffId: string | null = null): SignInOutcome => {
    auditAuth(db, {
      action: "auth.denied",
      staffId,
      actor: "system",
      summary: `Sign-in denied (${reason})`,
      reason,
      details: { reason, issuer: identity.issuer, subject: sub, staffId },
      correlationId: opts.correlationId,
    });
    return { ok: false, reason };
  };

  // An auth_time in the future (a provider clock running ahead) would stretch the re-authentication window.
  if (identity.authTime * 1000 > now + 60_000) return deny("token_invalid");
  if (cfg.labClaim && !labClaimAllows(identity.claims, cfg.labClaim, cfg.labId)) return deny("wrong_lab");

  const link = db
    .prepare("SELECT staff_id FROM staff_identity WHERE lab_id = ? AND issuer = ? AND subject = ? AND active = 1")
    .get(cfg.labId, identity.issuer, identity.subject) as { staff_id: string } | undefined;
  if (!link) return deny("unlinked");
  const staff = db.prepare("SELECT id, active, lab_id FROM staff WHERE id = ?").get(link.staff_id) as
    | { id: string; active: number; lab_id: string }
    | undefined;
  if (!staff || staff.active !== 1) return deny("inactive", link.staff_id);
  if (staff.lab_id !== cfg.labId) return deny("wrong_lab", link.staff_id);

  const authTimeMs = identity.authTime * 1000;
  const existing = peekSession(db, opts.existingCookie);
  const existingUsable = existing && !existing.revoked_at && now < Date.parse(existing.expires_at) && existing.lab_id === cfg.labId;

  return db.transaction((): SignInOutcome => {
    if (existingUsable && existing.staff_id === staff.id) {
      if (existing.locked_at && !opts.reauth) return deny("reauth_not_fresh", staff.id);
      // The same person authenticated again (unlock, or "Confirm it's you"): same session, new auth_time.
      unlockAfterReauth(db, existing.id_hash, { authTimeMs, issuer: identity.issuer, subject: identity.subject }, now);
      auditAuth(db, {
        action: "auth.reauthenticated",
        staffId: staff.id,
        summary: `Signed in again${existing.locked_at ? " (unlocked)" : ""}`,
        details: { issuer: identity.issuer, subject: sub, unlocked: Boolean(existing.locked_at) },
        correlationId: opts.correlationId,
      });
      return { ok: true, cookieValue: opts.existingCookie!, staffId: staff.id, kind: "reauthenticated" };
    }
    let kind: "signed_in" | "handover" = "signed_in";
    if (existing && !existing.revoked_at) {
      // Workstation hand-over (or a stale session): the previous session ends here.
      const handover = existing.staff_id !== staff.id;
      revokeSession(db, existing.id_hash, handover ? "handover" : "replaced", now);
      if (handover) {
        kind = "handover";
        auditAuth(db, {
          action: "auth.handover",
          staffId: existing.staff_id,
          actor: "system",
          summary: "Session ended: another staff member signed in on this browser",
          details: { nextStaffId: staff.id },
          correlationId: opts.correlationId,
        });
      }
    }
    const created = createSession(
      db,
      { staffId: staff.id, labId: cfg.labId, issuer: identity.issuer, subject: identity.subject, authTimeMs, userAgent: opts.userAgent, secret: cfg.sessionSecret },
      policy,
      now,
    );
    auditAuth(db, {
      action: "auth.signed_in",
      staffId: staff.id,
      summary: kind === "handover" ? "Signed in (workstation hand-over)" : "Signed in",
      details: { issuer: identity.issuer, subject: sub, expiresAt: created.expiresAt },
      correlationId: opts.correlationId,
    });
    return { ok: true, cookieValue: created.cookieValue, staffId: staff.id, kind };
  })();
}

/** One audit event per kind of flow-level denial per window; the repeats in between are only counted. */
export const FLOW_DENIAL_WINDOW_MS = 60_000;
type FlowDenialSeen = Map<string, { at: number; suppressed: number }>;

/**
 * Records a flow-level denial (before any identity was verified). Anyone can
 * cause these without signing in, so they must not grow the append-only audit
 * trail per request: per database, reason and detail (a provider_error's
 * detail comes from the request, so it is not part of the key) at most one
 * event is written per FLOW_DENIAL_WINDOW_MS; the next event written carries
 * `suppressed`, the number of identical denials not recorded one by one.
 */
function auditFlowDenial(db: DB, reason: DenyReason, correlationId: string, detail?: string, now: number = Date.now()): void {
  const g = globalThis as typeof globalThis & { __hlosFlowDenials?: FlowDenialSeen };
  const seen = (g.__hlosFlowDenials ??= new Map());
  const key = [db.name, reason, reason === "provider_error" ? "" : (detail ?? "")].join("\n");
  const last = seen.get(key);
  if (last && now >= last.at && now - last.at < FLOW_DENIAL_WINDOW_MS) {
    last.suppressed += 1;
    return;
  }
  if (seen.size > 1000) seen.clear(); // bounded memory (keys are a small fixed vocabulary per database)
  seen.set(key, { at: now, suppressed: 0 });
  auditAuth(db, {
    action: "auth.denied",
    staffId: null,
    actor: "system",
    summary: `Sign-in denied (${reason})`,
    reason,
    details: { reason, ...(detail ? { detail } : {}), ...(last?.suppressed ? { suppressed: last.suppressed } : {}) },
    correlationId,
  });
}

// ------------------------------------------------------------------ handlers

export async function handleLogin(req: Request, deps: { db?: DB; now?: number } = {}): Promise<Response> {
  const refused = modeRefusal();
  if (refused) return refused;
  const cfg = securedConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now();
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  // Every interactive sign-in is a fresh authentication at the provider (prompt=login&max_age=0), whether or not
  // this browser still holds a session: on a shared workstation the provider may still hold the PREVIOUS person's
  // single-sign-on session (after a lock, a sign-out whose provider logout was declined, or an expiry), and it
  // must never sign anyone in without that person authenticating again. The callback checks auth_time too.
  const reauth = true;
  let authReq;
  try {
    authReq = await buildAuthorizationRequest(cfg, { reauth });
  } catch (e) {
    const code = e instanceof OidcError ? e.code : "PROVIDER_UNAVAILABLE";
    auditFlowDenial(db, "provider_unavailable", correlationIdFor(req), code, now);
    return redirectTo(`${cfg.publicOrigin}${denialPagePath("provider_unavailable", returnTo)}`);
  }
  createTransaction(db, { state: authReq.state, nonce: authReq.nonce, codeVerifier: authReq.codeVerifier, returnTo, reauth }, now);
  const binding = serializeCookie(transactionCookieName(cfg.secureCookies), txBindingValue(cfg.sessionSecret, authReq.state), {
    secure: cfg.secureCookies,
    maxAge: TRANSACTION_TTL_MS / 1000,
  });
  return redirectTo(authReq.url.toString(), [binding]);
}

const PROVIDER_ERROR_CODE = /^[a-z_]{1,64}$/;

export async function handleCallback(req: Request, deps: { db?: DB; now?: number } = {}): Promise<Response> {
  const refused = modeRefusal();
  if (refused) return refused;
  const cfg = securedConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now();
  const correlationId = correlationIdFor(req);
  const params = new URL(req.url).searchParams;
  const cookieHeader = req.headers.get("cookie");
  const clearTx = clearCookie(transactionCookieName(cfg.secureCookies), cfg.secureCookies);
  const denied = (reason: DenyReason, returnTo = "/", detail?: string, audited = false) => {
    if (!audited) auditFlowDenial(db, reason, correlationId, detail, now);
    return redirectTo(`${cfg.publicOrigin}${denialPagePath(reason, returnTo)}`, [clearTx]);
  };

  const txCookie = readCookie(cookieHeader, transactionCookieName(cfg.secureCookies));
  if (!txCookie) {
    // No sign-in was started in this browser: this cannot be a sign-in in progress (a stray, stale or forged
    // callback). Anyone can send it without signing in, so it is logged, never written to the audit trail.
    log("warn", "auth.callback_without_transaction", { correlationId });
    return redirectTo(`${cfg.publicOrigin}${denialPagePath("bad_state")}`, [clearTx]);
  }
  const state = params.get("state");
  if (!state || state.length > 200) return denied("bad_state", "/", "missing_state");
  // The transaction must have been started by THIS browser (login CSRF), before it is consumed.
  if (!txBindingMatches(cfg.sessionSecret, state, txCookie)) {
    return denied("bad_state", "/", "browser_binding");
  }
  const consumed = consumeTransaction(db, state, now);
  if (!consumed.ok) return denied("bad_state", "/", consumed.reason);
  const tx = consumed.tx;
  const providerError = params.get("error");
  if (providerError) return denied("provider_error", tx.return_to, PROVIDER_ERROR_CODE.test(providerError) ? providerError : "error");

  let identity: VerifiedIdentity;
  try {
    identity = await exchangeCode(cfg, params, { state: tx.state, nonce: tx.nonce, codeVerifier: tx.code_verifier, maxAge: maxAgeFor(cfg, tx.reauth === 1) });
  } catch (e) {
    const code = e instanceof OidcError ? e.code : "ID_TOKEN_INVALID";
    return denied(code === "PROVIDER_UNAVAILABLE" ? "provider_unavailable" : code === "PROVIDER_ERROR" ? "provider_error" : "token_invalid", tx.return_to, code);
  }
  // Every sign-in must be a NEW authentication (allowing one minute of clock skew), whatever the provider did with
  // prompt=login: an older single-sign-on session at the provider never signs anyone in here.
  if (identity.authTime * 1000 < Date.parse(tx.created_at) - 60_000) {
    return denied("reauth_not_fresh", tx.return_to);
  }

  const outcome = completeSignIn(db, identity, {
    cfg,
    reauth: true, // checked just above for every sign-in
    existingCookie: readCookie(cookieHeader, sessionCookieName(cfg.secureCookies)),
    userAgent: req.headers.get("user-agent"),
    correlationId,
    now,
  });
  if (!outcome.ok) return denied(outcome.reason, tx.return_to, undefined, true);
  const sessionCookie = serializeCookie(sessionCookieName(cfg.secureCookies), outcome.cookieValue, { secure: cfg.secureCookies });
  return redirectTo(`${cfg.publicOrigin}${safeReturnTo(tx.return_to)}`, [sessionCookie, clearTx]);
}

export async function handleLogout(req: Request, deps: { db?: DB; now?: number } = {}): Promise<Response> {
  const refused = modeRefusal();
  if (refused) return refused;
  const crossOrigin = requireSameOrigin(req);
  if (crossOrigin) return crossOrigin;
  const cfg = securedConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now();
  const row = peekSession(db, readCookie(req.headers.get("cookie"), sessionCookieName(cfg.secureCookies)));
  let signedOut = false;
  if (row && !row.revoked_at) {
    signedOut = revokeSession(db, row.id_hash, "signed_out", now);
    auditAuth(db, { action: "auth.signed_out", staffId: row.staff_id, summary: "Signed out", correlationId: correlationIdFor(req) });
  }
  const headers = new Headers(NO_STORE);
  headers.append("Set-Cookie", clearCookie(sessionCookieName(cfg.secureCookies), cfg.secureCookies));
  return Response.json({ ok: true, result: { signedOut, endSessionUrl: await endSessionUrl(cfg) } }, { headers });
}

export async function handleLock(req: Request, deps: { db?: DB; now?: number } = {}): Promise<Response> {
  const refused = modeRefusal();
  if (refused) return refused;
  const crossOrigin = requireSameOrigin(req);
  if (crossOrigin) return crossOrigin;
  const cfg = securedConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now();
  const r = resolveSession(db, readCookie(req.headers.get("cookie"), sessionCookieName(cfg.secureCookies)), { touch: false, policy: policyOf(cfg), now });
  if (!r.ok && r.reason !== "locked" && r.reason !== "idle_locked") {
    return guardFailureResponse(sessionFailure(r.reason));
  }
  const staffId = r.ok ? r.staff.id : null;
  const idHash = r.ok ? r.session.idHash : r.session!.idHash;
  const changed = lockSession(db, idHash, now);
  if (changed && staffId) auditAuth(db, { action: "auth.locked", staffId, summary: "Locked the workstation", correlationId: correlationIdFor(req) });
  return Response.json({ ok: true, result: { locked: true } }, { headers: NO_STORE });
}

/**
 * POST /api/auth/activity (same-origin): the person is working on the open
 * page (keys, pointer, scrolling) without causing a request, for example while
 * typing a long note. The client sends it after real input, at most about once
 * a minute, so the server's idle lock follows "no user input" (the client's
 * idle timer) instead of "no request". Background polling never sends it. A
 * locked, expired or ended session is not touched (401/403, no data).
 * 200: { ok: true, result: { idleLocksAt } }.
 */
export async function handleActivity(req: Request, deps: { db?: DB; now?: number } = {}): Promise<Response> {
  const refused = modeRefusal();
  if (refused) return refused;
  const crossOrigin = requireSameOrigin(req);
  if (crossOrigin) return crossOrigin;
  const cfg = securedConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now();
  const r = resolveSession(db, readCookie(req.headers.get("cookie"), sessionCookieName(cfg.secureCookies)), { touch: true, policy: policyOf(cfg), now });
  if (!r.ok) return guardFailureResponse(sessionFailure(r.reason, r.session));
  return Response.json({ ok: true, result: { idleLocksAt: r.session.idleLocksAt } }, { headers: NO_STORE });
}

/**
 * Session status for the client (lock screen, idle timer, "Confirm it's you").
 * 200: { ok: true, result: { mode: "secured", signedIn: true, locked, actor (null while locked),
 *        expiresAt, idleLocksAt, authTime, reauthFresh, reauthFreshUntil, idleMinutes, reauthMaxAgeMinutes } }
 * 401: no valid session. In demo mode: { ok: true, result: { mode: "demo", signedIn: false } }.
 */
export async function handleSessionInfo(req: Request, deps: { db?: DB; now?: number } = {}): Promise<Response> {
  const mode = runtimeMode();
  if (mode === "demo") return Response.json({ ok: true, result: { mode: "demo", signedIn: false } }, { headers: NO_STORE });
  const refused = modeRefusal();
  if (refused) return refused;
  const cfg = securedConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now();
  const policy = policyOf(cfg);
  const r = resolveSession(db, readCookie(req.headers.get("cookie"), sessionCookieName(cfg.secureCookies)), { touch: false, policy, now });
  if (r.ok) {
    return Response.json(
      {
        ok: true,
        result: {
          mode: "secured",
          signedIn: true,
          locked: false,
          actor: { id: r.staff.id, name: r.staff.name, role: r.staff.role },
          expiresAt: r.session.expiresAt,
          idleLocksAt: r.session.idleLocksAt,
          authTime: r.session.authTime,
          reauthFresh: isReauthFresh(r.session, policy, now),
          reauthFreshUntil: reauthFreshUntil(r.session.authTime, policy),
          idleMinutes: policy.idleMinutes,
          reauthMaxAgeMinutes: policy.reauthMaxAgeMinutes,
        },
      },
      { headers: NO_STORE },
    );
  }
  if ((r.reason === "locked" || r.reason === "idle_locked") && r.session) {
    // The lock screen shows no patient, case or operator details: no actor while locked.
    return Response.json(
      { ok: true, result: { mode: "secured", signedIn: true, locked: true, actor: null, expiresAt: r.session.expiresAt, lockedAt: r.session.lockedAt } },
      { headers: NO_STORE },
    );
  }
  return guardFailureResponse(sessionFailure(r.reason));
}
