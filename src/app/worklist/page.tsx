import { getDb } from "@/server/db/db";
import { getActor } from "@/server/session";
import { getWorklist, listSavedFilters } from "@/server/queries/worklist";
import { WorklistScreen } from "@/components/worklist/worklist-screen";
import { filtersFromSearchParams, isWorklistView, type WorklistFilters, type WorklistView } from "@/components/worklist/views";
import type { Role } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Worklist" };

/** Default view per demo role (spec §5.1 landing table). */
function defaultView(role: Role): { view: WorklistView; filters: WorklistFilters } {
  switch (role) {
    case "accessioner":
    case "accessioning_lead":
      return { view: "accessioning", filters: {} };
    case "grosser":
      return { view: "grossing", filters: {} };
    case "histology_assistant":
      return { view: "grossing", filters: { queue: "source_entry" } };
    case "histotech":
      return { view: "histotech", filters: {} };
    default:
      return { view: "operations", filters: {} };
  }
}

export default async function WorklistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const actor = await getActor();
  const rawView = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const fallback = defaultView(actor.role);
  const view = isWorklistView(rawView) ? rawView : fallback.view;
  const hasParams = Object.keys(sp).some((k) => k !== "selected");
  const filters = hasParams ? filtersFromSearchParams(sp) : fallback.filters;
  const selected = (Array.isArray(sp.selected) ? sp.selected[0] : sp.selected) ?? null;

  const db = getDb();
  const data = getWorklist(db, { staffId: actor.id, view, filters });
  const saved = listSavedFilters(db, actor.id, view);
  return <WorklistScreen data={data} saved={saved} selectedId={selected} actor={{ id: actor.id, name: actor.name, role: actor.role }} />;
}
