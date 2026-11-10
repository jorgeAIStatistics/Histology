"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, Inbox, LayoutDashboard, ListChecks, MessageSquareWarning, Microscope, Printer, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { roleCan, type ViewPermission } from "@/lib/roles";
import { useActor } from "@/lib/client/shell-context";
import type { NavCounts } from "@/lib/client/types";
import { Tooltip } from "@/components/ui/tooltip";

interface JobLink {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The screen's view permission (src/lib/roles.ts): a role without it is not offered the link. */
  view: ViewPermission;
  /** Count key and how it is read aloud ("Clarify, 7 open"). */
  count?: { key: keyof NavCounts; phrase: (n: number) => string };
}

/** Navigation grouped by the jobs at the bench, in the order work flows. */
const JOBS: { job: string; items: JobLink[] }[] = [
  {
    job: "Receive and reconcile",
    items: [
      { href: "/intake", label: "Intake", icon: Inbox, view: "view.intake", count: { key: "intake", phrase: (n) => `${n} to review` } },
      { href: "/clarifications", label: "Clarify", icon: MessageSquareWarning, view: "view.clarifications", count: { key: "clarifications", phrase: (n) => `${n} open` } },
    ],
  },
  { job: "Gross and enter", items: [{ href: "/grossing", label: "Gross", icon: Microscope, view: "view.grossing" }] },
  {
    job: "Bench histology",
    items: [
      { href: "/worklist", label: "Worklist", icon: ListChecks, view: "view.worklist" },
      {
        href: "/materials",
        label: "Materials",
        icon: Printer,
        view: "view.materials",
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
        view: "view.operations",
        count: { key: "operations", phrase: (n) => `${n} ${n === 1 ? "hold" : "holds"} open` },
      },
      { href: "/insights", label: "Insights", icon: ChartColumn, view: "view.insights" },
    ],
  },
];

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function JobNavLink({ item, active, count }: { item: JobLink; active: boolean; count: number | null }) {
  const Icon = item.icon;
  const showCount = typeof count === "number" && count > 0;
  // Below 1536px the scan field must lead the bar: inactive jobs become 44px icon targets (label in a
  // tooltip on hover and keyboard focus, and in the accessible name); the active job keeps its label.
  const compact = active ? "max-[85.375rem]:h-11 max-[85.375rem]:w-11 max-[85.375rem]:justify-center max-[85.375rem]:px-0" : "max-[96rem]:h-11 max-[96rem]:w-11 max-[96rem]:justify-center max-[96rem]:px-0";
  const hideLabel = active ? "max-[85.375rem]:sr-only" : "max-[96rem]:sr-only";
  const showIcon = active ? "min-[85.375rem]:hidden" : "min-[96rem]:hidden";
  const badgeCorner = active ? "max-[85.375rem]" : "max-[96rem]";
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm transition-colors duration-[var(--hlo-duration-fast)]",
        compact,
        active ? "bg-shell-fg font-semibold text-shell" : "font-medium text-shell-muted hover:bg-shell-2 hover:text-shell-fg",
      )}
    >
      <Icon className={cn("size-4 shrink-0", showIcon)} aria-hidden />
      <span className={hideLabel}>{item.label}</span>
      {showCount ? (
        <>
          <span
            aria-hidden
            className={cn(
              "num-tabular inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-pill px-1 text-xs font-semibold leading-none",
              badgeCorner === "max-[85.375rem]" ? "max-[85.375rem]:absolute max-[85.375rem]:top-0.5 max-[85.375rem]:right-0.5" : "max-[96rem]:absolute max-[96rem]:top-0.5 max-[96rem]:right-0.5",
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
  return (
    <Tooltip content={showCount ? `${item.label}: ${item.count!.phrase(count as number)}` : item.label} side="bottom">
      {link}
    </Tooltip>
  );
}

/**
 * Job navigation in the hematoxylin top bar: text links grouped by job
 * (receive, gross, bench histology, oversee), hairlines between jobs. The
 * current page is the one light chip on the dark bar. Below 1536px the other
 * jobs become 44px icon targets (label in a tooltip and the accessible name)
 * so the scan field stays the widest control; below 1366px the active job
 * does too. Counts are only for work someone can act on and are read aloud.
 */
export function JobNav({ counts }: { counts: NavCounts }) {
  const pathname = usePathname() ?? "/";
  const { role } = useActor();
  // Only the screens this role may open (every bench role: all of them; the laboratory administrator and the
  // auditor: none, so no link leads to the 403 page).
  const jobs = JOBS.map((g) => ({ ...g, items: g.items.filter((item) => roleCan(role, item.view)) })).filter((g) => g.items.length);
  if (!jobs.length) return null;
  return (
    <nav aria-label="Main" className="flex min-w-0 shrink-0 items-center">
      {jobs.map((group, gi) => (
        <div key={group.job} role="group" aria-label={group.job} className={cn("flex items-center gap-0.5", gi > 0 && "ml-1 border-l border-shell-line pl-1")}>
          {group.items.map((item) => (
            <JobNavLink key={item.href} item={item} active={isActivePath(pathname, item.href)} count={item.count ? counts[item.count.key] : null} />
          ))}
        </div>
      ))}
    </nav>
  );
}
