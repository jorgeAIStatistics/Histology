"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clock, Pause, Play, Presentation } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLastDemoStep } from "@/lib/client/demo-step";
import { isReadOnlyRole } from "@/lib/client/shell-context";
import type { ShellActor } from "@/lib/client/types";
import { Tooltip } from "@/components/ui/tooltip";
import { optionText, ROLE_SHORT } from "./acting-as";
import { useDemoClockLabel } from "./demo-clock";
import { isActivePath } from "./job-nav";

/** "Maya" for "Maya Torres", "Dr. Marsh" for "Dr. Elena Marsh", the short role for demo-only people ("Director (demo)"). */
function shortName(actor: ShellActor): string {
  if (/\(demo\)$/.test(actor.name)) return ROLE_SHORT[actor.role];
  const words = actor.name.split(" ");
  return words[0] === "Dr." ? `Dr. ${words[words.length - 1]}` : words[0];
}

// The words "Demo role:" and "Demo time" show where the bar has room: 1280-1535px (job labels folded) and from 1920px.
const PREFIX = "max-xl:hidden min-[96rem]:max-[120rem]:hidden";

/**
 * Read-only status in the top bar (synthetic demo only): which demo role every
 * screen acts as, and the demo time. It is not a control: the role switch and
 * the clock controls live on the presenter console, never on a bench screen.
 * The accessible name and tooltip always carry the full sentence ("Demo role:
 * Maya Torres, Accessioner ... Demo time Wed Oct 14, 11:00 AM ET, paused");
 * the screen shows as much as the bar has room for (measured 683-1920px, source
 * online and offline): first name and role from 1280px, first name and a pause
 * or play glyph below.
 */
export function DemoRoleIndicator({ actor }: { actor: ShellActor }) {
  const clock = useDemoClockLabel();
  const who = optionText(actor);
  const first = shortName(actor);
  const short = /\(demo\)$/.test(actor.name) ? first : `${first}, ${ROLE_SHORT[actor.role]}`;
  const readOnly = isReadOnlyRole(actor.role);
  const time = clock.time.replace(/ ET$/, "");
  const state = clock.running ? "running" : "paused";
  const sentence = `Demo role: ${who}${readOnly ? ", read only" : ""} (demo role switch, not a sign-in). Demo time ${clock.full}, ${state}.`;
  return (
    // The only top-bar item that gives way when text is enlarged (125% root size): the name truncates, then the
    // "Demo time" word; the time and its state stay whole. The scan field keeps its minimum width.
    <div role="note" aria-label={sentence} title={sentence} className="flex h-10 min-w-0 shrink flex-col justify-center px-1 leading-tight text-shell-fg max-xl:px-0">
      <span aria-hidden className="flex min-w-0 items-baseline gap-1 whitespace-nowrap text-sm">
        <span className={cn("shrink-0 text-shell-muted", PREFIX)}>Demo role:</span>
        <span className="min-w-0 max-w-[11rem] truncate font-semibold max-xl:hidden">{short}</span>
        <span className="min-w-0 max-w-[5.5rem] truncate font-semibold xl:hidden">{first}</span>
      </span>
      <span aria-hidden className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-shell-muted">
        <Clock className="size-3 shrink-0 max-xl:hidden" aria-hidden />
        {/* Below 1280px (tablet) the state is a pause or play glyph; the word stays in the name and tooltip. */}
        {clock.running ? <Play className="size-3 shrink-0 xl:hidden" aria-hidden /> : <Pause className="size-3 shrink-0 xl:hidden" aria-hidden />}
        <span className={cn("min-w-0 truncate", PREFIX)}>Demo time</span>
        <span className="shrink-0">
          <span className="num-tabular">{time}</span>
          <span className="max-xl:hidden">, {state}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * The one presenter entry on the bench screens: a link to the presenter console
 * (/demo). It returns to the guided-demo step last viewed in this tab. Its name
 * is always "Presenter console"; from 1280px it shows "Console" beside the
 * icon, below that it is a 44px icon target (label in the tooltip).
 */
export function PresenterConsoleLink() {
  const pathname = usePathname() ?? "/";
  const demoStep = useLastDemoStep();
  const onConsole = isActivePath(pathname, "/demo");
  const href = demoStep && !onConsole ? `/demo?tab=guide&step=${demoStep.step}` : "/demo";
  const hint = demoStep && !onConsole ? `Presenter console (synthetic demo): back to guide step ${demoStep.step}, ${demoStep.short}` : "Presenter console (synthetic demo)";
  return (
    <Tooltip content={hint} side="bottom">
      <Link
        href={href}
        aria-label="Presenter console"
        aria-current={onConsole ? "page" : undefined}
        className={cn(
          "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-shell-line px-2.5 text-sm font-medium transition-colors duration-[var(--hlo-duration-fast)]",
          "max-xl:size-11 max-xl:justify-center max-xl:px-0",
          onConsole ? "border-shell-fg bg-shell-fg font-semibold text-shell" : "text-shell-fg hover:bg-shell-2",
        )}
      >
        <Presentation className="size-4 shrink-0" aria-hidden />
        {/* The visible word is part of the accessible name ("Presenter console"). */}
        <span className="max-xl:hidden">Console</span>
      </Link>
    </Tooltip>
  );
}
