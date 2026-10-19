"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, CirclePause, Hourglass, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { DeliveryView, QueueItem } from "@/server/queries/intake";
import { AccessionChip } from "@/components/domain/chips";
import { DoctorSwatch } from "@/components/domain/doctor-chip";
import { IdentityMark } from "@/components/domain/identity-mark";
import { LabelRef } from "@/components/domain/specimen-label";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/time";
import { laneGroups, type QueueFlag } from "./plan";

/** Lane headings stay pinned at the top of the queue scroller while their rows scroll under them. */
const LANE_HEADING = "sticky top-0 z-10 flex items-baseline gap-2 bg-canvas px-3 pt-2 pb-1 text-sm font-semibold text-ink";

export function itemHref(displayId: string): string {
  return `/intake?item=${encodeURIComponent(displayId)}`;
}

/** Flag in the severity ladder: identity red, differs amber, hold hatched ink, waiting neutral with the owner's name. */
function Flag({ f, showId }: { f: QueueFlag; showId: boolean }) {
  const Icon = f.severity === "warning" ? TriangleAlert : f.severity === "hold" ? CirclePause : Hourglass;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm px-1.5 text-sm leading-5",
        f.severity === "danger" && "bg-danger-bg font-medium text-danger-fg",
        f.severity === "warning" && "bg-warning-bg font-medium text-warning-fg",
        f.severity === "hold" && "hatch border border-hold-border font-medium text-hold-fg",
        (f.severity === "waiting" || f.severity === "neutral") && "text-ink-secondary",
      )}
    >
      {f.severity === "danger" ? (
        <IdentityMark className="size-3.5" />
      ) : (
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            f.severity === "warning" && "text-warning-solid",
            f.severity === "hold" && "text-hold-solid",
            (f.severity === "waiting" || f.severity === "neutral") && "text-ink-muted",
          )}
          aria-hidden
        />
      )}
      {/* Wraps rather than cuts the words of a flag (large text); the queue column has a fixed width. */}
      <span className="min-w-0 break-words">{f.text}</span>
      {f.id && showId ? <span className="id-mono">{f.id}</span> : null}
    </span>
  );
}

