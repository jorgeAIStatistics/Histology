import { getDb } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { pumpSources } from "@/server/sim/pump";
import { loadLiveSnapshot } from "@/components/shell/server-data";

/**
 * GET /api/live — polled every 2.5 s by <LiveRefresh>. Lets the simulated
 * sources deliver anything due at the current demo time, then reports the
 * change counters (so the client knows when to refresh), the demo clock and
 * source freshness.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  let delivered = 0;
  try {
    delivered = pumpSources(db).delivered;
  } catch (e) {
    console.error("[live] pumpSources failed", e);
  }
  const snapshot = loadLiveSnapshot(db, readClock(db));
  return Response.json({ ...snapshot, delivered }, { headers: { "Cache-Control": "no-store" } });
}
