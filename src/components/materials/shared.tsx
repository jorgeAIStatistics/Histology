"use client";

import type { ReactNode } from "react";
import { Printer } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatusPill } from "@/components/ui/status-pill";
import { SimulatedLabel } from "@/components/domain/honesty";
import { useActor, isReadOnlyRole } from "@/lib/client/shell-context";
import type { ScanOutcome } from "@/lib/client/scan";
import type { CommandFailure } from "@/lib/client/command";

/** Printer name without the "(simulated)" suffix (the status pill already says "(simulated)"). */
export function printerName(name: string): string {
  return name.replace(/ \(simulated\)$/i, "");
}

/** Printer status: name and state in words, e.g. "Slide printer 1  [Ready (simulated)]" (spec §6.5). */
export function PrinterChip({ name, status, statusLabel, queued, unknown }: { name: string; status: string; statusLabel: string; queued: number; unknown: number }) {
  const tone = status === "online" ? "success" : status === "offline" ? "danger" : "warning";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 whitespace-nowrap">
      <span className="text-sm font-medium text-ink">{printerName(name)}</span>
      <StatusPill tone={tone} size="sm">
        {statusLabel}
      </StatusPill>
      {queued > 0 ? <span className="text-xs text-ink-secondary">{queued} queued</span> : null}
      {unknown > 0 ? <span className="text-xs font-medium text-warning-fg">{unknown} unknown outcome</span> : null}
    </span>
  );
}

/** One row with every printer's state, plus the Simulated label once for the group. */
export function PrinterStrip({ children, controls }: { children: ReactNode; controls?: ReactNode }) {
  return (
    <section aria-label="Label printers" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line bg-surface px-3 py-2">
      <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
        <Printer className="size-4 shrink-0 text-ink-muted" aria-hidden />
        Printers
        <SimulatedLabel connector="printers" size="xs" />
      </span>
      {children}
      {controls}
    </section>
  );
}

/**
 * Sticky context bar for a tray or retrieval request (spec §5.3: identity
 * stays visible while scanning and deciding). Not a case identity bar: a tray
 * or request spans several cases, so the context is the tray/request itself.
 */
export function ContextBar({ label, children, className, bleed }: { label: string; children: ReactNode; className?: string; bleed?: boolean }) {
  return (
    <section
      aria-label={label}
      className={cn(
        "sticky top-[var(--hlo-chrome-h)] z-20 flex min-h-[var(--hlo-identity-h)] flex-wrap items-center gap-x-3 gap-y-1.5 bg-surface py-2",
        bleed ? "-mx-6 border-b border-line px-6 max-xl:-mx-4 max-xl:px-4" : "rounded-md border border-line px-3 shadow-1",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function Divider() {
  return <span aria-hidden className="h-5 w-px shrink-0 bg-line" />;
}

/** Read-only demo roles: hide/disable actions with this reason. */
export function useReadOnly(): string | null {
  const actor = useActor();
  return isReadOnlyRole(actor.role) ? "Read only: this demo role can view but not change records." : null;
}

/** Map a failed command to a scan-field result line (nothing changed). */
export function failureToScan(error: CommandFailure): ScanOutcome {
  return { tone: "danger", alert: true, message: `${error.message}${/nothing (was )?changed/i.test(error.message) ? "" : " Nothing was changed."}` };
}

export function SectionTitle({ children, aside, id }: { children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id={id} className="text-sm font-semibold text-ink">
        {children}
      </h3>
      {aside ? <div className="text-xs text-ink-muted">{aside}</div> : null}
    </div>
  );
}

/** Line explaining the hardware dependency (spec §8). */
export const HARDWARE_NOTE =
  "Direct cassette and slide printing needs compatible printers, drivers or supported interfaces, validated label materials and bench procedures. This page only queues simulated jobs.";
