"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, CirclePause, Download, FlaskConical, Layers, Printer, RefreshCw, Search, TriangleAlert, UserRound, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE } from "@/lib/domain";
import { fmtSmart } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { ReadOnlyTag } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { WorklistData } from "@/server/queries/worklist";
import { FILTER_STAGES, VIEW_LABEL, VIEW_SCOPE_TEXT, WORKLIST_VIEWS, type WorklistFilters, type WorklistView } from "./views";
import { fmtSnapshotTime, plural } from "./format";

/**
 * The worklist's chrome, kept to one header line, one toolbar line on the sheet and the change line:
 * which list (view switch, all-cases scope, saved filter sets) and what goes on paper (print snapshot, CSV);
 * then find and filters; then the state of this copy of the list: its version and source data age (always
 * shown, "simulated" included), what changed since the user's acknowledgment and last print, and Acknowledge.
 */

const ALL_CASES_TITLE = "Ignore the view's scope: every case on today's worklist";

/** Short labels for the view switch; the full name stays in the title and the screen-reader text. */
const VIEW_SHORT: Record<WorklistView, string> = {
  accessioning: "Accessioning",
  grossing: "Grossing",
  histotech: "Histotech",
  operations: "Operations",
};

export function WorklistHeader({
  view,
  readOnly,
  allCases,
  onToggleAllCases,
  savedMenu,
  printing,
  downloading,
  onPrint,
  onDownload,
}: {
  view: WorklistView;
  readOnly: boolean;
  /** "All cases": the view's scope is ignored and every case on today's worklist shows. */
  allCases: boolean;
  onToggleAllCases: () => void;
  savedMenu: ReactNode;
  printing: boolean;
  downloading: boolean;
  onPrint: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Worklist</h1>
        {/* On the tablet the footer's "Read only" line (tag and reason, always shown) carries it, so the header stays one line. */}
        {readOnly ? <ReadOnlyTag className="@max-5xl/wl:hidden" /> : null}
      </div>
      <nav aria-label="Worklist views" className="inline-flex rounded-md border border-line-strong bg-surface p-0.5">
        {WORKLIST_VIEWS.map((v) => (
          <Link
            key={v}
            href={`/worklist?view=${v}`}
            aria-current={v === view ? "page" : undefined}
            title={`${VIEW_LABEL[v]} view: ${VIEW_SCOPE_TEXT[v]}`}
            className={cn(
              "inline-flex min-h-[max(2rem,var(--hlo-target-min))] items-center rounded-sm px-3 text-sm font-semibold @max-5xl/wl:px-2.5 transition-colors duration-[var(--hlo-duration-fast)]",
              v === view ? "bg-shell text-shell-fg" : "text-ink-secondary hover:bg-surface-subtle hover:text-ink",
            )}
          >
            {VIEW_SHORT[v]}
            {VIEW_SHORT[v] !== VIEW_LABEL[v] ? <span className="sr-only"> ({VIEW_LABEL[v]})</span> : null}
          </Link>
        ))}
      </nav>
      {/* Beside the view switch it changes: the view's scope, or every case on today's worklist. */}
      <FilterToggle pressed={allCases} onToggle={onToggleAllCases} icon={<Layers />} title={ALL_CASES_TITLE}>
        All cases
      </FilterToggle>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {savedMenu}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" icon={<Printer />} onClick={onPrint} loading={printing} loadingLabel="Recording...">
            Print<span className="@max-5xl/wl:sr-only"> snapshot</span>
            <Kbd aria-hidden className="ml-0.5">
              P
            </Kbd>
          </Button>
          <Button variant="quiet" size="sm" icon={<Download />} onClick={onDownload} loading={downloading} loadingLabel="Preparing..." className="border border-line" title="Download CSV">
            <span className="@max-5xl/wl:sr-only">Download CSV</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A filter that is on or off: a pressed button, never colour alone (the icon and the word stay). */
function FilterToggle({
  pressed,
  onToggle,
  icon,
  tone = "ink",
  title,
  className,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  icon?: ReactNode;
  tone?: "ink" | "pas";
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      title={title}
      className={cn(
        "inline-flex min-h-[max(2rem,var(--hlo-target-min))] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-sm font-medium transition-colors duration-[var(--hlo-duration-fast)] @max-5xl/wl:px-2.5",
        pressed
          ? tone === "pas"
            ? "border-pas-border bg-pas-bg text-pas-fg"
            : "border-shell bg-shell text-shell-fg"
          : "border-line-strong bg-surface text-ink-secondary hover:border-ink-secondary hover:text-ink",
        className,
      )}
    >
      {icon ? (
        <span aria-hidden className="inline-flex [&>svg]:size-4">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}

export function WorklistToolbar({
  view,
  filters,
  doctors,
  query,
  onQuery,
  onFind,
  onFilters,
  onToggle,
  pasReviewTotal,
}: {
  view: WorklistView;
  filters: WorklistFilters;
  doctors: WorklistData["doctors"];
  query: string;
  onQuery: (q: string) => void;
  onFind: () => void;
  onFilters: (next: WorklistFilters) => void;
  onToggle: (key: "pasOnly" | "onHold" | "mine" | "changedOnly") => void;
  pasReviewTotal: number;
}) {
  // Bench tablet (or the list narrowed by the side panel): the Doctor and Stage words move into the selects
  // ("All doctors", "All stages") so find, both selects and the four toggles stay on one line.
  return (
    <div role="toolbar" aria-label="Find and filter the worklist" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 @max-5xl/wl:gap-x-2.5 @max-[62rem]/wl:gap-x-2">
      <form
        role="search"
        aria-label="Find in this list"
        className="relative flex items-center"
        onSubmit={(e) => {
          e.preventDefault();
          onFind();
        }}
      >
        <label className="sr-only" htmlFor="worklist-find">
          Find in list (case, work order, office or clinician; a scanned label works too)
        </label>
        <Search className="pointer-events-none absolute left-2.5 size-4 text-ink-muted" aria-hidden />
        <Input
          id="worklist-find"
          type="search"
          size="sm"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Case or work order"
          aria-describedby="worklist-find-hint"
          className="w-52 pl-8 @max-5xl/wl:w-44"
        />
        <span id="worklist-find-hint" className="sr-only">
          Press Enter to find.
        </span>
      </form>
      <label className="flex items-center gap-2 text-sm text-ink-secondary">
        <span className="@max-5xl/wl:sr-only">Doctor</span>
        <Select size="sm" value={filters.doctor ?? ""} onChange={(e) => onFilters({ ...filters, doctor: e.target.value || undefined })} className="w-48 @max-5xl/wl:w-36 @max-[62rem]/wl:w-32">
          <option value="">All doctors</option>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.colorToken ?? "no color"})
            </option>
          ))}
          <option value="unassigned">No active doctor (routing exceptions, unassigned)</option>
        </Select>
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-secondary">
        <span className="@max-5xl/wl:sr-only">Stage</span>
        <Select size="sm" value={filters.stage ?? ""} onChange={(e) => onFilters({ ...filters, stage: e.target.value || undefined })} className="w-40 @max-5xl/wl:w-32 @max-[62rem]/wl:w-28">
          <option value="">All stages</option>
          {FILTER_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE[s]}
            </option>
          ))}
        </Select>
      </label>
      {view === "grossing" ? (
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <span className="@max-5xl/wl:sr-only">Queue</span>
          <Select
            size="sm"
            value={filters.queue ?? ""}
            onChange={(e) =>
              onFilters({
                ...filters,
                queue: (e.target.value || undefined) as WorklistFilters["queue"],
              })
            }
            className="w-52 @max-5xl/wl:w-44"
          >
            <option value="">All grossing work</option>
            <option value="gross_pending">No approved gross record yet</option>
            <option value="source_entry">Source entry pending</option>
            <option value="source_attested">Entered, awaiting source ack</option>
          </Select>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterToggle
          pressed={!!filters.pasOnly}
          onToggle={() => onToggle("pasOnly")}
          tone="pas"
          icon={<FlaskConical />}
          title={pasReviewTotal ? "PAS still to do, plus canceled PAS awaiting review (struck through)" : "PAS still to do"}
        >
          PAS only
        </FilterToggle>
        <FilterToggle pressed={!!filters.onHold} onToggle={() => onToggle("onHold")} icon={<CirclePause />}>
          On hold
        </FilterToggle>
        <FilterToggle pressed={!!filters.mine} onToggle={() => onToggle("mine")} icon={<UserRound />} title="Rows with an open task you own">
          My work
        </FilterToggle>
        <FilterToggle pressed={!!filters.changedOnly} onToggle={() => onToggle("changedOnly")} icon={<RefreshCw />} title="New, changed or canceled since your last acknowledgment">
          Changed
        </FilterToggle>
      </div>
    </div>
  );
}

