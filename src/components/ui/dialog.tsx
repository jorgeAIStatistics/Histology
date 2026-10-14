"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/**
 * Modal dialog on the native <dialog> element (focus is trapped only while
 * open; Esc calls onClose). Focus moves to `initialFocusRef`, or to the title,
 * and returns to the element that had focus before opening.
 */
export interface DialogProps {
  open: boolean;
  /** Called on Esc, the close button, or backdrop-less close. Parent sets `open` to false. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row (right-aligned). */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Element to focus on open (e.g. the safe option). Defaults to the title. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** "alertdialog" for confirmations. */
  role?: "dialog" | "alertdialog";
  /** Hide the top-right close button (the footer must offer a way out). */
  hideCloseButton?: boolean;
  className?: string;
}

const SIZES = { sm: "w-[min(420px,calc(100vw-2rem))]", md: "w-[min(560px,calc(100vw-2rem))]", lg: "w-[min(760px,calc(100vw-2rem))]" };

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocusRef,
  role = "dialog",
  hideCloseButton,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
      const target = initialFocusRef?.current ?? titleRef.current;
      requestAnimationFrame(() => target?.focus());
    } else if (!open && d.open) {
      d.close();
      const back = returnTo.current;
      returnTo.current = null;
      if (back && document.contains(back)) back.focus();
    }
  }, [open, initialFocusRef]);

  // If the dialog unmounts while open, still return focus.
  useEffect(() => {
    return () => {
      const back = returnTo.current;
      if (back && document.contains(back)) back.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      role={role === "alertdialog" ? "alertdialog" : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        "hlo-dialog m-auto max-h-[calc(100vh-4rem)] overflow-visible rounded-lg border border-line bg-surface p-0 text-ink shadow-3 open:animate-fade-in",
        SIZES[size],
        className,
      )}
    >
      {open ? (
        <div className="flex max-h-[calc(100vh-4rem)] flex-col">
          <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-md font-semibold text-ink focus:outline-none focus-visible:outline-2">
                {title}
              </h2>
              {description ? (
                <div id={descId} className="mt-1 text-sm text-ink-secondary">
                  {description}
                </div>
              ) : null}
            </div>
            {hideCloseButton ? null : (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="-mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-subtle hover:text-ink"
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
          {children ? <div className="min-h-0 overflow-auto px-5 py-4 text-sm">{children}</div> : null}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-subtle px-5 py-3">{footer}</div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * Confirm dialog (spec §7): the title names the action and object
 * ("Reset all demo data?"); buttons say what they do ("Reset demo data" /
 * "Keep current data"), never OK/Cancel alone. Initial focus is the safe option.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
  /** Shows the loading label on the confirm button. */
  pending?: boolean;
  pendingLabel?: string;
  /** Extra content (e.g. a required reason field) placed above the buttons. */
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  destructive,
  pending,
  pendingLabel,
  confirmDisabled,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      role="alertdialog"
      initialFocusRef={cancelRef}
      hideCloseButton
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            onClick={onConfirm}
            loading={pending}
            loadingLabel={pendingLabel}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
