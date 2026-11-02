import { Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatePill } from "@/components/ui/status-pill";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { FreshnessSummary } from "@/server/queries/worklist";
import { IntegrationLink } from "./integration-link";

const SYNC_PILL: Record<string, string> = { current: "synced", delayed: "delayed", offline: "offline", unknown: "unknown" };

/** Source freshness per tenant (simulated adapters), quiet beside the owner queue. Unknown stays Unknown; offline is stale. */
export function SourceFreshness({ freshness, now }: { freshness: FreshnessSummary; now: string }) {
  return (
    <section aria-labelledby="freshness-title" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <h2 id="freshness-title" className="text-md font-bold tracking-[-0.01em] text-ink">
          Source freshness
        </h2>
        <SimulatedLabel connector="source adapters" size="xs" />
      </div>
      <ul className="mt-1 flex flex-col">
        {freshness.sources.map((s) => (
          <li key={s.id} className="flex flex-col gap-1 border-b border-line px-4 py-2.5 text-sm last:border-b-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-ink">{s.tenantName ?? s.name}</span>
              <StatePill domain="sync" state={SYNC_PILL[s.state]} />
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-ink-muted">Last successful sync</dt>
              <dd className="text-ink">{s.lastSuccessAt ? <Timestamp iso={s.lastSuccessAt} now={now} showAge /> : <UnknownValue reason="none recorded" />}</dd>
              {s.lastError ? (
                <>
                  <dt className="text-ink-muted">Last error</dt>
                  <dd className="text-ink">{s.lastError}</dd>
                </>
              ) : null}
            </dl>
            {s.state !== "current" || s.stale ? (
              <p className={cn("flex items-start gap-1 text-xs", s.state === "offline" || s.stale ? "font-medium text-warning-fg" : "text-ink-secondary")}>
                {s.state === "offline" || s.stale ? <Clock className="mt-px size-3.5 shrink-0 text-warning-solid" aria-hidden /> : null}
                {s.text}
              </p>
            ) : null}
          </li>
        ))}
        {freshness.sources.length === 0 ? <li className="px-4 py-2.5 text-sm text-ink-secondary">No source systems configured.</li> : null}
      </ul>
      <IntegrationLink className="border-t border-line px-4 py-1" />
      <p className="border-t border-line px-4 py-2.5 text-xs text-ink-muted">
        Thresholds (5 and 15 min) are demo settings, not clinical rules. Local task completion never writes to a source system in this demo.
      </p>
    </section>
  );
}
