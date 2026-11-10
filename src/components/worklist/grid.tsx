"use client";

import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { ChevronDown, ChevronRight, CirclePause, FlaskConical, TriangleAlert, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PathologistColor } from "@/lib/domain";
import { fmtDate, fmtFull, fmtTime, labDay } from "@/lib/time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { DoctorSwatch, isPathologistColor } from "@/components/domain/doctor-chip";
import { SimulatedLabel } from "@/components/domain/honesty";
import { LabelRef } from "@/components/domain/specimen-label";
import { Timestamp } from "@/components/domain/timestamp";
import type { WorklistGroup, WorklistRow } from "@/server/queries/worklist";
import { COLUMN_LABEL, COLUMN_PRIORITY, type ColumnKey } from "./views";
import { BlocksCell, ChangeTags, HoldList, PartsCell, StainList, UpdateOrigin } from "./cells";

/**
 * The worklist grid: the printed "bible" as a live sheet. One band per assigned dermatopathologist (swatch,
 * name, colour name, case / PAS / hold counts; the band sticks under the column header while its rows scroll),
 * dense rows with identifiers in the identifier mono, PAS rows tinted yellow and always saying "PAS", holds
 * hatched with their scope. Native table semantics: a row group per doctor, rows with an accessible name
 * that starts with the case number, sortable column headers.
 *
 * Yellow on the sheet only ever means PAS: the doctor's colour lives in the band's top rule, its swatch and the
 * colour word, on a neutral band ground. The Stage column folds into Parts on screen (each part already names
 * its step there); print and CSV keep it. Empty cells are a quiet dash that reads "None" to screen readers.
 */

/** Screen columns: Stage is read from Parts (and the side panel), so the step is not repeated three times a row. */
export function screenColumns(columns: ColumnKey[]): ColumnKey[] {
  return columns.filter((c) => c !== "stage");
}

/** Screen header labels; the caption, the overflow hint, print and CSV keep the full names. */
const HEADER_LABEL: Record<ColumnKey, string> = {
  accession: "Case",
  parts: "Parts and stage",
  stage: "Stage",
  stains: "PAS and stains",
  holds: "Hold",
  readiness: "Readiness",
  blocks: "Blocks",
  sourceEntry: "Source entry",
  owner: "Owner",
  lastUpdate: "Updated",
  office: "Office",
  clinician: "Clinician",
};

/**
 * Column widths (cell padding included). Every column but Readiness is sized to its usual content on one line:
 * "D26-04741 New", "PAS (WO-2141) A1-5", "Hold: Part B", "Entry pending: A, B". Readiness, the next step, takes
 * whatever the sheet has left, so a wider screen or a closed side panel gives its room to what can happen next.
 */
const WIDTH: Record<ColumnKey, string> = {
  accession: "w-36",
  // The tablet's larger cell text needs the room the P2 columns give back there ("A ready for sectioning").
  parts: "w-[9.5rem] max-xl:w-44",
  stage: "w-28",
  stains: "w-[12.75rem]",
  holds: "w-[7.75rem]",
  readiness: "min-w-56",
  blocks: "w-20",
  sourceEntry: "w-32",
  owner: "w-24",
  lastUpdate: "w-[7.25rem]",
  office: "w-32",
  clinician: "w-28",
};
/** No stain on any row: the column only needs its header. */
const WIDTH_NO_STAINS = "w-32";
/**
 * Narrower screens: these columns live in the side panel. On the bench tablet (< 1280 px) Updated, Blocks and
 * Task owner hide in every view (Source entry stays in the Grossing view, where it is the work; it hides in
 * Operations below 1360 px), so the case, its parts and stage, PAS, holds and the next step stay on one line
 * where they can; the owner then rides at the end of the Readiness cell ("You" or the name), as it does while
 * the side panel is open. Office and clinician (P3) show from 1280 px, or from 1600 px in the eleven-column
 * Operations view. (Stage never shows on screen: Parts names each part's stage.)
 */
