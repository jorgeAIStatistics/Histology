"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Type } from "lucide-react";
import { fmtTime } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { AlertBanner } from "@/components/ui/alert-banner";
import { useToast } from "@/components/ui/toast";
import { useDemoNow, useLive } from "@/lib/client/live";

// ------------------------------------------------------------------ presenter text size (per browser)

const KEY = "hlos.demo.presenterLarge";
const SizeCtx = createContext<{ large: boolean; toggle: () => void }>({ large: false, toggle: () => {} });

export function PresenterSizeProvider({ children }: { children: ReactNode }) {
  const [large, setLarge] = useState(false);
  useEffect(() => {
    try {
      setLarge(window.localStorage.getItem(KEY) === "1");
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);
  const toggle = useCallback(() => {
    setLarge((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return <SizeCtx.Provider value={{ large, toggle }}>{children}</SizeCtx.Provider>;
}

export function usePresenterLarge(): boolean {
  return useContext(SizeCtx).large;
}

// ------------------------------------------------------------------ toolbar

/**
 * Presenter controls above the tabs: progress (derived from records), demo
 * clock, "Presenter text size" and "Reset demo" (POST /api/demo/reset with an
 * explicit confirmation; the route belongs to the integration slice).
 */
export function DemoToolbar({ doneCount, total }: { doneCount: number; total: number }) {
  const { large, toggle } = useContext(SizeCtx);
  const now = useDemoNow();
  const running = useLive().data.clock.running;
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On failure the (modal) confirmation closes first, so the explanation below the toolbar is visible.
  const fail = (message: string) => {
    setConfirming(false);
    setError(message);
  };

  const reset = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ confirm: true }),
        cache: "no-store",
      });
      if (res.status === 404) {
        fail("Reset is not available in this build yet (the reset service was not found). Nothing was changed.");
        return;
      }
      let body: { ok?: boolean; result?: { message?: string }; error?: { message?: string } } = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON */
      }
      if (!res.ok || !body.ok) {
        fail(body.error?.message ?? `Reset failed (HTTP ${res.status}). Reload the page to see the current state of the demo data.`);
        return;
      }
      toast.show({ tone: "info", title: "Demo data reset", body: body.result?.message ?? "Back to the 10:52 ET starting state (synthetic)." });
      setConfirming(false);
      // The guide remounts after the reseed (it is keyed on the seed time), so no old action log survives.
      router.push("/demo?tab=guide&step=1");
      router.refresh();
    } catch {
      fail("Could not reach the local demo server. The reset may not have happened; reload the page to check.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-4 py-2">
        <p className="text-sm text-ink">
          <span className="font-semibold">
            {doneCount} of {total} steps done
          </span>{" "}
          <span className="text-ink-muted">(read from the records)</span>
        </p>
        <p className="text-sm text-ink-secondary">
          Demo clock <span className="font-semibold text-ink">{fmtTime(now)} ET</span>, {running ? "running" : "paused"}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="quiet" size="sm" icon={<Type />} aria-pressed={large} onClick={toggle}>
            {large ? "Presenter text size: large" : "Presenter text size: normal"}
          </Button>
          <Button variant="secondary" size="sm" icon={<RotateCcw />} onClick={() => setConfirming(true)}>
            Reset demo
          </Button>
        </div>
      </div>
      {error ? (
        <AlertBanner
          tone="warning"
          title="Demo data was not reset"
          action={
            <Button variant="quiet" size="sm" onClick={() => setError(null)}>
              Dismiss
            </Button>
          }
        >
          {error}
        </AlertBanner>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="Reset all demo data?"
        confirmLabel="Reset demo data"
        cancelLabel="Keep current data"
        destructive
        pending={pending}
        pendingLabel="Resetting..."
        onCancel={() => setConfirming(false)}
        onConfirm={() => void reset()}
      >
        <p className="text-sm text-ink-secondary">
          Reset all demo data to the 10:52 ET starting state? Your demo changes will be lost, including the local history. Only synthetic data is affected.
        </p>
      </ConfirmDialog>
    </div>
  );
}
