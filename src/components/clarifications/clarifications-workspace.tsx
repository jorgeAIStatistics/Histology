"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ReadOnlyTag } from "@/components/domain/honesty";
import { isDialogOpen, isEditableTarget, useSingleKey } from "@/lib/client/keyboard";
import { hasUnsavedChanges, unsavedLabels } from "@/lib/client/unsaved";
import { cn } from "@/lib/cn";
import type { ClarificationDetail, ClarificationFilter, ClarificationQueue as Queue, DeskAttention } from "@/server/queries/clarifications";
import { ClarificationQueue, selectionHref } from "./clarification-queue";
import { ClarificationNotFound, ClarificationRecord } from "./clarification-record";
import { DeskLanding } from "./desk-landing";

export interface FilterTab {
  key: ClarificationFilter;
  label: string;
}

type FocusTarget = { kind: "record" } | { kind: "row"; id: string } | null;

/**
 * /clarifications desk: saved filters in the job header (kept in the URL), the
 * queue on the left, and the open question (?selected=<CLR id>) as its
 * conversation beside the decision column; with nothing open, the desk's own
 * triage (overdue or undelivered first, then answers waiting for a lead). At 1024px and wider it is one
 * fixed frame whose columns scroll on their own; below 1024px (and at 200%
 * zoom) it stacks and the page scrolls.
 *
 * Keys: J/K open the next or previous question and keep focus in the queue;
 * ArrowUp/ArrowDown move between rows; Enter or a click opens a question and
 * moves focus to its heading; Esc (outside a field) closes it and returns
 * focus to its row; Ctrl/Cmd+Enter runs the docked next step (a form in the
 * conversation that has its own button submits only itself).
 */