function hideClass(key: ColumnKey, columnCount: number): string | undefined {
  switch (key) {
    case "stage":
      return columnCount > 9 ? "max-[90rem]:hidden" : "max-xl:hidden";
    case "lastUpdate":
    case "blocks":
    case "owner":
      return "max-xl:hidden";
    case "sourceEntry":
      return columnCount > 10 ? "max-[85rem]:hidden" : undefined;
    case "office":
    case "clinician":
      return columnCount > 10 ? "max-[100rem]:hidden" : "max-xl:hidden";
    default:
      return undefined;
  }
}
const WRAP = new Set<ColumnKey>(["parts", "stage", "stains", "holds", "readiness", "sourceEntry", "blocks", "owner", "lastUpdate", "office", "clinician"]);

/**
 * Keyboard focus on a row: the shared row draws the 2 px focus outline; the sticky Case cell (positioned, opaque)
 * paints over the row's own outline, so the same three sides are redrawn inside it (the shared row does this for
 * its selected outline only). The outline's bottom 2 px cover the cell's 1 px rule, so the redrawn bottom is that
 * rule in focus colour plus 1 px above it; the last row of a band has no rule and takes the full 2 px inside.
 */
const STICKY_CELL_FOCUS = [
  "focus-visible:[&>[data-sticky]]:border-b-focus",
  "focus-visible:[&>[data-sticky]]:shadow-[inset_2px_0_0_var(--hlo-focus),inset_0_2px_0_var(--hlo-focus),inset_0_-1px_0_var(--hlo-focus)]",
  "last:focus-visible:[&>[data-sticky]]:shadow-[inset_2px_0_0_var(--hlo-focus),inset_0_2px_0_var(--hlo-focus),inset_0_-2px_0_var(--hlo-focus)]",
];

/** The doctor's colour as a 4 px rule along the TOP of the band (a horizontal rule, never a side stripe or a fill). */
const BAND_RULE: Record<PathologistColor, string> = {
  teal: "shadow-[inset_0_4px_0_var(--hlo-dr-teal)]",
  violet: "shadow-[inset_0_4px_0_var(--hlo-dr-violet)]",
  amber: "shadow-[inset_0_4px_0_var(--hlo-dr-amber)]",
};

export interface GridGroup {
  group: WorklistGroup;
  rows: WorklistRow[];
}

export interface GridProps {
  tableRef: RefObject<HTMLDivElement | null>;
  caption: string;
  columns: ColumnKey[];
  groups: GridGroup[];
  collapsed: Set<string>;
  onToggleGroup: (key: string) => void;
  sortOf: (key: ColumnKey) => "asc" | "desc" | "none";
  onSort: (key: ColumnKey) => void;
  selectedId: string | null;
  /** The row that takes Tab focus (roving tabindex). */
  tabStopId: string | null;
  panelOpen: boolean;
  maxHeight: string;
  scrolledSideways: boolean;
  actorId: string;
  now: string;
  /** Rows matched by the last find are pinged once (key restarts the animation). */
  pingKey: string | null;
  onRowClick: (id: string) => void;
  onRowFocus: (id: string) => void;
  onRowKey: (e: KeyboardEvent<HTMLTableRowElement>, id: string) => void;
}

