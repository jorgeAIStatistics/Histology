import { cn } from "@/components/ui/cn";

const RUNGS = [
  {
    title: "Engineering readiness",
    state: "current",
    body: "The pipeline runs end to end on synthetic data: frozen datasets, patient-grouped splits, queued training, a checkpoint, metrics with denominators. Synthetic results only.",
  },
  {
    title: "Internal validation",
    state: "not started",
    body: "Needs authorised, de-identified slides from the pilot lab, approved expert labels and a prespecified protocol. No real slide has been used.",
  },
  {
    title: "External validation",
    state: "not started",
    body: "Needs an independent site or a later time period, untouched by development, with its own scanners and stains.",
  },
  {
    title: "Clinical deployment readiness",
    state: "not started",
    body: "Needs a reader study (physician with versus without the tool), quality management and the appropriate regulatory pathway. Not a goal of this prototype.",
  },
];

export function ReadinessLadder({ compact = false }: { compact?: boolean }) {
  return (
    <section aria-labelledby="readiness" className="rounded-[var(--radius-panel)] border border-line bg-surface p-4" data-testid="readiness-ladder">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="readiness" className="font-bold text-ink">
          Readiness ladder
        </h2>
        <p className="text-small text-graphite">Where the work honestly stands: engineering only.</p>
      </div>
      <ol className={cn("mt-3 grid gap-2", compact ? "md:grid-cols-4" : "md:grid-cols-2 xl:grid-cols-4")}>
        {RUNGS.map((r, i) => {
          const current = r.state === "current";
          return (
            <li key={r.title} className={cn("relative rounded-[var(--radius-control)] border p-3", current ? "border-teal bg-teal-tint/60" : "border-dashed border-line-strong bg-sheet/60")} aria-current={current ? "step" : undefined}>
              <p className="flex items-center gap-2 text-small font-bold text-ink">
                <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-micro", current ? "bg-teal text-white" : "border border-line-strong text-graphite")}>{i + 1}</span>
                {r.title}
              </p>
              <p className={cn("mt-1 text-micro font-bold", current ? "text-teal-deep" : "text-graphite")}>{current ? "We are here (in progress)" : "Not started"}</p>
              {!compact ? <p className="mt-1 text-micro text-graphite">{r.body}</p> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
