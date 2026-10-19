import "@/server/commands"; // registers every command
import { executeCommand } from "@/server/commands/registry";
import { httpStatusFor } from "@/server/core/errors";
import { getDb } from "@/server/db/db";
import { LOCKED_MESSAGE, runtimeMode } from "@/server/runtime-mode";
import { actorIdFromRequest, correlationIdFor, rejectCrossOrigin } from "@/server/session";
import { guardFailureResponse, requireApiActor, requireSameOrigin } from "@/server/auth/guard";

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

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const mode = runtimeMode();
  if (mode === "secured") return securedPost(req, ctx);

  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  if (mode !== "demo") {
    return Response.json({ ok: false, error: { code: "AUTH_REQUIRED", message: LOCKED_MESSAGE } }, { status: 401, headers: NO_STORE });
  }

  const { name } = await ctx.params;
  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // A malformed key is refused by executeCommand (never truncated into a different key).
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey : undefined;
  const correlationId = correlationIdFor(req);

  const result = executeCommand(getDb(), actorIdFromRequest(req), name, body.input ?? {}, { idempotencyKey, correlationId });
  const status = result.ok ? 200 : (httpStatusFor[result.error.code] ?? 400);
  return Response.json(result, { status, headers: { ...NO_STORE, "X-Correlation-Id": correlationId } });
}

async function securedPost(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const crossOrigin = requireSameOrigin(req);
  if (crossOrigin) return crossOrigin;
  // The session decides who acts; the page's actor header must match it before anything is touched or recorded.
  const g = requireApiActor(req, { touch: true, checkActorHeader: true });
  if (!g.ok) return guardFailureResponse(g);

  const { name } = await ctx.params;
  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey : undefined;
  const correlationId = correlationIdFor(req);

  const result = executeCommand(getDb(), g.actor.id, name, body.input ?? {}, { idempotencyKey, correlationId, auth: g.auth });
  const status = result.ok ? 200 : (httpStatusFor[result.error.code] ?? 400);
  return Response.json(result, { status, headers: { ...NO_STORE, "X-Correlation-Id": correlationId } });
}
