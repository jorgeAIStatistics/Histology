import { getDb } from "@/server/db/db";
import { getActor } from "@/server/session";
import { intakeBench, type ItemDetail } from "@/server/queries/intake";
import { conceptMono, conceptSans } from "./fonts";
import { Workstation } from "./workstation";
import styles from "./intake-a.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Intake concept A" };

/**
 * Concept A, "Precision workstation": a read-only preview of the populated
 * Intake screen. It reads the real fixture through intakeBench() and never
 * runs a command. ?item=<INT id> selects the item (default INT-1014-032).
 */
export default async function IntakeConceptA({ searchParams }: { searchParams: Promise<{ item?: string }> }) {
  const sp = await searchParams;
  const item = typeof sp.item === "string" && sp.item.trim() ? sp.item.trim().slice(0, 40) : "INT-1014-032";
  const actor = await getActor();
  const db = getDb();
  const bench = intakeBench(db, actor, { item });

  // Possibly related items are shown beside this one as context (never merged).
  const siblings: ItemDetail[] = [];
  for (const rel of bench.selected?.related ?? []) {
    for (const other of rel.otherItems) {
      if (siblings.some((s) => s.id === other.id)) continue;
      const detail = intakeBench(db, actor, { item: other.displayId }).selected;
      if (detail) siblings.push(detail);
    }
  }

  return (
    <div className={`${styles.root} ${conceptSans.variable} ${conceptMono.variable}`}>
      <Workstation bench={bench} siblings={siblings} />
    </div>
  );
}
