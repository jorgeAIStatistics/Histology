import { getDb } from "@/server/db/db";
import { getActor, rejectCrossOrigin } from "@/server/session";
import { exportWorklistCsv } from "./export-csv";

/**
 * POST /api/worklist/export  body: { view, filters, expectedSeq?, idempotencyKey? }
 * CSV downtime/transition fallback. Records a worklist snapshot through the
 * command layer (worklist.snapshot, audited) and returns the CSV for that same
 * version. Header lines: generation time (ET, full), worklist version, source
 * data age and "Synthetic demo data". The file is not updated after download.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

  let body: { view?: unknown; filters?: unknown; expectedSeq?: unknown; idempotencyKey?: unknown } = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    return Response.json({ ok: false, error: { code: "VALIDATION", message: "Request body must be JSON: { view, filters, expectedSeq }." } }, { status: 400 });
  }

  const actor = await getActor();
  const out = exportWorklistCsv(getDb(), actor.id, body);
  if (!out.ok) return Response.json({ ok: false, error: out.error }, { status: out.status, headers: { "Cache-Control": "no-store" } });
  return new Response("﻿" + out.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
