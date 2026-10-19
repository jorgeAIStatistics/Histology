import fs from "node:fs";
import path from "node:path";
import { log } from "@/server/core/log";
import { closeSharedDb, databasePath, getDb } from "@/server/db/db";
import { readClock, setClockRunning } from "@/server/core/clock";
import { isDemoMode } from "@/server/runtime-mode";
import { rejectCrossOrigin } from "@/server/session";

/**
 * POST /api/demo/reset  body: { confirm: true }
 *
 * DEMO ONLY. Replaces the local synthetic database with a freshly seeded demo
 * day (clock back to 10:52 ET, paused: spec §9 "the demo clock only moves when
 * the presenter moves it"; step runs and the clock controls move it forward,
 * Resume lets it run at normal speed). This is not a command because it replaces the
 * whole database (including the audit log) rather than changing records. It
 * requires an explicit confirm flag so a stray request cannot wipe a demo.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;
  // Presenter-only: does not exist outside synthetic demo mode.
  if (!isDemoMode()) return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });

  let body: { confirm?: unknown } = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    return Response.json({ ok: false, error: { code: "VALIDATION", message: "Request body must be JSON: { confirm: true }." } }, { status: 400 });
  }
  if (body.confirm !== true) {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "Reset not performed: send { confirm: true } to replace all demo data with the 10:52 starting state." } },
      { status: 400 },
    );
  }

  const file = databasePath();
  try {
    closeSharedDb();
    if (file !== ":memory:") {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        try {
          fs.rmSync(f, { force: true });
        } catch (e) {
          log("error", "demo_reset.remove_failed", { file: path.basename(f), error: e });
        }
      }
    }
    const db = getDb(); // reopens and reseeds the synthetic demo day
    setClockRunning(db, false); // nothing ages or arrives while the presenter is talking
    const clock = readClock(db);
    const cases = (db.prepare("SELECT COUNT(*) n FROM accession WHERE is_prior_day = 0").get() as { n: number }).n;
    return Response.json(
      { ok: true, result: { clock: { now: clock.now, running: clock.running }, cases, message: "Back to the 10:52 ET starting state (synthetic). The demo clock is paused until you move it." } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // The error goes to the server log (name, code, scrubbed message); the response never echoes it.
    log("error", "demo_reset.failed", { error: e });
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "Reset failed on the server. Restart the demo server if the problem continues." } },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
