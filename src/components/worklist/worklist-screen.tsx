"use client";

import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { useReactTable, getCoreRowModel, getSortedRowModel, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { STAGE } from "@/lib/domain";
import { decodeLabel } from "@/lib/identifiers";
import { useCommand, newIdempotencyKey, ERROR_TITLE, type CommandFailure } from "@/lib/client/command";
import { handleCommandAuthFailure, withActorHeader } from "@/lib/client/session";
import { useSingleKey } from "@/lib/client/keyboard";
import { isReadOnlyRole } from "@/lib/client/shell-context";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { SidePanelLayout } from "@/components/ui/side-panel";
import { useToast } from "@/components/ui/toast";
import { ReadOnlyTag } from "@/components/domain/honesty";
import { StaleBanner } from "@/components/domain/stale-banner";
import type { Role } from "@/lib/roles";
import type { SavedFilter, WorklistData, WorklistRow } from "@/server/queries/worklist";
import { COLUMN_LABEL, VIEW_LABEL, VIEW_SCOPE_TEXT, describeFilters, filtersToSearchParams, stripUndefined, type ColumnKey, type WorklistFilters, type WorklistView } from "./views";
import { plural } from "./format";
import { WorklistGrid } from "./grid";
import { ChangeLine, OverflowHint, WorklistHeader, WorklistToolbar } from "./toolbar";
import { SavedFiltersMenu } from "./saved-filters-menu";
import { WorklistPanel } from "./worklist-panel";
import { PrintSnapshot, type PrintMeta } from "./print-snapshot";
import { FreshnessWatcher } from "./freshness-watcher";

interface Props {
  data: WorklistData;
  saved: SavedFilter[];
  selectedId: string | null;
  actor: { id: string; name: string; role: Role };
}

/** The failed print or download says why beside the buttons; focus stays on the button, which points to it. */
const SNAPSHOT_ERROR_ID = "worklist-snapshot-error";

const STAGE_RANK = new Map<string, number>(["intake", ...Object.keys(STAGE)].map((s, i) => [s, i]));

function hrefFor(view: WorklistView, filters: WorklistFilters, selected?: string | null): string {
  const p = filtersToSearchParams(view, filters);
  if (selected) p.set("selected", selected);
  return `/worklist?${p.toString()}`;
}

/**
 * What to find for a typed or scanned value: a demo label payload (HL1:...) or a human block/slide label
 * ("D26-04817 A1-2 H&E") finds its case; anything else is searched as typed.
 */
function findTerm(raw: string): string {
  const value = raw.trim();
  if (/^HL1:/i.test(value)) {
    const decoded = decodeLabel(value);
    return decoded.ok ? decoded.identity.accession : value;
  }
  const accession = /^(D\d{2}-\d{5})\s+[A-Z]\d*/i.exec(value);
  return accession ? accession[1].toUpperCase() : value;
}

export function WorklistScreen({ data, saved, selectedId, actor }: Props) {
  const router = useRouter();
  const toast = useToast();
  const now = data.generatedAt;
  const view = data.view;
  const filters = data.filters;
  const readOnly = isReadOnlyRole(actor.role);
  const navigate = useCallback(
    (href: string, mode: "push" | "replace") =>
      startTransition(() => {
        if (mode === "replace") router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
      }),
    [router],
  );

  // ------------------------------------------------------------ table model (tanstack for sorting)
  const allRows = useMemo(() => data.groups.flatMap((g) => g.rows), [data.groups]);
  const groupOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of data.groups) for (const r of g.rows) m.set(r.id, g.key);
    return m;
  }, [data.groups]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = useMemo<ColumnDef<WorklistRow>[]>(
    () => [
      { id: "accession", accessorFn: (r) => r.accessionNumber ?? r.provisionalId ?? "" },
      // Stage folds into the Parts column on screen, so sorting Parts sorts by the case's stage.
      { id: "parts", accessorFn: (r) => STAGE_RANK.get(r.stage) ?? 99 },
      { id: "stage", accessorFn: (r) => STAGE_RANK.get(r.stage) ?? 99 },
      { id: "stains", accessorFn: (r) => (r.hasPas ? 0 : r.stains.length ? 1 : 2) },
      { id: "holds", accessorFn: (r) => -r.holds.length },
      { id: "readiness", accessorFn: (r) => r.readinessText },
      { id: "blocks", accessorFn: (r) => r.blocks.prepared },
      { id: "sourceEntry", accessorFn: (r) => -r.sourceEntry.pendingParts.length },
      { id: "owner", accessorFn: (r) => r.owner?.ownerName ?? (r.unownedOwner ? "~unassigned" : "~") },
      { id: "lastUpdate", accessorFn: (r) => (r.lastUpdate.at ? Date.parse(r.lastUpdate.at) : 0) },
      { id: "office", accessorFn: (r) => r.office },
      { id: "clinician", accessorFn: (r) => r.clinician ?? "~" },
    ],
    [],
  );
  const table = useReactTable({
    data: allRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (r) => r.id,
  });
  const sortedRows = table.getRowModel().rows.map((r) => r.original);
  const sortedKey = sortedRows.map((r) => r.id).join("|");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const grouped = useMemo(
    () => data.groups.map((g) => ({ group: g, rows: sortedRows.filter((r) => groupOf.get(r.id) === g.key) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.groups, sortedKey, groupOf],
  );
  const visibleIds = useMemo(() => grouped.flatMap(({ group, rows }) => (collapsed.has(group.key) ? [] : rows.map((r) => r.id))), [grouped, collapsed]);
  const selectedRow = selectedId ? allRows.find((r) => r.id === selectedId || r.accessionNumber === selectedId || r.provisionalId === selectedId) ?? null : null;
  const selectedGroup = selectedRow ? data.groups.find((g) => g.key === groupOf.get(selectedRow.id)) ?? null : null;
  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  // ------------------------------------------------------------ keyboard: J/K, arrows, Enter, A, P
  const [activeId, setActiveId] = useState<string | null>(selectedRow?.id ?? null);
  const tableRef = useRef<HTMLDivElement>(null);
  const headerAreaRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [tableMax, setTableMax] = useState("calc(100vh - var(--hlo-chrome-h) - 16px)");
  const focusRow = useCallback((id: string) => {
    setActiveId(id);
    requestAnimationFrame(() => {
      const row = tableRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
      if (!row) return;
      row.focus({ preventScroll: true });
      revealRow(row);
    });
  }, []);
  // A panel opened from a link (?selected=...) brings its row into view, so the list shows which record is open.
  // (Closing the panel returns focus to the row it showed last: the shared SidePanel does that, J/K included.)
  const selectedRowId = selectedRow?.id ?? null;
  useEffect(() => {
    if (!selectedRowId) return;
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(selectedRowId)}"]`);
    if (row) revealRow(row, { center: true });
    // Re-checked once the table has its final height (tableMax), which is measured after the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRowId, tableMax]);
  // J/K with the panel open moves the panel along and keeps focus on the row, where its ring shows; Enter or a
  // click opens it with focus on the panel's heading, so a screen reader announces the case.
  const [panelFollows, setPanelFollows] = useState(false);
  const openRow = useCallback((id: string, mode: "push" | "replace" = "push") => navigate(hrefFor(view, filters, id), mode), [navigate, view, filters]);
  const move = useCallback(
    (delta: number) => {
      if (!visibleIds.length) return;
      const cur = activeId ? visibleIds.indexOf(activeId) : -1;
      const next = visibleIds[Math.min(visibleIds.length - 1, Math.max(0, cur === -1 ? 0 : cur + delta))];
      focusRow(next);
      if (selectedRow) {
        setPanelFollows(true);
        openRow(next, "replace"); // the panel follows along
      }
    },
    [visibleIds, activeId, focusRow, selectedRow, openRow],
  );
  const onRowKey = useCallback(
    (e: ReactKeyboardEvent<HTMLTableRowElement>, id: string) => {
      if (e.key === "Enter") {
        e.preventDefault();
        setPanelFollows(false);
        openRow(id);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      }
    },
    [openRow, move],
  );
  const onRowClick = useCallback(
    (id: string) => {
      setActiveId(id);
      setPanelFollows(false);
      openRow(id);
    },
    [openRow],
  );

  // ------------------------------------------------------------ acknowledge
  // The version is captured when the dialog OPENS: a background refresh while it is open must not
  // acknowledge rows the user has not seen yet.
  const [ackTarget, setAckTarget] = useState<{ seq: number; counts: WorklistData["changes"] } | null>(null);
  const openAck = useCallback(() => setAckTarget({ seq: data.seq, counts: data.changes }), [data.seq, data.changes]);
  const ack = useCommand<{ ackedSeq: number }, { view: WorklistView; seq: number }>("worklist.ack", {
    successToast: (r) => `Acknowledged up to version v${r.ackedSeq}. Tags cleared for you in the ${VIEW_LABEL[view]} view.`,
    onSuccess: () => setAckTarget(null),
  });

  // ------------------------------------------------------------ print snapshot
  const [printMeta, setPrintMeta] = useState<PrintMeta | null>(null);
  // A recorded snapshot header only describes the version it was recorded for.
  useEffect(() => setPrintMeta((m) => (m && m.seq !== data.seq ? null : m)), [data.seq]);
  const [snapshotError, setSnapshotError] = useState<CommandFailure | null>(null);
  const snapshot = useCommand<
    { snapshotId: string; displayId: string; seq: number; generatedAt: string; generatedBy: string; dataAsOf: string | null; stale: boolean },
    { view: WorklistView; filters: WorklistFilters; format: "print"; expectedSeq: number }
  >("worklist.snapshot", { conflict: false, errorToast: false, refresh: false });
  const printSnapshot = useCallback(async () => {
    setSnapshotError(null);
    const out = await snapshot.run({ view, filters, format: "print", expectedSeq: data.seq });
    if (!out.ok) {
      setSnapshotError(out.error);
      return;
    }
    const meta: PrintMeta = { displayId: out.result.displayId, seq: out.result.seq, generatedAt: out.result.generatedAt, generatedBy: out.result.generatedBy, dataAsOf: out.result.dataAsOf, stale: out.result.stale };
    // Render the recorded header synchronously, then open the print dialog for exactly that version.
    flushSync(() => setPrintMeta(meta));
    window.print();
    toast.show({ tone: "success", title: `Snapshot ${meta.displayId} recorded (v${meta.seq}).`, body: "The paper copy is not updated after printing." });
    startTransition(() => router.refresh());
  }, [snapshot, view, filters, data.seq, toast, router]);

  // ------------------------------------------------------------ CSV download
  const [csvPending, setCsvPending] = useState(false);
  const [csvError, setCsvError] = useState<CommandFailure | null>(null);
  const downloadCsv = useCallback(async () => {
    if (csvPending) return;
    setCsvPending(true);
    setCsvError(null);
    try {
      const res = await fetch("/api/worklist/export", {
        method: "POST",
        // Secured mode: the staff member this page was opened for (X-HLOS-Actor), as for every command.
        headers: withActorHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify({ view, filters, expectedSeq: data.seq, idempotencyKey: newIdempotencyKey("csv") }),
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: CommandFailure } | null;
        setCsvError(body?.error ? await handleCommandAuthFailure(body.error) : { code: "VALIDATION", message: `Download failed (HTTP ${res.status}).` });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const name = disposition.match(/filename="([^"]+)"/)?.[1] ?? `worklist-v${data.seq}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.show({ tone: "success", title: `Downloaded ${name}`, body: "Snapshot recorded with its version and time. The file is not updated after download." });
      startTransition(() => router.refresh());
    } catch {
      setCsvError({ code: "NETWORK", message: "Could not reach the local demo server. Try again." });
    } finally {
      setCsvPending(false);
    }
  }, [csvPending, view, filters, data.seq, toast, router]);

  useSingleKey({
    j: () => move(1),
    k: () => move(-1),
    a: () => {
      if (data.changes.total > 0 || data.ack.never) openAck();
    },
    p: () => void printSnapshot(),
  });

  // ------------------------------------------------------------ filters → URL
  const setFilters = (next: WorklistFilters) => navigate(hrefFor(view, stripUndefined(next), null), "replace");
  const toggle = (key: "pasOnly" | "onHold" | "mine" | "changedOnly") => setFilters({ ...filters, [key]: filters[key] ? undefined : true });
  const pasReviewTotal = data.groups.reduce((n, g) => n + g.counts.pasReview, 0);
  const [q, setQ] = useState(filters.q ?? "");
  useEffect(() => setQ(filters.q ?? ""), [filters.q]);
  // A find (typed or scanned into the field) pings the rows it located once they arrive.
  const [ping, setPing] = useState<{ q: string; n: number } | null>(null);
  const find = () => {
    const term = findTerm(q);
    setQ(term);
    setPing(term ? { q: term, n: Date.now() } : null);
    setFilters({ ...filters, q: term || undefined });
  };
  const pingKey = ping && filters.q && ping.q.toLowerCase() === filters.q.toLowerCase() ? `${ping.q}-${ping.n}` : null;
  const activeFilterCount = Object.keys(stripUndefined({ ...filters, scope: undefined, queue: undefined })).length;

  const closeHref = hrefFor(view, filters, null);
  const doctorName = (id: string) => data.doctors.find((d) => d.id === id)?.name;
  const staleSources = data.freshness.sources.filter((s) => s.stale);
  const panelOpen = !!selectedRow;

  // A queue or stage filter opened from an Operations number also counts the PARTS it matched, so the
  // number on the tile or chart can be found in what opens (the list itself shows cases).
  const partsNote = useMemo(() => {
    const parts = allRows.flatMap((r) => r.parts);
    if (filters.queue === "source_entry") return `${plural(allRows.reduce((n, r) => n + r.sourceEntry.pendingParts.length, 0), "part")} in this queue`;
    if (filters.queue === "source_attested") return `${plural(allRows.reduce((n, r) => n + r.sourceEntry.attestedParts.length, 0), "part")} in this queue`;
    if (filters.queue === "gross_pending") {
      const n = parts.filter((p) => p.status !== "canceled" && p.documentation.grossState !== "approved_for_downstream" && (p.stage === "awaiting_gross" || p.stage === "gross_in_progress")).length;
      return `${plural(n, "part")} in this queue`;
    }
    if (filters.stage && filters.stage in STAGE) return `${plural(parts.filter((p) => p.stage === filters.stage).length, "part")} at this stage`;
    return null;
  }, [allRows, filters.queue, filters.stage]);

  // ------------------------------------------------------------ one scroll region
  // Bench screens: the grid fills the rest of the window and scrolls inside, so the page itself does not scroll
  // and the header, toolbar and change line stay in view (with or without the side panel). A window too short
  // for that (200% zoom, a small tablet) stacks instead: the page scrolls, and the grid's box is one window tall
  // under the top bar, so its sticky column header and doctor band are never hidden under the bar.
  const hasRows = allRows.length > 0;
  useLayoutEffect(() => {
    if (!hasRows) return;
    const update = () => {
      const el = tableRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const footer = footerRef.current?.offsetHeight ?? 0;
      const fit = Math.floor(window.innerHeight - top - footer - 10 /* gap */ - 12 /* page padding */);
      const chrome = document.querySelector<HTMLElement>("header[data-shell-chrome]")?.offsetHeight ?? 0;
      const stacked = Math.max(200, Math.floor(window.innerHeight - chrome - 16));
      setTableMax(`${fit >= 320 ? fit : stacked}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    if (headerAreaRef.current) ro.observe(headerAreaRef.current);
    if (footerRef.current) ro.observe(footerRef.current);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [hasRows]);
  const overflow = useHorizontalOverflow(tableRef, `${view}|${panelOpen}|${allRows.length}`);
  const scrollTableBy = useCallback((dir: 1 | -1) => {
    const box = tableRef.current?.querySelector<HTMLElement>(".overflow-auto");
    if (!box) return;
    const sticky = box.querySelector<HTMLElement>("thead th")?.offsetWidth ?? 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollBy({ left: dir * Math.max(160, box.clientWidth - sticky - 48), behavior: reduce ? "auto" : "smooth" });
  }, []);

  const sortOf = (key: ColumnKey) => {
    const s = table.getColumn(key)?.getIsSorted();
    return s === "asc" ? "asc" : s === "desc" ? "desc" : "none";
  };
  const onSort = (key: ColumnKey) => {
    const col = table.getColumn(key);
    col?.toggleSorting(col.getIsSorted() === "asc");
  };

  const shownCount = allRows.length;
  const caption = `Worklist, ${VIEW_LABEL[view]} view, grouped by assigned dermatopathologist. Sorted: ${
    sorting.length ? `${sorting[0].id === "parts" ? "Parts and stage" : COLUMN_LABEL[sorting[0].id as ColumnKey]} ${sorting[0].desc ? "descending" : "ascending"}` : "holds first, then accession number"
  }.${panelOpen ? " Side panel open: more columns are shown in the panel." : ""}`;

  const snapError = snapshotError ?? csvError;

  return (
    <>
      <FreshnessWatcher freshness={data.freshness} />
      <div className="no-print">
        <SidePanelLayout
          panel={
            selectedRow ? (
              <WorklistPanel row={selectedRow} group={selectedGroup} now={now} actor={actor} closeHref={closeHref} readOnly={readOnly} preserveFocus={panelFollows} />
            ) : null
          }
        >
          <div className="@container/wl flex flex-col gap-2.5 px-6 pb-3 pt-3 max-xl:px-4">
            <div ref={headerAreaRef} className="flex flex-col gap-2.5">
              <WorklistHeader
                view={view}
                readOnly={readOnly}
                allCases={filters.scope === "all"}
                onToggleAllCases={() => setFilters({ ...filters, scope: filters.scope === "all" ? undefined : "all" })}
                savedMenu={<SavedFiltersMenu view={view} filters={filters} saved={saved} />}
                printing={snapshot.pending}
                downloading={csvPending}
                onPrint={() => void printSnapshot()}
                onDownload={() => void downloadCsv()}
                errorId={snapError ? SNAPSHOT_ERROR_ID : undefined}
              />
              {snapError ? (
                <AlertBanner
                  id={SNAPSHOT_ERROR_ID}
                  announce="alert"
                  tone="warning"
                  title={ERROR_TITLE[snapError.code] ?? "Could not create the snapshot"}
                  action={
                    snapError.code === "CONFLICT" ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setSnapshotError(null);
                          setCsvError(null);
                          startTransition(() => router.refresh());
                        }}
                      >
                        Refresh the list
                      </Button>
                    ) : null
                  }
                >
                  {snapError.message} Nothing was printed or downloaded.
                </AlertBanner>
              ) : null}
              {staleSources.map((s) =>
                s.state === "offline" ? (
                  <StaleBanner
                    key={s.id}
                    sourceName={s.tenantName ?? s.name}
                    since={s.lastSuccessAt}
                    now={now}
                    detail="New orders and source changes since then are not shown. Local tasks, holds and grossing still update. Snapshots record this data age."
                  />
                ) : (
                  <AlertBanner key={s.id} tone="warning" title={s.text}>
                    Rows built from this source may be out of date. Snapshots record this data age.
                  </AlertBanner>
                ),
              )}
            </div>
            <section aria-label="Worklist" className="rounded-lg border border-line bg-surface shadow-1">
              <WorklistToolbar
                view={view}
                filters={filters}
                doctors={data.doctors}
                query={q}
                onQuery={setQ}
                onFind={find}
                onFilters={setFilters}
                onToggle={toggle}
                pasReviewTotal={pasReviewTotal}
              />
              <ChangeLine
                data={data}
                view={view}
                shown={shownCount}
                partsNote={partsNote}
                onClearFilters={activeFilterCount ? () => setFilters({ scope: filters.scope, queue: filters.queue }) : null}
                onAcknowledge={openAck}
                ackError={ack.error ? <CommandError error={ack.error} /> : null}
                overflowHint={overflow.right || overflow.left ? <OverflowHint right={overflow.right} hidden={overflow.hidden} onScroll={scrollTableBy} /> : null}
              />
              {data.totals.allCases === 0 ? (
                <EmptyState title="No cases for today yet" className="rounded-none rounded-b-lg border-x-0 border-b-0 border-t border-solid">
                  Cases appear after accessioning. Routing exceptions appear here as soon as an item from an unknown office is received.
                </EmptyState>
              ) : shownCount === 0 ? (
                <EmptyState
                  title="No cases match these filters"
                  className="rounded-none rounded-b-lg border-x-0 border-b-0 border-t border-solid"
                  action={
                    <Link href={hrefFor(view, {}, null)} className="inline-flex min-h-[max(2rem,var(--hlo-target-min))] items-center rounded-md border border-line-strong px-3 text-sm font-semibold text-ink hover:bg-surface-subtle">
                      Clear filters
                    </Link>
                  }
                >
                  Filters: {describeFilters(filters, doctorName)}. {plural(data.totals.inScope, "case")} {data.totals.inScope === 1 ? "is" : "are"} in the {VIEW_LABEL[view]} view scope (
                  {VIEW_SCOPE_TEXT[view]}); {data.totals.allCases} {data.totals.allCases === 1 ? "is" : "are"} on today&apos;s worklist in total.
                </EmptyState>
              ) : (
                <WorklistGrid
                  tableRef={tableRef}
                  caption={caption}
                  columns={data.columns}
                  groups={grouped}
                  collapsed={collapsed}
                  onToggleGroup={toggleGroup}
                  sortOf={sortOf}
                  onSort={onSort}
                  selectedId={selectedRow?.id ?? null}
                  tabStopId={activeId ?? visibleIds[0] ?? null}
                  panelOpen={panelOpen}
                  maxHeight={tableMax}
                  scrolledSideways={overflow.left}
                  actorId={actor.id}
                  now={now}
                  pingKey={pingKey}
                  onRowClick={onRowClick}
                  onRowFocus={setActiveId}
                  onRowKey={onRowKey}
                />
              )}
            </section>
            <div ref={footerRef} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
              {shownCount ? (
                // Keyboard help is for the bench workstation; the tablet list keeps the room for rows.
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1 @max-5xl/wl:hidden">
                  <KeysHint />
                  <span>Filters: {describeFilters(filters, doctorName)}.</span>
                </span>
              ) : null}
              {readOnly ? (
                <span className="inline-flex items-center gap-2">
                  <ReadOnlyTag /> {actor.name} can view, acknowledge and print, not claim tasks. The role switch is a demo selector, not a sign-in.
                </span>
              ) : null}
            </div>
          </div>
        </SidePanelLayout>
      </div>
      <PrintSnapshot
        data={data}
        meta={printMeta ?? { displayId: null, seq: data.seq, generatedAt: data.generatedAt, generatedBy: actor.name, dataAsOf: data.freshness.dataAsOf, stale: data.freshness.stale }}
      />
      <ConfirmDialog
        open={ackTarget !== null}
        title={`Acknowledge changes up to v${ackTarget?.seq ?? data.seq}?`}
        confirmLabel="Acknowledge changes"
        cancelLabel="Keep reviewing"
        onConfirm={() => {
          if (ackTarget) void ack.run({ view, seq: ackTarget.seq });
        }}
        onCancel={() => setAckTarget(null)}
        pending={ack.pending}
        pendingLabel="Recording..."
        error={ack.error ? <CommandError error={ack.error} /> : null}
      >
        <p className="text-sm text-ink">
          This clears the New, Changed and Canceled tags for you in the {VIEW_LABEL[view]} view ({ackTarget?.counts.new ?? 0} new, {ackTarget?.counts.changed ?? 0} changed,{" "}
          {ackTarget?.counts.canceled ?? 0} canceled). Other people and your other views are not affected. Changes that arrive after version v{ackTarget?.seq ?? data.seq} will
          still be tagged.
        </p>
        {ackTarget && data.seq !== ackTarget.seq ? (
          <p className="mt-2 text-sm font-medium text-warning-fg">
            The list changed while this was open (now v{data.seq}). Only changes up to v{ackTarget.seq}, the version you were looking at, will be acknowledged.
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

/**
 * Brings a row into view below the grid's sticky column header and doctor band (WCAG 2.4.11). When the grid's
 * box is not fully in the window (the stacked layout at 200% zoom), the page first scrolls the box up under the
 * top bar; on the bench screens the page never scrolls and only the grid moves.
 */
function revealRow(row: HTMLElement, { center = false }: { center?: boolean } = {}) {
  const box = row.closest<HTMLElement>(".overflow-auto");
  if (!box) return;
  const chrome = document.querySelector<HTMLElement>("header[data-shell-chrome]")?.getBoundingClientRect().bottom ?? 0;
  let b = box.getBoundingClientRect();
  if (b.top < chrome || b.bottom > window.innerHeight + 1) {
    window.scrollBy({ top: b.top - chrome - 8 });
    b = box.getBoundingClientRect();
  }
  const header = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  const band = box.querySelector("tbody > tr > th")?.getBoundingClientRect().height ?? 0;
  const r = row.getBoundingClientRect();
  const top = b.top + header + band;
  const bottom = Math.min(b.top + box.clientHeight, window.innerHeight);
  if (r.top >= top && r.bottom <= bottom) return;
  // A row opened from a link sits mid-list with context around it; J/K moves just far enough.
  if (center) box.scrollTop += r.top - top - Math.max(0, (bottom - top - r.height) / 2);
  else if (r.top < top) box.scrollTop -= top - r.top;
  else box.scrollTop += r.bottom - bottom;
}

function KeysHint() {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <Kbd>J</Kbd>
      <Kbd>K</Kbd> move, <Kbd>Enter</Kbd> opens, <Kbd>Esc</Kbd> closes the panel, <Kbd>Space</Kbd> on a doctor band collapses it, <Kbd>A</Kbd> acknowledges, <Kbd>P</Kbd> prints.
    </span>
  );
}

/**
 * Whether the grid scrolls sideways, and which column headers are (partly) cut off at the right edge,
 * so the screen can say "2 more columns" instead of leaving a sliver of a column with no hint.
 */
function useHorizontalOverflow(ref: RefObject<HTMLDivElement | null>, key: string): { right: boolean; left: boolean; hidden: string[] } {
  const [state, setState] = useState<{ right: boolean; left: boolean; hidden: string[] }>({ right: false, left: false, hidden: [] });
  useEffect(() => {
    const box = ref.current?.querySelector<HTMLElement>(".overflow-auto");
    if (!box) return;
    const update = () => {
      const right = box.scrollLeft + box.clientWidth < box.scrollWidth - 2;
      const left = box.scrollLeft > 2;
      const edge = box.getBoundingClientRect().right - 8;
      const hidden = [...box.querySelectorAll<HTMLElement>("thead th")]
        .filter((th) => th.offsetWidth > 0 && th.getBoundingClientRect().right > edge)
        .map((th) => th.dataset.label ?? th.textContent ?? "");
      setState((prev) => (prev.right === right && prev.left === left && prev.hidden.join("|") === hidden.join("|") ? prev : { right, left, hidden }));
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(box);
    const t = box.querySelector("table");
    if (t) ro.observe(t);
    return () => {
      box.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref, key]);
  return state;
}
