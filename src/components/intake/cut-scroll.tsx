"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * What is read as a whole: a paragraph, an option, a field, a button, a list
 * entry, a quoted notice. A cut never falls inside one of these.
 */
const UNIT = "p, li, label, legend, figure, figcaption, blockquote, button, select, textarea, h3, h4, dl, [data-cut-unit], [data-cut-keep]";

interface Box {
  t: number;
  b: number;
  leaf: boolean;
  el: HTMLElement;
}

/** Plain text that may break between its lines (never an option, a field or a button). */
const TEXT = "p, blockquote, figcaption, dd";

/** The lowest (dir "down") or highest (dir "up") y between from and to that no unit straddles. */
function cleanY(boxes: Box[], from: number, to: number, leafOnly: boolean, dir: "down" | "up"): number | null {
  const set = leafOnly ? boxes.filter((x) => x.leaf) : boxes;
  const straddles = (y: number) => set.some((x) => x.t < y - 0.5 && x.b > y + 0.5);
  const ys = [from, to, ...set.flatMap((x) => [x.t, x.b])].filter((y) => y >= from - 0.5 && y <= to + 0.5);
  ys.sort((a, b) => (dir === "down" ? b - a : a - b));
  for (const y of ys) if (!straddles(y)) return y;
  return null;
}

/** Keep groups (a quoted notice, an option with its hint) together unless that leaves this much of the view empty. */
const GROUP_SLACK = 32;

/**
 * Between whole lines of the text that crosses the limit, when another whole
 * line of it fits before the cue: the last line that fits.
 */
function lineCut(boxes: Box[], cut: number, limit: number, base: number): number {
  const next = boxes.find((x) => x.leaf && x.t >= cut - 0.5 && x.t < limit && x.b > limit && x.el.matches(TEXT) && !x.el.querySelector("a, button, input, select, textarea"));
  if (!next) return cut;
  const range = document.createRange();
  range.selectNodeContents(next.el);
  let best = cut;
  for (const r of range.getClientRects()) {
    const b = r.bottom - base;
    if (b <= limit + 0.5 && b > best) best = b;
  }
  range.detach();
  return best;
}

function bottomCut(boxes: Box[], top: number, limit: number, base: number): number {
  if (limit - top < 12) return top; // only the cue fits: show the cue, not a sliver
  const grouped = cleanY(boxes, top, limit, false, "down");
  const leaves = cleanY(boxes, top, limit, true, "down");
  const g = grouped !== null && grouped > top + 1 ? grouped : null;
  const l = leaves !== null && leaves > top + 1 ? leaves : null;
  let cut = g !== null && (l === null || l - g <= GROUP_SLACK) ? g : (l ?? top);
  if (limit - cut >= 18) cut = lineCut(boxes, cut, limit, base); // room for at least one more whole line
  return cut > top + 1 ? cut : limit; // nothing whole fits: show what there is rather than nothing
}

function topCut(boxes: Box[], top: number, bottom: number): number {
  if (top < 1) return top;
  for (const leafOnly of [false, true]) {
    const y = cleanY(boxes, top, bottom, leafOnly, "up");
    if (y !== null && y < bottom - 1) return y;
  }
  return top;
}

function measureBoxes(sc: HTMLElement): Box[] {
  const base = sc.getBoundingClientRect().top - sc.scrollTop;
  const boxes: Box[] = [];
  for (const n of sc.querySelectorAll<HTMLElement>(UNIT)) {
    // Inside a block that must stay whole (a task with its button, a field with its label): only the block counts.
    const keep = n.parentElement?.closest("[data-cut-keep]");
    if (keep && sc.contains(keep)) continue;
    const r = n.getBoundingClientRect();
    if (r.height < 1) continue;
    boxes.push({ t: r.top - base, b: r.bottom - base, leaf: n.hasAttribute("data-cut-keep") || !n.querySelector(UNIT), el: n });
  }
  return boxes;
}

/** The names line under the cue (text-sm leading-5 plus its bottom padding). */
const NAMES_H = 26;

const still = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A short scrolling region that never shows half a line or half a button.
 * When its content does not fit, the view ends at the last whole unit
 * (paragraph, option, field, button) and an opaque cover with an explicit
 * "More below" cue takes the rest; the cue scrolls to the next whole unit.
 * A unit scrolled partly out at the top is covered the same way. Keyboard
 * focus is kept clear of the covers. With room to spare it is plain content.
 * With `snap`, the region gives back the room under its cue: it ends at the
 * last whole unit plus the cue, so no empty strip is left inside the sheet
 * (the column below gets the room instead).
 */
