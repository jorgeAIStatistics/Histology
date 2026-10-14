import { ChartColumn, CircleQuestionMark, Eye, Plug } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Honesty labels (spec §3.1, §7): simulated connectors, illustrative numbers
 * and unknown values are always labeled in words.
 */

/**
 * "Simulated: notifications" — plug icon, dashed border. Place it only where
 * data leaves the app or arrives from a connector (send, print, accession
 * request, sync indicator, AI draft).
 */
export function SimulatedLabel({
  connector,
  children,
  className,
  size = "sm",
}: {
  /** Connector name, e.g. "notifications", "EMA-SIM", "printer". Omit for plain "Simulated". */
  connector?: string;
  /** Replaces the default text entirely. */
  children?: ReactNode;
  className?: string;
  size?: "sm" | "xs";
}) {
  return (
    <span
      className={cn(
        "hlo-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-dashed border-sim-border bg-sim-bg font-medium text-sim-fg",
        size === "sm" ? "h-6 px-1.5 text-xs" : "h-5 px-1 text-xs",
        className,
      )}
    >
      <Plug className="size-3.5 shrink-0" aria-hidden />
      {children ?? (connector ? `Simulated: ${connector}` : "Simulated")}
    </span>
  );
}

/** "Illustrative: synthetic prior-day data" — for charts and computed demo numbers. */
export function IllustrativeTag({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "hlo-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-dashed border-sim-border bg-sim-bg px-1.5 py-0.5 text-xs font-medium text-sim-fg",
        className,
      )}
    >
      <ChartColumn className="size-3.5 shrink-0" aria-hidden />
      {children ?? "Illustrative: synthetic prior-day data"}
    </span>
  );
}

/**
 * "Unknown" with a "?" icon plus the reason when known. Never 0, blank or a dash.
 * Read as "Unknown, <reason>".
 */
export function UnknownValue({ reason, className, label = "Unknown" }: { reason?: ReactNode; className?: string; label?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-1 text-ink-muted", className)}>
      <CircleQuestionMark className="size-3.5 shrink-0 self-center" aria-hidden />
      <span>
        {label}
        {reason ? (
          <>
            <span className="sr-only">, </span>
            <span className="ml-1">({reason})</span>
          </>
        ) : null}
      </span>
    </span>
  );
}

/** "Read only" tag for Director (demo) / Medical director (demo). */
export function ReadOnlyTag({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <span
      className={cn(
        "hlo-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-line-strong bg-surface-subtle px-1.5 py-0.5 text-xs font-medium text-ink-secondary",
        className,
      )}
    >
      <Eye className="size-3.5 shrink-0" aria-hidden />
      {children ?? "Read only"}
    </span>
  );
}

/** Small "Synthetic" tag placed after synthetic patient names. */
export function SyntheticTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border border-dashed border-sim-border bg-sim-bg px-1 text-xs font-medium leading-4 text-sim-fg",
        className,
      )}
    >
      Synthetic
    </span>
  );
}
