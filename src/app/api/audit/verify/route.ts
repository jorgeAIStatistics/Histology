import { getDb } from "@/server/db/db";
import { runtimeMode } from "@/server/runtime-mode";
import { correlationIdFor, rejectCrossOrigin } from "@/server/session";
import { guardFailureResponse, requireApiActor, requireSameOrigin } from "@/server/auth/guard";
import { makeCtx } from "@/server/core/context";
import { audit } from "@/server/core/audit";
import { activeAuditKey, auditReport, sessionRefFor } from "@/server/core/audit-seal";
import { log } from "@/server/core/log";

/**
 * POST /api/audit/verify  body: {} (none needed)
 *
 * Recomputes the audit trail's HMAC chain (src/server/core/audit-seal.ts),
 * compares it with the anchors in HLOS_AUDIT_ANCHOR_PATH when that is set, and
 * returns the result with a downloadable evidence object (seq ranges, MACs,
 * the key id; no audit event content).
 *
 * Goes through the one guard with the view.audit permission (laboratory
 * administrator and auditor): secured -> same-origin, the signed-in session,
 * X-HLOS-Actor (as for commands) and a user-driven activity touch; demo ->
 * the demo role (no demo role holds view.audit, so 403); locked -> 401.
 *
 * Each run is recorded as one audit event (audit.verified: who ran it and the
 * outcome, sealed like every other event). The run itself is read-only.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: Request) {
  const blocked = runtimeMode() === "secured" ? requireSameOrigin(req) : rejectCrossOrigin(req);
  if (blocked) return blocked;
  const g = requireApiActor(req, { touch: true, view: "view.audit", checkActorHeader: true });
  if (!g.ok) return guardFailureResponse(g);

  const key = activeAuditKey();
  if (!key) {
    return Response.json(
      { ok: false, error: { code: "BLOCKED", message: "No audit key is configured (HLOS_AUDIT_KEY), so the chain cannot be verified." } },
      { status: 503, headers: NO_STORE },
    );
  }
  const correlationId = correlationIdFor(req);
  const db = getDb();
  try {
    const report = auditReport(db, key);
    const v = report.verification;
    const ctx = makeCtx(db, g.actor, "user", correlationId);
    ctx.permission = "view.audit";
    ctx.sessionRef = g.auth ? sessionRefFor(g.auth.sessionIdHash, key) : null;
    audit(ctx, {
      action: "audit.verified",
      entityType: "audit_chain",
      entityId: v.lab,
      summary: report.ok
        ? `Audit chain verified by ${g.actor.name}: intact through seq ${v.sealedThrough} (${v.anchorsChecked} anchor${v.anchorsChecked === 1 ? "" : "s"} checked)`
        : `Audit chain verified by ${g.actor.name}: ${v.firstProblem ? `${v.firstProblem.kind} at seq ${v.firstProblem.seq}` : "the anchor file could not be used"}`,
      after: {
        ok: report.ok,
        checked: v.checked,
        sealedThrough: v.sealedThrough,
        keyId: v.keyId,
        anchorsChecked: v.anchorsChecked,
        firstProblem: v.firstProblem ? { seq: v.firstProblem.seq, kind: v.firstProblem.kind } : null,
        anchorFileError: report.anchorFile.error !== null,
      },
    });
    return Response.json({ ok: true, result: report }, { headers: { ...NO_STORE, "X-Correlation-Id": correlationId } });
  } catch (e) {
    log("error", "audit_verify.failed", { correlationId, error: e });
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "Verification could not run. Nothing was changed; try again." } },
      { status: 500, headers: { ...NO_STORE, "X-Correlation-Id": correlationId } },
    );
  }
}
