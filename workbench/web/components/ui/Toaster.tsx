"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "./cn";

type Tone = "info" | "success" | "warning" | "error";
type Toast = { id: number; tone: Tone; title: string; body?: string };

type ToastApi = { show: (t: Omit<Toast, "id">) => void };
const ToastContext = createContext<ToastApi | null>(null);
const AnchorContext = createContext<(el: HTMLElement | null) => void>(() => {});
type HostRef = (el: HTMLElement | null) => (() => void) | undefined;
const HostContext = createContext<HostRef>(() => undefined);

const DURATION: Record<Tone, number> = { success: 4000, info: 4000, warning: 9000, error: 9000 };

/**
 * Messages sit bottom-right by default. A page can register a toast zone (useToastZone): messages then sit in that
 * element's bottom-left corner instead. The slide review stage does this, so a confirmation never covers the review
 * panel's buttons (it covers the scale bar for a few seconds instead). An open dialog hosts messages in its own outlet
 * (useToastHost): a modal dialog sits above everything else, so a message shown elsewhere would be hidden behind it.
 * Timers pause while a message is hovered or focused, so it can be read at any pace.
 */
export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, { left: number; started: number; handle: number | null }>());
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [hosts, setHosts] = useState<HTMLElement[]>([]);
  const registerHost = useCallback<HostRef>((el) => {
    if (!el) return undefined;
    setHosts((hs) => [...hs.filter((h) => h !== el), el]);
    return () => setHosts((hs) => hs.filter((h) => h !== el));
  }, []);
  const host = hosts.length ? hosts[hosts.length - 1] : null;

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t?.handle) window.clearTimeout(t.handle);
    timers.current.delete(id);
    setToasts((ts) => ts.filter((x) => x.id !== id));
  }, []);

  const arm = useCallback(
    (id: number, ms: number) => {
      timers.current.set(id, { left: ms, started: Date.now(), handle: window.setTimeout(() => dismiss(id), ms) });
    },
    [dismiss],
  );
  const pause = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (!t || t.handle === null) return;
    window.clearTimeout(t.handle);
    timers.current.set(id, { left: Math.max(1200, t.left - (Date.now() - t.started)), started: 0, handle: null });
  }, []);
  const resume = useCallback(
    (id: number) => {
      const t = timers.current.get(id);
      if (t && t.handle === null) arm(id, t.left);
    },
    [arm],
  );

  const show = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++seq.current;
      // At most three at once; an older message's timer later dismisses nothing.
      setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
      arm(id, DURATION[t.tone]);
    },
    [arm],
  );

  useEffect(() => {
    const live = timers.current;
    return () => live.forEach((t) => t.handle && window.clearTimeout(t.handle));
  }, []);

  useLayoutEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }
    const measure = () => setRect(anchor.getBoundingClientRect());
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);

  const list = toasts.map((t) => (
    <div
      key={t.id}
      onMouseEnter={() => pause(t.id)}
      onMouseLeave={() => resume(t.id)}
      onFocus={() => pause(t.id)}
      onBlur={() => resume(t.id)}
      className={cn(
        "wb-toast pointer-events-auto flex items-start gap-3 rounded-[var(--radius-panel)] border bg-sheet px-4 py-3 shadow-[0_10px_28px_-14px_rgba(30,35,39,0.55)]",
        t.tone === "error" && "border-rust/60",
        t.tone === "warning" && "border-amber",
        t.tone === "success" && "border-approved/50",
        t.tone === "info" && "border-line-strong",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          t.tone === "error" && "bg-rust",
          t.tone === "warning" && "bg-amber",
          t.tone === "success" && "bg-approved",
          t.tone === "info" && "bg-teal",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">{t.title}</p>
        {t.body ? <p className="mt-0.5 text-small text-graphite">{t.body}</p> : null}
      </div>
      <button type="button" onClick={() => dismiss(t.id)} className="rounded p-0.5 text-graphite hover:text-ink" aria-label="Dismiss message">
        <X size={16} aria-hidden />
      </button>
    </div>
  ));
  const value = useMemo(() => ({ show }), [show]);
  const zoneStyle: CSSProperties | undefined = rect
    ? {
        left: rect.left + 12,
        bottom: Math.max(16, window.innerHeight - rect.bottom + 12),
        right: "auto",
        // Leave the navigator (bottom-right of the stage) uncovered.
        width: Math.max(240, Math.min(400, rect.width - 200)),
      }
    : undefined;

  return (
    <ToastContext.Provider value={value}>
      <AnchorContext.Provider value={setAnchor}>
        <HostContext.Provider value={registerHost}>
          {children}
          {host ? createPortal(list, host) : null}
        </HostContext.Provider>
        <div
          aria-live="polite"
          role="status"
          data-testid="toaster"
          data-zone={rect ? "anchored" : "default"}
          style={zoneStyle}
          className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(400px,calc(100vw-2rem))] flex-col gap-2"
        >
          {host ? null : list}
        </div>
      </AnchorContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside Toaster");
  return ctx;
}

/** Ref callback for a dialog's message outlet: while it is mounted, messages render inside it. */
export function useToastHost(): HostRef {
  return useContext(HostContext);
}

/** Ref callback: while the element is mounted, messages appear in its bottom-left corner. */
export function useToastZone(): (el: HTMLElement | null) => void {
  return useContext(AnchorContext);
}
