"use client";

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Popover } from "./Popover";
import { cn } from "@/components/ui/cn";

type Health = {
  status: "ok" | "degraded" | "refusing";
  mode: string;
  checks: Record<string, { status: string; [k: string]: unknown }>;
};

function Row({ name, status, detail }: { name: string; status: string; detail?: string }) {
  const ok = status === "ok" || status === "mounted";
  return (
    <li className="flex items-start justify-between gap-3 py-1">
      <span className="text-small text-ink">{name}</span>
      <span className={cn("text-right text-small font-semibold", ok ? "text-approved" : "text-amber-ink")}>
        {status.replace(/_/g, " ")}
        {detail ? <span className="block text-micro font-normal text-graphite">{detail}</span> : null}
      </span>
    </li>
  );
}

/** The persistent research-use status. One quiet pill; details on demand, no blocking banners. */
export function ResearchStatus() {
  const { meta } = useSession();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const load = async () => {
    try {
      setHealth(await api<Health>("/health"));
      setHealthError(null);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const degraded = healthError || (health && health.status !== "ok");
  const handlers = (health?.checks.job_handlers as { modules?: Record<string, string> } | undefined)?.modules ?? {};
  const mlPresent = handlers["dermpath.ml.jobs"] === "loaded";

  return (
    <Popover
      label="Research use only: status and limits"
      testId="research-status"
      align="right"
      trigger={
        <span className="flex items-center gap-1.5">
          <FlaskConical size={15} aria-hidden className="text-teal-deep" />
          <span className="hidden text-small font-semibold text-ink sm:inline">Research use only</span>
          <span aria-hidden className={cn("h-2 w-2 rounded-full", degraded ? "bg-amber" : "bg-approved")} />
        </span>
      }
      triggerClassName="flex h-10 items-center rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2.5 hover:border-teal"
      panelClassName="w-[380px]"
    >
      {() => (
        <div className="space-y-3">
          <div>
            <p className="text-small font-bold text-ink">Research use only</p>
            <p className="mt-1 text-small text-graphite">
              {meta?.research_use_only ?? "Research use only. Not a medical device. Not for diagnosis, treatment or clinical decision-making."}
            </p>
            <p className="mt-1 text-small text-graphite">
              Data here is fictional workflow metadata, procedural synthetic images and one public CC0 test slide. No patient data. Nothing is signed out, ordered or reprioritised.
            </p>
          </div>
          <div className="border-t border-line pt-2">
            <div className="flex items-center justify-between">
              <p className="text-small font-bold text-ink">System status</p>
              <button type="button" className="text-micro font-semibold text-teal-deep underline-offset-2 hover:underline" onClick={() => void load()}>
                Check again
              </button>
            </div>
            {healthError ? (
              <p className="mt-1 text-small text-rust">API not reachable: {healthError}</p>
            ) : health ? (
              <ul className="mt-1 divide-y divide-line">
                <Row name="API mode" status={health.mode === "demo" ? "ok" : health.mode} detail={health.mode === "demo" ? "demo (role switch, not authentication)" : undefined} />
                <Row name="Database" status={health.checks.database?.status ?? "unknown"} />
                <Row name="Tile service (OpenSlide)" status={health.checks.tile_service?.status ?? "unknown"} />
                <Row
                  name="Worker"
                  status={String(health.checks.worker?.status ?? "unknown")}
                  detail={health.checks.worker?.status === "ok" ? undefined : "queued jobs wait until `python -m dermpath.worker` runs"}
                />
                <Row name="ML service" status={mlPresent ? "ok" : "not available"} detail={mlPresent ? undefined : "dermpath.ml is not installed in this API"} />
              </ul>
            ) : (
              <p className="mt-1 text-small text-graphite">Checking…</p>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
