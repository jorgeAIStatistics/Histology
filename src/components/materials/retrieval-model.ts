import type { RetrievalDetail, RetrievalItemView } from "@/server/queries/materials";

/**
 * The walk for a retrieval request, derived from the server's pick list:
 * the blocks still to pick in walking order (stop by stop, as the pick list
 * groups them), so the column's "Next" block is the first one in that list.
 * Pending blocks the pick list does not place (no known location) come last.
 * Pure and read only: picking, rejecting and delivering stay server commands.
 */
export function retrievalWalk(detail: Pick<RetrievalDetail, "items" | "pickList">): { next: RetrievalItemView | null; toPick: RetrievalItemView[] } {
  const byId = new Map(detail.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const toPick: RetrievalItemView[] = [];
  for (const group of detail.pickList) {
    for (const entry of group.items) {
      const item = byId.get(entry.itemId);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      if (item.status === "pending") toPick.push(item);
    }
  }
  for (const item of detail.items) if (!seen.has(item.id) && item.status === "pending") toPick.push(item);
  return { next: toPick[0] ?? null, toPick };
}
