"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { Table, THead, TBody, TH, TR, TD, TableCount, type SortDirection } from "@/components/ui/table";
import { StatePill } from "@/components/ui/status-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { HoldPill } from "@/components/domain/hold";
import { Timestamp } from "@/components/domain/timestamp";
import { useSingleKey } from "@/lib/client/keyboard";
import type { ClarificationFilter, ClarificationListRow } from "@/server/queries/clarifications";

type SortKey = "default" | "id" | "followUp" | "lastEvent";

const EMPTY: Record<ClarificationFilter, { title: string; body: string }> = {
  my_open: {
    title: "No open clarifications for you",
    body: "Clarifications you raise, own, or have a task on appear here. Raise one from a differing row on the Intake screen.",
  },
  overdue: { title: "Nothing overdue", body: "Clarifications waiting on an office past their next follow-up time appear here." },
  awaiting_office: { title: "Nothing waiting on an office", body: "Sent clarifications appear here until the office answers." },
  needs_review: { title: "No answers waiting for review", body: "When an office answers, the clarification appears here for a lead or supervisor to review and resolve." },
  resolved: { title: "Nothing resolved yet", body: "Resolved and canceled clarifications appear here with their resolution notes." },
  all: { title: "No clarifications yet", body: "New ones appear here when a discrepancy is recorded at intake or grossing." },
};

const PRIORITY_LABEL: Record<string, string> = { urgent: "Urgent", high: "High", routine: "Routine" };

/**
 * Hold scope for the queue pill. When the hold covers exactly the affected
 * material the row already names it, so the pill just says "Hold"; otherwise
 * the scope is named ("Hold: INT-1014-022").
 */
