"use client";

import Link from "next/link";
import { Popover } from "radix-ui";
import { CircleCheck, CircleQuestionMark, Clock, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtSmart, fmtAge } from "@/lib/time";
import { useDemoNow, useLive } from "@/lib/client/live";
import {
  SYNC_THRESHOLDS_MIN,
  sourceLabel,
  syncSentence,
  syncState,
  tenantSources,
  worstSyncState,
  type SyncState,
} from "@/lib/client/freshness";
import { SimulatedLabel } from "@/components/domain/honesty";

// iconClass/textClass for the light popover; dark* for the trigger on the hematoxylin bar.
const STATE_UI: Record<SyncState, { icon: LucideIcon; text: string; iconClass: string; textClass: string; darkIconClass: string; darkTextClass: string }> = {
  synced: { icon: CircleCheck, text: "Synced", iconClass: "text-success-solid", textClass: "text-ink", darkIconClass: "text-shell-muted", darkTextClass: "text-shell-fg" },
  delayed: { icon: Clock, text: "Delayed", iconClass: "text-warning-solid", textClass: "text-warning-fg", darkIconClass: "text-warning-on-dark", darkTextClass: "text-warning-on-dark" },
  // A stale or offline source is "data may be wrong" (amber); red is reserved for patient identity.
  offline: { icon: TriangleAlert, text: "Offline", iconClass: "text-warning-solid", textClass: "text-warning-fg", darkIconClass: "text-warning-on-dark", darkTextClass: "text-warning-on-dark" },
  unknown: { icon: CircleQuestionMark, text: "Sync status unknown", iconClass: "text-ink-muted", textClass: "text-ink-secondary", darkIconClass: "text-shell-muted", darkTextClass: "text-shell-fg" },
};

/**
 * Source freshness indicator (spec §5.1): icon, text and time, always with a
 * Simulated label. The popover lists each tenant with last successful sync and
 * last attempt, plus the other simulated connectors.
 */
