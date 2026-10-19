"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { isDialogOpen, isEditableTarget } from "@/lib/client/keyboard";

/**
 * Detail side panel (spec §5.4). Keeps list context: on desktop it sits
 * beside the list (push layout, <aside>); below 1280px it overlays the right
 * 480px as a non-modal sheet. Focus moves to the heading on open (and when
 * `focusKey` changes); Esc closes and focus returns to the element that
 * opened it (usually the row). Put the selection in the URL (?selected=<id>)
 * and pass `closeHref` so Back closes the panel and links can be shared.
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef<() => void>(() => {});

  closeRef.current = () => {
    if (closeHref) router.push(closeHref, { scroll: false });
    else onClose?.();
  };

  // Remember who opened us; give focus back on unmount.
  useEffect(() => {
    // Capture once (React dev mode runs effects twice). When the panel was
    // opened by navigation, focus may already be on <body>: fall back to the
    // selected row that opened it.
    if (!returnTo.current) {
      const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      returnTo.current =
        active ?? (document.querySelector<HTMLElement>('[aria-selected="true"], [data-panel-opener="true"]') ?? null);
    }
    return () => {
      const back = returnTo.current;
      const active = document.activeElement;
      const focusLost = !active || active === document.body;
      if (back && document.contains(back) && focusLost) back.focus();
    };
  }, []);

  useEffect(() => {
    // J/K moved the panel to another record: Esc should return to that record's row, not the first opener.
    const selected = document.querySelector<HTMLElement>('[aria-selected="true"], [data-panel-opener="true"]');
    if (selected) returnTo.current = selected;
    if (preserveFocus) return;
    headingRef.current?.focus();
  }, [focusKey, preserveFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (isDialogOpen() || isEditableTarget(e.target)) return;
      e.preventDefault();
      const back = returnTo.current;
      closeRef.current();
      if (back && document.contains(back)) requestAnimationFrame(() => back.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const top = belowIdentityBar ? "top-[calc(var(--hlo-chrome-h)_+_var(--hlo-identity-h))]" : "top-[var(--hlo-chrome-h)]";
  const height = belowIdentityBar
    ? "h-[calc(100vh_-_var(--hlo-chrome-h)_-_var(--hlo-identity-h))]"
    : "h-[calc(100vh_-_var(--hlo-chrome-h))]";

  return (
    <aside
      aria-labelledby={headingId}
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
      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm stacked:flex-none stacked:overflow-visible">{children}</div>
      {footer ? <div className="border-t border-line bg-surface-subtle px-4 py-3">{footer}</div> : null}
    </aside>
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
