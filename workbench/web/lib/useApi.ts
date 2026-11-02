"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { useSession } from "./session";

export type ApiState<T> = {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T | null) => void;
};

/**
 * GET a path (null = skip). Refetches when the path changes or the demo role / project switches.
 * Keeps the previous data while reloading so panels do not flash.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const { version } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path));
  const ctrl = useRef<AbortController | null>(null);
  const lastPath = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    if (lastPath.current !== path) setData(null);
    lastPath.current = path;
    setLoading(true);
    try {
      const d = await api<T>(path, { signal: c.signal });
      if (!c.signal.aborted) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      if (!c.signal.aborted) {
        setError(err as Error);
      }
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void run();
    return () => ctrl.current?.abort();
    // version: refetch after a role or project switch
  }, [run, version]);

  return { data, error, loading, reload: run, setData };
}

/** Poll a job until it finishes. Returns the latest job state. */
export async function pollJob<T extends { status: string }>(
  jobId: string,
  onUpdate: (job: T) => void,
  opts: { intervalMs?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const interval = opts.intervalMs ?? 800;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
  for (;;) {
    const job = await api<T>(`/jobs/${jobId}`, { signal: opts.signal });
    onUpdate(job);
    if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
    if (Date.now() > deadline) return job;
    await new Promise((r) => setTimeout(r, interval));
    if (opts.signal?.aborted) return job;
  }
}
