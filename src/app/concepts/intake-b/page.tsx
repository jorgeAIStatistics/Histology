import { getDb } from "@/server/db/db";
import { requireView } from "@/server/auth/guard";
import { requirePresenterSurface } from "@/app/demo/gate";
import { intakeBench, type ItemDetail } from "@/server/queries/intake";
import { atkMono, atkSans } from "./fonts";
import { AtlasScreen } from "./atlas-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Concept B: Specimen atlas (preview)" };

/**
 * /concepts/intake-b — design preview of the Intake bench as a specimen atlas.
 * Reads the real fixture through intakeBench (read-only). Interactions are
 * client-side previews; no command is called and nothing is saved.
 *   ?item=<INT id> (default INT-1014-032)   ?node=<tree node key> (optional initial selection)
 */
export default async function ConceptB({ searchParams }: { searchParams: Promise<{ item?: string; node?: string }> }) {
  // The one guard, then the design-preview gate (synthetic demo only, also enforced by src/proxy.ts).
  const actor = await requireView("view.intake");
  requirePresenterSurface();
  const sp = await searchParams;
  const db = getDb();
  const item = typeof sp.item === "string" && sp.item.trim() ? sp.item.trim().slice(0, 40) : "INT-1014-032";
  const bench = intakeBench(db, actor, { item });

  // The atlas draws the whole submission: intake items tied to this one by a
  // related-order candidate are read too (their own read model, unchanged).
  const siblings: ItemDetail[] = [];
  const seen = new Set<string>([bench.selected?.id ?? ""]);
  for (const r of bench.selected?.related ?? []) {
    for (const o of r.otherItems) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const other = intakeBench(db, actor, { item: o.displayId }).selected;
      if (other) siblings.push(other);
    }
  }

  const node = typeof sp.node === "string" ? sp.node.slice(0, 80) : null;
  return (
    <div className={`${atkSans.variable} ${atkMono.variable}`}>
      <AtlasScreen bench={bench} siblings={siblings} initialNode={node} />
    </div>
  );
}
