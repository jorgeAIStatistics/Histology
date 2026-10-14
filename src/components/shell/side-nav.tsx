"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartColumn,
  Inbox,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  MessageSquareWarning,
  Microscope,
  PanelLeftClose,
  PanelLeftOpen,
  Presentation,
  Printer,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { PREFS } from "@/lib/client/pref-keys";
import { usePref } from "@/lib/client/preferences";
import { openShortcutHelp } from "@/lib/client/keyboard";
import { useLastDemoStep } from "@/lib/client/demo-step";
import type { NavCounts } from "@/lib/client/types";

interface NavItem {
  href: string;
  label: string;
  short: string;
  icon: LucideIcon;
  /** Count key and how it is read aloud ("Clarifications, 2 open"). */
  count?: { key: keyof NavCounts; phrase: (n: number) => string };
}

interface NavGroup {
  label: string;
  /** Hide the visible group heading (still named for screen readers). */
  hideHeading?: boolean;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: "Bench",
    items: [
      { href: "/intake", label: "Intake", short: "Intake", icon: Inbox, count: { key: "intake", phrase: (n) => `${n} to review` } },
      {
        href: "/clarifications",
        label: "Clarifications",
        short: "Clarif.",
        icon: MessageSquareWarning,
        count: { key: "clarifications", phrase: (n) => `${n} open` },
      },
      { href: "/worklist", label: "Worklist", short: "Worklist", icon: ListChecks },
      { href: "/grossing", label: "Grossing", short: "Grossing", icon: Microscope },
      {
        href: "/materials",
        label: "Materials",
        short: "Materials",
        icon: Printer,
        count: { key: "materials", phrase: (n) => `${n} ${n === 1 ? "needs" : "need"} attention` },
      },
    ],
  },
  {
    label: "Oversight",
    items: [
      {
        href: "/operations",
        label: "Operations",
        short: "Ops",
        icon: LayoutDashboard,
        count: { key: "operations", phrase: (n) => `${n} ${n === 1 ? "hold" : "holds"} open` },
      },
      { href: "/insights", label: "Insights", short: "Insights", icon: ChartColumn },
    ],
  },
  { label: "Admin", items: [{ href: "/settings", label: "Settings", short: "Settings", icon: Settings }] },
  { label: "Guided demo", hideHeading: true, items: [{ href: "/demo", label: "Guided demo", short: "Demo", icon: Presentation }] },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Left nav (spec §5.1): Bench, Oversight, Admin, Guided demo. Each item has an
 * icon and a text label; counts show items that need action and are read
 * aloud ("Clarifications, 2 open"). Active item: brand-50 fill, 3px brand
 * edge, aria-current. Collapses to a 72px rail (user choice, or below 1280px).
 */
export function SideNav({ counts }: { counts: NavCounts }) {
  const pathname = usePathname() ?? "/";
  const [collapsed, setCollapsed] = usePref(PREFS.navCollapsed);
  const demoStep = useLastDemoStep();
  const onDemo = isActive(pathname, "/demo");

  return (
    <nav
      aria-label="Main"
      data-rail={collapsed ? "true" : "false"}
      data-shell-chrome
      className="sticky top-[var(--hlo-chrome-h)] flex h-[calc(100vh_-_var(--hlo-chrome-h))] w-[var(--hlo-nav-w)] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface rail:w-[var(--hlo-nav-rail-w)]"
    >
      <div className="flex flex-1 flex-col gap-3 py-3">
        {GROUPS.map((group) => {
          const headingId = `nav-${group.label.toLowerCase().replace(/\s+/g, "-")}`;
          return (
            <div key={group.label} role="group" aria-labelledby={headingId}>
              <p
                id={headingId}
                className={cn(
                  "px-4 pb-1 text-xs font-medium text-ink-muted rail:sr-only",
                  group.hideHeading && "sr-only",
                )}
              >
                {group.label}
              </p>
              <ul className="flex flex-col gap-0.5 rail:gap-1">
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  const n = item.count ? counts[item.count.key] : null;
                  const showCount = typeof n === "number" && n > 0;
                  const Icon = item.icon;
                  // On the real screens, the guided-demo entry returns to the step the presenter was on.
                  const demoReturn = item.href === "/demo" && demoStep && !onDemo ? demoStep : null;
                  return (
                    <li key={item.href}>
                      <Link
                        href={demoReturn ? `/demo?tab=guide&step=${demoReturn.step}` : item.href}
                        aria-current={active ? "page" : undefined}
                        title={demoReturn ? `Back to guided demo step ${demoReturn.step}: ${demoReturn.short}` : item.label}
                        className={cn(
                          "relative flex items-center gap-2.5 border-l-[3px] pl-[13px] pr-3 text-sm",
                          demoReturn ? "min-h-9 py-1.5" : "h-9",
                          "rail:h-14 rail:flex-col rail:justify-center rail:gap-0.5 rail:px-1 rail:pl-0 rail:text-xs",
                          active
                            ? "border-l-brand bg-brand-50 font-medium text-ink"
                            : "border-l-transparent text-ink-secondary hover:bg-surface-subtle hover:text-ink",
                        )}
                      >
                        <Icon className={cn("size-4 shrink-0 rail:size-5", active ? "text-brand" : "text-ink-muted")} aria-hidden />
                        <span className="min-w-0 flex-1 rail:hidden">
                          <span className="block truncate">{item.label}</span>
                          {demoReturn ? (
                            <span className="block text-xs leading-tight text-ink-muted">
                              Back to step {demoReturn.step} of {demoReturn.total}: {demoReturn.short}
                            </span>
                          ) : null}
                        </span>
                        <span className="hidden max-w-full truncate rail:block" aria-hidden>
                          {demoReturn ? `Step ${demoReturn.step}` : item.short}
                        </span>
                        <span className="hidden rail:sr-only rail:inline">
                          {item.label}
                          {demoReturn ? `, back to step ${demoReturn.step}: ${demoReturn.short}` : ""}
                        </span>
                        {showCount ? (
                          <>
                            <span
                              aria-hidden
                              className={cn(
                                "num-tabular inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-pill border border-line-strong bg-surface px-1.5 text-xs font-medium text-ink",
                                "rail:absolute rail:right-1.5 rail:top-1 rail:h-4 rail:min-w-4 rail:px-1",
                              )}
                            >
                              {n}
                            </span>
                            <span className="sr-only">, {item.count!.phrase(n as number)}</span>
                          </>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-0.5 border-t border-line py-2">
        <button
          type="button"
          onClick={openShortcutHelp}
          className="flex h-8 items-center gap-2.5 px-4 text-sm text-ink-secondary hover:bg-surface-subtle hover:text-ink rail:justify-center rail:px-0"
        >
          <Keyboard className="size-4 shrink-0 text-ink-muted" aria-hidden />
          <span className="rail:sr-only">Keyboard shortcuts</span>
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-pressed={collapsed}
          className="flex h-8 items-center gap-2.5 px-4 text-sm text-ink-secondary hover:bg-surface-subtle hover:text-ink max-xl:hidden rail:justify-center rail:px-0"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4 shrink-0 text-ink-muted" aria-hidden />
          ) : (
            <PanelLeftClose className="size-4 shrink-0 text-ink-muted" aria-hidden />
          )}
          <span className="rail:sr-only">{collapsed ? "Expand navigation" : "Collapse navigation"}</span>
        </button>
      </div>
    </nav>
  );
}
