/**
 * One structured log line per API request (Stage 6 Phase E4), through the redacting logger (src/server/core/log.ts):
 *
 *   {"ts":"…","level":"info","event":"http.request","correlationId":"req-…","method":"POST",
 *    "route":"/api/commands/[name]","status":200,"durationMs":12.3,"actorId":"stf_maya","command":"hold.place"}
 *
 * - `route` is the route TEMPLATE given by the route file, never the request URL: no path values beyond the
 *   template, no query string (sign-in codes, state, return paths never reach the log).
 * - `actorId` is a staff id (never a name), or null when the request has no resolved actor.
 * - The correlation id is the request's X-Request-Id when well formed; otherwise one is generated and set on the
 *   request before the handler runs, so the handler's audit events, its X-Correlation-Id header (where it sends
 *   one) and this line share it.
 * - The response is never changed (the integration endpoint's gated 404 must stay identical to an unknown path).
 * - Level: error for 5xx and for a thrown handler (logged with the error reduced by errorInfo, then rethrown),
 *   info otherwise.
 */
import { randomUUID } from "node:crypto";
import { log } from "../core/log";
import { getDb } from "../db/db";
import { runtimeMode } from "../runtime-mode";
import { sessionCookieFromHeader } from "../auth/guard";
import { peekSession } from "../auth/sessions";

/** What a handler may add to its line: ids and codes only (the logger redacts anything else by name). */
export interface RequestLogScope {
  correlationId: string;
  actorId: string | null;
  /** A registered command name (commands route). */
  command?: string;
  /** An error code from the response (VALIDATION, FORBIDDEN, …). */
  code?: string;
}

const GIVEN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Ensures the request carries a usable X-Request-Id; returns the request to pass on and the id. */
export function withCorrelationId(req: Request): { req: Request; correlationId: string } {
  const given = req.headers.get("x-request-id")?.trim();
  if (given && GIVEN_ID.test(given)) return { req, correlationId: given };
  const id = `req-${randomUUID()}`;
  try {
    req.headers.set("x-request-id", id);
    if (req.headers.get("x-request-id") === id) return { req, correlationId: id };
  } catch {
    /* immutable headers: copy the request below */
  }
  try {
    const headers = new Headers(req.headers);
    headers.set("x-request-id", id);
    return { req: new Request(req, { headers }), correlationId: id };
  } catch {
    return { req, correlationId: id };
  }
}

export interface RequestLogOptions {
  /** Resolves the actor id BEFORE the handler runs (for routes whose handler ends the session, such as sign-out). Must not throw. */
  actor?: (req: Request) => string | null;
}

/**
 * Wraps a route handler so that every request writes exactly one `http.request` line. The handler receives a
 * scope it may fill (actor id once resolved, command name, error code).
 */
export function withRequestLog<A extends unknown[]>(
  route: string,
  handler: (req: Request, scope: RequestLogScope, ...rest: A) => Promise<Response> | Response,
  opts: RequestLogOptions = {},
): (req: Request, ...rest: A) => Promise<Response> {
  return async (incoming: Request, ...rest: A): Promise<Response> => {
    const t0 = performance.now();
    const { req, correlationId } = withCorrelationId(incoming);
    const scope: RequestLogScope = { correlationId, actorId: null };
    if (opts.actor) {
      try {
        scope.actorId = opts.actor(req);
      } catch {
        scope.actorId = null;
      }
    }
    let status = 500;
    let thrown: unknown = undefined;
    try {
      const res = await handler(req, scope, ...rest);
      status = res.status;
      if (!scope.code && !res.ok) scope.code = (await errorCodeOf(res)) ?? undefined;
      return res;
    } catch (e) {
      thrown = e;
      throw e;
    } finally {
      const fields: Record<string, unknown> = {
        correlationId,
        method: SAFE_ID.test(req.method) ? req.method : "OTHER",
        route,
        status,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
        actorId: scope.actorId && SAFE_ID.test(scope.actorId) ? scope.actorId : null,
      };
      if (scope.command && SAFE_ID.test(scope.command)) fields.command = scope.command;
      if (scope.code && /^[A-Z][A-Z0-9_]{1,47}$/.test(scope.code)) fields.code = scope.code;
      if (thrown !== undefined) fields.error = thrown;
      log(status >= 500 || thrown !== undefined ? "error" : "info", "http.request", fields);
    }
  };
}

/**
 * Secured mode: the staff id of the session this request's cookie names, when that session exists and is not
 * revoked (read only: nothing is touched, locked or revoked). Null in every other case, and in demo or locked mode.
 * For the request line of the auth routes, resolved before the handler (sign-out revokes the session).
 */
export function sessionActorId(req: Request): string | null {
  try {
    if (runtimeMode() !== "secured") return null;
    const cookie = sessionCookieFromHeader(req.headers.get("cookie"));
    if (!cookie) return null;
    const row = peekSession(getDb(), cookie);
    return row && !row.revoked_at ? row.staff_id : null;
  } catch {
    return null;
  }
}

/** The error code of a JSON error response ({ error: { code } }), read from a clone (the response is untouched); null when there is none. */
export async function errorCodeOf(res: Response): Promise<string | null> {
  if (res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
