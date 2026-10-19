/**
 * THE one place that resolves the current actor, for every page, read API,
 * server action and command route. Fail closed.
 *
 *   mode      | who is the actor
 *   ----------|---------------------------------------------------------------
 *   demo      | the demo role cookie (hlos_actor), exactly as before Stage 6
 *             | (unknown or inactive staff id -> the default demo actor)
 *   secured   | the signed-in session (auth_session), resolved fresh: lab,
 *             | active staff, identity link, lock and expiry; the demo cookie
 *             | is ignored
 *   locked    | nobody
 *
 * PAGES (server components) - redirect, never render data on failure:
 *   const actor = await requireView("view.intake");   // the page's view permission
 *   const actor = await requireActor();               // signed in, no view check
 *     locked                         -> /locked
 *     no / revoked / unknown session -> /signin?returnTo=<this page>
 *     expired                        -> /signin?returnTo=…&reason=expired
 *     locked (idle or manual)        -> /signin?returnTo=…&reason=locked
 *     inactive staff, other lab, identity unlinked -> /no-access?reason=…
 *     role lacks the view            -> /forbidden
 *   Only a full document load counts as activity (touch): a page rendered for
 *   a fetch() (Sec-Fetch-Dest other than "document": router.refresh() from
 *   background polling, client navigations, prefetches) does not; the client
 *   reports real input itself (POST /api/auth/activity).
 *   `returnTo` comes from the x-hlos-path request header set by src/proxy.ts.
 *
 * LAYOUT / SERVER ACTIONS - no redirect:
 *   const viewer = await currentViewer({ touch: false, view?: "view.intake" });
 *   if (!viewer.ok) …  // GuardFail: { status, code, reason, message }
 *
 * ROUTE HANDLERS (plain Request, testable without Next.js):
 *   const g = requireApiActor(req, { touch: true, view?: "view.worklist", checkActorHeader?: true });
 *   if (!g.ok) return guardFailureResponse(g);   // 401 / 403 / 409 JSON, no data
 *   g.actor, g.auth (pass g.auth to executeCommand in secured mode)
 *     locked                     -> 401 AUTH_REQUIRED
 *     no / unknown / revoked     -> 401 SIGN_IN_REQUIRED
 *     expired                    -> 401 SESSION_EXPIRED
 *     locked / idle              -> 401 SESSION_LOCKED
 *     inactive / other lab / unlinked, or view missing -> 403 FORBIDDEN
 *     X-HLOS-Actor != session staff (checkActorHeader) -> 409 ACTOR_MISMATCH
 *   Background polling (/api/live, /api/auth/session) passes touch: false;
 *   commands and user-driven requests pass touch: true. The actor header and
 *   view are checked BEFORE the session is touched.
 *
 * STATE-CHANGING ROUTES also call requireSameOrigin(req) first.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { DB } from "../db/db";
import { getDb } from "../db/db";
import { roleCan, type ViewPermission } from "@/lib/roles";
import type { Actor } from "../core/context";
import { LOCKED_MESSAGE, runtimeMode, type RuntimeMode } from "../runtime-mode";
import { actorIdFromRequest, demoActor, getActorId } from "../session";
import { authConfig, sessionCookieName } from "./config";
import { readCookie } from "./cookies";
import { resolveSession, sessionPolicyFromEnv, touchSession, type SessionFailureReason, type SessionInfo } from "./sessions";
import { safeReturnTo } from "./transactions";

/** What executeCommand needs to know about the session behind a secured request. */
export interface CommandAuth {
  /** sha256 of the session id (never the id itself). */
  sessionIdHash: string;
  /** The session's staff member: the only actor a secured request may act as. */
  staffId: string;
  /** Last authentication at the provider (ISO), for sensitive-command freshness. */
  authTime: string;
}

export type GuardCode = "AUTH_REQUIRED" | "SIGN_IN_REQUIRED" | "SESSION_EXPIRED" | "SESSION_LOCKED" | "FORBIDDEN" | "ACTOR_MISMATCH";
export type GuardReason = "not_configured" | SessionFailureReason | "view_denied" | "actor_mismatch";

export interface GuardOk {
  ok: true;
  mode: "demo" | "secured";
  actor: Actor;
  /** The session (secured mode only). */
  session: SessionInfo | null;
  /** Pass to executeCommand (secured mode only; null in demo). */
  auth: CommandAuth | null;
}

export interface GuardFail {
  ok: false;
  mode: RuntimeMode;
  status: 401 | 403 | 409;
  code: GuardCode;
  reason: GuardReason;
  message: string;
  /** Lock state and expiry for a locked or expired session (never an actor or any lab data). */
  session?: Pick<SessionInfo, "expiresAt" | "lockedAt">;
}

export type GuardResult = GuardOk | GuardFail;

export interface GuardOptions {
  /** Count this request as user activity (page loads, commands). Background polling: false. */
  touch: boolean;
  /** The view permission the page or read API needs. */
  view?: ViewPermission;
  /** Secured mode: the X-HLOS-Actor header must equal the session's staff id (commands, exports). */
  checkActorHeader?: boolean;
  /** Wall clock in ms (tests). */
  now?: number;
  /** Database (tests); default the shared connection. */
  db?: DB;
}

