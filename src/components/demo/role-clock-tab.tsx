"use client";

import { useState } from "react";
import { UserRound } from "lucide-react";
import { labDay, labLocalToIso, fmtTime } from "@/lib/time";
import { DEMO_CLOCK_COMMAND } from "@/lib/client/demo-commands";
import { useDemoNow } from "@/lib/client/live";
import { isReadOnlyRole } from "@/lib/client/shell-context";
import type { ShellActor, ShellStaff } from "@/lib/client/types";
import { Card } from "@/components/ui/card";
import { CommandButton } from "@/components/ui/command-button";
import { Input, Label } from "@/components/ui/field";
import { ActingAs, optionText } from "@/components/shell/acting-as";
import { DemoClockPanel } from "@/components/shell/demo-clock";

/** Later scripted moments of the demo day (11:00, the courier, is the clock panel's own jump). */
const JUMPS: { hhmm: string; label: string }[] = [
  { hhmm: "11:04", label: "11:04 duplicate message" },
  { hhmm: "11:20", label: "11:20 PAS cancellation" },
  { hhmm: "11:25", label: "11:25 stale replay" },
];

/** Jump forward to a later scripted moment or a typed time (the clock never moves backwards except by Reset). */
function ClockJumps() {
  const now = useDemoNow(5_000);
  const day = labDay(now);
  const [custom, setCustom] = useState("");
  const customIso = /^\d{2}:\d{2}$/.test(custom) ? labLocalToIso(day, custom) : null;
  const customPast = customIso ? Date.parse(customIso) <= Date.parse(now) : false;
  const toast = (r: unknown) => {
    const x = r as { now: string; delivered: number };
    return `Demo clock ${fmtTime(x.now)} ET.${x.delivered ? ` ${x.delivered} simulated source message${x.delivered === 1 ? "" : "s"} delivered.` : ""}`;
  };
  return (
    <section aria-labelledby="clock-jumps" className="mt-4 border-t border-line pt-3">
      <h3 id="clock-jumps" className="text-sm font-semibold text-ink">
        Jump forward to a scripted moment
      </h3>
      <p className="mt-0.5 text-sm text-ink-secondary">Scheduled simulated source messages fall due as the clock passes their time, and arrive only while the source is connected.</p>
      <div className="mt-2 flex flex-wrap gap-x-1 gap-y-1" role="group" aria-labelledby="clock-jumps">
        {JUMPS.map((j) => {
          const iso = labLocalToIso(day, j.hhmm);
          const past = Date.parse(iso) <= Date.parse(now);
          return (
            <CommandButton
              key={j.hhmm}
              command={DEMO_CLOCK_COMMAND}
              input={{ iso }}
              size="sm"
              variant="ghost"
              disabled={past}
              pendingLabel="Jumping..."
              successToast={toast}
              aria-label={past ? `Jump to ${j.label} (already past)` : `Jump to ${j.label}`}
            >
              {j.label}
              {past ? " (past)" : ""}
            </CommandButton>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor="clock-jump">Jump forward to (ET, today)</Label>
          <Input id="clock-jump" type="time" size="sm" value={custom} onChange={(e) => setCustom(e.target.value)} className="w-32" invalid={customPast} />
        </div>
        <CommandButton
          command={DEMO_CLOCK_COMMAND}
          input={() => ({ iso: customIso })}
          size="sm"
          disabledReason={!customIso ? "Enter a time first." : customPast ? "That time has already passed; the clock does not move backwards." : undefined}
          pendingLabel="Jumping..."
          successToast={toast}
        >
          Jump
        </CommandButton>
      </div>
    </section>
  );
}

/**
 * Presenter console, "Role and clock" (synthetic demo only): the demo role
 * switch (not a sign-in) and the demo clock. Both used to sit in a menu in
 * the top bar; the bar now only shows them, read only.
 */
export function RoleClockTab({ actor, staff }: { actor: ShellActor; staff: ShellStaff[] }) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <Card aria-label="Demo role">
        <h2 className="flex items-center gap-1.5 text-md font-bold tracking-[-0.01em] text-ink">
          <UserRound className="size-4 text-ink-muted" aria-hidden />
          Demo role
        </h2>
        <p className="mt-0.5 text-sm text-ink-secondary">A demo role switch, not a sign-in. Every screen acts as this person until you switch again.</p>
        <div className="mt-3 max-w-md">
          <ActingAs actor={actor} staff={staff} />
        </div>
        {isReadOnlyRole(actor.role) ? (
          <p className="mt-3 text-sm text-ink-secondary">{optionText(actor)} is a read-only demo role: every screen can be viewed and nothing can be changed, including by a simulated event that edits a record.</p>
        ) : null}
        <p className="mt-3 text-sm text-ink-muted">
          The server checks the role on every action, whatever this says. Switching with unsaved edits on another screen asks first; values never carry over to another role.
        </p>
      </Card>
      <Card aria-label="Demo clock controls">
        <DemoClockPanel headingLevel={2} />
        <ClockJumps />
      </Card>
    </div>
  );
}
