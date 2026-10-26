"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "./cn";

export type TabDef = { id: string; label: ReactNode; badge?: ReactNode };

/** WAI-ARIA tabs with arrow-key movement. The parent renders the active panel with TabPanel. */
export function Tabs({ tabs, active, onChange, idBase, className }: { tabs: TabDef[]; active: string; onChange: (id: string) => void; idBase: string; className?: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (delta: number) => {
    const i = tabs.findIndex((t) => t.id === active);
    const next = tabs[(i + delta + tabs.length) % tabs.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div role="tablist" aria-orientation="horizontal" className={cn("flex gap-1 border-b border-line", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          role="tab"
          type="button"
          id={`${idBase}-tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`${idBase}-panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            }
          }}
          className={cn(
            "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-small font-semibold",
            active === t.id ? "border-teal text-ink" : "border-transparent text-graphite hover:text-ink",
          )}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idBase, id, active, children, className }: { idBase: string; id: string; active: string; children: ReactNode; className?: string }) {
  if (active !== id) return null;
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
