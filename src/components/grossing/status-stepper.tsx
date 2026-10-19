import type { ReactNode } from "react";
import { ArrowRight, Check, Circle, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GrossState, SourceUpdateState } from "@/lib/domain";
import { currentStepIndex, STEPS, type StepKey } from "./model";

/**
 * The six record states in order, as a rail. Documentation approval and the
 * source-system update are separate: "Entered (staff attested)" is not an
 * acknowledgment, and only the simulator can produce "Source acknowledged
 * (simulated)". Each step says who and when once reached, or who it waits on.
 * As on the Intake rail, the current step is filled with the hematoxylin tint
 * and set bold; done steps go quiet; the top edge carries tone only.
 */
export function StatusRail({
  state,
  sourceUpdateState,
  details,
}: {
  state: GrossState | null;
  sourceUpdateState: SourceUpdateState | null;
  /** One short line under each step: who and when, or who it waits on. */
  details?: Partial<Record<StepKey, ReactNode>>;
}) {
  const current = currentStepIndex(state, sourceUpdateState);
  const flagged = state === "needs_clarification";
  return (
    <nav aria-label="Gross record status">
      <ol className="grid grid-cols-6 gap-1">
        {STEPS.map((s, i) => {
          const isCurrent = i === current;
          // The last step is complete as soon as it is reached; every earlier reached step is done.
          const done = i < current || (isCurrent && i === STEPS.length - 1);
          const warn = isCurrent && flagged;
          const detail = details?.[s.key];
          return (
            <li
              key={s.key}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex min-w-0 flex-col gap-0.5 border-t-2 px-1.5 pt-1.5 pb-1.5",
                warn ? "border-warning-solid" : isCurrent && !done ? "border-shell" : done ? "border-line" : "border-line-strong",
                isCurrent && !done && "bg-brand-50",
              )}
            >
              <span
                className={cn(
                  "flex min-w-0 items-start gap-1 text-sm leading-5",
                  isCurrent && !done ? "font-bold text-ink" : done ? "font-medium text-ink-muted" : "font-medium text-ink-secondary",
                )}
              >
                {done ? (
                  <Check className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
                ) : warn ? (
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-solid" aria-hidden />
                ) : isCurrent ? (
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-ink" aria-hidden />
                ) : (
                  <Circle className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
                )}
                <span className="min-w-0">
                  {s.label}
                  <span className="sr-only">{isCurrent ? " (current step)" : done ? " (done)" : " (not yet)"}</span>
                </span>
              </span>
              {warn ? <span className="pl-[1.125rem] text-sm leading-[1.15rem] font-medium text-warning-fg max-[1279px]:pl-0">Needs clarification</span> : null}
              {detail ? (
                <span className={cn("pl-[1.125rem] text-sm leading-[1.15rem] max-[1279px]:pl-0", isCurrent && !done ? "text-ink" : "text-ink-muted")}>{detail}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
