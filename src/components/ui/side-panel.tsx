"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { isDialogOpen, isEditableTarget } from "@/lib/client/keyboard";

/**
 * When the sheet is modal: it overlays the page (below 1280px) AND the layout is stacked (below 1024px, or
 * shorter than 560px). At the bench sizes (1024 to 1279px wide, 1280px and wider) it stays as it was.
 */
const MODAL_SHEET_QUERY = "(max-width: 63.99875rem), (max-width: 79.99875rem) and (max-height: 35rem)";

function subscribeModalSheet(onChange: () => void): () => void {
  const m = window.matchMedia(MODAL_SHEET_QUERY);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

function useModalSheet(): boolean {
  return useSyncExternalStore(subscribeModalSheet, () => window.matchMedia(MODAL_SHEET_QUERY).matches, () => false);
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]";

/** Where focus goes back to: the opener itself when it takes focus, else its first focusable part (a selected row's link). */
function focusTarget(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  if (el.matches(FOCUSABLE)) return el;
  return el.querySelector<HTMLElement>(FOCUSABLE);
}

const SELECTED = '[aria-selected="true"], [data-panel-opener="true"]';

/** The opener when it is still on the page, else the selected row (the opener may have been re-rendered away). */
function returnTarget(opener: HTMLElement | null): HTMLElement | null {
  const back = focusTarget(opener);
  if (back && document.contains(back)) return back;
  return focusTarget(document.querySelector<HTMLElement>(SELECTED));
}

/**
 * Makes everything on the page inert except `keep` and the elements marked [data-modal-exempt] (the scrim, the
 * notifications, the session notice), walking down from <body> along their ancestors. Content added later beside
 * those ancestors is made inert too. Returns the undo, which clears only what this call set.
 */
function inertOutside(keep: HTMLElement): () => void {
  const changed = new Set<HTMLElement>();
  const apply = () => {
    const keepers = [keep, ...Array.from(document.querySelectorAll<HTMLElement>("[data-modal-exempt]"))];
    const walk = (parent: Element) => {
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement) || keepers.includes(child) || child.localName === "next-route-announcer") continue;
        if (keepers.some((k) => child.contains(k))) walk(child);
        else if (!child.inert) {
          child.inert = true;
          changed.add(child);
        }
      }
    };
    walk(document.body);
  };
  apply();
  let frame = 0;
  const mo = new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(apply);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    cancelAnimationFrame(frame);
    for (const el of changed) el.inert = false;
  };
}

/**
 * Whether the element's content is taller than its box (it scrolls). Re-measured when it or its content changes.
 * Used to make a scrolling panel body a keyboard stop only while it actually scrolls.
 */
function useOverflowing(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
  return overflowing;
}

/**
 * Detail side panel (spec §5.4). Keeps list context: on desktop it sits
 * beside the list (push layout, a complementary region); below 1280px it
 * overlays the right 480px as a non-modal sheet. In the stacked layout
 * (200% zoom, tablet portrait, a short window below 1280px), where the sheet
 * covers most of the page, it is a MODAL sheet instead: a dialog (aria-modal)
 * over a scrim, everything else on the page inert (out of the Tab order and
 * the accessibility tree; the notifications stay live), focus moved into it,
 * and a click on the scrim closes it like Esc. Focus moves to the heading on
 * open (and when `focusKey` changes); Esc closes and focus returns to the
 * element that opened it (usually the row). Put the selection in the URL
 * (?selected=<id>) and pass `closeHref` so Back closes the panel and links
 * can be shared.
 */
