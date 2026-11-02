import { redirect } from "next/navigation";
import { getDb } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { requireView } from "@/server/auth/guard";
import { grossingQueue, partWorkspace, resolvePartRef, sourceEntryQueue } from "@/server/queries/grossing";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import { GrossingQueue } from "@/components/grossing/queue";
import { GrossingWorkspace } from "@/components/grossing/workspace";

export const metadata = { title: "Grossing" };
export const dynamic = "force-dynamic";

type Search = { part?: string; case?: string; view?: string };

/**
 * /grossing — reviewed gross record per part (design-spec §6.4).
 *   ?part=D26-04817-A   open that exact part (also "D26-04817 A")
 *   ?case=D26-04817     open the first part of the case that still needs grossing work
 *   ?view=source        Sam Ortiz's source-entry queue
 */
export default async function GrossingPage({ searchParams }: { searchParams: Promise<Search> }) {
  // The one guard: signed in (or the demo role), with this screen's view permission, before any data is read.
  const actor = await requireView("view.grossing");
  const sp = await searchParams;
  const isReadOnly = actor.role === "director" || actor.role === "medical_director";
  let lookupError: string | null = null;
  let loadError: string | null = null;

  const db = getDb();
  const now = readClock(db).now;

  const ref = sp.part ?? sp.case ?? null;
  if (ref) {
    const r = resolvePartRef(db, ref);
    if (r.ok) {
      if (sp.case && !sp.part) redirect(`/grossing?part=${encodeURIComponent(r.ref)}`);
      let ws: ReturnType<typeof partWorkspace> = null;
      try {
        ws = partWorkspace(db, r.partId);
      } catch (e) {
        console.error("[grossing] workspace failed", e);
      }
      if (ws) return <GrossingWorkspace key={`${ws.identity.partId}:${ws.record?.id ?? "none"}`} ws={ws} />;
      lookupError = `${r.ref} could not be loaded. Nothing was changed.`;
    } else {
      lookupError = r.reason;
    }
  }

  let rows: ReturnType<typeof grossingQueue> = [];
  let sourceRows: ReturnType<typeof sourceEntryQueue> = [];
  try {
    rows = grossingQueue(db);
    sourceRows = sourceEntryQueue(db);
  } catch (e) {
    console.error("[grossing] queue failed", e);
    loadError = "Could not load the grossing queue. Nothing was changed. Reload the page to try again.";
  }
  const view = sp.view === "source" ? "source" : "bench";
  const notice = lookupError ? (
    <AlertBanner tone="danger" title="Part not opened" blocking>
      {lookupError}
      {/[.!?]$/.test(lookupError.trim()) ? "" : "."} Check the number, or scan the cassette label again (for example D26-04817 A).
    </AlertBanner>
  ) : null;

  if (loadError) {
    return (
      <PageBody>
        <PageHeader title="Grossing" readOnly={isReadOnly} description="One reviewed gross record per part. Approved parts move on; unfinished parts stay visible." />
        {notice}
        <AlertBanner tone="danger" title="Grossing queue unavailable" blocking>
          {loadError}
        </AlertBanner>
      </PageBody>
    );
  }
  return <GrossingQueue rows={rows} sourceRows={sourceRows} view={view} now={now} readOnly={isReadOnly} notice={notice} />;
}
