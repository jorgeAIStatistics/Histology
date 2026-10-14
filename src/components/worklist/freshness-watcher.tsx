"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useLive } from "@/lib/client/live";
import type { FreshnessSummary } from "@/server/queries/worklist";

/**
 * Freshness banners on the worklist, case and operations pages are rendered on the server. The shell's
 * live poll refreshes the page only when records change, and a sync that merely catches up (for example
 * after the laptop slept or no tab was open) changes no record. This watcher re-renders the page once a
 * source the page shows as delayed, stale or Unknown has synced again since the page was rendered, so a
 * banner never claims "out of date" while the top bar says the source is synced.
 */
export function FreshnessWatcher({ freshness }: { freshness: FreshnessSummary }) {
  const router = useRouter();
  const { data, ok } = useLive();
  const refreshedFor = useRef<string | null>(null);
  const notCurrent = freshness.sources.filter((s) => s.stale || s.state !== "current");
  const renderedKey = notCurrent.map((s) => `${s.id}:${s.lastSuccessAt ?? "none"}`).join("|");
  useEffect(() => {
    if (!ok || !notCurrent.length || refreshedFor.current === renderedKey) return;
    const caughtUp = notCurrent.some((s) => {
      const live = data.sources.find((l) => l.id === s.id);
      if (!live || live.status !== "connected" || !live.last_success_at) return false;
      return !s.lastSuccessAt || Date.parse(live.last_success_at) - Date.parse(s.lastSuccessAt) > 60_000;
    });
    if (!caughtUp) return;
    refreshedFor.current = renderedKey;
    router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, data.sources, renderedKey, router]);
  return null;
}
