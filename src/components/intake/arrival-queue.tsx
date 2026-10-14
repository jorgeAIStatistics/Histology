"use client";

import Link from "next/link";
import { CirclePause, TriangleAlert } from "lucide-react";
import type { QueueItem, Lane } from "@/server/queries/intake";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { StatePill } from "@/components/ui/status-pill";
import { ProvisionalChip, AccessionChip } from "@/components/domain/chips";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { SyntheticTag } from "@/components/domain/honesty";
import { cn } from "@/lib/cn";

const LANE_LABEL: Record<Lane, string> = { to_review: "To review", exceptions: "Exceptions", done: "Done" };

const EMPTY: Record<Lane, { title: string; body: string }> = {
  to_review: {
    title: "Nothing waiting for routine review",
    body: "New arrivals appear here after unpacking. Record the courier arrival, then unpack (simulated) or scan a requisition.",
  },
  exceptions: {
    title: "No exceptions right now",
    body: "Routing exceptions, discrepancies, missing containers, identity conflicts, related-order reviews and holds appear here.",
  },
  done: { title: "No accessioned items yet today", body: "Items move here once the simulated source issues the official accession." },
};

export function hrefFor(item: { displayId: string }, lane: Lane): string {
  return `/intake?item=${encodeURIComponent(item.displayId)}&lane=${lane}`;
}

export function ArrivalQueue({
  queue,
  counts,
  lane,
  onLaneChange,
  selectedId,
}: {
  queue: QueueItem[];
  counts: Record<Lane, number>;
  lane: Lane;
  onLaneChange: (l: Lane) => void;
  selectedId: string | null;
}) {
  const rows = queue.filter((q) => q.lane === lane);
  return (
    <section
      aria-label="Arrival queue"
      className="sticky top-[calc(var(--hlo-chrome-h)+var(--intake-idbar-h,var(--hlo-identity-h))+0.5rem)] flex max-h-[calc(100vh-var(--hlo-chrome-h)-var(--intake-idbar-h,var(--hlo-identity-h))-1rem)] flex-col overflow-hidden rounded-md border border-line bg-surface shadow-1"
    >
      <h2 className="sr-only">Arrival queue</h2>
      <div className="px-1.5 pt-1">
        <Tabs
          idBase="lanes"
          label="Arrival queue lanes"
          size="sm"
          className="flex-nowrap gap-0.5 [&_[role=tab]]:px-2 max-xl:[&_[role=tab]]:px-1.5 max-xl:[&_[role=tab]]:text-xs"
          active={lane}
          onChange={(k) => onLaneChange(k as Lane)}
          items={(Object.keys(LANE_LABEL) as Lane[]).map((k) => ({ key: k, label: LANE_LABEL[k], count: counts[k] }))}
        />
      </div>
      <TabPanel idBase="lanes" tabKey={lane} active className="flex min-h-0 flex-1 flex-col">
        {lane === "exceptions" ? <p className="border-b border-line bg-surface-subtle px-3 py-1.5 text-xs text-ink-secondary">Other containers can continue under local policy.</p> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="p-3">
              <EmptyState compact title={EMPTY[lane].title}>
                {EMPTY[lane].body}
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((q) => {
                const selected = q.id === selectedId;
                // Spec §11: the hold stripe is the only coloured row edge (exceptions are said in words, below).
                const held = q.reasons.some((r) => /^hold\b/i.test(r));
                return (
                  <li key={q.id}>
                    <Link
                      href={hrefFor(q, lane)}
                      scroll={false}
                      aria-current={selected ? "true" : undefined}
                      data-queue-item={q.displayId}
                      className={cn(
                        "block border-l-[3px] py-2 pr-2 pl-2.5 text-sm hover:bg-surface-subtle",
                        selected ? "border-l-brand bg-brand-50" : held ? "border-l-hold-solid" : "border-l-transparent",
                      )}
                    >
                      {/* On a tablet the queue is narrow: the status pill moves to the name line so the ID chip keeps its own line. */}
                      <span className="flex items-center gap-1.5">
                        {q.accessionNumber ? <AccessionChip accession={q.accessionNumber} compact href={false} /> : <ProvisionalChip id={q.displayId} compact href={false} />}
                        <StatePill domain="intake" state={q.status} className={q.accessionNumber ? undefined : "max-xl:hidden"} />
                      </span>
                      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-ink">
                        <span className="truncate">{q.patientName ?? "Patient unknown"}</span>
                        {q.patientName ? <SyntheticTag /> : null}
                        {q.accessionNumber ? null : <StatePill domain="intake" state={q.status} size="sm" className="ml-auto shrink-0 xl:hidden" />}
                      </span>
                      <span className="block truncate text-xs text-ink-secondary">
                        {q.officeName}
                        {q.officeKnown ? "" : " (not in directory)"} · {q.orderRefs.length ? q.orderRefs.join(", ") : "no order linked"}
                      </span>
                      {q.accessionNumber ? (
                        // Two intake items can share one accession (parts A and B): keep the provisional id visible to tell them apart.
                        <span className="block text-xs text-ink-muted">
                          From provisional <span className="id-mono">{q.displayId}</span>
                        </span>
                      ) : null}
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                        <span>
                          {q.verifiedCount} of {q.containerCount} {q.containerCount === 1 ? "container" : "containers"} checked
                        </span>
                        {q.routingStatus === "exception" ? null : q.pathologistName ? <DoctorChip name={q.pathologistName} color={q.pathologistColor} compact className="text-xs" /> : null}
                      </span>
                      {q.reasons.length ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {q.reasons.map((r) =>
                            /^hold\b/i.test(r) ? (
                              // Holds keep their own colour and pause icon everywhere (never the warning look).
                              <span key={r} className="inline-flex items-center gap-1 rounded-sm bg-hold-bg px-1.5 text-xs text-hold-fg">
                                <CirclePause className="size-3 shrink-0 text-hold-solid" aria-hidden />
                                {r}
                              </span>
                            ) : (
                              <span key={r} className="inline-flex items-center gap-1 rounded-sm bg-warning-bg px-1.5 text-xs text-warning-fg">
                                <TriangleAlert className="size-3 shrink-0 text-warning-solid" aria-hidden />
                                {r}
                              </span>
                            ),
                          )}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </TabPanel>
      <p className="flex flex-wrap items-center gap-1 border-t border-line px-3 py-1.5 text-xs text-ink-muted">
        <Kbd>J</Kbd>/<Kbd>K</Kbd> move · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> current step
      </p>
    </section>
  );
}
