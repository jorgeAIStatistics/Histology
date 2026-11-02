import { getDb } from "@/server/db/db";
import { requireView } from "@/server/auth/guard";
import { requirePresenterSurface } from "@/app/demo/gate";
import { intakeBench, type ItemDetail } from "@/server/queries/intake";
import { buildDesk, STEP_KEYS, type StepKey } from "./model";
import { Desk } from "./desk";
import { deskMono, deskSans } from "./fonts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Intake concept C" };

/**
 * /concepts/intake-c — Concept C, "Guided reconciliation desk".
 * A design preview over the real fixture: it reads intakeBench() and never
 * runs a command. ?item=<INT id> (default INT-1014-032), ?step=1..5 or a step key.
 */
export default async function ConceptC({ searchParams }: { searchParams: Promise<{ item?: string; step?: string }> }) {
  // The one guard, then the design-preview gate (synthetic demo only, also enforced by src/proxy.ts).
  const actor = await requireView("view.intake");
  requirePresenterSurface();
  const sp = await searchParams;
  const itemId = typeof sp.item === "string" && sp.item.trim() ? sp.item.trim().slice(0, 40) : "INT-1014-032";
  const db = getDb();
  const bench = intakeBench(db, actor, { item: itemId });

  // The other side of each related-order candidate (e.g. Part A for Part B), read through the same read model.
  const siblings: ItemDetail[] = [];
  const seen = new Set<string>();
  for (const rel of bench.selected?.related ?? []) {
    for (const other of rel.otherItems) {
      if (seen.has(other.displayId) || siblings.length >= 3) continue;
      seen.add(other.displayId);
      const s = intakeBench(db, actor, { item: other.displayId }).selected;
      if (s) siblings.push(s);
    }
  }

  const raw = typeof sp.step === "string" ? sp.step.trim().toLowerCase() : "";
  const step: StepKey | null = /^[1-5]$/.test(raw) ? STEP_KEYS[Number(raw) - 1] : (STEP_KEYS as string[]).includes(raw) ? (raw as StepKey) : null;

  return (
    <div className={`${deskSans.variable} ${deskMono.variable}`}>
      <Desk key={`${bench.selected?.id ?? "none"}-${step ?? "auto"}`} model={buildDesk(bench, siblings)} initialStep={step} />
    </div>
  );
}
