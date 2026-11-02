import { getDb } from "@/server/db/db";
import { requireView } from "@/server/auth/guard";
import { intakeBench } from "@/server/queries/intake";
import { IntakeWorkstation } from "@/components/intake/workstation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Intake" };

/**
 * /intake: the intake workstation. ?item=<INT display id> opens an item.
 * The read model computes the plan for this item and this person (finding,
 * hold scope, five steps, next step, waiting on, accession reason).
 */
export default async function IntakePage({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  // The one guard: signed in (or the demo role), with this screen's view permission, before any data is read.
  const actor = await requireView("view.intake");
  const sp = await searchParams;
  const item = typeof sp.item === "string" && sp.item.trim() ? sp.item.trim().slice(0, 40) : null;
  const bench = intakeBench(getDb(), actor, { item });
  return <IntakeWorkstation bench={bench} />;
}
