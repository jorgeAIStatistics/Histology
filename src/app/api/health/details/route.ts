import { guardFailureResponse, requireApiActor } from "@/server/auth/guard";
import { log } from "@/server/core/log";
import { runtimeMode } from "@/server/runtime-mode";
import { computeHealth, httpStatusForHealth } from "@/server/ops/health";
import { withRequestLog } from "@/server/ops/request-log";

/**
 * GET /api/health/details — every health check: { status, time, mode, checks: { <name>: { status, detail,
 * measured_at, … } }, rules }. See src/server/ops/health.ts for the checks and the rules.
 *
 * Who: secured mode -> a signed-in, unlocked session holding view.audit (the laboratory administrator and the
 * auditor; never a bench role); demo mode -> any demo role; locked -> 401. Through the one guard; reading it is
 * not activity (it may be polled). No patient data, credentials, cookies, tokens, keys or file paths in the answer.
 * HTTP 200, or 503 when the status is unavailable. One structured `http.request` log line per request.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export const GET = withRequestLog("/api/health/details", (req, scope) => {
  let g: ReturnType<typeof requireApiActor>;
  try {
    g = requireApiActor(req, runtimeMode() === "secured" ? { touch: false, view: "view.audit" } : { touch: false });
  } catch (e) {
    // The guard needs the database: when it cannot be opened nobody can be authorized, and nothing else is said.
    log("error", "health.details_guard_failed", { correlationId: scope.correlationId, error: e });
    return Response.json({ status: "unavailable", time: new Date().toISOString() }, { status: 503, headers: NO_STORE });
  }
  if (!g.ok) return guardFailureResponse(g);
  scope.actorId = g.actor.id;
  const h = computeHealth({ scheduleAudit: true });
  return Response.json(h, { status: httpStatusForHealth(h.status), headers: NO_STORE });
});
