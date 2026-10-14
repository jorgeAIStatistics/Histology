"use client";

import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { LivePayload } from "./types";

/**
 * <LiveRefresh> is mounted once in the shell. It polls GET /api/live every
 * 2.5 s (paused while the tab is hidden). When the audit or worklist change
 * counters move, it calls router.refresh() so server components re-render with
 * the latest data; client state (form drafts, scroll, selection) is kept.
 * The latest payload is available through useLive() / useDemoNow().
 */

interface LiveState {
  data: LivePayload;
  /** Wall-clock ms when `data` was received (used to tick the running demo clock). */
  receivedAt: number;
  /** False after a failed poll (the local server is unreachable). */
  ok: boolean;
  lastError: string | null;
}

interface LiveContextValue extends LiveState {
  /** Poll now and adopt the counters without triggering another refresh (used after a command already refreshed). */
  sync: () => Promise<void>;
  /** Poll now and refresh the page if anything changed. */
  pollNow: () => Promise<void>;
}

const LiveContext = createContext<LiveContextValue | null>(null);

interface LiveActions {
  sync: () => Promise<void>;
  pollNow: () => Promise<void>;
}
/** Stable actions in their own context so command buttons do not re-render on every poll. */
const LiveActionsContext = createContext<LiveActions | null>(null);

export function LiveRefresh({
  initial,
  intervalMs = 2500,
  children,
}: {
  initial: LivePayload;
  intervalMs?: number;
  children: ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>(() => ({ data: initial, receivedAt: Date.now(), ok: true, lastError: null }));
  const baseline = useRef({ audit: initial.auditSeq, worklist: initial.worklistSeq });
  const inFlight = useRef<Promise<void> | null>(null);

  // A server re-render (router.refresh / navigation) hands us fresher data: adopt it as the baseline.
  const lastInitial = useRef(initial);
  useEffect(() => {
    if (lastInitial.current === initial) return;
    lastInitial.current = initial;
    if (initial.auditSeq >= baseline.current.audit && initial.worklistSeq >= baseline.current.worklist) {
      baseline.current = { audit: initial.auditSeq, worklist: initial.worklistSeq };
      setState({ data: initial, receivedAt: Date.now(), ok: true, lastError: null });
    }
  }, [initial]);

  const poll = useCallback(
    (refreshOnChange: boolean): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      const p = (async () => {
        try {
          const res = await fetch("/api/live", { cache: "no-store", headers: { Accept: "application/json" } });
          if (!res.ok) throw new Error(`Live status returned HTTP ${res.status}`);
          const data = (await res.json()) as LivePayload;
          const changed = data.auditSeq !== baseline.current.audit || data.worklistSeq !== baseline.current.worklist;
          baseline.current = { audit: data.auditSeq, worklist: data.worklistSeq };
          setState({ data, receivedAt: Date.now(), ok: true, lastError: null });
          if (changed && refreshOnChange) startTransition(() => router.refresh());
        } catch (e) {
          setState((s) => ({ ...s, ok: false, lastError: e instanceof Error ? e.message : String(e) }));
        } finally {
          inFlight.current = null;
        }
      })();
      inFlight.current = p;
      return p;
    },
    [router],
  );

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void poll(true);
    };
    const timer = window.setInterval(tick, intervalMs);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll, intervalMs]);

  const sync = useCallback(() => poll(false), [poll]);
  const pollNow = useCallback(() => poll(true), [poll]);
  const actions = useMemo(() => ({ sync, pollNow }), [sync, pollNow]);
  const value = useMemo(() => ({ ...state, ...actions }), [state, actions]);

  return (
    <LiveActionsContext.Provider value={actions}>
      <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
    </LiveActionsContext.Provider>
  );
}

const NOOP = async () => {};
const NOOP_ACTIONS: LiveActions = { sync: NOOP, pollNow: NOOP };

/** { sync, pollNow } without subscribing to live data updates. */
export function useLiveActions(): LiveActions {
  return useContext(LiveActionsContext) ?? NOOP_ACTIONS;
}

/** Latest live payload: { data: { auditSeq, worklistSeq, clock, sources }, ok, receivedAt, sync, pollNow }. */
export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext);
  if (ctx) return ctx;
  return {
    data: {
      auditSeq: 0,
      worklistSeq: 0,
      clock: { now: new Date(0).toISOString(), running: false, anchorDemo: "", anchorWall: "" },
      sources: [],
    },
    receivedAt: 0,
    ok: false,
    lastError: "LiveRefresh is not mounted",
    sync: NOOP,
    pollNow: NOOP,
  };
}

/**
 * Current demo-clock time (UTC ISO). When the demo clock is running it ticks
 * locally between polls; the first render uses the server value exactly so
 * hydration matches.
 */
export function useDemoNow(tickMs = 10_000): string {
  const { data, receivedAt } = useLive();
  const [, setTick] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (!data.clock.running) return;
    const t = window.setInterval(() => setTick((n) => n + 1), tickMs);
    return () => window.clearInterval(t);
  }, [data.clock.running, tickMs]);
  if (!mounted || !data.clock.running || !receivedAt) return data.clock.now;
  return new Date(Date.parse(data.clock.now) + Math.max(0, Date.now() - receivedAt)).toISOString();
}