export function WorklistGrid(p: GridProps) {
  // Hiding rules are keyed to the view's full column count (print and CSV keep every column).
  const count = p.columns.length;
  const columns = screenColumns(p.columns);
  const anyStains = p.groups.some(({ rows }) => rows.some((r) => r.stains.length > 0));
  const widthOf = (key: ColumnKey) => (key === "stains" && !anyStains ? WIDTH_NO_STAINS : WIDTH[key]);
  return (
    <div ref={p.tableRef} className="relative">
      <Table
        caption={p.caption}
        scroll="container"
        maxHeight={p.maxHeight}
        // Side panel open: P2 and P3 details are in the panel, so the list keeps every P1 column visible.
        hideP2={p.panelOpen}
        wrapperClassName={cn(
          // Rows revealed by focus stop below the sticky column header and doctor band (WCAG 2.4.11).
          "scroll-pt-[5.5rem] rounded-none rounded-b-lg border-0 border-t border-line",
          // Scrolled sideways: a rule on the sticky Case column shows where the scrolled columns slide under it.
          p.scrolledSideways && "[&_tr>td:first-child]:border-r [&_tr>td:first-child]:border-r-line-strong [&_thead_th:first-child]:border-r [&_thead_th:first-child]:border-r-line-strong",
        )}
      >
        <THead>
          <tr>
            {columns.map((key) => (
              <TH
                key={key}
                data-label={key === "parts" ? "Parts and stage" : COLUMN_LABEL[key]}
                stickyFirst={key === "accession"}
                priority={COLUMN_PRIORITY[key]}
                sort={p.sortOf(key)}
                onSort={() => p.onSort(key)}
                title={key === "parts" ? "Each part and the stage it is at (sorts by stage)" : HEADER_LABEL[key] !== COLUMN_LABEL[key] ? COLUMN_LABEL[key] : undefined}
                className={cn("px-2.5", hideClass(key, count), widthOf(key))}
              >
                {HEADER_LABEL[key]}
              </TH>
            ))}
          </tr>
        </THead>
        {p.groups.map(({ group, rows }) => (
          <TBody key={group.key}>
            <BandRow group={group} span={columns.length} collapsed={p.collapsed.has(group.key)} onToggle={() => p.onToggleGroup(group.key)} />
            {p.collapsed.has(group.key)
              ? null
              : rows.map((r) => (
                  <GridRow
                    key={r.id}
                    row={r}
                    columns={columns}
                    columnCount={count}
                    selected={p.selectedId === r.id}
                    tabStop={p.tabStopId === r.id}
                    widthOf={widthOf}
                    ownerInline={p.panelOpen}
                    actorId={p.actorId}
                    now={p.now}
                    pingKey={p.pingKey}
                    onClick={p.onRowClick}
                    onFocus={p.onRowFocus}
                    onKey={p.onRowKey}
                  />
                ))}
          </TBody>
        ))}
      </Table>
    </div>
  );
}

function BandRow({ group, span, collapsed, onToggle }: { group: WorklistGroup; span: number; collapsed: boolean; onToggle: () => void }) {
  const color = isPathologistColor(group.colorToken) ? group.colorToken : null;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const noun = group.kind === "routing_exception" ? (group.counts.rows === 1 ? "item" : "items") : group.counts.rows === 1 ? "case" : "cases";
  return (
    <tr>
      <th
        scope="colgroup"
        colSpan={span}
        className={cn(
          // Neutral ground: on this sheet yellow belongs to PAS alone, so the doctor's colour is the rule, swatch and word.
          "sticky top-8 z-[6] h-12 border-b border-line-strong bg-surface-subtle p-0 pt-1 text-left font-normal",
          color ? BAND_RULE[color] : "border-t border-dashed border-t-line-strong",
        )}
      >
        <div className="sticky left-0 flex w-max items-center gap-x-4 px-3">
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggle}
            title={collapsed ? "Show this doctor's rows" : "Collapse this doctor's rows"}
            className="-ml-1 inline-flex min-h-[max(2.25rem,var(--hlo-target-min))] items-center gap-2 rounded-sm px-1 text-left hover:bg-surface"
          >
            <Chevron className="size-4 shrink-0 text-ink-secondary" aria-hidden />
            <DoctorSwatch color={color} className="size-4 rounded-[4px]" />
            {group.kind === "doctor" ? (
              <span className="text-md font-bold text-ink">
                {group.name} <span className="font-normal text-ink-secondary">({group.colorName ?? "no color"})</span>
              </span>
            ) : (
              <span className="text-md font-semibold text-ink-secondary">{group.kind === "routing_exception" ? "Unassigned: routing exception" : group.name}</span>
            )}
          </button>
          <span className="flex items-center gap-3 text-sm text-ink-secondary">
            <span>
              <span className="num-tabular font-semibold text-ink">{group.counts.rows}</span> {noun}
            </span>
            {group.counts.pas ? (
              <span className="hlo-pas-tag inline-flex h-6 items-center gap-1 rounded-sm border border-pas-border bg-pas-bg px-1.5 text-xs font-semibold text-pas-fg">
                <FlaskConical className="size-3.5 shrink-0" aria-hidden />
                <span className="num-tabular">{group.counts.pas}</span> PAS
              </span>
            ) : (
              <span className="text-ink-muted">No PAS</span>
            )}
            {group.counts.onHold ? (
              <span className="hlo-pill hatch inline-flex h-6 items-center gap-1 rounded-sm border border-hold-border px-1.5 text-xs font-semibold text-hold-fg">
                <CirclePause className="size-3.5 shrink-0 text-hold-solid" aria-hidden />
                <span className="num-tabular">{group.counts.onHold}</span> on hold
              </span>
            ) : (
              <span className="text-ink-muted">None on hold</span>
            )}
            {group.counts.pasReview ? (
              <span className="inline-flex items-center gap-1 font-medium text-warning-fg">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                <span className="num-tabular">{group.counts.pasReview}</span> canceled or amended PAS to review
              </span>
            ) : null}
          </span>
        </div>
      </th>
    </tr>
  );
}