function QueueRow({
  q,
  selected,
  pending,
  pingKey,
  shortName,
  inBracket,
  onOpen,
}: {
  q: QueueItem;
  selected: boolean;
  pending: boolean;
  pingKey: number | null;
  shortName: string | null;
  inBracket: boolean;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void;
}) {
  const [top, ...rest] = q.flags;
  const done = q.lane === "done";
  return (
    <li className="relative">
      <a
        href={itemHref(q.displayId)}
        onClick={(e) => onOpen(e, q.displayId)}
        aria-current={selected ? "true" : undefined}
        aria-busy={pending || undefined}
        data-queue-item={q.displayId}
        className={cn(
          "relative block scroll-mt-10 scroll-mb-2 rounded-md px-2.5 py-2 outline-offset-[-2px] transition-colors duration-[var(--hlo-duration-fast)] max-xl:min-h-11",
          selected ? "bg-surface shadow-1 ring-1 ring-shell" : "hover:bg-surface/70",
        )}
      >
        {pingKey ? <span key={pingKey} aria-hidden className="animate-scan-ping pointer-events-none absolute inset-0 rounded-md" /> : null}
        {/* The id and the doctor share a line; with large text the doctor moves under the id rather than being cut. */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {q.accessionNumber ? (
            <>
              <AccessionChip accession={q.accessionNumber} compact href={false} />
              <span className="sr-only">Accessioned</span>
            </>
          ) : (
            <LabelRef id={q.displayId} provisional className={selected ? undefined : "font-medium"} />
          )}
          {pending ? <LoaderCircle className="size-3.5 animate-spin text-ink-muted motion-reduce:animate-none" aria-hidden /> : null}
          <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 text-sm text-ink-secondary">
            {q.routingStatus === "exception" || !q.pathologistName ? (
              <span className="text-ink-muted">No doctor yet</span>
            ) : (
              <>
                <DoctorSwatch color={q.pathologistColor} />
                <span aria-hidden>{shortName ?? q.pathologistName}</span>
                <span className="sr-only">{q.pathologistName}</span>
              </>
            )}
          </span>
        </span>
        <span className="mt-1 flex min-w-0 items-baseline gap-1.5">
          <span className={cn("shrink-0 text-base leading-5 text-ink", selected ? "font-semibold" : "font-medium")}>{q.patientName ?? "Patient unknown"}</span>
          <span className="min-w-0 truncate text-sm text-ink-muted">
            {q.officeName}
            {q.officeKnown ? "" : " (not in directory)"}
          </span>
        </span>
        {done ? (
          <span className="mt-0.5 block text-sm text-ink-muted">
            From provisional <span className="id-mono">{q.displayId}</span>
          </span>
        ) : top ? (
          <span className="mt-1 flex min-w-0 items-center gap-1.5">
            <Flag f={top} showId={!(inBracket && top.kind === "related")} />
            {rest.length ? <span className="shrink-0 text-sm text-ink-muted">+{rest.length} more</span> : null}
          </span>
        ) : (
          <span className="mt-0.5 block text-sm text-ink-muted">
            {q.verifiedCount} of {q.containerCount} {q.containerCount === 1 ? "container" : "containers"} checked
          </span>
        )}
      </a>
    </li>
  );
}

/** Rows of one lane; members of one related-order review sit together under a bracket that says they are not merged. */
function LaneRows({ rows, ...rest }: { rows: QueueItem[] } & Omit<RowProps, "q" | "inBracket">) {
  const out: ReactNode[] = [];
  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    const rel = q.related;
    const members = rel ? rows.filter((r) => r.related?.displayId === rel.displayId) : [];
    if (rel && members.length > 1 && members[0].id === q.id) {
      out.push(
        <li key={`rel-${rel.displayId}`}>
          <div className="my-1 ml-1.5 border-l border-ink-muted pl-1.5">
            <p className="-ml-1.5 flex items-center gap-1.5 pl-2.5 text-sm text-ink-secondary">
              <span className="id-mono font-medium text-ink">{rel.displayId}</span>
              <span>· not merged</span>
            </p>
            <ul aria-label={`${rel.displayId}: possibly related, reviewed together, never merged`}>
              {members.map((m) => (
                <QueueRow key={m.id} q={m} inBracket {...rowProps(rest, m)} />
              ))}
            </ul>
          </div>
        </li>,
      );
      i += members.length - 1;
      continue;
    }
    out.push(<QueueRow key={q.id} q={q} inBracket={false} {...rowProps(rest, q)} />);
  }
  return <ul className="space-y-0.5 px-1.5">{out}</ul>;
}

interface RowProps {
  q: QueueItem;
  inBracket: boolean;
  selectedId: string | null;
  pendingId: string | null;
  ping: { displayId: string; n: number } | null;
  shortNames: Record<string, string>;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void;
}

function rowProps(p: Omit<RowProps, "q" | "inBracket">, q: QueueItem) {
  return {
    selected: q.id === p.selectedId,
    pending: q.displayId === p.pendingId,
    pingKey: p.ping && p.ping.displayId === q.displayId ? p.ping.n : null,
    shortName: q.pathologistName ? p.shortNames[q.pathologistName] ?? null : null,
    onOpen: p.onOpen,
  };
}

