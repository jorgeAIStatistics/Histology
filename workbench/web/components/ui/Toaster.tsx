"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";

type Tone = "info" | "success" | "warning" | "error";
type Toast = { id: number; tone: Tone; title: string; body?: string };

type ToastApi = { show: (t: Omit<Toast, "id">) => void };
const ToastContext = createContext<ToastApi | null>(null);

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.tone === "error" || t.tone === "warning" ? 9000 : 4500);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" role="status" data-testid="toaster" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-[var(--radius-panel)] border bg-sheet px-4 py-3 shadow-[0_8px_24px_-12px_rgba(30,35,39,0.45)]",
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
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside Toaster");
  return ctx;
}
