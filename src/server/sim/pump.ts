import type { DB } from "@/server/db/db";

/**
 * Placeholder — replaced by the integration slice.
 * Called by GET /api/live before it computes the live payload, so simulated
 * source events can be delivered as the demo clock moves.
 */
export function pumpSources(db: DB): { delivered: number } {
  void db;
  return { delivered: 0 };
}
