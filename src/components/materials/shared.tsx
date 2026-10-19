"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, Printer, ScanLine } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { StatusPill } from "@/components/ui/status-pill";
import { SimulatedLabel } from "@/components/domain/honesty";
import { useActor, isReadOnlyRole } from "@/lib/client/shell-context";
import type { ScanOutcome } from "@/lib/client/scan";
import type { CommandFailure } from "@/lib/client/command";

/** Printer name without the "(simulated)" suffix (the status pill already says "(simulated)"). */
export function printerName(name: string): string {
  return name.replace(/ \(simulated\)$/i, "");
}

/** Printer status: name and state in words, e.g. "Slide printer 1  [Ready]"; the strip says "Simulated" once for the group (spec §6.5). */
export function PrinterChip({ name, status, statusLabel, queued, unknown }: { name: string; status: string; statusLabel: string; queued: number; unknown: number }) {
  // An unavailable source is amber on the severity ladder (red is kept for patient identity).
  const tone = status === "online" ? "success" : "warning";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 whitespace-nowrap">
      <span className="text-sm font-medium text-ink">{printerName(name)}</span>
      <StatusPill tone={tone} size="sm">
        {statusLabel.replace(/ \(simulated\)$/i, "")}
      </StatusPill>
      {queued > 0 ? <span className="text-xs text-ink-secondary">{queued} queued</span> : null}
      {unknown > 0 ? <span className="text-xs font-medium text-warning-fg">{unknown} unknown outcome</span> : null}
    </span>
  );
}

/** One row with every printer's state, plus the Simulated label once for the group. */
export function PrinterStrip({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Label printers" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line bg-surface px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
        <Printer className="size-4 shrink-0 text-ink-muted" aria-hidden />
        Printers
        <SimulatedLabel connector="printers" size="xs" />
      </span>
      {children}
    </section>
  );
}

/**
 * Bench frame (tray, retrieval): at 1024px wide and more than 560px tall the
 * record band is pinned, the work sits on the left and the decision column is
 * pinned on the right. In the shared `stacked:` variant (a 1024 bench tablet in
 * portrait, 200% browser zoom of a bench screen, a short window) the frame
 * becomes one page-scrolling stack in DOM (and tab) order: band, decision, then
 * the material, and only the top bar stays pinned. The decision column comes
 * first in the DOM for that reason; the frame places it on the right.
 */
export const BENCH_GRID =
  "grid grid-cols-[minmax(0,1fr)_var(--dc-w)] gap-4 px-6 py-4 max-xl:px-4 [--dc-w:300px] xl:[--dc-w:320px] min-[87.5rem]:[--dc-w:340px] stacked:grid-cols-1";
export const BENCH_DECISION = "col-start-2 row-start-1 stacked:col-start-auto stacked:row-start-auto";
export const BENCH_WORK = "col-start-1 row-start-1 stacked:col-start-auto stacked:row-start-auto";

/**
 * The record band (tray, retrieval request): pinned under the top bar in the bench frame only. The element carrying
 * it also carries data-identity-sticky, so focus scrolled into view stays clear of it (globals.css scroll padding).
 */
export const BENCH_BAND =
  "sticky top-[var(--hlo-chrome-h)] z-20 flex min-h-[var(--hlo-identity-h)] flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-6 py-2 max-xl:gap-x-4 max-xl:px-4 stacked:static";

/**
 * The decision column stays in view while scanning in the bench frame: pinned
 * under the top bar and the record band, no taller than what is left of the
 * viewport below the page's first rows, so its action is always visible.
 */
export const STICKY_COLUMN = "sticky top-[calc(var(--hlo-chrome-h)+6.5rem)] max-h-[calc(100vh-17.5rem)] stacked:static stacked:max-h-none";

/** The least of a pinned column's scrolling middle (marked data-fit-scroller) that must stay in view: about one row and its heading. */
const MIN_MIDDLE_REM = 7.5;

