import { getDb } from "@/server/db/db";
import { getActor } from "@/server/session";
import { intakeBench, type Lane } from "@/server/queries/intake";
import { IntakeBenchView } from "@/components/intake/intake-bench";

export const dynamic = "force-dynamic";
export const metadata = { title: "Intake" };

const LANES: Lane[] = ["to_review", "exceptions", "done"];

/**
 * /intake — arrival, reconciliation and routing bench (design spec §6.1).
 * ?item=<INT display id> selects an item; ?lane=to_review|exceptions|done picks the queue tab.
 */
export default async function IntakePage({ searchParams }: { searchParams: Promise<{ item?: string; lane?: string }> }) {
  const sp = await searchParams;
  const actor = await getActor();
  const db = getDb();
  const item = typeof sp.item === "string" && sp.item.trim() ? sp.item.trim().slice(0, 40) : null;
  const bench = intakeBench(db, actor, { item });
  const requested = LANES.includes(sp.lane as Lane) ? (sp.lane as Lane) : null;
  const lane: Lane = requested ?? bench.selected?.lane ?? (bench.counts.to_review > 0 || bench.counts.exceptions === 0 ? "to_review" : "exceptions");
  return <IntakeBenchView bench={bench} initialLane={lane} />;
}
