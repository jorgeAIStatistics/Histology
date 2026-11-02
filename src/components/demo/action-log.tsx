import { ChevronRight, CircleCheck, CircleMinus, Clock, Plug, ShieldCheck, TriangleAlert, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/time";
import { IdText } from "@/components/domain/id-text";

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

// Severity ladder: done is a quiet check; a safeguard that held reads in ink; anything that did not complete is amber with a triangle (red is only for patient identity).
const OUTCOME: Record<StepRunResult["actions"][number]["outcome"], { label: string; cls: string; Icon: typeof CircleCheck }> = {
  done: { label: "Done", cls: "text-ink-muted", Icon: CircleCheck },
  already_done: { label: "Already done", cls: "text-ink-muted", Icon: CircleCheck },
  skipped: { label: "Skipped", cls: "text-ink-muted", Icon: CircleMinus },
  rejected_as_expected: { label: "Refused, as expected", cls: "text-ink-secondary", Icon: ShieldCheck },
  failed: { label: "Did not complete", cls: "text-warning-fg", Icon: TriangleAlert },
  not_available: { label: "Not available yet", cls: "text-warning-fg", Icon: TriangleAlert },
};

const KIND = { world: { label: "Simulator", Icon: Plug }, staff: { label: "Staff action", Icon: UserRound }, clock: { label: "Demo clock", Icon: Clock } } as const;

// The run's own line, on the same ladder: done is a quiet check in ink, "needs the presenter" is waiting on a person, a step that is missing or partly failed is amber.
const RESULT_TONE = {
  done: { Icon: CircleCheck, icon: "text-ink-muted", title: "text-ink" },
  waiting: { Icon: UserRound, icon: "text-ink-secondary", title: "text-ink" },
  warning: { Icon: TriangleAlert, icon: "text-warning-solid", title: "text-warning-fg" },
} as const;

/* The server summarizes each command result as "key: value · key: value" (src/server/domain/demoSteps.ts).
 * Read it back as labeled values in the product's words; anything else (a sentence, an error) stays as written. */
const DETAIL_LABEL: Record<string, string> = {
  displayId: "Record",
  display_id: "Record",
  accessionNumber: "Accession",
  accession_number: "Accession",
  result: "Result",
  status: "Status",
  state: "Status",
  outcome: "Outcome",
  duplicate: "Duplicate",
};
const ID_NOUN: [RegExp, string][] = [
  [/^CR-/, "Delivery"],
  [/^INT-/, "Intake item"],
  [/^CLR-/, "Clarification"],
  [/^H-/, "Hold"],
  [/^ORD-/, "Order"],
  [/^AR-/, "Accession request"],
  [/^PJ-/, "Print job"],
  [/^TRY-/, "Tray"],
  [/^RR-/, "Retrieval request"],
  [/^D\d{2}-/, "Accession"],
];
const IDENTIFIER = /^[A-Z][A-Z0-9]{0,4}(?:-[A-Z0-9]+)+$/;

function readDetail(detail: string): { label: string; value: string }[] | null {
  const facts: { label: string; value: string }[] = [];
  for (const part of detail.split(" · ")) {
    const m = /^(\w+): (.+)$/.exec(part);
    const label = m ? DETAIL_LABEL[m[1]] : undefined;
    if (!m || !label) return null;
    const [, key, raw] = m;
    if (label === "Record" && IDENTIFIER.test(raw)) {
      facts.push({ label: ID_NOUN.find(([re]) => re.test(raw))?.[1] ?? label, value: raw });
    } else if (key === "duplicate") {
      facts.push({ label, value: raw === "true" ? "Yes" : raw === "false" ? "No" : raw });
    } else if (IDENTIFIER.test(raw)) {
      facts.push({ label, value: raw });
    } else {
      const words = raw.replace(/_/g, " ");
      facts.push({ label, value: words.charAt(0).toUpperCase() + words.slice(1) });
    }
  }
  return facts.length ? facts : null;
}

function ActionDetail({ detail }: { detail: string }) {
  const facts = readDetail(detail);
  return facts ? (
    <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
      {facts.map((f) => (
        <div key={`${f.label}-${f.value}`} className="flex gap-1.5">
          <dt className="text-ink-muted">{f.label}</dt>
          <dd className="text-ink-secondary">
            <IdText text={f.value} />
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="text-sm text-ink-secondary">
      <IdText text={detail} />
    </p>
  );
}

/**
 * What the last run of a step did, action by action (each one is also in History). It is a hairline section of the
 * step sheet, not a tinted box. `fresh` marks a run the presenter just made in this view: it swaps in, so the change
 * they caused is noticed (reduced motion removes it). This line is the run's only confirmation (no toast).
 */
export function ActionLog({ result, ranAt, fresh = false }: { result: StepRunResult; ranAt?: string; fresh?: boolean }) {
  const failed = result.actions.filter((a) => a.outcome === "failed" || a.outcome === "not_available");
  const completed = result.actions.length - failed.length;
  const line =
    result.status === "not_available"
      ? { tone: RESULT_TONE.warning, title: "This step is not available yet in this build", body: result.message }
      : result.status === "needs_presenter"
        ? { tone: RESULT_TONE.waiting, title: "Nothing to simulate yet", body: result.message }
        : failed.length
          ? {
              tone: RESULT_TONE.warning,
              title: `${completed} of ${result.actions.length} actions completed; ${failed.length} did not`,
              body: `${result.message} The actions that did not complete are listed below with the reason. Nothing was overwritten.`,
            }
          : {
              tone: RESULT_TONE.done,
              title: result.autoStaffActions ? "Simulator events and rehearsal actions done" : "Simulator events done",
              body: result.message,
            };
  const moved = result.clockBefore !== result.clockAfter;
  return (
    <section
      aria-label={`Result of the last run of step ${result.step}`}
      aria-live="polite"
      className={cn("grid gap-2 border-b border-line pb-4", fresh && "animate-swap-in")}
    >
      <div className="flex items-start gap-2">
        <line.tone.Icon className={cn("mt-0.5 size-4 shrink-0", line.tone.icon)} aria-hidden />
        <div className="min-w-0">
          <p className={cn("font-semibold", line.tone.title)}>{line.title}</p>
          <p className="text-ink-secondary">
            <IdText text={line.body} />
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">
            {ranAt ? `Last run at ${fmtTime(ranAt)} ET (demo clock). ` : ""}
            {moved ? `Demo clock moved from ${fmtTime(result.clockBefore)} ET to ${fmtTime(result.clockAfter)} ET.` : `Demo clock stayed at ${fmtTime(result.clockAfter)} ET.`} Every action
            is also recorded in the case History and the audit log.
          </p>
        </div>
      </div>
      {result.actions.length ? (
        <details open={failed.length > 0 || result.actions.length <= 3} className="group border-t border-line">
          <summary className="flex min-h-[max(2rem,var(--hlo-target-min))] cursor-pointer list-none flex-wrap items-center gap-x-1 rounded-sm px-1 text-sm font-medium text-ink-secondary hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 shrink-0 text-ink-muted transition-transform duration-[var(--hlo-duration-fast)] group-open:rotate-90" aria-hidden />
            {result.actions.length} action{result.actions.length === 1 ? "" : "s"} in this run
            <span className="font-normal text-ink-muted">
              {" "}
              ({completed} completed
              {failed.length ? `, ${failed.length} did not complete` : ""})
            </span>
          </summary>
          <ol className="grid border-t border-line text-sm">
            {result.actions.map((a, i) => {
              const o = OUTCOME[a.outcome];
              const k = KIND[a.kind];
              return (
                <li key={i} className="flex items-start gap-2 border-b border-line px-1 py-1.5 last:border-b-0">
                  <o.Icon className={cn("mt-0.5 size-4 shrink-0", o.cls)} aria-hidden />
                  <div className="min-w-0">
                    <p className="text-ink">
                      <span className="sr-only">{o.label}: </span>
                      <IdText text={a.label} />
                    </p>
                    <p className="flex flex-wrap items-center gap-x-3 text-sm text-ink-muted">
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
                    {a.detail ? <ActionDetail detail={a.detail} /> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