/** Inputs read from a request or from next/headers. */
export interface GuardInput {
  /** The secured-mode session cookie value. */
  sessionCookie: string | undefined;
  /** The demo role cookie's staff id (already validated / defaulted). Used only in demo mode. */
  demoActorId: string;
  /** X-HLOS-Actor header value (commands). */
  actorHeader?: string | null;
}

const MESSAGES: Record<GuardCode, string> = {
  AUTH_REQUIRED: LOCKED_MESSAGE,
  SIGN_IN_REQUIRED: "Sign in to continue. Nothing was shown or recorded.",
  SESSION_EXPIRED: "Your session has ended. Sign in again; nothing was recorded.",
  SESSION_LOCKED: "This workstation is locked. Sign in again to continue; nothing was recorded.",
  FORBIDDEN: "Not allowed.",
  ACTOR_MISMATCH:
    "This screen was opened for a different staff member than the one signed in now. Nothing was recorded. Reload the page to continue as the person signed in.",
};

function fail(mode: RuntimeMode, status: GuardFail["status"], code: GuardCode, reason: GuardReason, message?: string, session?: SessionInfo): GuardFail {
  return {
    ok: false,
    mode,
    status,
    code,
    reason,
    message: message ?? MESSAGES[code],
    ...(session ? { session: { expiresAt: session.expiresAt, lockedAt: session.lockedAt } } : {}),
  };
}

/** The guard failure for a session that did not resolve (401 or 403, never data). */
export function sessionFailure(reason: SessionFailureReason, session?: SessionInfo): GuardFail {
  switch (reason) {
    case "expired":
      return fail("secured", 401, "SESSION_EXPIRED", reason, undefined, session);
    case "locked":
    case "idle_locked":
      return fail("secured", 401, "SESSION_LOCKED", reason, undefined, session);
    case "wrong_lab":
      return fail("secured", 403, "FORBIDDEN", reason, "This account is not linked to this laboratory. Nothing was shown or recorded.");
    case "staff_inactive":
      return fail("secured", 403, "FORBIDDEN", reason, "This staff account is not active. Nothing was shown or recorded.");
    case "identity_unlinked":
      return fail("secured", 403, "FORBIDDEN", reason, "This sign-in is no longer linked to a staff account. Nothing was shown or recorded.");
    default:
      return fail("secured", 401, "SIGN_IN_REQUIRED", reason);
  }
}

/**
 * The core decision, independent of how cookies and headers were read.
 * Synchronous (better-sqlite3).
 */
export function resolveViewer(input: GuardInput, opts: GuardOptions): GuardResult {
  const mode = runtimeMode();
  if (mode === "locked") return fail("locked", 401, "AUTH_REQUIRED", "not_configured");
  const db = opts.db ?? getDb();

  if (mode === "demo") {
    const actor = demoActor(db, input.demoActorId);
    if (opts.view && !roleCan(actor.role, opts.view)) {
      return fail("demo", 403, "FORBIDDEN", "view_denied", `Not allowed: this role cannot open this screen.`);
    }
    return { ok: true, mode: "demo", actor, session: null, auth: null };
  }

  // secured
  const policy = sessionPolicyFromEnv();
  if (!policy) return fail("locked", 401, "AUTH_REQUIRED", "not_configured");
  const now = opts.now ?? Date.now();
  const r = resolveSession(db, input.sessionCookie, { touch: false, policy, now });
  if (!r.ok) return sessionFailure(r.reason, r.session);
  const actor: Actor = { id: r.staff.id, name: r.staff.name, role: r.staff.role };
  if (opts.view && !roleCan(actor.role, opts.view)) {
    return fail("secured", 403, "FORBIDDEN", "view_denied", "Not allowed: this role cannot open this screen.");
  }
  if (opts.checkActorHeader && (input.actorHeader ?? "").trim() !== actor.id) {
    return fail("secured", 409, "ACTOR_MISMATCH", "actor_mismatch");
  }
  let session = r.session;
  if (opts.touch) {
    touchSession(db, session.idHash, now);
    session = { ...session, lastActivityAt: new Date(now).toISOString(), idleLocksAt: new Date(now + policy.idleMinutes * 60_000).toISOString() };
  }
  return { ok: true, mode: "secured", actor, session, auth: { sessionIdHash: session.idHash, staffId: actor.id, authTime: session.authTime } };
}

/** The secured-mode session cookie value from a Cookie header (either cookie name is accepted only as configured). */
export function sessionCookieFromHeader(cookieHeader: string | null | undefined): string | undefined {
  const cfg = authConfig();
  if (!cfg.ok) return undefined;
  return readCookie(cookieHeader, sessionCookieName(cfg.config.secureCookies));
}

/** Route handlers: resolve the actor from a plain Request. */
export function requireApiActor(req: Request, opts: GuardOptions): GuardResult {
  const mode = runtimeMode();
  if (mode === "locked") return fail("locked", 401, "AUTH_REQUIRED", "not_configured");
  return resolveViewer(
    {
      sessionCookie: mode === "secured" ? sessionCookieFromHeader(req.headers.get("cookie")) : undefined,
      demoActorId: mode === "demo" ? actorIdFromRequest(req) : "",
      actorHeader: req.headers.get("x-hlos-actor"),
    },
    opts,
  );
}

