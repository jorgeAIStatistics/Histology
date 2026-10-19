import { getDb } from "@/server/db/db";
import { runtimeMode } from "@/server/runtime-mode";
import { rejectCrossOrigin } from "@/server/session";
import { guardFailureResponse, requireApiActor, requireSameOrigin } from "@/server/auth/guard";
import { exportWorklistCsv } from "./export-csv";

/**
 * POST /api/worklist/export  body: { view, filters, expectedSeq?, idempotencyKey? }
 * CSV downtime/transition fallback. Records a worklist snapshot through the
 * command layer (worklist.snapshot, audited) and returns the CSV for that same
 * version. Header lines: generation time (ET, full), worklist version, source
 * data age and "Synthetic demo data". The file is not updated after download.
 *
 * Goes through the one guard with the view.worklist permission: demo -> the
 * demo role (as before); secured -> same-origin, the signed-in session, the
 * X-HLOS-Actor header (as for commands) and a user-driven activity touch;
 * locked -> 401 with no data.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const blocked = runtimeMode() === "secured" ? requireSameOrigin(req) : rejectCrossOrigin(req);
  if (blocked) return blocked;
  const g = requireApiActor(req, { touch: true, view: "view.worklist", checkActorHeader: true });
  if (!g.ok) return guardFailureResponse(g);

  let body: { view?: unknown; filters?: unknown; expectedSeq?: unknown; idempotencyKey?: unknown } = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    return Response.json({ ok: false, error: { code: "VALIDATION", message: "Request body must be JSON: { view, filters, expectedSeq }." } }, { status: 400 });
  }

  const out = exportWorklistCsv(getDb(), g.actor.id, body, { auth: g.auth });
  if (!out.ok) return Response.json({ ok: false, error: out.error }, { status: out.status, headers: { "Cache-Control": "no-store" } });
  return new Response("﻿" + out.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
