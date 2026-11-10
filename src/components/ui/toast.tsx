"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { TONE_CLASSES, TONE_ICON } from "./tone";

/**
 * Toasts (spec §7): bottom centre of the window. On every bench layout that is
 * the middle working column, clear of the queue on the left, the scan field and
 * the specimen label at the top and the docked next-step controls on the right.
 * Success and info confirmations time out; warnings (failed actions) stay until
 * dismissed and the same error is also shown inline next to the action. Never
 * take focus; live region "polite".
 * Success auto-dismisses after 6 s (paused on hover/focus), info after 8 s,
 * warning stays until dismissed. Errors that block an action belong in an
 * inline AlertBanner; a toast is never the only record of an event.
 */
export type ToastTone = "info" | "success" | "warning";

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  body?: ReactNode;
  /** Optional action rendered as a small button. */
  action?: { label: string; onClick: () => void };
  /** Override auto-dismiss (ms). `null` = stays until dismissed. */
  durationMs?: number | null;
}

interface ToastItem extends ToastInput {
  id: string;
  tone: ToastTone;
}

interface ToastContextValue {
  show: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION: Record<ToastTone, number | null> = { success: 6000, info: 8000, warning: null };
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback((toast: ToastInput) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    setItems((list) => [...list, { ...toast, id, tone: toast.tone ?? "info" }].slice(-MAX_VISIBLE));
    return id;
  }, []);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* data-modal-exempt: stays live (announced, dismissible) while a modal side sheet makes the page inert. */}
      <section
        aria-label="Notifications"
        data-modal-exempt=""
        className="no-print pointer-events-none fixed bottom-4 left-1/2 z-[70] flex w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
      >
        <ol aria-live="polite" aria-relevant="additions text" className="flex flex-col gap-2">
          {items.map((t) => (
            <ToastView key={t.id} toast={t} dismiss={dismiss} />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, dismiss }: { toast: ToastItem; dismiss: (id: string) => void }) {
  const id = toast.id;
  const [paused, setPaused] = useState(false);
  const duration = toast.durationMs === undefined ? DEFAULT_DURATION[toast.tone] : toast.durationMs;
  const remaining = useRef(duration ?? 0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (duration === null || paused) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismiss(id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt.current));
    };
  }, [duration, paused, dismiss, id]);

  const Icon = TONE_ICON[toast.tone];
  const c = TONE_CLASSES[toast.tone];
  return (
    <li
      className={cn(
        "hlo-banner animate-rise-in pointer-events-auto flex gap-2 rounded-lg border bg-surface p-3 shadow-3",
        c.border,
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", c.solidText)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", c.fg)}>{toast.title}</p>
        {toast.body ? <div className="mt-0.5 text-sm text-ink-secondary">{toast.body}</div> : null}
        {toast.action ? (
          <button
            type="button"
            className="mt-1.5 rounded-sm text-sm font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
            onClick={() => {
              toast.action?.onClick();
              dismiss(id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => dismiss(id)}
        className="-m-1 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-subtle hover:text-ink"
        aria-label={`Dismiss notification: ${toast.title}`}
      >
        <X className="size-4" aria-hidden />
      </button>
    </li>
  );
}

/** `const toast = useToast(); toast.show({ tone: "success", title: "Label queued", body: "PJ-8841" })` */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return {
    show: (t) => {
      if (process.env.NODE_ENV !== "production") console.warn("[toast] ToastProvider is not mounted", t.title);
      return "";
    },
    dismiss: () => {},
  };
}
