import "@/server/commands"; // registers every command
import { executeCommand } from "@/server/commands/registry";
import { httpStatusFor } from "@/server/core/errors";
import { getDb } from "@/server/db/db";
import { isDemoMode, LOCKED_MESSAGE } from "@/server/runtime-mode";
import { actorIdFromRequest, correlationIdFor, rejectCrossOrigin } from "@/server/session";

/**
 * POST /api/commands/<name>  body: { input, idempotencyKey }
 * Single HTTP entry point for every state change. Outside synthetic demo mode
 * it refuses every request (401 AUTH_REQUIRED): there is no identity provider.
 * In demo mode the acting staff member comes from the demo role cookie (see
 * src/server/session.ts); permissions, validation, transactions and scoped
 * idempotency are handled by executeCommand. Each request gets one
 * correlation id (X-Correlation-Id) that is written to its audit events.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  if (!isDemoMode()) {
    return Response.json({ ok: false, error: { code: "AUTH_REQUIRED", message: LOCKED_MESSAGE } }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const { name } = await ctx.params;

  let body: { input?: unknown; idempotencyKey?: unknown } = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "Request body must be JSON: { input, idempotencyKey }." } },
      { status: 400 },
    );
  }

  // A malformed key is refused by executeCommand (never truncated into a different key).
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey : undefined;
  const correlationId = correlationIdFor(req);

  const result = executeCommand(getDb(), actorIdFromRequest(req), name, body.input ?? {}, { idempotencyKey, correlationId });
  const status = result.ok ? 200 : (httpStatusFor[result.error.code] ?? 400);
  return Response.json(result, { status, headers: { "Cache-Control": "no-store", "X-Correlation-Id": correlationId } });
}
