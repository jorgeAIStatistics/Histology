import { computeHealth, httpStatusForHealth } from "@/server/ops/health";
import { withRequestLog } from "@/server/ops/request-log";

/**
 * GET /api/health — for a load balancer or uptime monitor. NO authentication, so it answers ONLY
 * { status: "healthy" | "degraded" | "unavailable", time }: no check, no detail, no version, no count.
 *
 * HTTP 200 for healthy and degraded (the application still serves requests), 503 for unavailable (a locked build,
 * or a database that cannot be read or written). The rules and every check are in src/server/ops/health.ts and
 * docs/release/operations-runbook.md; the checks themselves are at GET /api/health/details (authorized).
 *
 * Cheap: a few small queries and a rolled-back write probe. The audit chain is never verified inside the request;
 * at most one background verification runs per HLOS_HEALTH_AUDIT_VERIFY_MINUTES (default 15).
 * One structured `http.request` log line per request.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRequestLog("/api/health", () => {
  const h = computeHealth({ scheduleAudit: true });
  return Response.json({ status: h.status, time: h.time }, { status: httpStatusForHealth(h.status), headers: { "Cache-Control": "no-store" } });
});
