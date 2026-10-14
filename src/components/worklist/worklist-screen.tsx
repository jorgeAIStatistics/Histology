"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { useReactTable, getCoreRowModel, getSortedRowModel, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { Bookmark, ChevronDown, ChevronLeft, ChevronRight, Download, Printer, Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE } from "@/lib/domain";
import { fmtSmart } from "@/lib/time";
import {
  AlertBanner, Button, Checkbox, CommandButton, CommandError, ConfirmDialog, EmptyState, Input, PageBody, PageHeader, Select, SidePanelLayout,
  Table, TableCount, Tabs, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { AccessionChip, DoctorChip, DoctorSwatch, DOCTOR_STRIPE, DOCTOR_TINT, isPathologistColor, ProvisionalChip, ReadOnlyTag, StaleBanner, Timestamp } from "@/components/domain";
import { useCommand, newIdempotencyKey, ERROR_TITLE, type CommandFailure } from "@/lib/client/command";
import { isDialogOpen, useSingleKey } from "@/lib/client/keyboard";
import { isReadOnlyRole } from "@/lib/client/shell-context";
import { useToast } from "@/components/ui/toast";
import type { Role } from "@/lib/roles";
import type { SavedFilter, WorklistData, WorklistRow } from "@/server/queries/worklist";
import {
  COLUMN_LABEL, COLUMN_PRIORITY, FILTER_STAGES, VIEW_LABEL, VIEW_SCOPE_TEXT, WORKLIST_VIEWS, describeFilters, filtersToSearchParams, stripUndefined,
  type ColumnKey, type WorklistFilters, type WorklistView,
} from "./views";
import { BlocksCell, ChangeTags, HoldList, PartsCell, StainList, UpdateOrigin } from "./cells";
import { plural } from "./format";
import { WorklistPanel } from "./worklist-panel";
import { PrintSnapshot, type PrintMeta } from "./print-snapshot";
import { FreshnessWatcher } from "./freshness-watcher";

interface Props {
  data: WorklistData;
  saved: SavedFilter[];
  selectedId: string | null;
  actor: { id: string; name: string; role: Role };
}

const STAGE_RANK = new Map<string, number>(["intake", ...Object.keys(STAGE)].map((s, i) => [s, i]));

/** Text columns that may wrap so the P1 columns fit a 1366 px workstation and a 1024 px bench tablet. Identifiers never wrap. */
const WRAP_COLUMNS = new Set<ColumnKey>(["parts", "stage", "stains", "holds", "readiness", "sourceEntry", "blocks", "owner", "lastUpdate", "office", "clinician"]);
/**
 * Minimum column widths. The table scrolls sideways once the columns no longer fit, so these minimums
 * decide what stays on screen: all P1 columns at 1024 px, plus the task owner at 1366 px.
 */
const COLUMN_WIDTH: Partial<Record<ColumnKey, string>> = {
  parts: "min-w-36",
  stage: "min-w-28",
  stains: "min-w-44",
  holds: "w-26 min-w-26",
  readiness: "min-w-48",
  sourceEntry: "min-w-32",
  blocks: "min-w-28",
  owner: "min-w-32",
  lastUpdate: "min-w-36",
  office: "min-w-36",
  clinician: "min-w-32",
};
/** Side panel open (about 680 px of list at 1366): P2 and P3 move to the panel and P1 tightens to fit. */
const COLUMN_WIDTH_PANEL: Partial<Record<ColumnKey, string>> = {
  parts: "min-w-28",
  stage: "min-w-24",
  stains: "min-w-24",
  holds: "w-20 min-w-20",
  readiness: "min-w-36",
};
/** Screen header labels (the caption, print and CSV keep the full names). */
const HEADER_LABEL: Record<ColumnKey, string> = { ...COLUMN_LABEL, stains: "Stains", owner: "Task owner", blocks: "Blocks prepared" };

function hrefFor(view: WorklistView, filters: WorklistFilters, selected?: string | null): string {
  const p = filtersToSearchParams(view, filters);
  if (selected) p.set("selected", selected);
  return `/worklist?${p.toString()}`;
}

function sameFilters(a: WorklistFilters, b: WorklistFilters): boolean {
  const norm = (f: WorklistFilters) => JSON.stringify(Object.entries(stripUndefined({ ...f })).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

export function WorklistScreen({ data, saved, selectedId, actor }: Props) {
  const router = useRouter();
  const toast = useToast();
  const now = data.generatedAt;
  const view = data.view;
  const filters = data.filters;
  const readOnly = isReadOnlyRole(actor.role);

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
      { id: "parts", accessorFn: (r) => r.partsSummary },
      { id: "stage", accessorFn: (r) => STAGE_RANK.get(r.stage) ?? 99 },
      { id: "stains", accessorFn: (r) => (r.hasPas ? 0 : r.stains.length ? 1 : 2) },
      { id: "holds", accessorFn: (r) => -r.holds.length },
      { id: "readiness", accessorFn: (r) => r.readinessText },
      { id: "blocks", accessorFn: (r) => r.blocks.prepared },
      { id: "sourceEntry", accessorFn: (r) => -r.sourceEntry.pendingParts.length },
      { id: "owner", accessorFn: (r) => r.owner?.ownerName ?? "~" },
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const grouped = useMemo(
    () => data.groups.map((g) => ({ group: g, rows: sortedRows.filter((r) => groupOf.get(r.id) === g.key) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.groups, sortedRows.map((r) => r.id).join("|"), groupOf],
  );
  const visibleIds = useMemo(() => grouped.flatMap(({ group, rows }) => (collapsed.has(group.key) ? [] : rows.map((r) => r.id))), [grouped, collapsed]);
  const selectedRow = selectedId ? allRows.find((r) => r.id === selectedId || r.accessionNumber === selectedId) ?? null : null;
  const selectedGroup = selectedRow ? data.groups.find((g) => g.key === groupOf.get(selectedRow.id)) ?? null : null;

  // ------------------------------------------------------------ keyboard: J/K, arrows, Enter, A, P
  const [activeId, setActiveId] = useState<string | null>(selectedRow?.id ?? null);
  const tableRef = useRef<HTMLDivElement>(null);
  const headerAreaRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [tableMax, setTableMax] = useState("calc(100vh - var(--hlo-chrome-h) - 16px)");
  const focusRow = useCallback((id: string) => {
    setActiveId(id);
    requestAnimationFrame(() => {
      const el = tableRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
      el?.focus();
    });
  }, []);
  // A panel opened from a link (?selected=...) brings its row into view, so the list shows which record is open.
  const selectedRowId = selectedRow?.id ?? null;
  useEffect(() => {
    if (!selectedRowId) return;
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(selectedRowId)}"]`);
    const box = row?.closest<HTMLElement>(".overflow-auto");
    if (!row || !box) return;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const headerH = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const visible = r.top >= b.top + headerH && r.bottom <= Math.min(b.bottom, window.innerHeight);
    // Scroll only the table, never the page: the tabs, change strip and filters stay in view.
    if (!visible) box.scrollTop += r.top - b.top - headerH - Math.max(0, (b.height - headerH - r.height) / 2);
    // Re-checked once the table has its final height (tableMax), which is measured after the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRowId, tableMax]);
  // Closing the panel (Esc, the close button or Back) returns focus to the row it showed, so J/K continue from there.
  const prevSelectedRef = useRef<string | null>(selectedRowId);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    prevSelectedRef.current = selectedRowId;
    if (!prev || selectedRowId) return;
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body) focusRow(prev);
    });
  }, [selectedRowId, focusRow]);
  const openRow = useCallback(
    (id: string, mode: "push" | "replace" = "push") => {
      const href = hrefFor(view, filters, id);
      if (mode === "replace") router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [router, view, filters],
  );
  const move = useCallback(
    (delta: number) => {
      if (!visibleIds.length) return;
      const cur = activeId ? visibleIds.indexOf(activeId) : -1;
      const next = visibleIds[Math.min(visibleIds.length - 1, Math.max(0, cur === -1 ? 0 : cur + delta))];
      focusRow(next);
      if (selectedRow) openRow(next, "replace"); // the panel follows along
    },
    [visibleIds, activeId, focusRow, selectedRow, openRow],
  );
  const onRowKey = (e: ReactKeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      openRow(id);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    }
  };

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
    router.refresh();
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ view, filters, expectedSeq: data.seq, idempotencyKey: newIdempotencyKey("csv") }),
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: CommandFailure } | null;
        setCsvError(body?.error ?? { code: "VALIDATION", message: `Download failed (HTTP ${res.status}).` });
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
      router.refresh();
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
  const setFilters = (next: WorklistFilters) => router.replace(hrefFor(view, stripUndefined(next), null), { scroll: false });
  const toggle = (key: "pasOnly" | "onHold" | "mine" | "changedOnly") => setFilters({ ...filters, [key]: filters[key] ? undefined : true });
  const pasReviewTotal = data.groups.reduce((n, g) => n + g.counts.pasReview, 0);
  const [q, setQ] = useState(filters.q ?? "");
  useEffect(() => setQ(filters.q ?? ""), [filters.q]);
  const activeFilterCount = Object.keys(stripUndefined({ ...filters, scope: undefined, queue: undefined })).length;

  const closeHref = hrefFor(view, filters, null);
  const columnsShown: ColumnKey[] = data.columns;
  const doctorName = (id: string) => data.doctors.find((d) => d.id === id)?.name;
  const staleSources = data.freshness.sources.filter((s) => s.stale);
  const panelOpen = !!selectedRow;
  const widthOf = (key: ColumnKey) => (panelOpen ? COLUMN_WIDTH_PANEL[key] ?? COLUMN_WIDTH[key] : COLUMN_WIDTH[key]);

  const viewTabs = WORKLIST_VIEWS.map((v) => ({ key: v, label: VIEW_LABEL[v], href: `/worklist?view=${v}` }));

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
  // The table fills the rest of the window and scrolls inside, so the page itself does not scroll
  // and the tabs, change strip and filters stay in view (with or without the side panel).
  const hasRows = allRows.length > 0;
  useLayoutEffect(() => {
    if (!hasRows) return;
    const update = () => {
      const el = tableRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const footer = footerRef.current?.offsetHeight ?? 0;
      const px = Math.max(320, Math.floor(window.innerHeight - top - footer - 12 /* gap */ - 16 /* page padding */));
      setTableMax(`${px}px`);
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
  const scrollTableBy = (dir: 1 | -1) => {
    const box = tableRef.current?.querySelector<HTMLElement>(".overflow-auto");
    if (!box) return;
    const sticky = box.querySelector<HTMLElement>("thead th")?.offsetWidth ?? 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollBy({ left: dir * Math.max(160, box.clientWidth - sticky - 48), behavior: reduce ? "auto" : "smooth" });
  };

  const nothingToAck = !data.changes.total && !data.ack.never;
  const strip = (
    <section aria-label="Changes since your last acknowledgment" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm">
      <p id="ack-status" className="min-w-0 flex-1 text-ink" aria-live="polite">
        {data.ack.never ? (
          <>You have not acknowledged the {VIEW_LABEL[view]} view yet. Every row counts as new.</>
        ) : data.changes.total ? (
          <>
            <span className="font-semibold">Since your last acknowledgment</span>{" "}
            <span className="text-ink-muted">
              ({data.ack.ackedAt ? `${fmtSmart(data.ack.ackedAt, now)} ET, ` : ""}v{data.ack.ackedSeq})
            </span>
            : <span className="num-tabular font-semibold">{data.changes.new}</span> new, <span className="num-tabular font-semibold">{data.changes.changed}</span> changed,{" "}
            <span className="num-tabular font-semibold">{data.changes.canceled}</span> canceled.
          </>
        ) : (
          <>
            Nothing to acknowledge: no new, changed or canceled rows since{" "}
            <span className="text-ink-muted">{data.ack.ackedAt ? `${fmtSmart(data.ack.ackedAt, now)} ET ` : ""}(v{data.ack.ackedSeq})</span>.
          </>
        )}
        {data.freshness.stale ? (
          // Short and inline: the stale banner above already explains the outage.
          <span className="text-warning-fg"> Source changes paused; local changes still tracked.</span>
        ) : null}
      </p>
      <Checkbox label="Only changed rows" checked={!!filters.changedOnly} onChange={() => toggle("changedOnly")} />
      <Button variant={data.changes.total ? "primary" : "secondary"} size="sm" onClick={openAck} disabled={nothingToAck} reasonId={nothingToAck ? "ack-status" : undefined}>
        Acknowledge (records v{data.seq})
      </Button>
      {ack.error ? <CommandError error={ack.error} /> : null}
    </section>
  );

  const filterRow = (
    <section aria-label="Filters" className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <label className="flex flex-col gap-0.5 text-xs text-ink-muted">
        Assigned dermatopathologist
        <Select size="sm" value={filters.doctor ?? ""} onChange={(e) => setFilters({ ...filters, doctor: e.target.value || undefined })} className="w-48">
          <option value="">All</option>
          {data.doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.colorToken ?? "no color"})
            </option>
          ))}
          <option value="unassigned">No active doctor (routing exceptions, unassigned)</option>
        </Select>
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-ink-muted">
        Stage
        <Select size="sm" value={filters.stage ?? ""} onChange={(e) => setFilters({ ...filters, stage: e.target.value || undefined })} className="w-40">
          <option value="">All stages</option>
          {FILTER_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE[s]}
            </option>
          ))}
        </Select>
      </label>
      {view === "grossing" ? (
        <label className="flex flex-col gap-0.5 text-xs text-ink-muted">
          Queue
          <Select
            size="sm"
            value={filters.queue ?? ""}
            onChange={(e) => setFilters({ ...filters, queue: (e.target.value || undefined) as WorklistFilters["queue"] })}
            className="w-56"
          >
            <option value="">All grossing work</option>
            <option value="gross_pending">No approved gross record yet</option>
            <option value="source_entry">Source entry pending</option>
            <option value="source_attested">Entered, awaiting source ack</option>
          </Select>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1.5">
        <Checkbox
          label="PAS only"
          checked={!!filters.pasOnly}
          onChange={() => toggle("pasOnly")}
          hint={filters.pasOnly && pasReviewTotal ? "Includes canceled PAS awaiting review (struck through)" : undefined}
        />
        <Checkbox label="On hold" checked={!!filters.onHold} onChange={() => toggle("onHold")} />
        <Checkbox label="My work" checked={!!filters.mine} onChange={() => toggle("mine")} />
      </div>
    </section>
  );

  const findForm = (
    <form
      role="search"
      aria-label="Find in this list"
      className="relative flex items-center"
      onSubmit={(e) => {
        e.preventDefault();
        setFilters({ ...filters, q: q.trim() || undefined });
      }}
    >
      <label className="sr-only" htmlFor="worklist-find">
        Find in list (accession, work order, office or clinician)
      </label>
      <Search className="pointer-events-none absolute left-2 size-4 text-ink-muted" aria-hidden />
      <Input
        id="worklist-find"
        type="search"
        size="sm"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find D26-04817, WO-2213"
        aria-describedby="worklist-find-hint"
        className="w-52 pl-7"
      />
      <span id="worklist-find-hint" className="sr-only">
        Press Enter to find.
      </span>
    </form>
  );

  const tableEl = (
    <div ref={tableRef} className="relative">
      <Table
        caption={`Worklist, ${VIEW_LABEL[view]} view, grouped by assigned dermatopathologist. Sorted: ${sorting.length ? `${COLUMN_LABEL[sorting[0].id as ColumnKey]} ${sorting[0].desc ? "descending" : "ascending"}` : "holds first, then accession number"}.${panelOpen ? " Side panel open: more columns are shown in the panel." : ""}`}
        scroll="container"
        maxHeight={tableMax}
        // Side panel open: P2 and P3 details are in the panel, so the list keeps every P1 column visible.
        hideP2={panelOpen}
        // Bench tablet (< 1280 px): P3 columns move to the side panel (spec 5.2).
        wrapperClassName={cn(
          "max-xl:[&_[data-priority='3']]:hidden",
          // Scrolled sideways: a rule on the sticky Case column shows where the scrolled columns slide under it.
          overflow.left && "[&_tr>td:first-child]:border-r [&_tr>td:first-child]:border-r-line-strong [&_thead_th:first-child]:border-r [&_thead_th:first-child]:border-r-line-strong",
        )}
      >
        <THead>
          <tr>
            {columnsShown.map((key) => {
              const col = table.getColumn(key);
              const s = col?.getIsSorted();
              return (
                <TH
                  key={key}
                  data-label={COLUMN_LABEL[key]}
                  stickyFirst={key === "accession"}
                  priority={COLUMN_PRIORITY[key]}
                  sort={s === "asc" ? "asc" : s === "desc" ? "desc" : "none"}
                  onSort={() => col?.toggleSorting(s === "asc")}
                  className={cn("whitespace-normal py-1 align-bottom leading-tight", panelOpen && "px-2", widthOf(key))}
                >
                  {HEADER_LABEL[key]}
                </TH>
              );
            })}
          </tr>
        </THead>
        {grouped.map(({ group, rows }) => {
          const isCollapsed = collapsed.has(group.key);
          const color = isPathologistColor(group.colorToken) ? group.colorToken : null;
          return (
            <TBody key={group.key}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={columnsShown.length}
                  className={cn(
                    "h-10 border-b border-line px-0 text-left font-normal",
                    color ? cn(DOCTOR_TINT[color], "border-l-4", DOCTOR_STRIPE[color]) : "border-y border-dashed border-line-strong bg-surface",
                  )}
                >
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                    className="sticky left-0 flex h-10 w-max max-w-[100vw] items-center gap-2 px-3 text-left text-sm"
                  >
                    {isCollapsed ? <ChevronRight className="size-4 shrink-0 text-ink-muted" aria-hidden /> : <ChevronDown className="size-4 shrink-0 text-ink-muted" aria-hidden />}
                    {group.kind === "routing_exception" ? (
                      <DoctorChip name={null} className="font-semibold" />
                    ) : group.kind === "no_doctor" ? (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-ink-secondary">
                        <DoctorSwatch color={null} />
                        {group.name}
                      </span>
                    ) : (
                      <DoctorChip name={group.name} color={group.colorToken} showColorName className="font-semibold" />
                    )}
                    <span className="text-ink-secondary">
                      <span className="num-tabular">{plural(group.counts.rows, group.kind === "routing_exception" ? "item" : "case")}</span>, <span className="num-tabular">{group.counts.pas}</span> PAS,{" "}
                      <span className="num-tabular">{group.counts.onHold}</span> on hold
                      {group.counts.pasReview ? (
                        <>
                          , <span className="num-tabular">{group.counts.pasReview}</span> canceled or amended PAS to review
                        </>
                      ) : null}
                    </span>
                    <span className="sr-only">{isCollapsed ? "Collapsed. Activate to expand." : "Expanded. Activate to collapse."}</span>
                  </button>
                </th>
              </tr>
              {isCollapsed
                ? null
                : rows.map((r) => (
                    <TR
                      key={r.id}
                      data-row-id={r.id}
                      tabIndex={(activeId ?? visibleIds[0]) === r.id ? 0 : -1}
                      interactive
                      selected={selectedRow?.id === r.id}
                      hold={r.holds.length > 0}
                      pas={r.hasPas}
                      canceled={r.change === "canceled" && r.stains.every((s) => s.canceled) && !r.stains.some((s) => s.needsReview)}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("a,button")) return;
                        setActiveId(r.id);
                        openRow(r.id);
                      }}
                      onFocus={() => setActiveId(r.id)}
                      onKeyDown={(e) => onRowKey(e, r.id)}
                      aria-label={`${r.accessionNumber ?? `Provisional ${r.provisionalId}`}, ${r.partsSummary}${r.changeTags.length ? `, ${r.changeTags.join(" and ")}` : ""}${r.pasNeedsReview ? ", canceled or amended PAS needs review" : ""}`}
                      className={cn("focus-visible:outline-2 focus-visible:-outline-offset-2", !r.hasPas && selectedRow?.id !== r.id && "bg-surface")}
                    >
                      {columnsShown.map((key) => (
                        <TD
                          key={key}
                          priority={COLUMN_PRIORITY[key]}
                          stickyFirst={key === "accession"}
                          wrap={WRAP_COLUMNS.has(key)}
                          className={cn("py-1", panelOpen && "px-2", widthOf(key))}
                        >
                          {renderCell(key, r, now, panelOpen)}
                        </TD>
                      ))}
                    </TR>
                  ))}
            </TBody>
          );
        })}
      </Table>
      {overflow.right ? <div aria-hidden className="pointer-events-none absolute bottom-px right-px top-px w-12 rounded-r-md bg-linear-to-l from-surface to-transparent" /> : null}
    </div>
  );

  const shownCount = allRows.length;
  const body =
    data.totals.allCases === 0 ? (
      <EmptyState title="No cases for today yet">Cases appear after accessioning. Routing exceptions appear here as soon as an item from an unknown office is received.</EmptyState>
    ) : shownCount === 0 ? (
      <EmptyState
        title="No cases match these filters"
        action={
          <Link href={hrefFor(view, {}, null)} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
            Clear filters
          </Link>
        }
      >
        {plural(data.totals.inScope, "case")} {data.totals.inScope === 1 ? "is" : "are"} in the {VIEW_LABEL[view]} view scope ({VIEW_SCOPE_TEXT[view]}). {data.totals.allCases}{" "}
        {data.totals.allCases === 1 ? "is" : "are"} on today&apos;s worklist in total.
      </EmptyState>
    ) : (
      tableEl
    );

  const keysHint = (
    <p className="text-xs text-ink-muted">
      Keys: <span className="font-medium">J/K</span> move, <span className="font-medium">Enter</span> opens, <span className="font-medium">Space</span> on a group header
      collapses it, <span className="font-medium">A</span> acknowledges, <span className="font-medium">P</span> prints. Filters: {describeFilters(filters, doctorName)}.
    </p>
  );

  return (
    <>
      <FreshnessWatcher freshness={data.freshness} />
      <div className="no-print">
        <SidePanelLayout
          panel={
            selectedRow ? (
              <WorklistPanel row={selectedRow} group={selectedGroup} now={now} actor={actor} closeHref={closeHref} readOnly={readOnly} />
            ) : null
          }
        >
          <PageBody className="gap-3">
            <div ref={headerAreaRef} className="flex flex-col gap-3">
              <PageHeader
                className="flex-nowrap"
                title="Worklist"
                readOnly={readOnly}
                meta={
                  <>
                    Version <span className="num-tabular font-medium text-ink-secondary">v{data.seq}</span>, read at <Timestamp iso={data.generatedAt} now={now} />
                  </>
                }
                description={<>Shared daily list by assigned dermatopathologist, in place of the paper &quot;bible&quot;.</>}
                actions={
                  <>
                    <Button variant="secondary" size="sm" icon={<Printer />} onClick={() => void printSnapshot()} loading={snapshot.pending} loadingLabel="Recording...">
                      Print snapshot
                    </Button>
                    <Button variant="secondary" size="sm" icon={<Download />} onClick={() => void downloadCsv()} loading={csvPending} loadingLabel="Preparing...">
                      Download CSV
                    </Button>
                  </>
                }
              />
              {snapshotError || csvError ? (
                <AlertBanner
                  tone={(snapshotError ?? csvError)!.code === "CONFLICT" ? "warning" : "danger"}
                  title={`${ERROR_TITLE[(snapshotError ?? csvError)!.code] ?? "Could not create the snapshot"}`}
                  action={
                    (snapshotError ?? csvError)!.code === "CONFLICT" ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setSnapshotError(null);
                          setCsvError(null);
                          router.refresh();
                        }}
                      >
                        Refresh the list
                      </Button>
                    ) : null
                  }
                >
                  {(snapshotError ?? csvError)!.message} Nothing was printed or downloaded.
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
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-end justify-between gap-x-4 border-b border-line">
                  <Tabs items={viewTabs} active={view} label="Worklist views" className="border-b-0" />
                  <Checkbox
                    className="pb-2"
                    label="All cases (ignore view scope)"
                    checked={filters.scope === "all"}
                    onChange={() => setFilters({ ...filters, scope: filters.scope === "all" ? undefined : "all" })}
                  />
                </div>
                <p className="truncate text-xs text-ink-muted" title="Views change columns and scope; every case stays on the shared list.">
                  {VIEW_LABEL[view]} view: {filters.scope === "all" ? "all cases on today's worklist (view scope ignored)" : VIEW_SCOPE_TEXT[view]}.
                </p>
              </div>
              {strip}
              {filterRow}
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <TableCount shown={shownCount} total={data.totals.inScope} noun={filters.scope === "all" ? "items on today's worklist" : "items in this view"} />
                  {partsNote ? <span className="text-sm font-medium text-ink">· {partsNote}</span> : null}
                  {activeFilterCount ? (
                    <Button size="sm" variant="quiet" icon={<X />} onClick={() => setFilters({ scope: filters.scope, queue: filters.queue })}>
                      Clear filters
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {findForm}
                  <SavedFiltersMenu view={view} filters={filters} saved={saved} />
                  {overflow.right || overflow.left ? (
                    // Sits right above the table's right edge: says how many columns are off screen and scrolls to them.
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => scrollTableBy(overflow.right ? 1 : -1)}
                      title={overflow.right ? `More columns: ${overflow.hidden.join(", ")}` : "Back to the first columns"}
                      aria-label={overflow.right ? `Scroll the table right to show ${plural(overflow.hidden.length, "more column")}: ${overflow.hidden.join(", ")}` : "Scroll the table back to the first columns"}
                      className="border border-line"
                    >
                      {overflow.right ? (
                        <>
                          {plural(overflow.hidden.length, "more column")}
                          <ChevronRight className="size-4" aria-hidden />
                        </>
                      ) : (
                        <>
                          <ChevronLeft className="size-4" aria-hidden />
                          First columns
                        </>
                      )}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
            {body}
            <div ref={footerRef} className="flex flex-col gap-1">
              {shownCount ? keysHint : null}
              {readOnly ? (
                <p className="flex items-center gap-2 text-xs text-ink-muted">
                  <ReadOnlyTag /> {actor.name} can view, acknowledge and print, but cannot claim tasks. The role switch is a demo selector, not a sign-in; the server checks every action.
                </p>
              ) : null}
            </div>
          </PageBody>
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
 * Whether the table scrolls sideways, and which column headers are (partly) cut off at the right edge,
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

function renderCell(key: ColumnKey, r: WorklistRow, now: string, narrow = false): ReactNode {
  switch (key) {
    case "accession":
      // Change and rush tags sit above the chip, so they never widen the sticky identity column.
      return (
        <span className="flex flex-col items-start gap-0.5">
          {r.changeTags.length || r.priority === "rush" ? (
            <span className="inline-flex items-center gap-1">
              <ChangeTags tags={r.changeTags} />
              {r.priority === "rush" ? <span className="rounded-sm border border-warning-border bg-warning-bg px-1 text-xs font-semibold text-warning-fg">Rush</span> : null}
            </span>
          ) : null}
          {r.accessionNumber ? (
            <AccessionChip accession={r.accessionNumber} compact />
          ) : (
            <ProvisionalChip id={r.provisionalId!} compact className="h-auto min-h-6 max-w-34 flex-wrap gap-x-1 py-0.5" />
          )}
        </span>
      );
    case "parts":
      return <PartsCell row={r} />;
    case "stage":
      return <span>{r.stageLabel}</span>;
    case "stains":
      return <StainList stains={r.stains} compact narrow={narrow} />;
    case "holds":
      return <HoldList holds={r.holds} stacked />;
    case "readiness":
      return (
        <span className="line-clamp-3" title={[...r.eligibleShort.map((e) => `Eligible: ${e}`), ...r.blockedShort.map((b) => `Not ready: ${b}`)].join("\n")}>
          {r.readinessText}
        </span>
      );
    case "blocks":
      return <BlocksCell blocks={r.blocks} />;
    case "sourceEntry":
      return (
        <span className={r.sourceEntry.pendingParts.length ? "text-ink" : "text-ink-secondary"} title={r.sourceEntry.text}>
          {r.sourceEntry.pendingParts.length
            ? `Entry pending: ${r.sourceEntry.pendingParts.join(", ")}`
            : r.sourceEntry.attestedParts.length
              ? `Entered (attested): ${r.sourceEntry.attestedParts.join(", ")}`
              : "None pending"}
        </span>
      );
    case "owner":
      return r.owner ? (
        <span title={r.ownerText}>
          {r.owner.ownerName ?? <span className="text-ink-muted">Unassigned ({(r.owner.ownerRole ?? "role unknown").replace(/_/g, " ")})</span>}
          {r.tasks.length > 1 ? <span className="text-ink-muted"> +{r.tasks.length - 1}</span> : null}
        </span>
      ) : (
        <span className="text-ink-muted">None</span>
      );
    case "lastUpdate":
      return (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" title={r.lastUpdate.summary ?? undefined}>
          <Timestamp iso={r.lastUpdate.at} now={now} />
          <UpdateOrigin origin={r.lastUpdate.origin} />
        </span>
      );
    case "office":
      return <span>{r.office}</span>;
    case "clinician":
      return r.clinician ? <span>{r.clinician}</span> : <span className="text-ink-muted">Unknown</span>;
  }
}

/**
 * Saved filters as a small menu (one button on the count row): the list of this view's saved filters,
 * each with delete, and a form to save the current filters. Esc or a click outside closes it.
 */
function SavedFiltersMenu({ view, filters, saved }: { view: WorklistView; filters: WorklistFilters; saved: SavedFilter[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = "saved-filters-panel";
  const active = saved.find((f) => sameFilters(f.filters, filters)) ?? null;
  const save = useCommand<{ filterId: string; replaced: boolean }, { view: WorklistView; name: string; filters: WorklistFilters }>("worklist.saveFilter", {
    successToast: (r, i) => (r.replaced ? `Saved filter "${i.name}" updated.` : `Saved filter "${i.name}".`),
    onSuccess: () => setName(""),
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (isDialogOpen() || t?.closest("dialog")) return; // a delete confirmation belongs to this menu
      if (!wrapRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isDialogOpen()) return;
      e.preventDefault(); // the side panel ignores an Escape that closed this menu
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <Button
        ref={buttonRef}
        type="button"
        size="sm"
        variant={active ? "secondary" : "ghost"}
        icon={<Bookmark />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={cn(active && "border-brand bg-brand-50")}
      >
        {active ? (
          <>
            Saved: <span className="max-w-32 truncate">{active.name}</span>
          </>
        ) : (
          <>
            Saved filters <span className="num-tabular text-ink-muted">({saved.length})</span>
          </>
        )}
        <ChevronDown className="size-3.5 text-ink-muted" aria-hidden />
      </Button>
      {open ? (
        <section id={panelId} aria-label="Saved filters" className="absolute right-0 top-full z-30 mt-1 flex w-80 flex-col gap-2 rounded-md border border-line bg-surface p-3 text-sm shadow-2">
          <h3 className="text-xs font-semibold text-ink-secondary">Saved filters for the {VIEW_LABEL[view]} view</h3>
          {saved.length === 0 ? <p className="text-xs text-ink-muted">None yet. Saved filters are yours only; nobody else&apos;s list changes.</p> : null}
          {saved.length ? (
            <ul className="flex flex-col gap-1">
              {saved.map((f) => {
                const isActive = sameFilters(f.filters, filters);
                return (
                  <li key={f.id} className={cn("flex items-center gap-1 rounded-sm border pl-2 pr-0.5", isActive ? "border-brand bg-brand-50" : "border-line")}>
                    <Link
                      href={hrefFor(view, f.filters, null)}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => setOpen(false)}
                      className="min-w-0 flex-1 truncate py-1 text-sm font-medium text-ink hover:underline"
                    >
                      {f.name}
                    </Link>
                    <CommandButton
                      command="worklist.deleteFilter"
                      input={{ filterId: f.id }}
                      variant="quiet"
                      size="sm"
                      aria-label={`Delete saved filter ${f.name}`}
                      pendingLabel="..."
                      showError="toast"
                      confirm={{ title: `Delete saved filter "${f.name}"?`, body: "Only your saved shortcut is removed. No cases or tasks change.", confirmLabel: "Delete saved filter", cancelLabel: "Keep it", destructive: true }}
                      successToast={`Deleted saved filter "${f.name}".`}
                      className="h-6 min-h-6 px-1"
                    >
                      <X className="size-3.5" aria-hidden />
                    </CommandButton>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <form
            className="flex items-center gap-1 border-t border-line pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void save.run({ view, name: name.trim(), filters: stripUndefined({ ...filters }) });
            }}
          >
            <label className="sr-only" htmlFor="save-filter-name">
              Name for the current filters
            </label>
            <Input id="save-filter-name" size="sm" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Name the current filters" className="min-w-0 flex-1" />
            <Button type="submit" size="sm" variant="secondary" loading={save.pending} loadingLabel="Saving..." disabled={!name.trim()}>
              Save
            </Button>
          </form>
          <CommandError error={save.error} />
        </section>
      ) : null}
    </div>
  );
}