export function SourceFreshness() {
  const { data, ok } = useLive();
  const now = useDemoNow();
  const tenants = tenantSources(data.sources);
  const others = data.sources.filter((s) => !s.tenant_id);
  const states = tenants.map((s) => syncState(s, now));
  const worst = tenants.length ? worstSyncState(states) : "unknown";
  const ui = STATE_UI[worst];
  const Icon = ui.icon;

  // The summary names the worst tenant when something is wrong. The bar shows the short tenant name and the
  // state word ("EMA-SIM offline"); the time follows on wide screens and always in the popover and the
  // accessible name.
  const worstSrc = tenants.find((s, i) => states[i] === worst) ?? tenants[0];
  const shortName = worstSrc ? sourceLabel(worstSrc).split(" ")[0] : "";
  let summary = "Sync status unknown";
  let detail = "";
  let age = "";
  if (worstSrc && worst === "synced") {
    // Conservative: report the OLDEST successful sync across tenants.
    const oldest = tenants.map((t) => t.last_success_at).filter(Boolean).sort()[0] ?? worstSrc.last_success_at;
    summary = `Synced ${fmtSmart(oldest, now)} ET`;
    age = fmtAge(oldest, now) === "just now" ? "just now" : `${fmtAge(oldest, now)} ago`;
  } else if (worstSrc && worst === "delayed") {
    summary = `${shortName} delayed`;
    detail = worstSrc.last_success_at ? `, last sync ${fmtSmart(worstSrc.last_success_at, now)} ET` : "";
  } else if (worstSrc && worst === "offline") {
    summary = worstSrc.status === "offline" ? `${shortName} offline` : `${shortName}: no recent sync`;
    detail = worstSrc.last_success_at ? ` since ${fmtSmart(worstSrc.last_success_at, now)} ET` : "";
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={`Source (simulated): ${summary}${detail}`}
          className="flex h-10 shrink-0 items-center gap-2 rounded-md px-2 text-left text-shell-fg hover:bg-shell-2 data-[state=open]:bg-shell-2"
          aria-label={`Source freshness: ${summary}${detail}${age ? ` (${age})` : ""}. Simulated. Show details`}
        >
          <Icon className={cn("size-4 shrink-0", ui.darkIconClass)} aria-hidden />
          <span className={cn("flex flex-col leading-tight", worst === "synced" && "max-[107.5rem]:hidden")}>
            <span className="text-xs text-shell-muted max-[90rem]:hidden">Source (simulated)</span>
            <span className={cn("max-w-[11rem] truncate text-sm font-semibold max-xl:max-w-[7.5rem] min-[107.5rem]:max-w-[17rem]", ui.darkTextClass)}>
              <span className="max-[90rem]:hidden">{summary}</span>
              {/* Below 1440px: the state word only ("Offline"); the full sentence stays in the accessible name and tooltip. */}
              <span className="min-[90rem]:hidden">{worst === "unknown" ? "Unknown" : ui.text}</span>
              {detail ? <span className="font-normal max-[107.5rem]:hidden">{detail}</span> : null}
              {age ? <span className="font-normal text-shell-muted max-[107.5rem]:hidden"> ({age})</span> : null}
            </span>
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="animate-fade-in z-50 w-[380px] rounded-lg border border-line bg-surface p-3 text-sm text-ink shadow-2"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-semibold">Source freshness</p>
            <SimulatedLabel connector="source adapters" />
          </div>
          {!ok ? (
            <p className="mb-2 rounded-sm bg-warning-bg px-2 py-1 text-xs text-warning-fg">
              Could not reach the local demo server. Times below are the last values received.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {tenants.length === 0 ? <li className="text-ink-secondary">No source systems configured.</li> : null}
            {tenants.map((s, i) => {
              const st = STATE_UI[states[i]];
              const SIcon = st.icon;
              return (
                <li key={s.id} className="rounded-md border border-line px-2.5 py-2">
                  <p className="flex items-start gap-1.5">
                    <SIcon className={cn("mt-0.5 size-4 shrink-0", st.iconClass)} aria-hidden />
                    <span className={cn("font-medium", st.textClass)}>{syncSentence(s, now)}</span>
                  </p>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-5.5 text-xs text-ink-secondary">
                    <dt>Last successful sync</dt>
                    <dd className="text-ink">{s.last_success_at ? `${fmtSmart(s.last_success_at, now)} ET` : "Unknown"}</dd>
                    <dt>Last attempt</dt>
                    <dd className="text-ink">{s.last_attempt_at ? `${fmtSmart(s.last_attempt_at, now)} ET` : "Unknown"}</dd>
                    {s.last_error ? (
                      <>
                        <dt>Last error</dt>
                        <dd className="text-warning-fg">{s.last_error}</dd>
                      </>
                    ) : null}
                  </dl>
                </li>
              );
            })}
          </ul>
          {others.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-medium text-ink-secondary">Other connectors (simulated)</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                {others.map((s) => (
                  <li key={s.id} className="flex justify-between gap-2">
                    <span className="text-ink">{sourceLabel(s)}</span>
                    <span className={cn(s.status === "offline" || s.status === "degraded" ? "text-warning-fg" : "text-ink-secondary")}>
                      {s.status === "connected" ? "Available (simulated)" : s.status === "offline" ? "Unavailable (simulated)" : "Degraded (simulated)"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-ink-muted">
            Delayed after {SYNC_THRESHOLDS_MIN.delayed} min, offline after {SYNC_THRESHOLDS_MIN.offline} min without a successful sync. These
            are demo settings, not clinical rules. Times use the demo clock.
          </p>
          <Link href="/settings?tab=integration" className="mt-2 inline-block text-xs font-medium text-brand underline underline-offset-2">
            What is simulated?
          </Link>
          <Popover.Arrow className="fill-surface" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