function rowLabel(r: WorklistRow): string {
  return `${r.accessionNumber ?? `Provisional ${r.provisionalId}`}, ${r.partsSummary}${r.hasPas ? ", PAS" : ""}${r.holds.length ? `, on hold: ${r.holds.map((h) => h.scopeLabel).join(", ")}` : ""}${r.changeTags.length ? `, ${r.changeTags.join(" and ")}` : ""}${r.pasNeedsReview ? ", canceled or amended PAS needs review" : ""}`;
}

function GridRow({
  row: r,
  columns,
  columnCount,
  selected,
  tabStop,
  widthOf,
  ownerInline,
  actorId,
  now,
  pingKey,
  onClick,
  onFocus,
  onKey,
}: {
  row: WorklistRow;
  columns: ColumnKey[];
  columnCount: number;
  selected: boolean;
  tabStop: boolean;
  widthOf: (key: ColumnKey) => string;
  /** The Owner column is hidden by the open side panel: the owner rides in the Readiness cell at every width. */
  ownerInline: boolean;
  actorId: string;
  now: string;
  pingKey: string | null;
  onClick: (id: string) => void;
  onFocus: (id: string) => void;
  onKey: (e: KeyboardEvent<HTMLTableRowElement>, id: string) => void;
}) {
  const canceled = r.change === "canceled" && r.stains.every((s) => s.canceled) && !r.stains.some((s) => s.needsReview);
  return (
    // The shared row: selected is an outline (redrawn on the sticky Case cell), holds hatch the Case cell, PAS rows
    // keep the yellow tint when selected or hovered, focus is the shared outline. Plain rows get an opaque ground
    // so the sticky Case cell (bg-inherit) hides the columns that scroll under it.
    <TR
      data-row-id={r.id}
      tabIndex={tabStop ? 0 : -1}
      selected={selected}
      hold={r.holds.length > 0}
      pas={r.hasPas}
      canceled={canceled}
      interactive
      aria-label={rowLabel(r)}
      onClick={(e: MouseEvent<HTMLTableRowElement>) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        onClick(r.id);
      }}
      onFocus={() => onFocus(r.id)}
      onKeyDown={(e) => onKey(e, r.id)}
      className={cn("transition-colors duration-[var(--hlo-duration-fast)]", !selected && !r.hasPas && "bg-surface", ...STICKY_CELL_FOCUS)}
    >
      {columns.map((key) => (
        <TD key={key} priority={COLUMN_PRIORITY[key]} stickyFirst={key === "accession"} wrap={WRAP.has(key)} className={cn("px-2.5 py-1", hideClass(key, columnCount), widthOf(key))}>
          <RowCell column={key} row={r} actorId={actorId} now={now} ping={pingKey} ownerInline={ownerInline} />
        </TD>
      ))}
    </TR>
  );
}

