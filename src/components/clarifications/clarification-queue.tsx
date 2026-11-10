"use client";

import type { KeyboardEvent, MouseEvent } from "react";
import { Check, Hourglass, Inbox, LoaderCircle, Minus, PencilLine, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ButtonLink } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { HoldPill } from "@/components/domain/hold";
import { LabelRef } from "@/components/domain/specimen-label";
import { Timestamp } from "@/components/domain/timestamp";
import type { ClarificationFilter, ClarificationListRow } from "@/server/queries/clarifications";
import { holdScopeWords, materialWords, rowFlag, rowWhen, type Flag, type Rung } from "./ladder";

export function selectionHref(tab: ClarificationFilter, selected: string | null): string {
  const p = new URLSearchParams();
  p.set("tab", tab);
  if (selected) p.set("selected", selected);
  return `/clarifications?${p.toString()}`;
}

const EMPTY: Record<ClarificationFilter, { title: string; body: string }> = {
  my_open: {
    title: "No open questions for you",
    body: "Questions you raise, own, or have a task on appear here. Raise one from a differing row on the Intake screen.",
  },
  overdue: { title: "Nothing overdue", body: "Questions waiting on an office past their next follow-up time appear here." },
  awaiting_office: { title: "Nothing waiting on an office", body: "Sent questions appear here until the office answers." },
  needs_review: {
    title: "No answers waiting for review",
    body: "When an office answers, the question appears here for a lead or supervisor to review and resolve. A closed question stays here while its hold waits to be released.",
  },
  resolved: { title: "Nothing resolved yet", body: "Resolved and canceled questions appear here with their resolution notes." },
  all: { title: "No clarifications yet", body: "New ones appear here when a discrepancy is recorded at intake or grossing." },
};

const READ_ONLY_EMPTY = {
  title: "Nothing is yours here",
  body: "Read-only roles do not own clarifications. The All tab lists every question and who is working on it.",
};

const FLAG_ICON: Record<Rung, typeof Check> = { warning: TriangleAlert, waiting: Hourglass, draft: PencilLine, done: Check, muted: Minus };

/**
 * A question's state on the ladder, in words: amber for overdue or a delivery
 * problem, a dashed edge only for a draft that has not been sent, neutral ink
 * for waiting, a quiet check for resolved.
 */
export function FlagChip({ flag }: { flag: Flag }) {
  const Icon = FLAG_ICON[flag.rung];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm text-sm leading-5",
        flag.rung === "warning" && "bg-warning-bg px-1.5 font-medium text-warning-fg",
        flag.rung === "draft" && "border border-dashed border-ink-muted px-1.5 text-ink",
        flag.rung === "waiting" && "text-ink-secondary",
        (flag.rung === "done" || flag.rung === "muted") && "text-ink-muted",
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", flag.rung === "warning" ? "text-warning-solid" : "text-ink-muted")} aria-hidden />
      <span className="truncate">{flag.text}</span>
    </span>
  );
}