/**
 * The change line under the toolbar, the state of this copy of the list: its version and read time with the
 * source data age ("Simulated source as of …" at every width, amber with ": out of date" when stale), how many
 * rows show, what changed since the user's acknowledgment and since their last printed copy, and the
 * Acknowledge action. Its region name is what the e2e guards read.
 */
export function ChangeLine({
  data,
  view,
  shown,
  partsNote,
  onClearFilters,
  onAcknowledge,
  ackError,
  overflowHint,
}: {
  data: WorklistData;
  view: WorklistView;
  shown: number;
  partsNote: string | null;
  /** Shown next to the count while any filter narrows the list. */
  onClearFilters: (() => void) | null;
  onAcknowledge: () => void;
  ackError: ReactNode;
  overflowHint: ReactNode;
}) {
  const now = data.generatedAt;
  const nothingToAck = !data.changes.total && !data.ack.never;
  const snap = data.lastSnapshot;
  const ackedAt = data.ack.ackedAt ? `${fmtSmart(data.ack.ackedAt, now)} ET` : null;
  return (
    <section aria-label="Changes since your last acknowledgment" className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line bg-surface-subtle px-3 py-1 text-sm @max-5xl/wl:gap-x-4">
      <ListVersion seq={data.seq} generatedAt={now} freshness={data.freshness} />
      <p
        className="shrink-0 text-ink-secondary"
        aria-live="polite"
        title={`${VIEW_LABEL[view]} view: ${data.filters.scope === "all" ? "all cases on today's worklist (view scope ignored)" : VIEW_SCOPE_TEXT[view]}`}
      >
        Showing <span className="num-tabular font-semibold text-ink">{shown}</span> of <span className="num-tabular">{data.totals.inScope}</span>
        <span className="@max-5xl/wl:sr-only"> {data.filters.scope === "all" ? "on today's worklist" : "in this view"}</span>
        {partsNote ? <span className="font-medium text-ink">, {partsNote}</span> : null}
      </p>
      {onClearFilters ? (
        <Button size="sm" variant="quiet" icon={<X />} onClick={onClearFilters} className="-ml-3">
          Clear filters
        </Button>
      ) : null}
      {/* What changed since the acknowledgment, and under it since the user's last paper copy: one column, so the
          line stays one row with Acknowledge beside it. */}
      <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-0.5">
        {/* One line at every bench width: on the tablet the sentence leads with the version it counts from. While a
            source is out of date the banner above says what is paused; this line only counts. */}
        <p id="ack-status" className="text-ink" aria-live="polite">
          {data.ack.never ? (
            <>You have not acknowledged the {VIEW_LABEL[view]} view yet. Every row counts as new.</>
          ) : data.changes.total ? (
            <>
              <span className="@max-5xl/wl:hidden">
                <span className="font-semibold">Since your last acknowledgment</span>{" "}
                <span className="text-ink-muted">
                  ({ackedAt ? `${ackedAt}, ` : ""}v{data.ack.ackedSeq})
                </span>
              </span>
              <span className="hidden @max-5xl/wl:inline">
                <span className="font-semibold">
                  Since <span className="sr-only">your acknowledgment of </span>v{data.ack.ackedSeq}
                </span>
                {ackedAt ? <span className="text-ink-muted"> ({ackedAt})</span> : null}
              </span>
              : <span className="num-tabular font-semibold">{data.changes.new}</span> new, <span className="num-tabular font-semibold">{data.changes.changed}</span> changed,{" "}
              <span className="num-tabular font-semibold">{data.changes.canceled}</span> canceled.
            </>
          ) : (
            <>
              Nothing to acknowledge since{" "}
              <span className="text-ink-muted">
                {ackedAt ? `${ackedAt} ` : ""}
                (v{data.ack.ackedSeq})
              </span>
              .
            </>
          )}
        </p>
        {snap ? (
          <p className={cn("min-w-0", snap.changedRows ? "font-medium text-warning-fg" : "text-ink-secondary")} title={`Recorded ${fmtSnapshotTime(snap.generatedAt)}`}>
            {/* A sentence that may wrap, with its icon inline (a flex row would split it into columns). */}
            {snap.changedRows ? <TriangleAlert className="mr-1 inline size-3.5 align-[-2px]" aria-hidden /> : <Printer className="mr-1 inline size-3.5 align-[-2px] text-ink-muted" aria-hidden />}
            {/* On the tablet the sentence keeps one line: "print" for "printed copy", the time in the tooltip. */}
            Your last{" "}
            {snap.format === "csv" ? (
              "CSV"
            ) : (
              <>
                <span className="@max-5xl/wl:hidden">printed copy</span>
                <span className="hidden @max-5xl/wl:inline">print</span>
              </>
            )}
            , <span className="id-mono">{snap.displayId}</span> (v{snap.seq}
            <span className="@max-5xl/wl:sr-only">, {fmtSmart(snap.generatedAt, now)} ET</span>):{" "}
            {snap.changedRows ? `${plural(snap.changedRows, "row")} changed since` : "nothing changed since"}
          </p>
        ) : null}
      </div>
      {overflowHint}
      <Button variant={data.changes.total ? "primary" : "secondary"} size="sm" onClick={onAcknowledge} disabled={nothingToAck} reasonId={nothingToAck ? "ack-status" : undefined} className="ml-auto">
        Acknowledge
        <span className="@max-5xl/wl:sr-only"> (records v{data.seq})</span>
        <Kbd aria-hidden className={cn("ml-0.5", data.changes.total && "border-white/50 bg-transparent text-white")}>
          A
        </Kbd>
      </Button>
      {ackError}
    </section>
  );
}