function RowCell({
  column,
  row: r,
  actorId,
  now,
  ping,
  ownerInline,
}: {
  column: ColumnKey;
  row: WorklistRow;
  actorId: string;
  now: string;
  ping: string | null;
  ownerInline: boolean;
}) {
  switch (column) {
    case "accession":
      return r.accessionNumber ? (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span key={ping ?? "id"} className={cn("rounded-sm", ping && "animate-scan-ping")}>
            <span className="sr-only">Accession </span>
            <span className="id-mono text-[0.875rem] font-semibold text-ink">{r.accessionNumber}</span>
          </span>
          <ChangeTags tags={r.changeTags} />
          {r.priority === "rush" ? <RushTag /> : null}
        </span>
      ) : (
        // A provisional intake item is set as its dashed label (never the solid look of an accession number), with
        // the word "Provisional" kept in view under it beside its change tags.
        <span className="flex flex-col items-start gap-0.5">
          <span key={ping ?? "id"} className={cn("rounded-sm", ping && "animate-scan-ping")}>
            <LabelRef id={r.provisionalId!} provisional />
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-ink-muted" aria-hidden>
              Provisional
            </span>
            <ChangeTags tags={r.changeTags} />
            {r.priority === "rush" ? <RushTag /> : null}
          </span>
        </span>
      );
    case "parts":
      return <PartsCell row={r} />;
    case "stage":
      return <span className="text-ink-secondary">{r.stageLabel}</span>;
    case "stains":
      return r.stains.length ? <StainList stains={r.stains} compact /> : <Blank />;
    case "holds":
      return r.holds.length ? <HoldList holds={r.holds} stacked /> : <Blank />;
    case "readiness":
      // The next step, and who owns it wherever the Owner column is not shown (bench tablet, side panel open).
      return (
        // The owner follows the readiness text and wraps under it only when the line runs out of room.
        // Never clamped: the end of the sentence is the action and where the material is (a routing
        // exception's "a lead must assign…", "on TRY-M-03 (tray not delivered)"), so the row grows instead.
        <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="min-w-[min(100%,14rem)] flex-1" title={[...r.eligibleShort.map((e) => `Eligible: ${e}`), ...r.blockedShort.map((b) => `Not ready: ${b}`)].join("\n")}>
            {r.readinessText}
          </span>
          {r.owner || r.unownedOwner ? <InlineOwner row={r} actorId={actorId} className={ownerInline ? "inline-flex" : "hidden max-xl:inline-flex"} /> : null}
        </span>
      );
    case "blocks":
      return <BlocksCell blocks={r.blocks} brief />;
    case "sourceEntry":
      if (!r.sourceEntry.pendingParts.length && !r.sourceEntry.attestedParts.length) return <Blank label="None pending" />;
      // Pending is Sam's work; "Attested" means a person entered it and the simulated source has not acknowledged it.
      return r.sourceEntry.pendingParts.length ? (
        <span className="font-medium text-ink" title={r.sourceEntry.text}>
          Entry pending: {r.sourceEntry.pendingParts.join(", ")}
        </span>
      ) : (
        <span className="text-ink-secondary" title={`Entered in the source system (staff attested), awaiting the simulated source's acknowledgment. ${r.sourceEntry.text}`}>
          Attested: {r.sourceEntry.attestedParts.join(", ")}
          <span className="sr-only"> (entered by staff, awaiting the simulated source)</span>
        </span>
      );
    case "owner":
      return <OwnerCell row={r} actorId={actorId} />;
    case "lastUpdate":
      return (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" title={[r.lastUpdate.origin === "Local" ? "Local update" : null, r.lastUpdate.summary].filter(Boolean).join(": ") || undefined}>
          <UpdatedAt iso={r.lastUpdate.at} now={now} />
          {/* Local is the usual origin and says so in the panel; only a simulated source update (or an unknown origin)
              is marked on the row: the shared "Simulated" label with its plug, in words, under the time. */}
          {r.lastUpdate.origin === "Local" ? (
            <span className="sr-only">, local</span>
          ) : r.lastUpdate.origin ? (
            <span title="From the simulated source system" className="inline-flex">
              <SimulatedLabel size="xs" />
              <span className="sr-only">: from the simulated source</span>
            </span>
          ) : (
            <UpdateOrigin origin={null} />
          )}
        </span>
      );
    case "office":
      return <span>{r.office}</span>;
    case "clinician":
      return r.clinician ? <span>{r.clinician}</span> : <span className="text-ink-muted">Unknown</span>;
  }
}