/**
 * Keeps a pinned decision column inside the viewport: its height is what is
 * left below its current top (the record band can wrap to two rows after a
 * scan, and the column gains room once it is pinned). Without script, or in
 * the stacked page where it is not pinned, STICKY_COLUMN's limit applies.
 * It never squeezes the scrolling middle (the rows to act on) below
 * MIN_MIDDLE_REM: with larger browser text the column reaches below the fold
 * until the page is scrolled and it is pinned; and when even the pinned column
 * cannot hold its heading, that much of the middle and its action (larger text
 * on a short screen), it is not pinned at all and scrolls with the page, whole,
 * instead of hiding every row under its cue.
 */
export function useFitColumn(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const fit = () => {
      frame = 0;
      el.style.position = "";
      if (getComputedStyle(el).position !== "sticky") {
        el.style.maxHeight = "";
        return;
      }
      let floor = 280;
      const middle = el.querySelector<HTMLElement>("[data-fit-scroller]");
      if (middle) {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        // Heading and action as laid out now, plus the middle's content up to the minimum, plus the cue when the rest is
        // cut. Counted the same whether the cue shows now or not, so pinning never flips back and forth.
        const min = MIN_MIDDLE_REM * rem;
        const cue = el.querySelector<HTMLElement>("[data-cut-cue]")?.offsetHeight ?? 0;
        const cueIfCut = middle.scrollHeight > min ? Math.max(cue, 2.5 * rem) : 0;
        const needed = Math.ceil(el.offsetHeight - cue - middle.clientHeight + Math.min(middle.scrollHeight, min) + cueIfCut);
        const pinned = Math.floor(window.innerHeight - (parseFloat(getComputedStyle(el).top) || 0) - 16);
        if (needed > pinned) {
          el.style.position = "static";
          el.style.maxHeight = "none";
          return;
        }
        floor = Math.max(floor, needed);
      }
      el.style.maxHeight = `${Math.max(floor, Math.floor(window.innerHeight - el.getBoundingClientRect().top - 16))}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    // The column itself too: its cue and action can change height after a scan (the floor follows them).
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      el.style.maxHeight = "";
      el.style.position = "";
    };
  }, [ref]);
}

/**
 * A short scrolling region of a pinned decision column never shows half a line
 * or half a button: when its bottom edge cuts through a unit (an element marked
 * data-cut-unit: a row, a line of text, a row of actions), an opaque cover hides
 * it from its top. The cue below says how many rows (data-cut-row) start under
 * the cover, or "More below" when only the rest of a row is hidden. In the
 * stacked page the region does not scroll and nothing is cut. `key` changes
 * when the content does.
 */
export interface Cut {
  /** Rows that start under the cover or further down. */
  rows: HTMLElement[];
  /** The first unit the edge cuts through or hides (what the cue brings into view). */
  first: HTMLElement | null;
  /** Height of the cover, px from the region's bottom edge. */
  cover: number;
}

const NO_CUT: Cut = { rows: [], first: null, cover: 0 };

export function useCutBelow(root: RefObject<HTMLDivElement | null>, key: string): Cut {
  const [state, setState] = useState<Cut>(NO_CUT);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      const scrolls = el.scrollHeight > el.clientHeight + 1;
      const first = scrolls ? ([...el.querySelectorAll<HTMLElement>("[data-cut-unit]")].find((u) => u.getBoundingClientRect().bottom > box.bottom + 0.5) ?? null) : null;
      const coverTop = first ? Math.max(box.top, first.getBoundingClientRect().top) : box.bottom;
      const rows = first ? [...el.querySelectorAll<HTMLElement>("[data-cut-row]")].filter((r) => r.getBoundingClientRect().top >= coverTop - 0.5) : [];
      const cover = first ? Math.max(0, Math.round(box.bottom - coverTop)) : 0;
      setState((prev) =>
        prev.first === first && prev.cover === cover && prev.rows.length === rows.length && prev.rows.every((r, i) => r === rows[i]) ? prev : first ? { rows, first, cover } : NO_CUT,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Keyboard focus is never left under the cover (WCAG 2.4.11/2.4.12): the focused control's whole unit is
    // scrolled into the uncovered part of the column; the cover then moves to the next cut unit.
    const onFocus = (e: FocusEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (!t) return;
      requestAnimationFrame(() => {
        const unit = t.closest<HTMLElement>("[data-cut-unit]");
        const target = unit && el.contains(unit) && unit.offsetHeight < el.clientHeight ? unit : t;
        const r = target.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        if (r.bottom > box.bottom - 0.5) el.scrollTop += r.bottom - box.bottom + 4;
        else if (r.top < box.top + 0.5) el.scrollTop -= box.top - r.top + 4;
      });
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    el.addEventListener("focusin", onFocus);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      el.removeEventListener("focusin", onFocus);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [root, key]);
  return state;
}

/** The opaque cover over a cut unit (see useCutBelow). Place it after the scroller, inside a relative wrapper. */
export function CutCover({ height, scroller }: { height: number; scroller: RefObject<HTMLDivElement | null> }) {
  return height ? (
    <div aria-hidden className="absolute inset-x-0 bottom-0 bg-surface" style={{ height }} onWheel={(e) => scroller.current?.scrollBy({ top: e.deltaY })} />
  ) : null;
}

/**
 * "2 more items below" (or "More below"): brings the first cut unit into view and moves focus to
 * its first control. `describe` words the rows when they are not all of one kind (it returns the
 * whole cue, e.g. "3 to pick and 1 not on this request below"), so the cue agrees with the headings.
 */
export function CutCue({ cut, noun, describe }: { cut: Cut; noun: [string, string]; describe?: (rows: HTMLElement[]) => string | null }) {
  if (!cut.first) return null;
  const show = () => {
    const target = cut.first;
    if (!target) return;
    target.scrollIntoView({ block: "nearest" });
    const control = target.matches("button, a[href]") ? target : target.querySelector<HTMLElement>("button, a[href], input, select, textarea");
    control?.focus({ preventScroll: true });
  };
  const words = cut.rows.length ? (describe?.(cut.rows) ?? `${cut.rows.length} more ${cut.rows.length === 1 ? noun[0] : noun[1]} below`) : "More below";
  return (
    <button
      type="button"
      data-cut-cue
      onClick={show}
      className="flex min-h-[max(2rem,var(--hlo-target-min))] shrink-0 items-center justify-center gap-1.5 border-t border-line text-sm font-medium text-brand hover:bg-brand-50"
    >
      <ChevronDown className="size-4" aria-hidden />
      {words}
    </button>
  );
}

/**
 * What a scan does here and where the scan field is, said the same way on every
 * scanning tab (tray, retrieval): one bound line, so "[/] goes to" never splits.
 */
export function ScanHint({ lead }: { lead: string }) {
  return (
    <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-ink">
      <ScanLine className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
      <span>
        <span className="font-semibold">{lead}</span>{" "}
        <span className="whitespace-nowrap">
          <Kbd>/</Kbd> goes to
        </span>{" "}
        the scan field.
      </span>
    </p>
  );
}

/** Read-only demo roles: hide/disable actions with this reason. */
export function useReadOnly(): string | null {
  const actor = useActor();
  return isReadOnlyRole(actor.role) ? "Read only: this demo role can view but not change records." : null;
}

/**
 * Map a failed command to a scan-field result line (nothing changed). A failure
 * is amber on the severity ladder; red is kept for patient identity only.
 */
export function failureToScan(error: CommandFailure, sound: "mismatch" | null = null): ScanOutcome {
  return { tone: "warning", alert: true, sound, message: `${error.message}${/nothing (was )?changed/i.test(error.message) ? "" : " Nothing was changed."}` };
}

export function SectionTitle({ children, aside, id }: { children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id={id} className="text-sm font-semibold text-ink">
        {children}
      </h3>
      {aside ? <div className="text-xs text-ink-muted">{aside}</div> : null}
    </div>
  );
}

/** Line explaining the hardware dependency (spec §8). */
export const HARDWARE_NOTE =
  "Direct cassette and slide printing needs compatible printers, drivers or supported interfaces, validated label materials and bench procedures. This page only queues simulated jobs.";
