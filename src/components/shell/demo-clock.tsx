"use client";

import { useState } from "react";
import { Clock, FastForward, Pause, Play, RotateCcw, Truck } from "lucide-react";
import { LAB_TZ, labDay, labLocalToIso } from "@/lib/time";
import { useCommand } from "@/lib/client/command";
import { DEMO_CLOCK_COMMAND, type DemoClockInput } from "@/lib/client/demo-commands";
import { useDemoNow, useLive } from "@/lib/client/live";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { ConfirmDialog } from "@/components/ui/dialog";

const clockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LAB_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Wed Oct 14, 10:52 AM ET" */
export function fmtDemoClock(iso: string): string {
  const parts = clockFmt.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")} ET`;
}

/** Demo clock state for labels: "11:00 AM ET" plus running/paused. */
export function useDemoClockLabel(): { time: string; full: string; running: boolean } {
  const { data } = useLive();
  const now = useDemoNow();
  const full = fmtDemoClock(now);
  return { time: full.replace(/^.*?, /, ""), full, running: data.clock.running };
}

/**
 * Demo clock controls (spec §5.1), on the presenter console (Role and clock).
 * Always labeled "Demo clock" so it never looks like real time: Advance 5 min,
 * Jump to courier arrival (11:00), Pause/Resume, Reset to 10:52. Runs demo
 * commands (see src/lib/client/demo-commands.ts for the names).
 */
export function DemoClockPanel({ headingLevel = 3 }: { headingLevel?: 2 | 3 } = {}) {
  const H = `h${headingLevel}` as const;
  const { data } = useLive();
  const now = useDemoNow();
  const running = data.clock.running;
  const day = labDay(now);
  const courierAt = labLocalToIso(day, "11:00");
  const startAt = labLocalToIso(day, "10:52");
  const pastCourier = Date.parse(now) >= Date.parse(courierAt);
  const [active, setActive] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const clock = useCommand<unknown, DemoClockInput>(DEMO_CLOCK_COMMAND, { errorToast: false });
  const go = (key: string, input: DemoClockInput) => {
    setActive(key);
    return clock.run(input).finally(() => setActive(null));
  };
  const busy = (key: string) => clock.pending && active === key;

  return (
    <section aria-labelledby="demo-clock-title">
      <H id="demo-clock-title" className={headingLevel === 2 ? "flex items-center gap-1.5 text-md font-bold tracking-[-0.01em]" : "flex items-center gap-1.5 font-semibold"}>
        <Clock className="size-4 text-ink-muted" aria-hidden />
        Demo clock
      </H>
      <p className="mt-0.5 text-sm text-ink-secondary">
        <span className="num-tabular font-medium text-ink">{fmtDemoClock(now)}</span>,{" "}
        {running ? "running at normal speed until paused." : "paused: it moves only when you advance or jump it."} Demo time, not the wall clock.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          icon={<FastForward />}
          className="justify-start"
          loading={busy("advance")}
          loadingLabel="Advancing..."
          disabled={clock.pending && active !== "advance"}
          onClick={() => void go("advance", { advanceMinutes: 5 })}
        >
          Advance 5 min
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={running ? <Pause /> : <Play />}
          className="justify-start"
          loading={busy("running")}
          loadingLabel={running ? "Pausing..." : "Resuming..."}
          disabled={clock.pending && active !== "running"}
          onClick={() => void go("running", { running: !running })}
        >
          {running ? "Pause clock" : "Resume clock"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Truck />}
          className="col-span-2 justify-start"
          loading={busy("courier")}
          loadingLabel="Moving clock..."
          disabled={pastCourier || (clock.pending && active !== "courier")}
          reasonId={pastCourier ? "demo-clock-courier-reason" : undefined}
          onClick={() => void go("courier", { iso: courierAt })}
        >
          Jump to courier arrival (11:00)
        </Button>
        {pastCourier ? (
          <p id="demo-clock-courier-reason" className="col-span-2 -mt-1 text-xs text-ink-muted">
            Already past 11:00 on the demo clock.
          </p>
        ) : null}
        <Button
          size="sm"
          variant="quiet"
          icon={<RotateCcw />}
          className="col-span-2 justify-start"
          loading={busy("reset")}
          loadingLabel="Resetting..."
          disabled={clock.pending && active !== "reset"}
          onClick={() => setConfirmReset(true)}
        >
          Reset clock to 10:52
        </Button>
      </div>
      <CommandError error={clock.error} className="mt-2" />
      <ConfirmDialog
        open={confirmReset}
        title="Reset the demo clock to 10:52?"
        confirmLabel="Reset clock to 10:52"
        cancelLabel="Keep current time"
        pending={busy("reset")}
        pendingLabel="Resetting..."
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void go("reset", { iso: startAt, reset: true }).then(() => setConfirmReset(false))}
      >
        <p>
          Only the clock moves back. Events already recorded after 10:52 will look as if they happen in the future. To start the
          demonstration again, use Reset demo data on the presenter console (Outages and reset).
        </p>
      </ConfirmDialog>
    </section>
  );
}
