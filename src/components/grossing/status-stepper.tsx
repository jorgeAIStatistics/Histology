import { Check, CircleDot, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GrossState, SourceUpdateState } from "@/lib/domain";
import { currentStepIndex, STEPS } from "./model";

/**
 * Status stepper for one gross record version. Documentation approval and the
 * source-system update are separate: "Entered in source (staff attested)" is
 * not an acknowledgment, and only the simulator can produce "Source
 * acknowledged (simulated)".
 */
export function StatusStepper({ state, sourceUpdateState, recordVersion }: { state: GrossState | null; sourceUpdateState: SourceUpdateState | null; recordVersion: number | null }) {
  const current = currentStepIndex(state, sourceUpdateState);
  return (
    <nav aria-label="Gross record status" className="flex items-start gap-2">
      <span className="mt-1.5 shrink-0 text-xs font-medium text-ink-muted">{recordVersion ? `Version ${recordVersion}` : "Not started"}</span>
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1.5">
        {STEPS.map((s, i) => {
          const done = i < current || (i === current && i === STEPS.length - 1);
          const isCurrent = i === current;
          return (
            <li key={s.key} className="flex items-center gap-1" aria-current={isCurrent ? "step" : undefined}>
              {i > 0 ? <span aria-hidden className={cn("h-px w-3", i <= current ? "bg-brand" : "bg-line-strong")} /> : null}
              <span
                className={cn(
                  "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-pill border px-2 text-xs font-medium",
                  isCurrent ? "border-brand bg-brand-50 text-brand-ink" : done ? "border-success-border bg-success-bg text-success-fg" : "border-line bg-surface text-ink-muted",
                )}
              >
                {done && !isCurrent ? <Check className="size-3.5" aria-hidden /> : isCurrent ? <CircleDot className="size-3.5" aria-hidden /> : null}
                {s.label}
                <span className="sr-only">{isCurrent ? " (current step)" : done ? " (done)" : " (not yet)"}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {state === "needs_clarification" ? (
        <span className="inline-flex shrink-0 h-7 items-center gap-1 rounded-pill border border-warning-border bg-warning-bg px-2 text-xs font-medium text-warning-fg">
          <TriangleAlert className="size-3.5 text-warning-solid" aria-hidden />
          Needs clarification
        </span>
      ) : null}
    </nav>
  );
}
