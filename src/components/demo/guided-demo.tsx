"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, CircleDot, Clock, ExternalLink, Lock, Play, WandSparkles } from "lucide-react";
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
import { COPY_GUARD, STEPS, type DemoIds } from "./content";
import { ActionLog, type StepRunResult } from "./action-log";
import { usePresenterLarge } from "./demo-toolbar";

export interface StepStatusView {
  step: number;
  state: "done" | "in_progress" | "not_started";
  checks: { label: string; done: boolean; detail?: string }[];
}

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

const runToast = (what: string) => (r: StepRunResult) => (r.status === "ran" ? `Step ${r.step}: ${what}` : null);

const STATE_LABEL = { done: "Done", in_progress: "In progress", not_started: "Not started" } as const;
const STATE_TONE = { done: "success", in_progress: "info", not_started: "neutral" } as const;

function StateIcon({ state, className }: { state: StepStatusView["state"]; className?: string }) {
  if (state === "done") return <CircleCheck className={cn("size-4 text-success-solid", className)} aria-hidden />;
  if (state === "in_progress") return <CircleDot className={cn("size-4 text-info-solid", className)} aria-hidden />;
  return <CircleDashed className={cn("size-4 text-ink-muted", className)} aria-hidden />;
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

  // Toast only when something ran; "nothing to simulate yet" and "not available" are explained in the action log banner.
  const world = useCommand<StepRunResult, { step: number }>("demo.runStep", {
    successToast: runToast("simulator events run"),
    onSuccess: (r) => setResults((prev) => ({ ...prev, [r.step]: r })),
  });
  const auto = useCommand<StepRunResult, { step: number; autoStaffActions: boolean }>("demo.runStep", {
    successToast: runToast("rehearsal actions performed"),
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
  const prev = content.step > 1 ? content.step - 1 : null;
  const next = content.step < STEPS.length ? content.step + 1 : null;
  const txt = presenterLarge ? "text-md" : "text-sm";

  return (
    <div className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)]">
      {/* Stepper */}
      <nav aria-label="Demo steps" className="min-w-0">
        <ol className="grid grid-cols-2 gap-1 sm:grid-cols-4 xl:grid-cols-1">
          {STEPS.map((s) => {
            const st = steps.find((x) => x.step === s.step)?.state ?? "not_started";
            const active = s.step === content.step;
            return (
              <li key={s.step}>
                <Link
                  href={`/demo?tab=guide&step=${s.step}`}
                  scroll={false}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "flex h-full items-start gap-2 rounded-md border px-3 py-2 text-sm",
                    active ? "border-brand bg-brand-50" : "border-line bg-surface hover:bg-surface-subtle",
                  )}
                >
                  <StateIcon state={st} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">
                      {s.step}. {s.short}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {stepClockIso[s.step] ? `${fmtTime(stepClockIso[s.step])} ET` : ""} · {STATE_LABEL[st]}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-xs text-ink-muted max-xl:hidden">Progress is read from the records, so it also counts work done directly on the real screens.</p>
      </nav>

      {/* Step detail */}
      <section aria-labelledby="demo-step-title" className="min-w-0 rounded-md border border-line bg-surface shadow-1">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink-muted">
              Step {content.step} of {STEPS.length} · about {content.seconds} s ·{" "}
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3.5" aria-hidden />
                {stepIso ? `Scripted for ${fmtTime(stepIso)} ET` : "Scripted time unknown"}
              </span>
            </p>
            <h2 id="demo-step-title" className={cn("font-semibold text-ink", presenterLarge ? "text-xl" : "text-md")}>
              {content.title}
            </h2>
            <p className="text-sm text-ink-secondary">On screen: {content.cast}</p>
          </div>
          {status ? (
            <StatusPill tone={STATE_TONE[status.state]}>
              {STATE_LABEL[status.state]} ({status.checks.filter((c) => c.done).length} of {status.checks.length})
            </StatusPill>
          ) : null}
        </header>

        <div className={cn("grid gap-4 p-4", txt)}>
          {/* Controls */}
          <div role="group" aria-label={`Presenter controls for step ${content.step}`} className="grid gap-3 rounded-md border border-line bg-surface-subtle p-3 lg:grid-cols-2">
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
              <p className="text-xs text-ink-secondary">{content.worldEvents}</p>
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
              <p className="text-xs text-ink-secondary">{content.staffActions}</p>
              {rehearsalNote ? (
                <p id="demo-rehearsal-note" className="text-xs text-ink-muted">
                  {rehearsalNote}
                </p>
              ) : null}
              <CommandError error={auto.error} />
            </div>
            {clockBehind && stepIso ? (
              <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
                <Button variant="quiet" size="sm" icon={<Clock />} loading={clock.pending} loadingLabel="Moving..." onClick={() => void clock.run({ iso: stepIso })}>
                  Jump demo clock to {fmtTime(stepIso)} ET
                </Button>
                <span className="text-xs text-ink-muted">The demo clock is at {fmtTime(clockNow)} ET. Step runs only move it forward.</span>
                <CommandError error={clock.error} />
              </div>
            ) : null}
          </div>

          {result ? <ActionLog result={result} ranAt={result.ranAt} /> : null}

          {/* Open the real screens */}
          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-ink">Open the real screen</h3>
            <ul className="flex flex-wrap gap-2">
              {links.map((l) => (
                <li key={l.href + l.label} className="flex flex-col">
                  <ButtonLink href={l.href} size="sm" variant="secondary" icon={<ExternalLink />}>
                    {l.label}
                  </ButtonLink>
                  {l.pending ? <span className="mt-0.5 text-xs text-ink-muted">Expected ID; exists {l.pending}</span> : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1.5 text-sm font-semibold text-ink">What to click</h3>
              <ol className="list-decimal space-y-1 pl-5 text-ink">
                {content.click.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="mb-1.5 text-sm font-semibold text-ink">What to notice</h3>
              <ul className="list-disc space-y-1 pl-5 text-ink">
                {content.notice.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="rounded-md border border-line bg-surface-subtle p-3">
            <h3 className="mb-1.5 text-sm font-semibold text-ink">Real vs simulated in this step</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold text-ink-secondary">Working in this demo (local logic)</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink">
                  {content.working.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold text-ink-secondary">
                  <SimulatedLabel size="xs">Simulated in this step</SimulatedLabel>
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink">
                  {content.simulated.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {status ? (
            <div>
              <h3 className="mb-1.5 text-sm font-semibold text-ink">Progress (read from the records)</h3>
              <ul className="grid gap-1">
                {status.checks.map((c) => (
                  <li key={c.label} className="flex items-start gap-2">
                    {c.done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-solid" aria-hidden /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />}
                    <span>
                      <span className="sr-only">{c.done ? "Done: " : "Not yet: "}</span>
                      {c.label}
                      {c.detail ? <span className="ml-1 text-ink-muted">({c.detail})</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {content.step === 8 ? <OperationsSummary blockers={blockers} heroAccession={ids.accession} /> : null}

          <nav aria-label="Step navigation" className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            {prev ? (
              <ButtonLink href={`/demo?tab=guide&step=${prev}`} size="sm" variant="quiet" icon={<ArrowLeft />} scroll={false}>
                Previous step
              </ButtonLink>
            ) : (
              <span />
            )}
            {next ? (
              <ButtonLink href={`/demo?tab=guide&step=${next}`} size="sm" variant="secondary" scroll={false}>
                Next step <ArrowRight className="size-4" aria-hidden />
              </ButtonLink>
            ) : (
              <ButtonLink href="/demo?tab=notes" size="sm" variant="secondary">
                Closing notes <ArrowRight className="size-4" aria-hidden />
              </ButtonLink>
            )}
          </nav>
        </div>

        <footer className="border-t border-line bg-surface-subtle px-4 py-2 text-xs text-ink-secondary" role="note">
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

/** Step 8: the real Operations "what is still blocked" list (owner and age), with a link to the full screen. */
function OperationsSummary({ blockers, heroAccession }: { blockers: OpsBlockerView[] | null; heroAccession: string | null }) {
  if (blockers === null) {
    return (
      <p className="rounded-md border border-line bg-surface-subtle p-3 text-sm text-ink-secondary">
        The Operations summary could not be read here. Open the Operations screen for the full list.
      </p>
    );
  }
  // The demonstrated case comes first (so its remaining work is visible without scrolling); the rest stay oldest first.
  const isHero = (b: OpsBlockerView) => !!heroAccession && b.item.includes(heroAccession);
  const ordered = heroAccession ? [...blockers.filter(isHero), ...blockers.filter((b) => !isHero(b))] : blockers;
  const shown = ordered.slice(0, 8);
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold text-ink">Still blocked right now (from the Operations screen)</h3>
      {blockers.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nothing is blocked in the synthetic records right now.</p>
      ) : (
        <ul className="grid gap-1 rounded-md border border-line p-2 text-sm">
          {shown.map((b) => (
            <li key={b.key} className="border-b border-line py-1 last:border-b-0">
              <Link href={b.href} className="font-medium text-brand underline-offset-2 hover:underline">
                {b.item}
              </Link>
              <p className="text-xs text-ink-secondary">{b.blocks}</p>
              <p className="text-xs text-ink-muted">
                Owner: {b.owner} · waiting {b.age}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-ink-muted">
        {blockers.length > shown.length ? `Showing ${shown.length} of ${blockers.length}${heroAccession && blockers.some(isHero) ? `, ${heroAccession} first` : ""}. ` : ""}Ages use the demo clock and synthetic records. They are not results and
        are not used to rank anyone.
      </p>
    </div>
  );
}
