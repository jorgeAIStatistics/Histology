import "@/server/commands"; // registers every command
import { executeCommand } from "@/server/commands/registry";
import { httpStatusFor } from "@/server/core/errors";
import { getDb } from "@/server/db/db";
import { getActorId, rejectCrossOrigin } from "@/server/session";


/**
 * POST /api/commands/<name>  body: { input, idempotencyKey }
 * Single HTTP entry point for every state change. The acting staff member
 * comes from the demo role cookie (see src/server/session.ts); permissions,
 * validation, transactions and idempotency are handled by executeCommand.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

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

  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey.slice(0, 200) : undefined;
  const actorId = await getActorId();

  const result = executeCommand(getDb(), actorId, name, body.input ?? {}, { idempotencyKey });
  const status = result.ok ? 200 : (httpStatusFor[result.error.code] ?? 400);
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
