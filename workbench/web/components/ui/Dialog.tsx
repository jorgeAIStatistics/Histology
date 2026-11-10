"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";
import { useToastHost } from "./Toaster";

/**
 * Native <dialog> (modal): focus is trapped by the browser, Escape closes, focus returns to the opener.
 * Messages raised while it is open (including "not available" explanations) appear in its own outlet above the footer,
 * because a modal dialog covers the page's message area.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const toastHost = useToastHost();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      data-testid={testId}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        "wb-dialog m-auto max-h-[88vh] w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-panel)] border border-line-strong bg-surface p-0 text-ink shadow-[0_24px_60px_-24px_rgba(30,35,39,0.6)] backdrop:bg-ink/40",
        wide && "w-[min(920px,calc(100vw-2rem))]",
      )}
    >
      {open ? (
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id={titleId} className="text-title font-bold">
                {title}
              </h2>
              {description ? <div className="mt-1 text-small text-graphite">{description}</div> : null}
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-graphite hover:bg-paraffin hover:text-ink" aria-label="Close dialog">
              <X size={18} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          <div ref={toastHost} role="status" aria-live="polite" data-testid="dialog-messages" className="flex flex-col gap-2 px-5 empty:hidden [&:not(:empty)]:pb-3" />
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-paraffin/50 px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
