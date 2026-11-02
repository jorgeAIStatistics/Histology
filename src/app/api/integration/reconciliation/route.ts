import { getDb } from "@/server/db/db";
import { guardFailureResponse, requireApiActor } from "@/server/auth/guard";
import { loadReconciliation } from "@/server/integration/reconciliation";
import { log } from "@/server/core/log";

/**
 * GET /api/integration/reconciliation[?all=1] — the source-versus-local reconciliation read model
 * (src/server/integration/reconciliation.ts). Clinical data: it goes through the one guard with the clinical
 * view permission view.operations (demo role, or a signed-in unlocked session in secured mode; locked → 401;
 * a role without the view, such as the laboratory administrator or the auditor → 403). Reads only; never
 * counts as activity (it may be polled). `all=1` also returns the comparisons that agree.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request): Promise<Response> {
  const g = requireApiActor(req, { touch: false, view: "view.operations" });
  if (!g.ok) return guardFailureResponse(g);
  try {
    const includeInSync = new URL(req.url).searchParams.get("all") === "1";
    return Response.json({ ok: true, result: loadReconciliation(getDb(), { includeInSync }) }, { headers: NO_STORE });
  } catch (e) {
    log("error", "integration.reconciliation_failed", { error: e });
    return Response.json({ ok: false, error: { code: "INTERNAL", message: "The reconciliation view could not be built." } }, { status: 500, headers: NO_STORE });
  }
}
