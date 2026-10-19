import { Ban, CircleCheck, Hourglass, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PrintJobRowView } from "@/server/queries/materials";

/**
 * What came of a print job, in words: printed, failed, queued, or an unknown
 * outcome that must be reconciled before any reprint. Derived from the job's
 * state, whether a person recorded the output, and whether it was replaced.
 */
export interface OutcomeWords {
  tone: "done" | "waiting" | "amber" | "muted";
  words: string;
  /** Second line: what it means for the next step. */
  next: string | null;
}

export function printOutcome(r: Pick<PrintJobRowView, "state" | "needsOutputCheck" | "reconciliation" | "supersededBy">): OutcomeWords {
  switch (r.state) {
    case "unknown_outcome":
      return { tone: "amber", words: "Unknown outcome", next: r.reconciliation === "cant_tell" ? "Escalated: a supervisor reconciles it" : "Reconcile before reprint" };
    case "acknowledged":
      return r.needsOutputCheck
        ? { tone: "waiting", words: "Printer acknowledged", next: "Output not recorded" }
        : { tone: "done", words: "Printed", next: r.reconciliation === "printed_damaged" ? "Checked: printed but damaged" : null };
    case "completion_confirmed":
      return { tone: "done", words: "Printed", next: r.reconciliation === "printed_damaged" ? "Checked: printed but damaged" : null };
    case "failed":
      return r.supersededBy
        ? { tone: "muted", words: "Failed", next: null }
        : { tone: "amber", words: "Failed", next: r.reconciliation === "not_printed" ? "Not printed: reprint with a reason" : "Reprint with a reason" };
    case "queued":
    case "planned":
      return { tone: "waiting", words: "Queued", next: "Prints only when released" };
    case "submitted":
      return { tone: "waiting", words: "Sent to the printer", next: "Waiting for its reply" };
    case "canceled":
      return { tone: "muted", words: "Canceled", next: null };
    default:
      return { tone: "muted", words: r.state, next: null };
  }
}

const ICON: Record<OutcomeWords["tone"], LucideIcon> = { done: CircleCheck, waiting: Hourglass, amber: TriangleAlert, muted: Ban };

export function PrintOutcome({ row, className }: { row: PrintJobRowView; className?: string }) {
  const o = printOutcome(row);
  const Icon = ICON[o.tone];
  return (
    <span className={cn("flex items-start gap-1.5", className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", o.tone === "amber" ? "text-warning-solid" : "text-ink-muted")} aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className={cn(o.tone === "amber" ? "font-semibold text-warning-fg" : o.tone === "done" || o.tone === "muted" ? "text-ink-secondary" : "font-medium text-ink")}>{o.words}</span>
        {row.supersededBy ? (
          <span className="text-xs text-ink-muted">
            Replaced by <span className="id-mono">{row.supersededBy}</span>
          </span>
        ) : o.next ? (
          <span className={cn("text-xs", o.tone === "amber" ? "text-warning-fg" : "text-ink-muted")}>{o.next}</span>
        ) : null}
      </span>
    </span>
  );
}