function holdScopeText(r: ClarificationListRow): string | undefined {
  const norm = (t: string) => t.replace(/\s*\(.*\)$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const scopes = [...new Set(r.activeHolds.map((h) => h.scopeLabel.replace(/\s*\(.*\)$/, "").trim()))];
  if (scopes.length === 1 && (norm(scopes[0]) === norm(r.affectedLabel) || norm(scopes[0]) === norm(r.affectedLabel.split(" · ")[0]))) return undefined;
  return scopes.join(", ");
}

export function selectionHref(tab: ClarificationFilter, selected: string | null): string {
  const p = new URLSearchParams();
  p.set("tab", tab);
  if (selected) p.set("selected", selected);
  return `/clarifications?${p.toString()}`;
}

export function ClarificationQueue({
  rows,
  filter,
  selected,
  now,
  total,
  sortNote,
  panelOpen,
  onNavigate,
}: {
  rows: ClarificationListRow[];
  filter: ClarificationFilter;
  selected: string | null;
  now: string;
  total: number;
  sortNote: string;
  panelOpen: boolean;
  /** "keys" = J/K (keep focus in the list); "open" = click or Enter (focus the panel). */
  onNavigate?: (source: "keys" | "open") => void;
}) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "default", dir: "asc" });
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const sorted = useMemo(() => {
    if (sort.key === "default") return rows;
    const val = (r: ClarificationListRow): number | string => {
      if (sort.key === "id") return r.displayId;
      if (sort.key === "lastEvent") return Date.parse(r.lastEventAt);
      return r.nextFollowUpAt ? Date.parse(r.nextFollowUpAt) : Number.POSITIVE_INFINITY;
    };
    const list = [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.dir === "asc" ? list : list.reverse();
  }, [rows, sort]);

  const selectedIndex = sorted.findIndex((r) => r.displayId === selected || r.id === selected);
  const [focusIndex, setFocusIndex] = useState(Math.max(0, selectedIndex));
  useEffect(() => {
    if (selectedIndex >= 0) setFocusIndex(selectedIndex);
  }, [selectedIndex]);

  // Closing the panel (Esc, close button, Back) returns focus to the row it was opened from (spec §5.4),
  // even when the panel's own focus memory is lost (e.g. effects re-run in development).
  const lastSelected = useRef<string | null>(selected);
  useEffect(() => {
    const prev = lastSelected.current;
    lastSelected.current = selected;
    if (!prev || selected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const idx = sorted.findIndex((r) => r.displayId === prev || r.id === prev);
    if (idx >= 0) {
      setFocusIndex(idx);
      rowRefs.current[idx]?.focus();
    }
  }, [selected, sorted]);

  const open = (index: number, moveFocus: boolean) => {
    const row = sorted[index];
    if (!row) return;
    onNavigate?.(moveFocus ? "keys" : "open");
    setFocusIndex(index);
    if (moveFocus) rowRefs.current[index]?.focus();
    router.push(selectionHref(filter, row.displayId), { scroll: false });
  };

  const step = (delta: number) => {
    if (!sorted.length) return;
    const base = selectedIndex >= 0 ? selectedIndex : focusIndex;
    const next = Math.min(sorted.length - 1, Math.max(0, base + delta));
    // J/K keep focus in the list; the panel follows along.
    open(next, true);
  };

  useSingleKey({ j: () => step(1), k: () => step(-1) });

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(index, false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = Math.min(sorted.length - 1, index + 1);
      setFocusIndex(n);
      rowRefs.current[n]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.max(0, index - 1);
      setFocusIndex(n);
      rowRefs.current[n]?.focus();
    }
  };

  const sortProps = (key: SortKey) => ({
    sort: (sort.key === key ? sort.dir : "none") as SortDirection,
    onSort: () =>
      setSort((s) => (s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : { key: "default", dir: "asc" })),
  });

  if (!rows.length) {
    const e = EMPTY[filter];
    return <EmptyState title={e.title}>{e.body}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <TableCount shown={rows.length} total={total} noun="clarifications" />
        <p className="text-xs text-ink-muted">
          {sort.key === "default" ? sortNote : "Sorted by the selected column. Select it again to change direction, a third time for the default order."}
          {" · "}
          <kbd className="id-mono">J</kbd>/<kbd className="id-mono">K</kbd> move, <kbd className="id-mono">Enter</kbd> opens, <kbd className="id-mono">Esc</kbd> closes
        </p>
      </div>
      {/* P1 columns always fit without sideways scrolling: panel open (desktop push layout) hides P2 and P3; below 1536px P3 (priority, last event; both in the panel) is hidden and, on a tablet, P2 may scroll. */}
      <Table
        caption={`Clarifications: ${sort.key === "default" ? sortNote : "custom sort"}`}
        hideP3={panelOpen}
        hideP2={panelOpen}
        wrapperClassName={cn("max-2xl:[&_[data-priority='3']]:hidden", panelOpen && "[&_td]:px-2 [&_th]:px-2")}
        maxHeight="calc(100vh - 250px)"
      >
        <THead>
          <tr>
            <TH stickyFirst priority={1} {...sortProps("id")}>
              CLR
            </TH>
            <TH priority={1}>Affected material</TH>
            <TH priority={1}>Type</TH>
            <TH priority={1}>State</TH>
            <TH priority={1} {...sortProps("followUp")}>
              Next follow-up
            </TH>
            <TH priority={2}>Office</TH>
            {/* Tablet: the contact role is in the panel; the table keeps CLR to lab owner without sideways scrolling. */}
            <TH priority={2} className="max-xl:hidden">
              Office contact role
            </TH>
            <TH priority={2}>Lab owner</TH>
            <TH priority={3}>Priority</TH>
            <TH priority={3} {...sortProps("lastEvent")}>
              Last event
            </TH>
          </tr>
        </THead>
        <TBody>
          {sorted.map((r, i) => {
            const isSel = i === selectedIndex;
            const overdue = r.overdueMinutes !== null;
            return (
              <TR
                key={r.id}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                selected={isSel}
                hold={r.activeHolds.length > 0}
                canceled={r.state === "canceled"}
                interactive
                tabIndex={i === focusIndex ? 0 : -1}
                onClick={() => open(i, false)}
                onKeyDown={(e) => onRowKey(e, i)}
                onFocus={() => setFocusIndex(i)}
                aria-label={`${r.displayId}, ${r.categoryLabel}, ${r.affectedLabel}, ${r.stateLabel}${overdue ? `, ${r.followUpText}` : ""}`}
                className="focus-visible:outline-2 focus-visible:-outline-offset-2"
              >
                <TD stickyFirst priority={1}>
                  <span className="id-mono font-medium">{r.displayId}</span>
                </TD>
                <TD priority={1} wrap>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
                    {/* "INT-1014-022 · ORD-75469 Part A": each identifier stays whole; the line may break between them. */}
                    <span className="flex flex-wrap gap-x-1.5">
                      {r.affectedLabel.split(" · ").map((part, k, all) => {
                        // "INT-1014-022 (all containers)": the identifier in mono, the scope words in text.
                        const m = /^(.*?) (\(.+\))$/.exec(part);
                        return (
                          <span key={k}>
                            <span className="id-mono">{m ? m[1] : part}</span>
                            {m ? <span className="text-ink-secondary"> {m[2]}</span> : null}
                            {k < all.length - 1 ? <span className="id-mono"> ·</span> : ""}
                          </span>
                        );
                      })}
                    </span>
                    {r.activeHolds.length ? <HoldPill scope={holdScopeText(r)} /> : null}
                  </span>
                </TD>
                <TD priority={1} wrap className="min-w-[8rem]">
                  {r.categoryLabel}
                </TD>
                <TD priority={1}>
                  <StatePill domain="clarification" state={r.state} size="sm" />
                </TD>
                <TD priority={1} wrap className="min-w-[7rem]">
                  <span className={cn("inline-flex items-center gap-1", overdue ? "font-medium whitespace-nowrap text-danger-fg" : r.isOpen ? "text-ink" : "text-ink-muted")}>
                    {overdue ? <AlertTriangle className="size-3.5 shrink-0 text-danger-solid" aria-hidden /> : r.nextFollowUpAt && r.isOpen ? <Clock className="size-3.5 shrink-0 text-ink-muted" aria-hidden /> : null}
                    {r.followUpText}
                  </span>
                </TD>
                <TD priority={2} wrap className="min-w-[8rem]">
                  {r.officeName}
                </TD>
                <TD priority={2} wrap className="min-w-[8rem] max-xl:hidden">
                  {r.contactRole}
                </TD>
                <TD priority={2} wrap className="min-w-[5.5rem]">
                  {r.labOwnerName}
                </TD>
                <TD priority={3}>{PRIORITY_LABEL[r.priority] ?? r.priority}</TD>
                <TD priority={3}>
                  <span className="text-ink-secondary">{r.lastEventLabel}</span> <Timestamp iso={r.lastEventAt} now={now} className="text-ink-muted" />
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
