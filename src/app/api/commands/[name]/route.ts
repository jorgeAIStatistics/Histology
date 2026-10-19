import "@/server/commands"; // registers every command
import { commandAudience, executeCommand } from "@/server/commands/registry";
import { httpStatusFor } from "@/server/core/errors";
import { getDb } from "@/server/db/db";
import { LOCKED_MESSAGE, runtimeMode } from "@/server/runtime-mode";
import { actorIdFromRequest, correlationIdFor, rejectCrossOrigin } from "@/server/session";
import { guardFailureResponse, requireApiActor, requireSameOrigin } from "@/server/auth/guard";
import { withRequestLog, type RequestLogScope } from "@/server/ops/request-log";

/**
 * POST /api/commands/<name>  body: { input, idempotencyKey }
 * Single HTTP entry point for every state change.
 *
 * - demo: the acting staff member comes from the demo role cookie (see
 *   src/server/session.ts), exactly as before.
 * - secured: same-origin only; the acting staff member comes ONLY from the
 *   signed-in session (the demo cookie is ignored). The request must carry
 *   `X-HLOS-Actor: <staff id the page was rendered for>`; any other value, or
 *   none, is 409 ACTOR_MISMATCH and nothing is recorded. An expired session
 *   is 401 SESSION_EXPIRED, a locked one 401 SESSION_LOCKED, no session 401
 *   SIGN_IN_REQUIRED; a sensitive command with a stale sign-in is 401
 *   REAUTH_REQUIRED. A command counts as activity.
 * - locked: every request is refused (401 AUTH_REQUIRED).
 *
 * Permissions, validation, transactions and scoped idempotency (owned by the
 * acting staff member) are handled by executeCommand. Each request gets one
 * correlation id (X-Correlation-Id) that is written to its audit events.
 *
 * Every request writes one structured `http.request` log line (src/server/ops/request-log.ts): method, the route
 * template, status, duration, correlation id, the acting staff id (never a name), the command name when it is a
 * registered command, and the error code. Never the input.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function readBody(req: Request): Promise<{ ok: true; body: { input?: unknown; idempotencyKey?: unknown } } | { ok: false; response: Response }> {
  try {
    const text = await req.text();
    return { ok: true, body: text ? (JSON.parse(text) as { input?: unknown; idempotencyKey?: unknown }) : {} };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: { code: "VALIDATION", message: "Request body must be JSON: { input, idempotencyKey }." } },
        { status: 400, headers: NO_STORE },
      ),
    };
  }
}

type Ctx = { params: Promise<{ name: string }> };

export const POST = withRequestLog("/api/commands/[name]", (req: Request, scope: RequestLogScope, ctx: Ctx) => post(req, scope, ctx));

/** The command name for the log line: a registered command, else "unknown" (never an arbitrary path segment). */
function logName(name: string): string {
  return commandAudience(name) ? name : "unknown";
}

async function post(req: Request, scope: RequestLogScope, ctx: Ctx) {
  const mode = runtimeMode();
  if (mode === "secured") return securedPost(req, scope, ctx);

  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  if (mode !== "demo") {
    return Response.json({ ok: false, error: { code: "AUTH_REQUIRED", message: LOCKED_MESSAGE } }, { status: 401, headers: NO_STORE });
  }

  const { name } = await ctx.params;
  scope.command = logName(name);
  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // A malformed key is refused by executeCommand (never truncated into a different key).
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey : undefined;
  const correlationId = correlationIdFor(req);

  const actorId = actorIdFromRequest(req);
  scope.actorId = actorId;
  const result = executeCommand(getDb(), actorId, name, body.input ?? {}, { idempotencyKey, correlationId });
  if (!result.ok) scope.code = result.error.code;
  const status = result.ok ? 200 : (httpStatusFor[result.error.code] ?? 400);
  return Response.json(result, { status, headers: { ...NO_STORE, "X-Correlation-Id": correlationId } });
}

async function securedPost(req: Request, scope: RequestLogScope, ctx: Ctx) {
  const crossOrigin = requireSameOrigin(req);
  if (crossOrigin) return crossOrigin;
  // The session decides who acts; the page's actor header must match it before anything is touched or recorded.
  const g = requireApiActor(req, { touch: true, checkActorHeader: true });
  if (!g.ok) return guardFailureResponse(g);
  scope.actorId = g.actor.id;

  const { name } = await ctx.params;
  scope.command = logName(name);
  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey : undefined;
  const correlationId = correlationIdFor(req);

  const result = executeCommand(getDb(), g.actor.id, name, body.input ?? {}, { idempotencyKey, correlationId, auth: g.auth });
  if (!result.ok) scope.code = result.error.code;
  const status = result.ok ? 200 : (httpStatusFor[result.error.code] ?? 400);
  return Response.json(result, { status, headers: { ...NO_STORE, "X-Correlation-Id": correlationId } });
}