function QueueRow({
  r,
  href,
  selected,
  tabbable,
  pending,
  pingKey,
  now,
  onOpen,
  onKeyDown,
}: {
  r: ClarificationListRow;
  href: string;
  selected: boolean;
  tabbable: boolean;
  pending: boolean;
  pingKey: number | null;
  now: string;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLAnchorElement>, displayId: string) => void;
}) {
  const flag = rowFlag(r);
  const when = rowWhen(r);
  const m = r.material;
  const words = materialWords(m);
  // A closed question whose hold is still to be released is still lead work: not greyed out.
  const closed = !r.isOpen && !r.holdToRelease;
  const label = [
    r.displayId,
    `${r.categoryLabel} question on ${m.kind === "provisional" ? "provisional " : ""}${r.affectedLabel}`,
    flag.text,
    r.activeHolds.length ? `on hold: ${r.activeHolds.map((h) => holdScopeWords(h.scopeShort)).join(", ")}` : null,
    when,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li className="relative">
      <a
        href={href}
        onClick={(e) => onOpen(e, r.displayId)}
        onKeyDown={(e) => onKeyDown(e, r.displayId)}
        aria-current={selected ? "true" : undefined}
        aria-busy={pending || undefined}
        aria-label={label}
        tabIndex={tabbable ? 0 : -1}
        data-clr-row={r.displayId}
        className={cn(
          "relative block scroll-mt-2 scroll-mb-2 rounded-md px-3 py-2.5 outline-offset-[-2px] transition-colors duration-[var(--hlo-duration-fast)]",
          // Selected: the white sheet outlined in hematoxylin (the shell colour), all the way round; never a side stripe.
          selected ? "bg-surface shadow-1 ring-1 ring-shell" : "hover:bg-surface/70",
        )}
      >
        {pingKey ? <span key={pingKey} aria-hidden className="animate-scan-ping pointer-events-none absolute inset-0 rounded-md" /> : null}
        <span className="flex min-w-0 items-center gap-2">
          <LabelRef id={m.labelId} provisional={m.kind === "provisional"} className={closed ? "border-ink-muted text-ink-secondary" : undefined} />
          {words ? <span className={cn("shrink-0 text-sm font-semibold", closed ? "text-ink-secondary" : "text-ink")}>{words}</span> : null}
          {pending ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-ink-muted motion-reduce:animate-none" aria-hidden /> : null}
          <span className={cn("id-mono ml-auto shrink-0 text-sm", selected ? "text-ink" : "text-ink-muted")}>{r.displayId}</span>
        </span>
        <span className={cn("mt-1 block truncate text-base leading-5", closed ? "text-ink-secondary" : "font-medium text-ink", selected && !closed && "font-semibold")}>{r.categoryLabel}</span>
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <FlagChip flag={flag} />
          {r.activeHolds.length ? <HoldPill scope={holdScopeWords(r.activeHolds[0].scopeShort)} /> : null}
          {when ? <span className="ml-auto shrink-0 text-sm text-ink-secondary">{when}</span> : null}
          {closed ? (
            <span className="ml-auto shrink-0 text-sm text-ink-muted">
              <Timestamp iso={r.lastEventAt} now={now} />
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}

/**
 * The queue: questions ordered by urgency (overdue and delivery problems
 * first, then answers waiting for review, then by next follow-up). Each row
 * leads with the affected material as its label reference (dashed while
 * provisional), the question type in words, the state on the ladder, the hold
 * with its scope, and the next follow-up time. Below 1280px, while a question
 * is open, it becomes a drawer opened from the identity band.
 */
export function ClarificationQueue({
  rows,
  filter,
  selected,
  total,
  allCount,
  sortNote,
  readOnly,
  now,
  pendingId,
  ping,
  drawer,
  drawerOpen,
  onCloseDrawer,
  onOpen,
  onRowKey,
}: {
  rows: ClarificationListRow[];
  filter: ClarificationFilter;
  selected: string | null;
  total: number;
  /** Questions in the All filter, for the empty list's way out. */
  allCount: number;
  sortNote: string;
  readOnly: boolean;
  now: string;
  pendingId: string | null;
  ping: { id: string; n: number } | null;
  /** A question is open: below 1280px the queue is a drawer. */
  drawer: boolean;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void;
  onRowKey: (e: KeyboardEvent<HTMLAnchorElement>, displayId: string) => void;
}) {
  const selectedIndex = rows.findIndex((r) => r.displayId === selected || r.id === selected);
  const tabIndexRow = selectedIndex >= 0 ? selectedIndex : 0;
  const empty = readOnly && filter === "my_open" ? READ_ONLY_EMPTY : EMPTY[filter];
  return (
    <>
      {drawer && drawerOpen ? <button type="button" aria-label="Close the queue" onClick={onCloseDrawer} className="fixed inset-0 z-30 bg-shell/30 xl:hidden" /> : null}
      <aside
        id="clr-queue"
        aria-label="Clarification queue"
        className={cn(
          "relative flex min-h-0 min-w-0 flex-col bg-canvas lg:border-r lg:border-line",
          drawer &&
            "max-xl:fixed max-xl:top-[var(--hlo-topbar-h)] max-xl:bottom-0 max-xl:left-0 max-xl:z-40 max-xl:w-[min(360px,100vw)] max-xl:border-r max-xl:border-line max-xl:shadow-3 max-xl:transition-transform max-xl:duration-[var(--hlo-duration-base)] max-xl:ease-[var(--hlo-ease)]",
          drawer && (drawerOpen ? "max-xl:translate-x-0" : "max-xl:invisible max-xl:-translate-x-[110%]"),
        )}
      >
        {drawer ? (
          <div className="flex items-center justify-between px-3 pt-2 xl:hidden">
            <p className="text-md font-semibold text-ink">Queue</p>
            <button type="button" onClick={onCloseDrawer} className="inline-flex size-11 items-center justify-center rounded-md text-ink-secondary hover:bg-surface" aria-label="Close the queue">
              <X className="size-5" aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="shrink-0 border-b border-line px-4 pt-3 pb-2">
          <p className="text-sm text-ink-secondary" aria-live="polite">
            <span className="num-tabular font-semibold text-ink">{rows.length}</span> of <span className="num-tabular">{total}</span> questions
          </p>
          {rows.length > 1 ? <p className="text-sm text-ink-muted">{sortNote.replace(/^Sorted: /, "").replace(/^./, (c) => c.toUpperCase())}.</p> : null}
        </div>
        <div className={cn("relative min-h-0 flex-1 pt-1.5 pb-2 lg:overflow-y-auto", drawer && "max-xl:overflow-y-auto")}>
          {rows.length ? (
            <ul className="space-y-0.5 px-1.5">
              {rows.map((r, i) => (
                <QueueRow
                  key={r.id}
                  r={r}
                  href={selectionHref(filter, r.displayId)}
                  selected={i === selectedIndex}
                  tabbable={i === tabIndexRow}
                  pending={pendingId === r.displayId}
                  pingKey={ping && ping.id === r.displayId ? ping.n : null}
                  now={now}
                  onOpen={onOpen}
                  onKeyDown={onRowKey}
                />
              ))}
            </ul>
          ) : (
            // The one empty message for this filter (no box): what it is, why it is empty, the way out.
            <div className="px-4 pt-2 pb-3">
              <p className="flex items-center gap-2 text-base font-semibold text-ink">
                <Inbox className="size-4 shrink-0 text-ink-muted" aria-hidden />
                {empty.title}
              </p>
              <p className="mt-1 text-sm text-ink-secondary">{empty.body}</p>
              {filter !== "all" && allCount > 0 ? (
                <ButtonLink href={selectionHref("all", selected)} scroll={false} variant="secondary" className="mt-3">
                  Open All ({allCount})
                </ButtonLink>
              ) : null}
            </div>
          )}
        </div>
        <p className="shrink-0 border-t border-line px-4 py-2.5 text-sm text-ink-muted max-lg:hidden">
          <span aria-hidden>
            <Kbd>J</Kbd> <Kbd>K</Kbd> next, previous <span className="ml-2" /> <Kbd>Esc</Kbd> close
          </span>
          <span className="sr-only">Press J or K for the next or previous question; Escape closes it.</span>
        </p>
      </aside>
    </>
  );
}