function CourierHeader({ d, checked }: { d: DeliveryView; checked: number }) {
  const [open, setOpen] = useState(false);
  const arrived = !!d.arrivedAt;
  const knownMissing = d.lines.reduce((n, l) => n + (l.missing ?? 0), 0);
  const noManifest = d.lines.filter((l) => l.expected === null).length;
  const total = d.totals.received;
  return (
    <section aria-labelledby="courier-h" className="border-b border-line px-3 pt-3 pb-2.5">
      <h2 id="courier-h" className="flex items-baseline gap-1.5 text-sm text-ink-secondary">
        <span>
          Courier <span className="id-mono font-semibold text-ink">{d.displayId}</span>
        </span>
        <span className="ml-auto">{arrived ? `Arrived ${fmtTime(d.arrivedAt)}` : d.expectedAt ? `Expected ${fmtTime(d.expectedAt)}` : "Not arrived"}</span>
      </h2>
      {arrived ? (
        <>
          <dl className="mt-1 flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5 text-sm">
            <div className="flex items-baseline gap-1">
              <dt className="text-ink-secondary">Received</dt>
              <dd className="num-tabular text-base font-semibold text-ink">{total}</dd>
            </div>
            <div className="flex items-baseline gap-1">
              <dt className="text-ink-secondary">Expected</dt>
              <dd className="num-tabular text-base font-semibold text-ink">{d.totals.expected === null ? "Unknown" : d.totals.expected}</dd>
            </div>
            {knownMissing ? (
              <div className="flex items-baseline gap-1">
                <dt className="text-ink-secondary">Missing{d.unpackingComplete ? "" : " so far"}</dt>
                <dd className="num-tabular inline-flex items-center gap-1 self-center text-base font-semibold text-warning-fg">
                  <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
                  {knownMissing}
                </dd>
              </div>
            ) : null}
          </dl>
          {d.totals.expected === null ? (
            <p className="text-sm text-ink-muted">
              {noManifest} {noManifest === 1 ? "office" : "offices"} sent no source manifest; {d.totals.expectedKnownPart} expected on manifests.
            </p>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <span aria-hidden className="h-1 flex-1 overflow-hidden rounded-pill bg-surface-sunken">
              <span className="block h-full rounded-pill bg-ink-secondary" style={{ width: `${total ? Math.round((checked / total) * 100) : 0}%` }} />
            </span>
            <span className="num-tabular shrink-0 text-sm text-ink-secondary">
              {checked} of {total} checked
            </span>
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm text-ink-secondary">Not arrived yet. Unknown until it is unpacked.</p>
      )}
      {d.lines.length || d.offManifest.length ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls="queue-manifest"
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 mt-1.5 inline-flex min-h-8 items-center gap-1 rounded-sm px-1 text-sm font-medium text-brand hover:bg-surface max-xl:min-h-11"
        >
          Manifest by office ({d.lines.length + d.offManifest.length})
          <ChevronDown className={cn("size-4 transition-transform duration-[var(--hlo-duration-fast)]", open && "rotate-180")} aria-hidden />
        </button>
      ) : null}
      {open ? (
        <table id="queue-manifest" className="animate-rise-in mt-1 w-full text-sm">
          <caption className="sr-only">
            Courier {d.displayId} by office: expected and received containers
          </caption>
          <thead>
            <tr className="text-left text-ink-muted">
              <th scope="col" className="py-1 font-medium">
                Office
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Exp.
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Rec.
              </th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id} className="border-t border-line align-top">
                <th scope="row" className="py-1 pr-2 text-left font-normal text-ink">
                  {l.officeName}
                  {l.missingParts.map((m) => (
                    <span key={`${m.orderRef}-${m.designation}`} className="block text-warning-fg">
                      Missing <span className="id-mono">{m.orderRef}</span> part {m.designation}
                    </span>
                  ))}
                </th>
                <td className="py-1 text-right">{l.expected === null ? <span className="text-ink-muted">Unknown</span> : l.expected}</td>
                <td className={cn("py-1 text-right", (l.missing ?? 0) > 0 && d.unpackingComplete && "font-semibold text-warning-fg")}>{arrived ? l.received : "–"}</td>
              </tr>
            ))}
            {d.offManifest.map((g) => (
              <tr key={g.officeName} className="border-t border-line align-top">
                <th scope="row" className="py-1 pr-2 text-left font-normal text-ink">
                  {g.officeName}
                  <span className="block text-warning-fg">Not on any manifest</span>
                </th>
                <td className="py-1 text-right text-ink-muted">None</td>
                <td className="py-1 text-right">{g.received}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {open ? <p className="mt-1 text-sm text-ink-muted">A delivery with an unknown expectation is never counted as complete.</p> : null}
    </section>
  );
}

/**
 * Arrival queue: the courier summary folded into its header (per-office
 * manifest on demand), then Exceptions, To review and Done. Rows are two to
 * three lines: provisional id, patient and office, one top reason by severity.
 * Below 1280px it is a drawer opened from the identity band.
 */
export function ArrivalQueue({
  queue,
  delivery,
  now,
  selectedId,
  pendingId,
  ping,
  shortNames,
  drawerOpen,
  onCloseDrawer,
  onOpen,
}: {
  queue: QueueItem[];
  delivery: DeliveryView | null;
  now: string;
  selectedId: string | null;
  pendingId: string | null;
  ping: { displayId: string; n: number } | null;
  shortNames: Record<string, string>;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void;
}) {
  const groups = laneGroups(queue);
  const [doneOpen, setDoneOpen] = useState<boolean | null>(null);
  const showDone = doneOpen ?? groups.done.some((q) => q.id === selectedId);
  const checked = delivery ? delivery.totals.checked : 0;
  const shared = { selectedId, pendingId, ping, shortNames, onOpen };
  return (
    <>
      {drawerOpen ? <button type="button" aria-label="Close the queue" onClick={onCloseDrawer} className="fixed inset-0 z-30 bg-shell/30 xl:hidden" /> : null}
      <aside
        id="intake-queue"
        aria-label="Arrival queue"
        className={cn(
          "relative flex min-h-0 flex-col border-r border-line bg-canvas",
          // Wide but short (the page scrolls): the queue column stays in view and scrolls on its own.
          "xl:stacked:sticky xl:stacked:top-[var(--hlo-topbar-h)] xl:stacked:h-[calc(100dvh-var(--hlo-topbar-h))] xl:stacked:self-start",
          "max-xl:fixed max-xl:top-[var(--hlo-topbar-h)] max-xl:bottom-0 max-xl:left-0 max-xl:z-40 max-xl:w-[320px] max-xl:shadow-3 max-xl:transition-transform max-xl:duration-[var(--hlo-duration-base)] max-xl:ease-[var(--hlo-ease)]",
          drawerOpen ? "max-xl:translate-x-0" : "max-xl:invisible max-xl:-translate-x-[110%]",
        )}
      >
        <div className="flex items-center justify-between px-3 pt-2 xl:hidden">
          <p className="text-md font-semibold text-ink">Queue</p>
          <button type="button" onClick={onCloseDrawer} className="inline-flex size-11 items-center justify-center rounded-md text-ink-secondary hover:bg-surface" aria-label="Close the queue">
            <X className="size-5" aria-hidden />
          </button>
        </div>
        {delivery ? <CourierHeader d={delivery} checked={checked} /> : <p className="border-b border-line px-3 py-3 text-sm text-ink-secondary">No courier delivery is scheduled today.</p>}
        <div className="relative min-h-0 flex-1 overflow-y-auto pb-2">
          <section aria-labelledby="lane-exceptions">
            <h3 id="lane-exceptions" className={LANE_HEADING}>
              Exceptions <span className="num-tabular font-normal text-ink-muted">{groups.exceptions.length}</span>
              <span className="ml-auto font-normal text-ink-muted">routine items continue</span>
            </h3>
            {groups.exceptions.length ? <LaneRows rows={groups.exceptions} {...shared} /> : <p className="px-3 pb-2 text-sm text-ink-muted">None right now.</p>}
          </section>
          <section aria-labelledby="lane-review" className="pt-1">
            <h3 id="lane-review" className={LANE_HEADING}>
              To review <span className="num-tabular font-normal text-ink-muted">{groups.to_review.length}</span>
            </h3>
            {groups.to_review.length ? (
              <LaneRows rows={groups.to_review} {...shared} />
            ) : (
              <p className="px-3 pb-2 text-sm text-ink-muted">Nothing waiting for routine review. New arrivals appear here after unpacking.</p>
            )}
          </section>
          <section aria-labelledby="lane-done" className="pt-1">
            <h3 id="lane-done" className="sticky top-0 z-10 bg-canvas px-1.5 py-1">
              <button
                type="button"
                aria-expanded={showDone}
                aria-controls="lane-done-list"
                onClick={() => setDoneOpen(!showDone)}
                className="flex min-h-8 w-full items-center gap-2 rounded-sm px-1.5 text-left text-sm font-semibold text-ink hover:bg-surface max-xl:min-h-11"
              >
                Done today <span className="num-tabular font-normal text-ink-muted">{groups.done.length}</span>
                <ChevronDown className={cn("ml-auto size-4 text-ink-muted transition-transform duration-[var(--hlo-duration-fast)]", showDone && "rotate-180")} aria-hidden />
              </button>
            </h3>
            {showDone ? (
              <div id="lane-done-list" role="region" aria-label="Done today">
                {groups.done.length ? <LaneRows rows={groups.done} {...shared} /> : <p className="px-3 pb-2 text-sm text-ink-muted">No accessioned items yet today.</p>}
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </>
  );
}
