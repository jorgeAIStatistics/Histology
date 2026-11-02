"use client";

import { ArrowRight, Check, Circle, CircleCheck, Hourglass, Info, Lock, TriangleAlert } from "lucide-react";
import { HoldPill } from "@/components/domain/hold";
import { IdentityMark } from "@/components/domain/identity-mark";
import { cn } from "@/lib/cn";
import { Segs } from "./bits";
import { segText, type IntakePlan, type PathStep, type Seg, type StepKey } from "./plan";

const LEAD_ICON = {
  danger: <IdentityMark className="mt-[3px] size-[18px]" />,
  warning: <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning-solid" aria-hidden />,
  neutral: <Info className="mt-0.5 size-5 shrink-0 text-ink-muted" aria-hidden />,
  done: <CircleCheck className="mt-0.5 size-5 shrink-0 text-ink-muted" aria-hidden />,
};

function StepIcon({ step }: { step: PathStep }) {
  const c = "mt-0.5 size-3.5 shrink-0";
  if (step.state === "done" || step.state === "none") return <Check className={cn(c, "text-ink-muted")} aria-hidden />;
  if (step.tone === "danger") return <IdentityMark className={cn(c, "mt-[3px]")} />;
  if (step.tone === "warning") return <TriangleAlert className={cn(c, "text-warning-solid")} aria-hidden />;
  if (step.state === "waiting") return <Hourglass className={cn(c, "text-ink-muted")} aria-hidden />;
  if (step.state === "blocked") return <Lock className={cn(c, "text-ink-muted")} aria-hidden />;
  if (step.state === "mine") return <ArrowRight className={cn(c, "text-ink")} aria-hidden />;
  return <Circle className={cn(c, "text-ink-muted")} aria-hidden />;
}

const STATE_WORD: Record<PathStep["state"], string> = {
  done: "done",
  mine: "yours now",
  waiting: "waiting",
  todo: "to do",
  blocked: "blocked",
  none: "not needed",
};

/** "Stops gross approval." read after the hold id: "H-0090 stops gross approval." */
function lowerFirst(s: Seg[]): Seg[] {
  const [first, ...rest] = s;
  return typeof first === "string" ? [first.charAt(0).toLowerCase() + first.slice(1), ...rest] : s;
}

/** The top edge carries tone only: identity red, differs amber, otherwise a quiet line. */
function edgeClass(s: PathStep): string {
  if (s.state === "done" || s.state === "none") return "border-line";
  if (s.tone === "danger") return "border-danger-solid";
  if (s.tone === "warning") return "border-warning-solid";
  return "border-line-strong";
}

/**
 * Finding band: one two-tone sentence (what the evidence says; what the
 * accession waits on), the hold scope for every part of the submission (each
 * hold leads as the shared hatched HoldPill, then its id and what it stops), and the five-step path to accession with the
 * owner and blocker of each step. Steps are buttons: they (and keys 1 to 5)
 * jump to the evidence for that step. The step that holds your next step is
 * filled with the hematoxylin tint and set bold (aria-current); other steps
 * that are also yours keep the arrow; the top edge only carries tone.
 */
export function FindingBand({ plan, active, onStep, className }: { plan: IntakePlan; active: StepKey | null; onStep: (key: StepKey) => void; className?: string }) {
  const f = plan.finding;
  const hl = plan.holdLine;
  return (
    <section aria-label="Current finding" className={cn("min-w-0 border-b border-line bg-surface px-5 pt-3 pb-2.5 max-[87.4375rem]:px-4", className)}>
      <p className="flex items-start gap-2.5 text-md leading-6">
        {LEAD_ICON[f.tone]}
        <span>
          <span className="font-bold text-ink">
            <Segs value={f.lead} />
          </span>{" "}
          <span className="text-ink-secondary">
            <Segs value={f.then} />
          </span>
        </span>
      </p>
      <p className={cn("mt-1 ml-[1.875rem] text-sm leading-6", hl.held ? "text-ink-secondary" : "text-ink-muted")}>
        {hl.holds.map((h) => (
          <span key={h.id}>
            <HoldPill scope={h.scope} className="align-middle" /> <span className="id-mono text-ink">{h.id}</span> <Segs value={lowerFirst(h.effect)} />{" "}
          </span>
        ))}
        <Segs value={hl.tail} />
      </p>
      <nav aria-label="Path to accession" className="mt-2.5">
        <ol className="grid grid-cols-5 gap-1">
          {plan.steps.map((s, i) => {
            const current = plan.current === s.key;
            const mine = s.state === "mine";
            const quiet = s.state === "done" || s.state === "none";
            return (
              <li key={s.key} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onStep(s.key)}
                  aria-current={current ? "step" : undefined}
                  aria-keyshortcuts={String(i + 1)}
                  aria-label={`Step ${i + 1}, ${s.label}, ${STATE_WORD[s.state]}: ${segText(s.status)}${s.owner && !mine ? `. Waiting on ${s.owner}` : ""}`}
                  className={cn(
                    "group flex h-full min-h-11 w-full min-w-0 flex-col items-start gap-0.5 rounded-none border-t-2 px-2 pt-1.5 pb-1.5 text-left transition-colors duration-[var(--hlo-duration-fast)]",
                    edgeClass(s),
                    current ? "bg-brand-50 hover:bg-brand-100" : active === s.key ? "bg-surface-subtle" : "hover:bg-surface-subtle",
                  )}
                >
                  <span className={cn("w-full min-w-0 truncate text-sm leading-5", current ? "font-bold text-ink" : quiet ? "font-medium text-ink-muted" : "font-semibold text-ink")}>
                    {s.label}
                  </span>
                  <span
                    className={cn(
                      "flex w-full min-w-0 items-start gap-1 text-sm leading-[1.15rem]",
                      quiet ? "text-ink-muted" : s.tone === "danger" ? "text-danger-fg" : s.tone === "warning" ? "text-warning-fg" : mine ? "text-ink" : "text-ink-secondary",
                    )}
                  >
                    <StepIcon step={s} />
                    <span className="line-clamp-2 min-w-0">
                      <Segs value={s.short} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </section>
  );
}
