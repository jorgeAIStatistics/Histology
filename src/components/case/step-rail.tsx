import { ArrowRight, Check, CirclePause, CircleQuestionMark, Lock, Minus, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { RailStep } from "./format";

const STATE_WORD: Record<RailStep["state"], string> = {
  done: "done",
  current: "in progress",
  next: "next",
  todo: "not yet",
  unknown: "unknown",
  na: "not applicable",
};

/**
 * The top edge carries progress and tone only: done steps share the
 * hematoxylin edge so how far a part has come reads in one sweep, the step in
 * progress is filled, the next step is outlined, steps not yet reached keep
 * the hairline. Held is hatched ink; a failed update or a record that needs
 * clarification is amber. A step a rule blocks is never outlined as next: it
 * keeps a stronger hairline, its lock and the reason in words.
 */
function cellClass(s: RailStep): string {
  if (s.held.length) return "hatch border-hold-solid";
  if (s.warning) return "border-warning-solid bg-warning-bg";
  if (s.blocked) return "border-line-strong";
  if (s.state === "done") return "border-shell";
  if (s.state === "current") return "border-brand bg-brand-50";
  if (s.state === "next") return "border-line-strong outline-1 -outline-offset-1 outline-ink-muted";
  return "border-line";
}

function labelClass(s: RailStep): string {
  if (s.held.length) return "font-semibold text-hold-fg";
  if (s.blocked) return "font-semibold text-ink";
  if (s.state === "current") return "font-bold text-ink";
  if (s.state === "next") return "font-semibold text-ink";
  return "text-ink-muted";
}

/** The second line of a cell: icon and words for every state except a step not yet reached, which stays a muted label. */
function StepState({ s }: { s: RailStep }) {
  const icon = "mt-px size-3.5 shrink-0";
  // In the text flow, so a short detail wraps under its icon in a narrow cell.
  const inline = "mr-1 inline size-3.5 align-[-0.2em] text-ink-muted";
  if (s.held.length) {
    return (
      <span className="flex min-w-0 items-start gap-1 font-medium text-hold-fg">
        <CirclePause className={cn(icon, "text-hold-solid")} aria-hidden />
        <span className="min-w-0">
          Held by <span className="id-mono">{s.held.join(", ")}</span>
        </span>
      </span>
    );
  }
  if (s.warning) {
    return (
      <span className="flex min-w-0 items-start gap-1 font-medium text-warning-fg">
        <TriangleAlert className={cn(icon, "text-warning-solid")} aria-hidden />
        <span className="min-w-0">{s.detail}</span>
      </span>
    );
  }
  if (s.blocked) {
    // The lock sits in the text flow so the words wrap under it in a narrow cell.
    return (
      <span className="block min-w-0 text-ink-secondary">
        <Lock className={inline} aria-hidden />
        {/* The cell is narrow: the lock and "until approved" when the reason is the approval; the readiness line gives the policy reason once. */}
        {/not approved/i.test(s.blocked) ? "Until approved" : `Blocked: ${s.blocked.charAt(0).toLowerCase() + s.blocked.slice(1)}`}
      </span>
    );
  }
  if (s.state === "done") {
    return (
      <span className="block min-w-0 text-ink-muted">
        <Check className={inline} aria-hidden />
        {s.detail}
      </span>
    );
  }
  if (s.state === "current") {
    return (
      <span className="block min-w-0 text-ink">
        <ArrowRight className={cn(inline, "text-ink")} aria-hidden />
        {s.detail ?? "In progress"}
      </span>
    );
  }
  if (s.state === "next") return <span className="text-ink-secondary">Next</span>;
  if (s.state === "unknown") {
    return (
      <span className="flex min-w-0 items-start gap-1 text-ink-muted">
        <CircleQuestionMark className={cn(icon, "text-ink-muted")} aria-hidden />
        Unknown
      </span>
    );
  }
  if (s.state === "na") {
    return (
      <span className="flex min-w-0 items-start gap-1 text-ink-muted">
        <Minus className={cn(icon, "text-ink-muted")} aria-hidden />
        Not applicable
      </span>
    );
  }
  return null;
}

/**
 * One track of a part (physical or documentation) as a read-only step rail,
 * the same rail idea as Intake's finding band: square cells, the top edge for
 * progress and tone only, done quiet, the step in progress filled, the next one
 * outlined, a held step hatched with the hold that stops it, and a step a rule
 * blocks with a lock and the reason in words (never the next outline). Physical evidence (where a
 * cassette waits) sits on the step it waits for. State is always in words for
 * screen readers.
 */
export function StepRail({ title, steps, className, columns }: { title: string; steps: RailStep[]; className?: string; columns: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <h4 className="text-xs font-semibold text-ink-secondary">{title}</h4>
      <ol aria-label={`${title} steps`} className={cn("mt-1 grid gap-1", columns)}>
        {steps.map((s) => (
          <li
            key={s.key}
            aria-current={s.state === "current" ? "step" : undefined}
            className={cn("flex min-h-11 min-w-0 flex-col gap-0.5 border-t-2 px-1 pt-1 pb-1.5", cellClass(s))}
          >
            <span className={cn("min-w-0 text-sm leading-[1.15rem] break-words", labelClass(s))}>{s.label}</span>
            {s.note ? <span className="min-w-0 text-xs text-ink-secondary">{s.note}</span> : null}
            <span className="min-w-0 text-xs">
              <StepState s={s} />
            </span>
            <span className="sr-only">
              , {STATE_WORD[s.state]}
              {s.held.length ? `, held by ${s.held.join(", ")}` : ""}
              {s.blocked ? `, blocked: ${s.blocked.charAt(0).toLowerCase() + s.blocked.slice(1)}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
