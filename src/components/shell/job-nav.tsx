"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, Inbox, LayoutDashboard, ListChecks, MessageSquareWarning, Microscope, Printer, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { NavCounts } from "@/lib/client/types";

interface JobLink {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Count key and how it is read aloud ("Clarify, 7 open"). */
  count?: { key: keyof NavCounts; phrase: (n: number) => string };
}

/** Navigation grouped by the jobs at the bench, in the order work flows. */
const JOBS: { job: string; items: JobLink[] }[] = [
  {
    job: "Receive and reconcile",
    items: [
      { href: "/intake", label: "Intake", icon: Inbox, count: { key: "intake", phrase: (n) => `${n} to review` } },
      { href: "/clarifications", label: "Clarify", icon: MessageSquareWarning, count: { key: "clarifications", phrase: (n) => `${n} open` } },
    ],
  },
  { job: "Gross and enter", items: [{ href: "/grossing", label: "Gross", icon: Microscope }] },
  {
    job: "Bench histology",
    items: [
      { href: "/worklist", label: "Worklist", icon: ListChecks },
      {
        href: "/materials",
        label: "Materials",
        icon: Printer,
        count: { key: "materials", phrase: (n) => `${n} ${n === 1 ? "needs" : "need"} attention` },
      },
    ],
  },
  {
    job: "Oversee",
    items: [
      {
        href: "/operations",
        label: "Operations",
        icon: LayoutDashboard,
        count: { key: "operations", phrase: (n) => `${n} ${n === 1 ? "hold" : "holds"} open` },
      },
      { href: "/insights", label: "Insights", icon: ChartColumn },
    ],
  },
];

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function JobNavLink({ item, active, count }: { item: JobLink; active: boolean; count: number | null }) {
  const Icon = item.icon;
  const showCount = typeof count === "number" && count > 0;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={item.label}
      className={cn(
        "relative inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm transition-colors duration-[var(--hlo-duration-fast)] max-[1365px]:h-11 max-[1365px]:w-11 max-[1365px]:justify-center max-[1365px]:px-0",
        active ? "bg-shell-fg font-semibold text-shell" : "font-medium text-shell-muted hover:bg-shell-2 hover:text-shell-fg",
      )}
    >
      <Icon className="size-4 shrink-0 min-[1366px]:hidden" aria-hidden />
      <span className="max-[1365px]:sr-only">{item.label}</span>
      {showCount ? (
        <>
          <span
            aria-hidden
            className={cn(
              "num-tabular inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-pill px-1 text-xs font-semibold leading-none max-[1365px]:absolute max-[1365px]:top-0.5 max-[1365px]:right-0.5 max-[1365px]:h-[1.125rem] max-[1365px]:min-w-[1.125rem] max-[1365px]:text-xs",
              active ? "bg-shell text-shell-fg" : "bg-shell-line text-shell-fg",
            )}
          >
            {count}
          </span>
          <span className="sr-only">, {item.count!.phrase(count as number)}</span>
        </>
      ) : null}
    </Link>
  );
}

/**
 * Job navigation in the hematoxylin top bar: text links grouped by job
 * (receive, gross, bench histology, oversee), hairlines between jobs. The
 * current page is the one light chip on the dark bar. Below 1366px the links
 * become 44px icon targets with the label kept for screen readers and as a
 * tooltip. Counts are only for work someone can act on and are read aloud.
 */
export function JobNav({ counts }: { counts: NavCounts }) {
  const pathname = usePathname() ?? "/";
  return (
    <nav aria-label="Main" className="flex min-w-0 shrink-0 items-center">
      {JOBS.map((group, gi) => (
        <div key={group.job} role="group" aria-label={group.job} className={cn("flex items-center gap-0.5", gi > 0 && "ml-1 border-l border-shell-line pl-1")}>
          {group.items.map((item) => (
            <JobNavLink key={item.href} item={item} active={isActivePath(pathname, item.href)} count={item.count ? counts[item.count.key] : null} />
          ))}
        </div>
      ))}
    </nav>
  );
}
