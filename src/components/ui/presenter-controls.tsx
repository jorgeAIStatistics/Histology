import type { ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";

/**
 * Presenter-only controls (demo): simulated events a real bench does not have
 * (a colleague's edit, an office answer, unpacking a courier bag). A
 * documented exception until the separate presenter surface exists
 * (docs/redesign/presentation-surface-proposal.md): one quiet disclosure at
 * the very foot of the record, closed by default, in muted ink.
 */
export function PresenterControls({ children, label = "Presenter controls (demo)" }: { children: ReactNode; label?: string }) {
  return (
    <details aria-label={label} className="group/presenter border-t border-line pt-1">
      <summary className="inline-flex min-h-[max(2rem,var(--hlo-target-min))] cursor-pointer list-none items-center gap-1.5 rounded-sm px-1 text-sm text-ink-muted hover:text-ink-secondary [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-3.5" aria-hidden />
        {label}
        <ChevronDown className="size-3.5 transition-transform duration-[var(--hlo-duration-fast)] group-open/presenter:rotate-180" aria-hidden />
      </summary>
      <div className="animate-rise-in mt-1 space-y-3 rounded-md border border-line bg-surface px-3 py-3">
        <p className="text-sm text-ink-muted">These simulate events for the guided demo. A real bench does not have them.</p>
        {children}
      </div>
    </details>
  );
}