export interface SidePanelProps {
  /** Heading text (also the panel's accessible name). */
  title: ReactNode;
  /** Identity chip shown above the title (AccessionChip, IdChip ...). */
  identity?: ReactNode;
  /** Status pill shown next to the identity. */
  status?: ReactNode;
  /** "Open full record" link (to /cases/[id]). */
  fullRecordHref?: string;
  /** Close by navigating (keeps the list's URL filters), e.g. "/clarifications?tab=overdue". */
  closeHref?: string;
  /** Close callback (used when closeHref is not given). */
  onClose?: () => void;
  /** Change this (e.g. the selected id) to move focus to the heading again (J/K navigation). */
  focusKey?: string;
  /** Do not steal focus on open (J/K navigation keeps focus in the list). */
  preserveFocus?: boolean;
  /** Sit below the sticky identity bar instead of directly below the top bar. */
  belowIdentityBar?: boolean;
  /** Keep the title for screen readers only (when `identity` already reads as the heading, e.g. a specimen label). */
  hideTitle?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SidePanel({
  title,
  identity,
  status,
  fullRecordHref,
  closeHref,
  onClose,
  focusKey,
  preserveFocus,
  belowIdentityBar,
  hideTitle,
  footer,
  children,
  className,
}: SidePanelProps) {
  const router = useRouter();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A body that scrolls on its own (bench sizes) is a keyboard stop while it scrolls, so text with no control in it
  // is reachable with the arrow keys (axe scrollable-region-focusable). Stacked, the whole sheet scrolls instead.
  const bodyScrolls = useOverflowing(bodyRef);
  const returnTo = useRef<HTMLElement | null>(null);
  /** The opener was the focused element (not the selected-row fallback), the record it opened, and whether J/K moved on. */
  const openerFocused = useRef(false);
  const openedFor = useRef<string | undefined>(undefined);
  const followSelection = useRef(false);
  const closeRef = useRef<() => void>(() => {});
  const modal = useModalSheet();

  closeRef.current = () => {
    if (closeHref) router.push(closeHref, { scroll: false });
    else onClose?.();
  };

  // Remember who opened us, before a modal sheet makes the page behind it inert (which takes focus away from it).
  useLayoutEffect(() => {
    // Capture once (React dev mode runs effects twice). When the panel was
    // opened by navigation, focus may already be on <body>: fall back to the
    // selected row that opened it.
    if (!returnTo.current) {
      const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      openerFocused.current = !!active;
      openedFor.current = focusKey;
      returnTo.current =
        active ?? (document.querySelector<HTMLElement>(SELECTED) ?? null);
    }
  }, []);

  // Modal sheet (stacked layout): the rest of the page is inert while it is open, and focus is inside it. A layout
  // effect, so on close the page is interactive again before focus goes back to the opener (the effect below).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!modal || !panel) return;
    const undo = inertOutside(panel);
    if (!panel.contains(document.activeElement)) headingRef.current?.focus();
    return undo;
  }, [modal]);

  // Give focus back on unmount.
  useEffect(
    () => () => {
      const back = returnTarget(returnTo.current);
      const active = document.activeElement;
      const focusLost = !active || active === document.body;
      if (back && focusLost) back.focus();
    },
    [],
  );

  useEffect(() => {
    // J/K moved the panel to another record: Esc should return to that record's row, not the first opener. On open,
    // the element that opened it (the link or row that had focus) is kept: it may not be the row (a banner's link).
    const selected = document.querySelector<HTMLElement>(SELECTED);
    if (focusKey !== openedFor.current) followSelection.current = true;
    if (selected && (followSelection.current || !openerFocused.current)) returnTo.current = selected;
    // A modal sheet always takes focus (the list behind it is inert).
    if (preserveFocus && !modal) return;
    headingRef.current?.focus();
    // (`modal` is read, not watched: the layout effect above moves focus in when it changes.)
  }, [focusKey, preserveFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (isDialogOpen() || isEditableTarget(e.target)) return;
      e.preventDefault();
      const back = returnTarget(returnTo.current);
      closeRef.current();
      if (back) requestAnimationFrame(() => back.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const top = belowIdentityBar ? "top-[calc(var(--hlo-chrome-h)_+_var(--hlo-identity-h))]" : "top-[var(--hlo-chrome-h)]";
  const height = belowIdentityBar
    ? "h-[calc(100vh_-_var(--hlo-chrome-h)_-_var(--hlo-identity-h))]"
    : "h-[calc(100vh_-_var(--hlo-chrome-h))]";

  return (
    <>
      {modal ? (
        // The page behind a modal sheet: dimmed, not interactive (inert); a click here closes the sheet, like Esc.
        <div data-modal-exempt="" aria-hidden className="fixed inset-0 z-[39] bg-[rgb(27_31_71/0.45)]" onClick={() => closeRef.current()} />
      ) : null}
      <div
        ref={panelRef}
        role={modal ? "dialog" : "complementary"}
        aria-modal={modal ? true : undefined}
        aria-labelledby={headingId}
        data-modal-sheet={modal ? "" : undefined}
        className={cn(
          "sticky z-40 flex w-[var(--hlo-panel-w)] shrink-0 flex-col border-l border-line bg-surface",
          top,
          height,
          "max-xl:fixed max-xl:right-0 max-xl:w-[min(480px,100vw)] max-xl:shadow-3",
          // Tablet portrait / 200% zoom / short windows: header and body scroll together so the header never pins half the view.
          "stacked:overflow-y-auto",
          className,
        )}
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3 has-[h2.sr-only:focus-visible]:outline-2 has-[h2.sr-only:focus-visible]:-outline-offset-2 has-[h2.sr-only:focus-visible]:outline-focus">
          <div className="min-w-0 flex-1">
            {identity || status ? <div className="mb-1.5 flex flex-wrap items-center gap-2">{identity}{status}</div> : null}
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              className={cn("w-fit rounded-sm text-md font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-1", hideTitle && "sr-only")}
            >
              {title}
            </h2>
            {fullRecordHref ? (
              <Link href={fullRecordHref} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-brand underline-offset-2 hover:underline">
                Open full record
                <ExternalLink className="size-3.5" aria-hidden />
              </Link>
            ) : null}
          </div>
          {closeHref ? (
            <Link
              href={closeHref}
              scroll={false}
              aria-label="Close panel"
              className="inline-flex size-8 min-h-[var(--hlo-target-min)] min-w-[var(--hlo-target-min)] shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-subtle hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => closeRef.current()}
              aria-label="Close panel"
              className="inline-flex size-8 min-h-[var(--hlo-target-min)] min-w-[var(--hlo-target-min)] shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-subtle hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <div
          ref={bodyRef}
          tabIndex={bodyScrolls ? 0 : undefined}
          role={bodyScrolls ? "region" : undefined}
          aria-label={bodyScrolls ? "Panel details (scrollable)" : undefined}
          className={cn(
            "relative min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm stacked:flex-none stacked:overflow-visible",
            bodyScrolls && "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
          )}
        >
          {children}
        </div>
        {footer ? <div className="border-t border-line bg-surface-subtle px-4 py-3">{footer}</div> : null}
      </div>
    </>
  );
}

/** Push layout: list on the left keeps its scroll and selection; the panel sits on the right. */
export function SidePanelLayout({ children, panel, className }: { children: ReactNode; panel?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-start", className)}>
      <div className="min-w-0 flex-1">{children}</div>
      {panel ?? null}
    </div>
  );
}