/** JSON response for a guard failure: { ok: false, error: { code, message, details: { reason } } }, never any data. */
export function guardFailureResponse(f: GuardFail, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  return Response.json(
    { ok: false, error: { code: f.code, message: f.message, details: { reason: f.reason, ...(f.session ? { session: f.session } : {}) } } },
    { status: f.status, headers },
  );
}

/**
 * Where a page sends a failed guard. `returnTo` is re-validated here (only a
 * same-origin application path survives).
 */
export function redirectTargetFor(f: GuardFail, returnTo: string): string {
  const back = safeReturnTo(returnTo);
  const q = (extra?: Record<string, string>) => {
    const p = new URLSearchParams({ returnTo: back, ...(extra ?? {}) });
    return p.toString();
  };
  switch (f.code) {
    case "AUTH_REQUIRED":
      return "/locked";
    case "SESSION_EXPIRED":
      return `/signin?${q({ reason: "expired" })}`;
    case "SESSION_LOCKED":
      return `/signin?${q({ reason: "locked" })}`;
    case "FORBIDDEN":
      return f.reason === "view_denied" ? "/forbidden" : `/no-access?${new URLSearchParams({ reason: f.reason }).toString()}`;
    default:
      return `/signin?${q()}`;
  }
}

async function pageInput(): Promise<{ input: GuardInput; returnTo: string; prefetch: boolean; background: boolean }> {
  const mode = runtimeMode();
  const h = await headers();
  let sessionCookie: string | undefined;
  if (mode === "secured") {
    const cfg = authConfig();
    if (cfg.ok) sessionCookie = (await cookies()).get(sessionCookieName(cfg.config.secureCookies))?.value;
  }
  return {
    input: { sessionCookie, demoActorId: mode === "demo" ? await getActorId() : "", actorHeader: null },
    returnTo: safeReturnTo(h.get("x-hlos-path")),
    // A Next.js prefetch is not the person doing anything: it never counts as activity.
    prefetch: h.get("next-router-prefetch") === "1" || h.get("purpose") === "prefetch",
    // Pages: only a full document load counts as activity. Next.js hides its own RSC headers from headers(), so the
    // browser's Fetch Metadata decides: a page rendered for fetch() (Sec-Fetch-Dest "empty": a background
    // router.refresh() from LiveRefresh, a client-side navigation or a prefetch) is not activity; the click behind
    // a navigation is already reported by the client (POST /api/auth/activity after real input).
    background: (h.get("sec-fetch-dest") ?? "document") !== "document",
  };
}

/** Pages, layouts, server actions: the guard result without redirecting. */
export async function currentViewer(opts: Pick<GuardOptions, "touch" | "view">): Promise<GuardResult> {
  if (runtimeMode() === "locked") return fail("locked", 401, "AUTH_REQUIRED", "not_configured");
  const { input, prefetch } = await pageInput();
  return resolveViewer(input, { touch: opts.touch && !prefetch, view: opts.view });
}

/**
 * Pages: the signed-in actor (demo: the demo role) or a redirect. Use
 * requireView when the page shows lab data (every bench page does).
 */
export async function requireActor(): Promise<Actor> {
  if (runtimeMode() === "locked") redirect("/locked");
  const { input, returnTo, prefetch, background } = await pageInput();
  const r = resolveViewer(input, { touch: !prefetch && !background });
  if (!r.ok) redirect(redirectTargetFor(r, returnTo));
  return r.actor;
}

/** Pages: the signed-in actor holding `view`, or a redirect (sign-in, locked, no access, 403). */
export async function requireView(view: ViewPermission): Promise<Actor> {
  if (runtimeMode() === "locked") redirect("/locked");
  const { input, returnTo, prefetch, background } = await pageInput();
  const r = resolveViewer(input, { touch: !prefetch && !background, view });
  if (!r.ok) redirect(redirectTargetFor(r, returnTo));
  return r.actor;
}

/**
 * Same-origin check for state-changing routes in secured mode: the Origin
 * header must be HLOS_PUBLIC_URL's origin, or, without Origin, Sec-Fetch-Site
 * must be "same-origin". A request with neither is refused (fail closed).
 * Returns a 403 Response, or null to proceed. In demo mode it is the light
 * demo check (src/server/session.ts rejectCrossOrigin); locked mode refuses.
 */
export function requireSameOrigin(req: Request): Response | null {
  const mode = runtimeMode();
  const refuse = () =>
    Response.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Cross-origin requests are refused. Nothing was recorded." } },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  if (mode !== "secured") return null; // demo: rejectCrossOrigin (unchanged); locked: the guard answers 401 first
  const cfg = authConfig();
  if (!cfg.ok) return refuse();
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === cfg.config.publicOrigin ? null : refuse();
  return req.headers.get("sec-fetch-site") === "same-origin" ? null : refuse();
}
