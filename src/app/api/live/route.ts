import { getDb } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { pumpSources } from "@/server/sim/pump";
import { loadLiveSnapshot } from "@/components/shell/server-data";
import { guardFailureResponse, requireApiActor } from "@/server/auth/guard";
import { hasBenchView } from "@/lib/roles";
import { log } from "@/server/core/log";

/**
 * GET /api/live — polled every 2.5 s by <LiveRefresh>. Reports the change
 * counters (so the client knows when to refresh), the demo clock and source
 * freshness.
 *
 * - demo: lets the simulated sources deliver anything due at the current demo
 *   time first (the simulators run only in synthetic demo mode).
 * - secured: needs a signed-in, UNLOCKED session, and never counts as
 *   activity (touch: false), so polling cannot keep an idle workstation open.
 *   Nothing is written from this GET.
 * - a role with no bench screen (lab_admin, auditor): 403 with no data.
 * - locked: 401 with no data.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = requireApiActor(req, { touch: false });
  if (!g.ok) return guardFailureResponse(g);
  // Lab counters, clock and source health are bench data: a role with no bench screen gets none (403).
  if (!hasBenchView(g.actor.role)) {
    return guardFailureResponse({ ok: false, mode: g.mode, status: 403, code: "FORBIDDEN", reason: "view_denied", message: "Not allowed: this role has no bench screen. Nothing was shown." });
  }
  const db = getDb();
  let delivered = 0;
  if (g.mode === "demo") {
    try {
      delivered = pumpSources(db).delivered;
    } catch (e) {
      log("error", "live.pump_failed", { error: e });
    }
  }
  const snapshot = loadLiveSnapshot(db, readClock(db));
  return Response.json({ ...snapshot, delivered }, { headers: { "Cache-Control": "no-store" } });
}
