import type { ReactNode } from "react";
import { getDb } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { getActor } from "@/server/session";
import { Tabs } from "@/components/ui/tabs";
import { AlertBanner } from "@/components/ui/alert-banner";
import { ReadOnlyTag } from "@/components/domain/honesty";
import {
  custodyExceptions, getPrintJobDetail, getRetrievalDetail, getTrayDetail, listPrintJobs, listRecentWorkOrderReviews, listRetrievalRequests, listTrays,
  listWorkOrdersInReview, materialsCounts, pathologistsForTrays, printerViews, slidesAwaitingLabel, storedBlocks, type PrintFilter, type RetrievalFilter,
} from "@/server/queries/materials";
import { PrintTab } from "@/components/materials/print-tab";
import { TrayTab } from "@/components/materials/tray-tab";
import { RetrievalTab } from "@/components/materials/retrieval-tab";

export const dynamic = "force-dynamic";
export const metadata = { title: "Materials" };

type Tab = "print" | "trays" | "retrieval";

type SearchParams = Promise<{ tab?: string; selected?: string; filter?: string; rfilter?: string }>;

const READ_ONLY_ROLES = new Set(["director", "medical_director"]);

/**
 * /materials: the materials bench. ?tab=print|trays|retrieval picks the job;
 * ?selected=<PJ|TRY|RR id> opens a print job, tray or retrieval request.
 * Each tab draws the physical thing in hand: the label, the tray as its
 * positions, the walk to the storage slot.
 */
export default async function MaterialsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const tab: Tab = sp.tab === "trays" || sp.tab === "retrieval" ? sp.tab : "print";
  const selected = sp.selected?.trim() || null;
  const db = getDb();
  const now = readClock(db).now;
  const actor = await getActor();

  let loadError: string | null = null;
  let content: ReactNode = null;
  let counts = { print: 0, trays: 0, retrieval: 0, reviews: 0 };

  try {
    counts = materialsCounts(db, now);
    if (tab === "print") {
      const filter: PrintFilter = sp.filter === "today" || sp.filter === "all" ? sp.filter : "attention";
      const jobs = listPrintJobs(db, { filter, now });
      const detail = selected ? getPrintJobDetail(db, selected, now) : null;
      content = (
        <PrintTab
          printers={printerViews(db)}
          rows={jobs.rows}
          total={jobs.total}
          counts={jobs.counts}
          filter={filter}
          detail={detail}
          selectedMissing={selected && !detail ? selected : null}
          reviews={listWorkOrdersInReview(db)}
          recent={listRecentWorkOrderReviews(db)}
          awaiting={slidesAwaitingLabel(db)}
          now={now}
        />
      );
    } else if (tab === "trays") {
      const trays = listTrays(db);
      const fallback = trays.find((t) => ["exception", "assembling", "open"].includes(t.status)) ?? null;
      const target = selected ?? fallback?.id ?? null;
      const detail = target ? getTrayDetail(db, target) : null;
      content = <TrayTab trays={trays} detail={detail} selectedMissing={selected && !detail ? selected : null} pathologists={pathologistsForTrays(db)} now={now} />;
    } else {
      const filter: RetrievalFilter = sp.rfilter === "overdue" || sp.rfilter === "outside" || sp.rfilter === "all" ? sp.rfilter : "open";
      const list = listRetrievalRequests(db, filter, now);
      const target = selected ?? list.rows[0]?.id ?? null;
      const detail = target ? getRetrievalDetail(db, target, now) : null;
      content = (
        <RetrievalTab
          rows={list.rows}
          counts={list.counts}
          filter={filter}
          detail={detail}
          selectedMissing={selected && !detail ? selected : null}
          exceptions={custodyExceptions(db, now)}
          blocks={storedBlocks(db)}
          now={now}
        />
      );
    }
  } catch (e) {
    console.error("[materials] could not load", e);
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="flex min-w-0 flex-col">
      <header className="flex flex-wrap items-end gap-x-8 gap-y-1 border-b border-line bg-surface px-6 pt-2.5 max-xl:gap-x-5 max-xl:px-4">
        <div className="flex items-center gap-2 pb-2.5">
          <h1 className="text-lg font-bold tracking-[-0.015em] text-ink">Materials</h1>
          {READ_ONLY_ROLES.has(actor.role) ? <ReadOnlyTag /> : null}
        </div>
        <Tabs
          label="Materials jobs"
          active={tab}
          bare
          items={[
            { key: "print", label: "Print labels", count: counts.print + counts.reviews || null, href: "/materials?tab=print" },
            { key: "trays", label: "Assemble trays", count: counts.trays || null, href: "/materials?tab=trays" },
            { key: "retrieval", label: "Retrieve blocks", count: counts.retrieval || null, href: "/materials?tab=retrieval" },
          ]}
        />
        <p className="ml-auto pb-2.5 text-sm text-ink-muted max-lg:ml-0 max-lg:basis-full max-lg:pt-0">Printers and scanners on this page are simulated.</p>
      </header>
      {loadError ? (
        <div className="px-6 py-5 max-xl:px-4">
          <AlertBanner tone="warning" title="Could not load this materials view.">
            Nothing was changed. Reload the page to try again. Detail: {loadError}
          </AlertBanner>
        </div>
      ) : (
        content
      )}
    </div>
  );
}
