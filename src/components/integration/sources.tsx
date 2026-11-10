import { CircleCheck, CircleQuestionMark, Clock, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatusPill } from "@/components/ui/status-pill";
import type { Tone } from "@/components/ui/tone";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import type { SourceView } from "./data";
import { LabTime } from "./parts";

function statusPill(s: SourceView): { tone: Tone; icon: LucideIcon; text: string } {
  if (s.status === "offline") return { tone: "warning", icon: TriangleAlert, text: "Unavailable" };
  if (s.status === "degraded") return { tone: "warning", icon: Clock, text: "Slow link" };
  if (s.freshness === "stale") return { tone: "warning", icon: Clock, text: "Connected, no recent sync" };
  if (s.freshness === "unknown") return { tone: "neutral", icon: CircleQuestionMark, text: "Connected, never synced" };
  return { tone: "neutral", icon: CircleCheck, text: "Connected" };
}

/**
 * Per source: name (simulated), status, last contacted, last successful sync, last error in plain words, and the
 * messages waiting at the source. One quiet sheet per source; no technical log.
 */
export function SourcesPanel({ sources, now }: { sources: SourceView[]; now: string }) {
  return (
    <section aria-labelledby="sources-title" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="sources-title" className="text-md font-bold tracking-[-0.01em] text-ink">
          Sources
        </h2>
        <SimulatedLabel connector="source adapters" />
      </div>
      {sources.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink-secondary">No source systems are configured.</p>
      ) : (
        <ul className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
          {sources.map((s) => {
            const pill = statusPill(s);
            const headingId = `source-${s.id}`;
            return (
              <li key={s.id} className="min-w-0">
                <article aria-labelledby={headingId} className="flex h-full min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 id={headingId} className="text-base font-semibold text-ink">
                        {s.name}
                      </h3>
                      <p className="text-sm text-ink-muted">
                        Simulated source system: orders{s.issuesAccessions ? " and accession numbers" : ""}
                      </p>
                    </div>
                    <StatusPill tone={pill.tone} icon={pill.icon}>
                      {pill.text}
                    </StatusPill>
                  </div>
                  <dl className="grid grid-cols-[minmax(9.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-ink-muted">Last contacted</dt>
                    <dd className="text-ink">{s.lastContactAt ? <LabTime iso={s.lastContactAt} now={now} /> : <UnknownValue reason="no contact recorded" />}</dd>
                    <dt className="text-ink-muted">Last successful sync</dt>
                    <dd className="text-ink">{s.lastSuccessAt ? <LabTime iso={s.lastSuccessAt} now={now} /> : <UnknownValue reason="none recorded" />}</dd>
                    <dt className="text-ink-muted">Last error</dt>
                    <dd className={cn(s.lastError ? "text-warning-fg" : "text-ink")}>{s.lastError ?? "None recorded"}</dd>
                    <dt className="text-ink-muted">Messages waiting</dt>
                    <dd className="text-ink">
                      <span className="num-tabular font-semibold">{s.waiting}</span>{" "}
                      <span className="text-ink-secondary">at the source, not yet delivered here</span>
                    </dd>
                  </dl>
                  {s.status === "offline" ? (
                    <p className="flex items-start gap-1.5 text-sm font-medium text-warning-fg">
                      <Clock className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
                      <span>
                        Unavailable{s.offlineSince ? <> since <LabTime iso={s.offlineSince} now={now} /></> : null}. Nothing from it is applied until it is back; waiting
                        messages are then applied once, in order. Screens show the last confirmed data.
                      </span>
                    </p>
                  ) : null}
                  <p className="text-sm text-ink-secondary">
                    From this source: <span className="num-tabular">{s.counts.review}</span> need review, <span className="num-tabular">{s.counts.waiting}</span> waiting,{" "}
                    <span className="num-tabular">{s.counts.failed}</span> failed.
                  </p>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
