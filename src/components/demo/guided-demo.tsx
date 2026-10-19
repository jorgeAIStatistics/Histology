"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppWindow, CircleCheck, CircleDashed, CircleDot, Clock, Lock, Play, WandSparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/time";
import { useCommand } from "@/lib/client/command";
import { DEMO_CLOCK_COMMAND, type DemoClockInput } from "@/lib/client/demo-commands";
import { rememberDemoStep } from "@/lib/client/demo-step";
import { Button, ButtonLink } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { SimulatedLabel } from "@/components/domain/honesty";
import { IdText } from "@/components/domain/id-text";
import { COPY_GUARD, STEPS, checkText, missingRecordText, recordsDoneText, type DemoIds, type StepRecords } from "./content";
import { ActionLog, type StepRunResult } from "./action-log";
import { usePresenterLarge } from "./demo-toolbar";

export type StepStatusView = StepRecords;

/** One row of the real Operations "what is blocked" list (S3 read model), for step 8. */
export interface OpsBlockerView {
  key: string;
  item: string;
  href: string;
  blocks: string;
  owner: string;
  age: string;
}

type LoggedRun = StepRunResult & { ranAt?: string; ranBy?: string | null };

// Severity ladder: done is a quiet check, in progress is plain ink (someone still has to act), not started is a dashed ring.
const STATE_ICON = { done: CircleCheck, in_progress: CircleDot, not_started: CircleDashed } as const;

function StateIcon({ state, className }: { state: StepStatusView["state"]; className?: string }) {
  const Icon = STATE_ICON[state];
  return <Icon className={cn("size-4", state === "in_progress" ? "text-ink" : "text-ink-muted", className)} aria-hidden />;
}

/**
 * Guided demo tab (design-spec §6.10): a stepper with the 8 narrative steps;
 * for the selected step, what to click (deep links into the real screens),
 * what to notice, real vs simulated, progress derived from the records, and
 * two controls: simulator events only, or simulator events plus the staff
 * actions (rehearsal). Both go through `demo.runStep`.
 */