export function CutScroll({
  children,
  className,
  scrollerClassName,
  contentClassName,
  tone = "surface",
  countSelector,
  countNoun,
  label,
  external,
  snap = false,
}: {
  children: ReactNode;
  className?: string;
  /** Padding of the scrolling box. */
  scrollerClassName?: string;
  /** Spacing between the units inside it. */
  contentClassName?: string;
  /** Background the covers match. */
  tone?: "surface" | "subtle";
  /**
   * Count these (e.g. "li", or the options of a choice) in the cue: "2 more options below". When none of them
   * is below the cut (only other content is), the cue says "More below". Without it the cue says "More below".
   * Counted units with a `data-cut-name` are also named under the cue when there is a whole line of room
   * ("Not related; Ask the office first"), so a cut choice never reads as complete.
   */
  countSelector?: string;
  /** Noun for the count, e.g. "task" gives "2 more tasks below". */
  countNoun?: string;
  /** What the region holds, for the cue's accessible name ("More below in your next step"). */
  label: string;
  /**
   * The cue lives outside (e.g. in a heading row): nothing is reserved for it here, `onMore` reports the
   * count, and `control.current.showMore()` scrolls to what follows the cut.
   */
  external?: { onMore: (n: number) => void; control: RefObject<{ showMore: () => void } | null> };
  /** Shrink to the last whole unit plus the cue while scrolled to the top (no empty strip under the cue). */
  snap?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLButtonElement>(null);
  const cut = useRef({ top: 0, bottom: 0, cueH: 36 });
  const [more, setMore] = useState(0);
  // How many of `countSelector` are below the cut (0: something else is, the cue says "More below").
  const [counted, setCounted] = useState(0);
  const [names, setNames] = useState<string[]>([]);
  const reported = useRef(-1);
  const report = (n: number, c = 0, named: string[] = []) => {
    setMore(n);
    setCounted(c);
    setNames((prev) => (prev.join("\n") === named.join("\n") ? prev : named));
    if (external && reported.current !== n) {
      reported.current = n;
      external.onMore(n);
    }
  };

  const measure = () => {
    const sc = scrollRef.current;
    const coverTop = topRef.current;
    const coverBottom = bottomRef.current;
    if (!sc || !coverTop || !coverBottom) return;
    // Snapped at the top: measure against the room the region is given, not the height it gave back last time.
    const snapNow = snap && !external && !!wrapRef.current && sc.scrollTop <= 1;
    if (snapNow) wrapRef.current!.style.maxHeight = "";
    const H = sc.clientHeight;
    const top = sc.scrollTop;
    const total = sc.scrollHeight;
    const cueH = external ? 0 : (cueRef.current?.offsetHeight || 36) + 1; // the cue row and its hairline
    // Never squeezed below the cue (or its own content, if shorter): a short column shows the cue, not half of it.
    if (wrapRef.current && !external) wrapRef.current.style.minHeight = `${Math.min(cueH + 2, total)}px`;
    const gutter = `${sc.offsetWidth - sc.clientWidth}px`;
    coverTop.style.right = gutter;
    coverBottom.style.right = gutter;
    if (total <= H + 1) {
      coverTop.style.height = "0px";
      coverBottom.style.height = "0px";
      cut.current = { ...cut.current, top: 0, bottom: 0 };
      report(0);
      return;
    }
    const boxes = measureBoxes(sc);
    const atEnd = top + H >= total - 1;
    const end = atEnd ? top + H : bottomCut(boxes, top, top + H - cueH, sc.getBoundingClientRect().top - top);
    const start = topCut(boxes, top, end);
    let bottomH = Math.max(0, top + H - end);
    const topH = Math.max(0, start - top);
    // Named units below the cut (the options of a choice), said under the cue when a whole line fits.
    const hiddenNames: string[] = [];
    if (countSelector && !atEnd && !external) {
      const base = sc.getBoundingClientRect().top - top;
      for (const el of sc.querySelectorAll<HTMLElement>(countSelector)) {
        const r = el.getBoundingClientRect();
        const name = el.getAttribute("data-cut-name");
        if (name && r.height >= 1 && r.bottom - base > end + 0.5) hiddenNames.push(name);
      }
    }
    const named = hiddenNames.length > 0 && bottomH >= cueH + NAMES_H;
    const keep = cueH + (named ? NAMES_H : 0);
    if (snapNow && !atEnd && bottomH > keep + 1) {
      // Give back the strip under the cue (and its names line): the region ends at the cut plus the cue.
      wrapRef.current!.style.maxHeight = `${Math.ceil(wrapRef.current!.offsetHeight - (bottomH - keep))}px`;
      bottomH = keep;
    }
    coverBottom.style.height = `${bottomH}px`;
    coverTop.style.height = `${topH}px`;
    cut.current = { top: topH, bottom: bottomH, cueH };
    if (atEnd) {
      report(0);
      return;
    }
    if (countSelector) {
      const base = sc.getBoundingClientRect().top - top;
      let n = 0;
      for (const el of sc.querySelectorAll<HTMLElement>(countSelector)) {
        const r = el.getBoundingClientRect();
        if (r.height >= 1 && r.bottom - base > end + 0.5) n++;
      }
      report(Math.max(1, n), n, named ? hiddenNames : []);
    } else report(1);
  };
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  });

  useLayoutEffect(() => {
    measureRef.current();
  }, []);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measureRef.current());
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(sc);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    const mo = new MutationObserver(schedule);
    mo.observe(sc, { childList: true, subtree: true, characterData: true });
    // Keyboard focus is never left under a cover (WCAG 2.4.11).
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el) return;
      requestAnimationFrame(() => {
        measureRef.current();
        const unit = el.closest<HTMLElement>(UNIT);
        const target = unit && sc.contains(unit) && unit.offsetHeight < sc.clientHeight - cut.current.cueH ? unit : el;
        const r = target.getBoundingClientRect();
        const s = sc.getBoundingClientRect();
        const reserve = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1 ? 0 : cut.current.cueH;
        const below = r.bottom - (s.bottom - Math.max(cut.current.bottom, reserve)) + 4;
        const above = s.top + cut.current.top - r.top + 4;
        if (below > 4) sc.scrollTop += below;
        else if (above > 4) sc.scrollTop -= above;
      });
    };
    sc.addEventListener("scroll", schedule, { passive: true });
    sc.addEventListener("focusin", onFocus);
    // A snapped region does not grow with the window by itself: re-measure on resize.
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      sc.removeEventListener("scroll", schedule);
      sc.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  /** Bring what follows the cut to the top of the view (a page down if nothing whole fitted). */
  const showMore = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    const end = sc.scrollTop + sc.clientHeight - cut.current.bottom;
    const step = end - 6 > sc.scrollTop + 1 ? end - 6 : sc.scrollTop + sc.clientHeight - cut.current.cueH;
    sc.scrollTo({ top: step, behavior: still() ? "auto" : "smooth" });
  };

  useEffect(() => {
    if (!external) return;
    const control = external.control;
    control.current = { showMore: () => showMoreRef.current() };
    return () => {
      control.current = null;
    };
  }, [external]);
  const showMoreRef = useRef(showMore);
  useLayoutEffect(() => {
    showMoreRef.current = showMore;
  });

  const bg = tone === "surface" ? "bg-surface" : "bg-surface-subtle";
  const cueText = !countSelector || (countNoun && !counted) ? "More below" : `${countNoun ? counted : more} more ${countNoun ? `${countNoun}${counted === 1 ? "" : "s"} ` : ""}below`;
  return (
    <div ref={wrapRef} className={cn("relative flex min-h-0 flex-col overflow-hidden", className)}>
      <div ref={scrollRef} data-cut-scroller="" className={cn("min-h-0 flex-auto overflow-y-auto", scrollerClassName)} style={{ scrollPaddingBottom: 48, scrollPaddingTop: 6 }}>
        <div className={contentClassName}>{children}</div>
      </div>
      <div ref={topRef} aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden", bg)}>
        <div className="absolute inset-x-0 bottom-0 border-b border-line" />
      </div>
      <div ref={bottomRef} className={cn("pointer-events-none absolute inset-x-0 bottom-0 h-0 overflow-hidden", bg)}>
        {external ? <div className="absolute inset-x-0 top-0 border-t border-line" /> : null}
        <div className={cn("absolute inset-x-0 top-0 border-t border-line px-3", external ? "hidden" : more ? "" : "invisible")}>
          <button
            ref={cueRef}
            type="button"
            tabIndex={more ? 0 : -1}
            aria-label={`${cueText} in ${label}${names.length ? `: ${names.join("; ")}` : ""}`}
            onClick={showMore}
            className="pointer-events-auto -ml-1.5 flex min-h-[max(2.25rem,var(--hlo-target-min))] w-fit items-center gap-1 rounded-sm px-1.5 text-sm font-medium text-brand hover:bg-brand-50"
          >
            <ChevronDown className="size-4" aria-hidden />
            {cueText}
          </button>
          {names.length ? (
            <p aria-hidden className="truncate pb-1.5 pl-[1.375rem] text-sm leading-5 text-ink-secondary">
              {names.join("; ")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
