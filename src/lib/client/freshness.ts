/**
 * Source freshness rules (spec §5.1). Thresholds are demo settings, not
 * clinical rules: Synced up to 5 min since the last successful sync, Delayed
 * up to 15 min, Offline beyond that or when the simulated source reports an
 * outage. Unknown when no successful sync is recorded.
 */
import { fmtAge, fmtSmart, minutesBetween } from "@/lib/time";
import type { LiveSource } from "./types";

export type SyncState = "synced" | "delayed" | "offline" | "unknown";

export const SYNC_THRESHOLDS_MIN = { delayed: 5, offline: 15 } as const;

export function syncState(src: Pick<LiveSource, "status" | "last_success_at">, now: string): SyncState {
  if (src.status === "offline") return "offline";
  if (!src.last_success_at) return "unknown";
  const age = minutesBetween(src.last_success_at, now);
  if (age > SYNC_THRESHOLDS_MIN.offline) return "offline";
  if (src.status === "degraded" || age > SYNC_THRESHOLDS_MIN.delayed) return "delayed";
  return "synced";
}

const RANK: Record<SyncState, number> = { synced: 0, unknown: 1, delayed: 2, offline: 3 };

/** Worst state across sources (offline > delayed > unknown > synced). */
export function worstSyncState(states: SyncState[]): SyncState {
  return states.reduce<SyncState>((w, s) => (RANK[s] > RANK[w] ? s : w), states.length ? "synced" : "unknown");
}

export function sourceLabel(src: Pick<LiveSource, "tenant_name" | "name">): string {
  return src.tenant_name ?? src.name.replace(/\s*\((simulated[^)]*|deterministic demo)\)\s*$/i, "");
}

/** One-line description in the spec's wording. */
export function syncSentence(src: LiveSource, now: string): string {
  const name = sourceLabel(src);
  const state = syncState(src, now);
  const last = src.last_success_at;
  switch (state) {
    case "synced":
      return `${name}: synced ${fmtSmart(last, now)} ET (${fmtAge(last, now) === "just now" ? "just now" : `${fmtAge(last, now)} ago`})`;
    case "delayed":
      return `${name}: last sync ${fmtSmart(last, now)} ET, ${fmtAge(last, now)} ago`;
    case "offline":
      return src.status === "offline"
        ? `${name}: unreachable since ${last ? `${fmtSmart(last, now)} ET` : "an unknown time"}. Showing last confirmed data.`
        : `${name}: no successful sync since ${fmtSmart(last, now)} ET (${fmtAge(last, now)}). Showing last confirmed data.`;
    default:
      return `${name}: sync status unknown`;
  }
}

/** Sources that represent a tenant's source system (EMA-SIM, OTHER-EHR-SIM). */
export function tenantSources(sources: LiveSource[]): LiveSource[] {
  return sources.filter((s) => s.tenant_id);
}