/**
 * This copy's version and read time, and the source data's age in the same words at every width: "Simulated
 * source as of …", amber with ": out of date" when a source is offline or past the stale threshold.
 */
function ListVersion({ seq, generatedAt, freshness }: { seq: number; generatedAt: string; freshness: WorklistData["freshness"] }) {
  const asOf = freshness.dataAsOf ? `${fmtSmart(freshness.dataAsOf, generatedAt)} ET` : "Unknown";
  return (
    <div className="flex shrink-0 flex-col leading-tight">
      <p className="text-ink-muted">
        Version <span className="num-tabular font-semibold text-ink">v{seq}</span>, read at <Timestamp iso={generatedAt} now={generatedAt} className="text-ink-secondary" />
      </p>
      {freshness.stale ? (
        <p className="flex items-center gap-1 font-semibold text-warning-fg">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span>Simulated source as of {asOf}: out of date</span>
        </p>
      ) : (
        <p className="text-ink-muted">Simulated source as of {asOf}</p>
      )}
    </div>
  );
}

/** Says how many columns are off to the right (or that the first ones are) and scrolls to them. */
export function OverflowHint({ right, hidden, onScroll }: { right: boolean; hidden: string[]; onScroll: (dir: 1 | -1) => void }) {
  return (
    <Button
      size="sm"
      variant="quiet"
      onClick={() => onScroll(right ? 1 : -1)}
      title={right ? `More columns: ${hidden.join(", ")}` : "Back to the first columns"}
      aria-label={right ? `Scroll the table right to show ${plural(hidden.length, "more column")}: ${hidden.join(", ")}` : "Scroll the table back to the first columns"}
      className="border border-line bg-surface"
    >
      {right ? (
        <>
          {plural(hidden.length, "more column")}
          <ChevronRight className="size-4" aria-hidden />
        </>
      ) : (
        <>
          <ChevronLeft className="size-4" aria-hidden />
          First columns
        </>
      )}
    </Button>
  );
}