/**
 * The last update in a dense cell: today's time ("8:15 AM ET"), or the day for an earlier update ("Oct 13"), with
 * the full time in the tooltip and for screen readers (the side panel shows it in full).
 */
function UpdatedAt({ iso, now }: { iso: string | null; now: string }) {
  if (!iso || labDay(iso) === labDay(now)) return <Timestamp iso={iso} now={now} />;
  return (
    <time dateTime={iso} title={fmtFull(iso)} className="num-tabular whitespace-nowrap">
      {fmtDate(iso)}
      <span className="sr-only">, {fmtTime(iso)} ET</span>
    </time>
  );
}

function RushTag() {
  return <span className="rounded-sm border border-warning-border bg-warning-bg px-1 text-xs font-semibold text-warning-fg">Rush</span>;
}

/** An empty cell: a quiet dash on screen, "None" (or the given words) to a screen reader. */
function Blank({ label = "None" }: { label?: string }) {
  return (
    <span className="text-ink-muted">
      <span aria-hidden>–</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The current task owner; the viewer's own tasks read "You" so a bench user finds hers at a glance. */
function OwnerCell({ row: r, actorId }: { row: WorklistRow; actorId: string }) {
  // Waiting work with no task still says who should own it (as Operations does), never a blank.
  if (!r.owner) return r.unownedOwner ? <span title={r.ownerText} className="text-ink-muted">{r.unownedOwner}</span> : <Blank />;
  const mine = r.owner.ownerId === actorId;
  const more = r.tasks.length > 1 ? <span className="text-ink-muted"> +{r.tasks.length - 1}</span> : null;
  if (mine) {
    return (
      <span title={r.ownerText}>
        <span className="inline-flex h-6 items-center rounded-sm bg-shell px-1.5 text-xs font-semibold text-shell-fg">You</span>
        <span className="sr-only"> ({r.owner.ownerName})</span>
        {more}
      </span>
    );
  }
  return (
    <span title={r.ownerText}>
      {r.owner.ownerName ?? <span className="text-ink-muted">Unassigned ({(r.owner.ownerRole ?? "role unknown").replace(/_/g, " ")})</span>}
      {more}
    </span>
  );
}

/**
 * The task owner inside the Readiness cell where the Owner column is not shown: "You" for the viewer's own task,
 * otherwise the owner's name after a person mark, so the next step and its owner read together.
 */
function InlineOwner({ row: r, actorId, className }: { row: WorklistRow; actorId: string; className?: string }) {
  if (!r.owner) {
    if (!r.unownedOwner) return null;
    return (
      <span title={`Current task owner: ${r.ownerText}`} className={cn("shrink-0 items-center gap-1 whitespace-nowrap text-ink-muted", className)}>
        <span className="sr-only">Owner: </span>
        <UserRound className="size-3.5 shrink-0" aria-hidden />
        {r.unownedOwner}
      </span>
    );
  }
  const mine = r.owner.ownerId === actorId;
  const more = r.tasks.length > 1 ? <span className="text-ink-muted"> +{r.tasks.length - 1}</span> : null;
  return (
    <span title={`Current task owner: ${r.ownerText}`} className={cn("shrink-0 items-center gap-1 whitespace-nowrap text-ink-secondary", className)}>
      <span className="sr-only">Owner: </span>
      {mine ? (
        <>
          <span className="inline-flex h-6 items-center rounded-sm bg-shell px-1.5 text-xs font-semibold text-shell-fg">You</span>
          <span className="sr-only"> ({r.owner.ownerName})</span>
        </>
      ) : (
        <>
          <UserRound className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
          {r.owner.ownerName ?? "Unassigned"}
        </>
      )}
      {more}
    </span>
  );
}
