"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { ChevronDown, Clock, Presentation, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLastDemoStep } from "@/lib/client/demo-step";
import { isReadOnlyRole } from "@/lib/client/shell-context";
import type { ShellActor, ShellStaff } from "@/lib/client/types";
import { ActingAs, optionText } from "./acting-as";
import { DemoClockPanel, useDemoClockLabel } from "./demo-clock";
import { isActivePath } from "./job-nav";

const menuLink =
  "inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md px-2 text-sm font-medium text-ink hover:bg-surface-subtle [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-muted";

/**
 * The presenter menu: everything that belongs to running the demonstration
 * rather than to bench work. The trigger shows the demo clock and the role
 * being demonstrated; the menu holds the role switch (not a sign-in), the
 * demo clock controls, the guided demo and settings. (Keyboard keys have
 * their own button in the bar: they are for bench work, not the presenter.)
 */
export function PresenterMenu({ actor, staff }: { actor: ShellActor; staff: ShellStaff[] }) {
  const clock = useDemoClockLabel();
  const pathname = usePathname() ?? "/";
  const demoStep = useLastDemoStep();
  const onDemo = isActivePath(pathname, "/demo");
  const demoHref = demoStep && !onDemo ? `/demo?tab=guide&step=${demoStep.step}` : "/demo";
  const who = optionText(actor);
  const readOnly = isReadOnlyRole(actor.role);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Presenter menu: acting as ${who}${readOnly ? ", read only" : ""} (demo role switch, not a sign-in); demo clock ${clock.full}${clock.running ? "" : ", paused"}`}
          className="flex h-10 shrink-0 items-stretch overflow-hidden rounded-md border border-shell-line text-left text-shell-fg hover:bg-shell-2 data-[state=open]:bg-shell-2"
        >
          <span className="flex items-center gap-1.5 px-2.5 max-xl:px-2" title={`Acting as ${who} (demo role switch, not a sign-in)`}>
            <span className="flex min-w-0 flex-col justify-center leading-tight">
              <span className="flex items-center gap-1 whitespace-nowrap text-xs text-shell-muted max-xl:hidden">
                <Clock className="size-3 shrink-0" aria-hidden />
                <span>
                  <span className="num-tabular">{clock.time.replace(/ ET$/, "")}</span>
                  {clock.running ? "" : ", paused"}
                </span>
              </span>
              <span className="max-w-[9rem] truncate text-sm font-semibold max-xl:max-w-[4.5rem]">
                <span className="xl:hidden">{actor.name.split(" ")[0]}</span>
                <span className="max-xl:hidden">{actor.name}</span>
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-shell-muted" aria-hidden />
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Presenter"
          className="animate-rise-in z-50 flex w-[360px] flex-col gap-3 rounded-lg border border-line bg-surface p-3.5 text-sm text-ink shadow-3"
        >
          <div>
            <h2 className="text-md font-bold">Presenter</h2>
            <p className="mt-0.5 text-sm text-ink-secondary">
              Synthetic demo: a fictional laboratory and patients. The source system, office notifications, printers, scanners and the
              assistant are simulated.{" "}
              <Link href="/settings?tab=integration" className="font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand">
                What is simulated?
              </Link>
            </p>
          </div>
          <div className="border-t border-line pt-3">
            <ActingAs actor={actor} staff={staff} />
          </div>
          <div className="border-t border-line pt-3">
            <DemoClockPanel />
          </div>
          <nav aria-label="Presenter destinations" className="flex flex-wrap gap-1 border-t border-line pt-2.5">
            <Link
              href={demoHref}
              aria-current={onDemo ? "page" : undefined}
              title={demoStep && !onDemo ? `Back to guided demo step ${demoStep.step}: ${demoStep.short}` : "Guided demo"}
              className={cn(menuLink, onDemo && "bg-surface-subtle font-semibold")}
            >
              <Presentation aria-hidden />
              {demoStep && !onDemo ? `Demo step ${demoStep.step}` : "Guided demo"}
            </Link>
            <Link href="/settings" aria-current={isActivePath(pathname, "/settings") ? "page" : undefined} className={menuLink}>
              <Settings aria-hidden />
              Settings
            </Link>
          </nav>
          <Popover.Arrow className="fill-surface" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
