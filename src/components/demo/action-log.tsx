import { CircleCheck, CircleMinus, Clock, OctagonX, Plug, ShieldCheck, TriangleAlert, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/time";
import { AlertBanner } from "@/components/ui/alert-banner";

/** Client-side mirror of DemoStepResult (src/server/domain/demoSteps.ts); type-only. */
export interface StepRunResult {
  step: number;
  autoStaffActions: boolean;
  status: "ran" | "not_available" | "needs_presenter";
  message: string;
  missingCommands: string[];
  actions: {
    kind: "world" | "staff" | "clock";
    label: string;
    command?: string;
    actor?: string;
    outcome: "done" | "already_done" | "skipped" | "rejected_as_expected" | "failed" | "not_available";
    detail?: string;
  }[];
  clockBefore: string;
  clockAfter: string;
}

const OUTCOME: Record<StepRunResult["actions"][number]["outcome"], { label: string; cls: string; Icon: typeof CircleCheck }> = {
  done: { label: "Done", cls: "text-success-fg", Icon: CircleCheck },
  already_done: { label: "Already done", cls: "text-ink-secondary", Icon: CircleCheck },
  skipped: { label: "Skipped", cls: "text-ink-secondary", Icon: CircleMinus },
  rejected_as_expected: { label: "Refused, as expected", cls: "text-info-fg", Icon: ShieldCheck },
  failed: { label: "Did not complete", cls: "text-danger-fg", Icon: OctagonX },
  not_available: { label: "Not available yet", cls: "text-warning-fg", Icon: TriangleAlert },
};

const KIND = { world: { label: "Simulator", Icon: Plug }, staff: { label: "Staff action", Icon: UserRound }, clock: { label: "Demo clock", Icon: Clock } } as const;

/** What the last run of a step did, action by action (each one is also in History). */
export function ActionLog({ result, ranAt }: { result: StepRunResult; ranAt?: string }) {
  const failed = result.actions.filter((a) => a.outcome === "failed" || a.outcome === "not_available");
  return (
    <section aria-label={`Result of the last run of step ${result.step}`} aria-live="polite" className="grid gap-2">
      {result.status === "not_available" ? (
        <AlertBanner tone="warning" title="This step is not available yet in this build">
          {result.message}
        </AlertBanner>
      ) : result.status === "needs_presenter" ? (
        <AlertBanner tone="info" title="Nothing to simulate yet">
          {result.message}
        </AlertBanner>
      ) : failed.length ? (
        <AlertBanner tone="warning" title={`${result.actions.length - failed.length} of ${result.actions.length} actions completed; ${failed.length} did not`}>
          {result.message} The actions that did not complete are listed below with the reason. Nothing was overwritten.
        </AlertBanner>
      ) : (
        <AlertBanner tone="success" title={result.autoStaffActions ? "Simulator events and rehearsal actions done" : "Simulator events done"}>
          {result.message}
        </AlertBanner>
      )}
      {result.actions.length ? (
        <details open={failed.length > 0 || result.actions.length <= 3} className="rounded-md border border-line">
          <summary className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-subtle">
            {result.actions.length} action{result.actions.length === 1 ? "" : "s"} in this run
            <span className="font-normal text-ink-muted">
              {" "}
              ({result.actions.length - failed.length} completed
              {failed.length ? `, ${failed.length} did not complete` : ""})
            </span>
          </summary>
          <ol className="grid gap-1 border-t border-line p-2 text-sm">
            {result.actions.map((a, i) => {
              const o = OUTCOME[a.outcome];
              const k = KIND[a.kind];
              return (
                <li key={i} className="flex items-start gap-2 border-b border-line py-1 last:border-b-0">
                  <o.Icon className={cn("mt-0.5 size-4 shrink-0", o.cls)} aria-hidden />
                  <div className="min-w-0">
                    <p className="text-ink">
                      <span className="sr-only">{o.label}: </span>
                      {a.label}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                      <span className="inline-flex items-center gap-1">
                        <k.Icon className="size-3.5" aria-hidden />
                        {k.label}
                      </span>
                      {a.actor ? <span>as {a.actor}</span> : null}
                      {a.command ? <span className="id-mono">{a.command}</span> : null}
                      <span className={o.cls} aria-hidden>
                        {o.label}
                      </span>
                    </p>
                    {a.detail ? <p className="text-xs text-ink-secondary">{a.detail}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
      <p className="text-xs text-ink-muted">
        {ranAt ? `Last run at ${fmtTime(ranAt)} ET (demo clock). ` : ""}Demo clock {fmtTime(result.clockBefore)} ET → {fmtTime(result.clockAfter)} ET. Every action
        above is also recorded in the case History and the audit log.
      </p>
    </section>
  );
}