export function GuidedDemo({
  steps,
  selected,
  ids,
  stepClockIso,
  clockNow,
  lastResults,
  canRehearse,
  rehearsalNote,
  blockers,
}: {
  steps: StepStatusView[];
  selected: number;
  ids: DemoIds;
  /** Step number → demo-clock ISO time for that step. */
  stepClockIso: Record<number, string>;
  clockNow: string;
  /** Last recorded run of each step (server log), so the action log survives a reload. */
  lastResults: Partial<Record<number, LoggedRun>>;
  /** Rehearsal acts as other named staff, so it is limited to the supervisor demo role. */
  canRehearse: boolean;
  rehearsalNote: string | null;
  /** Step 8 only: the real Operations blocked list, or null when it could not be read. */
  blockers: OpsBlockerView[] | null;
}) {
  const presenterLarge = usePresenterLarge();
  const content = STEPS.find((s) => s.step === selected) ?? STEPS[0];
  const status = steps.find((s) => s.step === content.step);
  const [results, setResults] = useState<Record<number, StepRunResult | undefined>>({});
  const [confirmAuto, setConfirmAuto] = useState(false);

  // No toast: the run's result line swaps in inside the step sheet and is the one confirmation (a toast would cover the sheet at 200% zoom).
  const world = useCommand<StepRunResult, { step: number }>("demo.runStep", {
    onSuccess: (r) => setResults((prev) => ({ ...prev, [r.step]: r })),
  });
  const auto = useCommand<StepRunResult, { step: number; autoStaffActions: boolean }>("demo.runStep", {
    onSuccess: (r) => setResults((prev) => ({ ...prev, [r.step]: r })),
  });
  const clock = useCommand<unknown, DemoClockInput>(DEMO_CLOCK_COMMAND, { successToast: "Demo clock moved" });

  // The side nav shows this step on the real screens, so the presenter can come straight back to it.
  useEffect(() => {
    rememberDemoStep({ step: content.step, short: content.short, total: STEPS.length });
  }, [content.step, content.short]);

  // Reset per-step command errors when the presenter changes step.
  const resetWorld = world.reset;
  const resetAuto = auto.reset;
  useEffect(() => {
    resetWorld();
    resetAuto();
  }, [selected, resetWorld, resetAuto]);

  const stepIso = stepClockIso[content.step];
  const clockBehind = stepIso ? Date.parse(clockNow) < Date.parse(stepIso) : false;
  const links = content.links(ids);
  const result: LoggedRun | undefined = results[content.step] ?? lastResults[content.step];
  const busy = world.pending || auto.pending;
  const prev = STEPS.find((x) => x.step === content.step - 1) ?? null;
  const next = STEPS.find((x) => x.step === content.step + 1) ?? null;
  const txt = presenterLarge ? "text-md" : "text-sm";

  const fresh = results[content.step] !== undefined;
  // Which record is still missing (a run can finish while a check is still open), named as a record, never as a claim.
  const missingRecord = status ? missingRecordText(status, steps) : null;

  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[17rem_minmax(0,1fr)]">
      <StepRail steps={steps} current={content.step} stepClockIso={stepClockIso} />

      {/* Step detail: one sheet, sections divided by hairlines */}
      <section aria-labelledby="demo-step-title" className="min-w-0 rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="demo-step-title" className={cn("font-bold tracking-[-0.01em] text-ink", presenterLarge ? "text-2xl" : "text-lg")}>
              {content.title}
            </h2>
            <dl className={cn("mt-1 flex flex-wrap gap-x-5 gap-y-0.5", txt)}>
              <div className="flex gap-1.5">
                <dt className="text-ink-muted">Step</dt>
                <dd className="text-ink">
                  {content.step} of {STEPS.length}
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-ink-muted">Scripted for</dt>
                <dd className="text-ink">{stepIso ? `${fmtTime(stepIso)} ET` : "Unknown"}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-ink-muted">Spoken</dt>
                <dd className="text-ink">About {content.seconds} s</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-ink-muted">On screen</dt>
                <dd className="text-ink">{content.cast}</dd>
              </div>
            </dl>
            {missingRecord ? (
              <p className={cn("mt-1 text-ink-secondary", txt)}>
                <span className="text-ink-muted">Missing record: </span>
                <IdText text={missingRecord} />
              </p>
            ) : null}
          </div>
          {status ? (
            <StatusPill tone="neutral" icon={STATE_ICON[status.state]}>
              Records: {recordsDoneText(status.checks)}
            </StatusPill>
          ) : null}
        </header>

        {/* Controls: the step's one primary action, then the rehearsal shortcut */}
        <div role="group" aria-label={`Presenter controls for step ${content.step}`} className={cn("grid gap-4 border-b border-line px-4 py-4 lg:grid-cols-2", txt)}>
          <div className="flex flex-col items-start gap-1.5">
            <Button
              variant="primary"
              icon={<Play />}
              loading={world.pending}
              loadingLabel="Running..."
              disabled={busy}
              onClick={() => void world.run({ step: content.step })}
            >
              Run simulator events for this step
            </Button>
            <p className="text-ink-secondary">
              <IdText text={content.worldEvents} />
            </p>
            <CommandError error={world.error} />
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <Button
              variant="secondary"
              icon={canRehearse ? <WandSparkles /> : <Lock />}
              loading={auto.pending}
              loadingLabel="Performing..."
              disabled={busy || !canRehearse}
              aria-describedby={canRehearse ? undefined : "demo-rehearsal-note"}
              onClick={() => setConfirmAuto(true)}
            >
              Auto-perform staff actions (rehearsal)
            </Button>
            <p className="text-ink-secondary">
              <IdText text={content.staffActions} />
            </p>
            {rehearsalNote ? (
              <p id="demo-rehearsal-note" className="text-ink-muted">
                {rehearsalNote}
              </p>
            ) : null}
            <CommandError error={auto.error} />
          </div>
          {clockBehind && stepIso ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:col-span-2">
              <Button variant="quiet" size="sm" icon={<Clock />} loading={clock.pending} loadingLabel="Moving..." onClick={() => void clock.run({ iso: stepIso })}>
                Jump demo clock to {fmtTime(stepIso)} ET
              </Button>
              <span className="text-sm text-ink-muted">The demo clock is at {fmtTime(clockNow)} ET. Step runs only move it forward.</span>
              <CommandError error={clock.error} />
            </div>
          ) : null}
        </div>

        <div className={cn("grid gap-5 p-4", txt)}>
          {result ? <ActionLog key={`${result.step}-${result.ranAt ?? "now"}-${result.clockAfter}`} result={result} ranAt={result.ranAt} fresh={fresh} /> : null}

          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-ink">Open the real screen</h3>
            <ul className="flex flex-wrap gap-2">
              {links.map((l) => (
                <li key={l.href + l.label} className="flex flex-col">
                  <ButtonLink href={l.href} size="sm" variant="secondary" icon={<AppWindow />}>
                    <IdText text={l.label} />
                  </ButtonLink>
                  {l.pending ? <span className="mt-0.5 text-sm text-ink-muted">Expected ID; exists {l.pending}</span> : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="mb-1.5 text-sm font-semibold text-ink">What to click</h3>
              <ol className="list-decimal space-y-1 pl-5 text-ink marker:text-ink-muted">
                {content.click.map((c) => (
                  <li key={c}>
                    <IdText text={c} />
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="mb-1.5 text-sm font-semibold text-ink">What to notice</h3>
              <ul className="list-disc space-y-1 pl-5 text-ink marker:text-ink-muted">
                {content.notice.map((c) => (
                  <li key={c}>
                    <IdText text={c} />
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <section aria-labelledby="demo-step-rvs" className="border-t border-line pt-4">
            <h3 id="demo-step-rvs" className="mb-1.5 text-sm font-semibold text-ink">
              Real vs simulated in this step
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm font-semibold text-ink-secondary">Working in this demo (local logic)</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink marker:text-ink-muted">
                  {content.working.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
              <div>
                <SimulatedLabel>Simulated in this step</SimulatedLabel>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink marker:text-ink-muted">
                  {/* Plain text: these name simulated systems (EMA-SIM), which are not identifiers. */}
                  {content.simulated.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {status ? (
            <section aria-labelledby="demo-step-progress" className="border-t border-line pt-4">
              <h3 id="demo-step-progress" className="mb-1.5 text-sm font-semibold text-ink">
                Progress (read from the records)
              </h3>
              <ul className="grid gap-1">
                {status.checks.map((c) => (
                  <li key={c.label} className="flex items-start gap-2">
                    {c.done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />}
                    <span className={c.done ? "text-ink-secondary" : "text-ink"}>
                      <span className="sr-only">{c.done ? "Done: " : "Not yet: "}</span>
                      <IdText text={checkText(content.step, c.label)} />
                      {c.detail ? (
                        <span className="ml-1 text-ink-muted">
                          (<IdText text={c.detail} />)
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {content.step === 8 ? <OperationsSummary blockers={blockers} heroAccession={ids.accession} /> : null}

          <nav aria-label="Step navigation" className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
            {prev ? (
              <ButtonLink href={`/demo?tab=guide&step=${prev.step}`} size="sm" variant="quiet" scroll={false}>
                Previous: {prev.step}. {prev.short}
              </ButtonLink>
            ) : (
              <span />
            )}
            {next ? (
              <ButtonLink href={`/demo?tab=guide&step=${next.step}`} size="sm" variant="secondary" scroll={false}>
                Next: {next.step}. {next.short}
              </ButtonLink>
            ) : (
              <ButtonLink href="/demo?tab=notes" size="sm" variant="secondary">
                Closing notes
              </ButtonLink>
            )}
          </nav>
        </div>

        <footer className="rounded-b-lg border-t border-line bg-surface-subtle px-4 py-2 text-sm text-ink-secondary" role="note">
          {COPY_GUARD}
        </footer>
      </section>

      <ConfirmDialog
        open={confirmAuto}
        title={`Perform the staff actions of step ${content.step} automatically?`}
        confirmLabel="Perform rehearsal actions"
        cancelLabel="Keep doing them by hand"
        pending={auto.pending}
        pendingLabel="Performing..."
        onCancel={() => setConfirmAuto(false)}
        onConfirm={() => {
          void auto.run({ step: content.step, autoStaffActions: true }).finally(() => setConfirmAuto(false));
        }}
      >
        <p className="text-sm text-ink-secondary">
          For rehearsal and testing. {content.staffActions}
        </p>
        <p className="mt-2 text-sm text-ink-secondary">
          Each action runs through the same commands as the real screens, performed as the named staff member (for example Kim Nguyen or Dana Whitfield), so that
          person&apos;s role checks, holds and safety rules apply. In History each action shows that staff member as the actor, marked as a demo action; the run itself is
          recorded under your name and linked to every action. This is a demo convenience, not a real person&apos;s work, and the role selector is not authentication.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * The eight steps as one hairline sheet, like the Intake step rail: the current step selected (fill and a
 * 1px brand outline), done quiet, in progress in ink. Progress is read from the records.
 */
function StepRail({ steps, current, stepClockIso }: { steps: StepStatusView[]; current: number; stepClockIso: Record<number, string> }) {
  return (
    <nav aria-label="Demo steps" className="min-w-0">
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4 xl:grid-cols-1">
        {STEPS.map((s) => {
          const rec = steps.find((x) => x.step === s.step);
          const st = rec?.state ?? "not_started";
          const active = s.step === current;
          return (
            <li key={s.step} className="flex bg-surface">
              <Link
                href={`/demo?tab=guide&step=${s.step}`}
                scroll={false}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex min-h-[max(2.75rem,var(--hlo-target-min))] w-full items-start gap-2 px-3 py-2 text-sm transition-colors duration-[var(--hlo-duration-fast)]",
                  active ? "bg-brand-50 shadow-[inset_0_0_0_1px_var(--hlo-brand)]" : "hover:bg-surface-subtle",
                )}
              >
                <StateIcon state={st} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className={cn("block", active ? "font-semibold text-ink" : st === "done" ? "font-medium text-ink-secondary" : "font-medium text-ink")}>
                    {s.step}. {s.short}
                  </span>
                  <span className="block text-sm text-ink-muted">
                    {stepClockIso[s.step] ? `${fmtTime(stepClockIso[s.step])} ET, ` : ""}
                    {rec ? recordsDoneText(rec.checks) : "not read from the records"}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-sm text-ink-muted max-xl:hidden">Progress is read from the records, so it also counts work done directly on the real screens.</p>
    </nav>
  );
}

/** Step 8: the real Operations "what is still blocked" list (owner and age), with a link to the full screen. */
function OperationsSummary({ blockers, heroAccession }: { blockers: OpsBlockerView[] | null; heroAccession: string | null }) {
  if (blockers === null) {
    return (
      <p className="border-t border-line pt-4 text-sm text-ink-secondary">
        The Operations summary could not be read here. Open the Operations screen for the full list.
      </p>
    );
  }
  // The demonstrated case comes first (so its remaining work is visible without scrolling); the rest stay oldest first.
  const isHero = (b: OpsBlockerView) => !!heroAccession && b.item.includes(heroAccession);
  const ordered = heroAccession ? [...blockers.filter(isHero), ...blockers.filter((b) => !isHero(b))] : blockers;
  const shown = ordered.slice(0, 8);
  return (
    <section aria-labelledby="demo-ops-summary" className="border-t border-line pt-4">
      <h3 id="demo-ops-summary" className="mb-1.5 text-sm font-semibold text-ink">
        Still blocked right now (from the Operations screen)
      </h3>
      {blockers.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nothing is blocked in the synthetic records right now.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line text-sm">
          {shown.map((b) => (
            <li key={b.key} className="grid gap-x-6 gap-y-0.5 py-2 md:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)]">
              <div className="min-w-0">
                <Link href={b.href} className="font-medium text-brand underline-offset-2 hover:underline">
                  <IdText text={b.item} />
                </Link>
                <p className="text-ink-secondary">
                  <IdText text={b.blocks} />
                </p>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-2 text-ink-secondary">
                <dt className="text-ink-muted">Owner</dt>
                <dd className="text-ink">{b.owner}</dd>
                <dt className="text-ink-muted">Waiting</dt>
                <dd>{b.age}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-sm text-ink-muted">
        {blockers.length > shown.length ? `Showing ${shown.length} of ${blockers.length}${heroAccession && blockers.some(isHero) ? `, ${heroAccession} first` : ""}. ` : ""}Ages use the demo clock and synthetic records. They are not results and
        are not used to rank anyone.
      </p>
    </section>
  );
}