export function ClarificationsWorkspace({
  filters,
  queue,
  detail,
  desk,
  selected,
  now,
  readOnly,
  readOnlyNote,
  banner,
}: {
  filters: FilterTab[];
  queue: Queue;
  detail: ClarificationDetail | null;
  /** What needs attention across the desk, for the landing pane (only when nothing is open). */
  desk: DeskAttention | null;
  selected: string | null;
  now: string;
  readOnly: boolean;
  readOnlyNote: string | null;
  banner?: ReactNode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [ping, setPing] = useState<{ id: string; n: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [leave, setLeave] = useState<{ href: string; id: string | null; focus: FocusTarget } | null>(null);
  const [announce, setAnnounce] = useState("");
  const focusNext = useRef<FocusTarget>(null);
  const targetRef = useRef<string | null>(null);
  const filter = queue.filter;
  const rows = queue.rows;
  const openId = detail?.row.displayId ?? null;

  const navigate = useCallback(
    (href: string, id: string | null, focus: FocusTarget) => {
      focusNext.current = focus;
      targetRef.current = id;
      setPendingId(id);
      startTransition(() => router.push(href, { scroll: false }));
    },
    [router],
  );

  /** Open a question (or close with null); unsaved text asks first and never carries over. */
  const go = useCallback(
    (id: string | null, focus: FocusTarget, tab: ClarificationFilter = filter) => {
      if (id !== null && id === (targetRef.current ?? openId) && id === openId) {
        if (focus?.kind === "record") document.getElementById("clr-record-heading")?.focus();
        return;
      }
      const href = selectionHref(tab, id);
      if (hasUnsavedChanges()) {
        setLeave({ href, id, focus });
        return;
      }
      navigate(href, id, focus);
    },
    [filter, navigate, openId],
  );

  // After a navigation lands: focus the heading (opened by click or Enter) or the row (J/K, Esc).
  useEffect(() => {
    const target = focusNext.current;
    if (targetRef.current === (selected ?? null)) targetRef.current = null;
    if (!target) return;
    const t = window.setTimeout(() => {
      if (target.kind === "record" && selected) {
        document.getElementById("clr-record-heading")?.focus();
        focusNext.current = null;
      } else if (target.kind === "row") {
        const row = document.querySelector<HTMLElement>(`[data-clr-row="${target.id}"]`);
        row?.focus();
        row?.scrollIntoView({ block: "nearest" });
        focusNext.current = null;
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [selected, detail?.row.id]);

  // Announce the question in hand and keep its row in view.
  useEffect(() => {
    if (!detail) return;
    const t = window.setTimeout(() => setAnnounce(`Now showing ${detail.row.displayId}: ${detail.row.categoryLabel} question on ${detail.row.affectedLabel}.`), 60);
    document.querySelector<HTMLElement>(`[data-clr-row="${detail.row.displayId}"]`)?.scrollIntoView({ block: "nearest" });
    return () => window.clearTimeout(t);
  }, [detail?.row.id, detail]);

  const step = useCallback(
    (delta: number) => {
      if (!rows.length) return;
      // From the question in hand, else from the focused row (after Esc), else from the top.
      const focused = document.activeElement instanceof HTMLElement ? (document.activeElement.dataset.clrRow ?? null) : null;
      const from = targetRef.current ?? openId ?? focused;
      const idx = from ? rows.findIndex((r) => r.displayId === from) : -1;
      const next = idx < 0 ? (delta > 0 ? rows[0] : rows[rows.length - 1]) : rows[Math.max(0, Math.min(rows.length - 1, idx + delta))];
      if (!next || next.displayId === from) return;
      setPing({ id: next.displayId, n: Date.now() });
      // J/K keep focus in the queue; the record follows.
      go(next.displayId, { kind: "row", id: next.displayId });
    },
    [rows, openId, go],
  );
  useSingleKey({ j: () => step(1), k: () => step(-1) });

  // Esc closes the open question (or the queue drawer); Ctrl/Cmd+Enter runs the docked next step.
  const latest = useRef({ openId, drawerOpen, go });
  useEffect(() => {
    latest.current = { openId, drawerOpen, go };
  });
  const [explain, setExplain] = useState("");
  useEffect(() => {
    const runPrimary = () => {
      const mark = document.querySelector<HTMLElement>("[data-clr-primary]");
      const btn = mark && (mark.matches("button") ? (mark as HTMLButtonElement) : mark.querySelector<HTMLButtonElement>("button"));
      if (!btn) {
        setExplain("Nothing to run on this question right now.");
        return;
      }
      if (btn.disabled) {
        const why = (btn.getAttribute("aria-describedby") ?? "")
          .split(" ")
          .map((id) => (id ? (document.getElementById(id)?.textContent ?? "") : ""))
          .join(" ")
          .trim();
        setExplain(why ? `Cannot run yet: ${why}` : "The next step cannot run yet.");
        return;
      }
      btn.focus();
      btn.click();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isDialogOpen()) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.defaultPrevented || !latest.current.openId) return;
        // A secondary form with its own button submits itself (handled there).
        if (t?.closest("[data-clr-own-submit]")) return;
        e.preventDefault();
        runPrimary();
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isEditableTarget(e.target)) return;
      if (latest.current.drawerOpen) {
        e.preventDefault();
        setDrawerOpen(false);
        document.querySelector<HTMLElement>("[aria-controls='clr-queue']")?.focus();
        return;
      }
      const open = latest.current.openId;
      if (!open) return;
      e.preventDefault();
      latest.current.go(null, { kind: "row", id: open });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Opening the drawer (bench tablet, 200% zoom) puts focus on the open question's row.
  useEffect(() => {
    if (!drawerOpen) return;
    const t = window.setTimeout(() => {
      const row = (openId && document.querySelector<HTMLElement>(`[data-clr-row="${openId}"]`)) || document.querySelector<HTMLElement>("[data-clr-row]");
      row?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [drawerOpen, openId]);

  const onOpen = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setDrawerOpen(false);
    go(id, { kind: "record" });
  };
  const onRowKey = (e: KeyboardEvent<HTMLAnchorElement>, id: string) => {
    if (e.key === " ") {
      e.preventDefault();
      setDrawerOpen(false);
      go(id, { kind: "record" });
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = [...document.querySelectorAll<HTMLElement>("[data-clr-row]")];
    const i = list.findIndex((el) => el.dataset.clrRow === id);
    list[Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  // From the landing pane: a question outside the current filter opens in All, so its row is in the queue beside it.
  const tabFor = (id: string): ClarificationFilter => (rows.some((r) => r.displayId === id) ? filter : "all");
  const onOpenFromDesk = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(id, { kind: "record" }, tabFor(id));
  };

  const counts = queue.counts;
  const drawer = Boolean(selected);
  return (
    <div className="flex flex-col lg:h-[calc(100dvh-var(--hlo-topbar-h))] lg:overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-end gap-x-6 border-b border-line bg-surface px-6 max-xl:gap-x-4 max-xl:px-4">
        <div className="flex items-center gap-2 py-2.5">
          <h1 className="text-lg font-bold tracking-[-0.015em] text-ink">Clarifications</h1>
          {readOnly ? <ReadOnlyTag /> : null}
        </div>
        <Tabs
          label="Clarification filters"
          active={filter}
          bare
          items={filters.map((f) => ({ key: f.key, label: f.label, count: counts[f.key], href: selectionHref(f.key, selected) }))}
        />
        <p className="ml-auto self-center py-2 text-sm text-ink-muted max-xl:hidden">Office messages are simulated; no office is contacted.</p>
      </header>
      {banner ? <div className="shrink-0 px-4 pt-3">{banner}</div> : null}
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col lg:grid",
          drawer
            ? "lg:grid-cols-[minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] min-[1400px]:grid-cols-[352px_minmax(0,1fr)]"
            : "lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] min-[1400px]:grid-cols-[352px_minmax(0,1fr)]",
        )}
      >
        <ClarificationQueue
          rows={rows}
          filter={filter}
          selected={selected}
          total={queue.total}
          allCount={counts.all}
          sortNote={queue.sortNote}
          readOnly={readOnly}
          now={now}
          pendingId={isPending ? pendingId : null}
          ping={ping}
          drawer={drawer}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
          onOpen={onOpen}
          onRowKey={onRowKey}
        />
        {selected ? (
          detail ? (
            <ClarificationRecord
              key={detail.row.id}
              detail={detail}
              now={now}
              readOnlyNote={readOnlyNote}
              busy={isPending}
              queueCount={rows.length}
              queueOpen={drawerOpen}
              onToggleQueue={() => setDrawerOpen((o) => !o)}
            />
          ) : (
            <ClarificationNotFound selected={selected} closeHref={selectionHref(filter, null)} />
          )
        ) : desk ? (
          <DeskLanding desk={desk} queueHasRows={rows.length > 0} hrefFor={(id) => selectionHref(tabFor(id), id)} onOpen={onOpenFromDesk} />
        ) : null}
      </div>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      <span className="sr-only" role="status">
        {explain}
      </span>
      <ConfirmDialog
        open={leave !== null}
        title={leave?.id ? `Leave without saving and open ${leave.id}?` : "Leave without saving and close this question?"}
        confirmLabel={leave?.id ? "Discard and open" : "Discard and close"}
        cancelLabel="Stay and keep editing"
        destructive
        onCancel={() => setLeave(null)}
        onConfirm={() => {
          const to = leave;
          setLeave(null);
          if (to) navigate(to.href, to.id, to.focus);
        }}
      >
        <p className="text-sm text-ink">Unsaved: {unsavedLabels().join("; ") || "a form on this question"}. Text never carries over to another question.</p>
      </ConfirmDialog>
    </div>
  );
}
