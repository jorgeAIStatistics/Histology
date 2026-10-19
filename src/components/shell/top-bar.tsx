import Link from "next/link";
import type { NavCounts, ShellActor } from "@/lib/client/types";
import { BrandMark } from "./brand-mark";
import { DemoBanner } from "./demo-banner";
import { DemoRoleIndicator, PresenterConsoleLink } from "./demo-role-indicator";
import { JobNav } from "./job-nav";
import { ScanField } from "./scan-field";
import { ShortcutsButton } from "./shortcuts-button";
import { SourceFreshness } from "./source-freshness";

/**
 * The hematoxylin top bar, the only chrome: mark, job navigation, the scan
 * field as the widest element (the bench's main input), source freshness (it
 * affects decisions), keys, then the always-visible Synthetic demo status. In synthetic demo mode it also shows the demo role and demo
 * time (read only, not a control) and one link to the presenter console; the
 * role switch, the clock and every simulated event live there, never on a
 * bench screen. A locked build has no presenter entry at all.
 */
export function TopBar({ actor, counts, demo }: { actor: ShellActor; counts: NavCounts; demo: boolean }) {
  return (
    <div
      data-on-dark
      className="flex h-[var(--hlo-topbar-h)] min-w-0 items-center gap-3 bg-shell px-3 text-shell-fg max-[90rem]:gap-2 max-lg:flex-wrap max-lg:content-center max-lg:gap-y-1.5"
    >
      <Link
        href="/"
        className="flex shrink-0 items-center gap-2 rounded-md px-1 text-shell-fg"
        title="Histology Lab OS · Histology Redesigned · Lumen Bay Dermatopathology Laboratory (fictional)"
      >
        <BrandMark className="size-7" />
        <span className="text-base font-bold tracking-[-0.01em] max-[120rem]:sr-only">Histology Lab OS</span>
      </Link>
      <JobNav counts={counts} />
      {/* Below 1024px (tablet portrait, 200% zoom) the scan field takes its own full-width row. */}
      <div className="contents max-lg:order-last max-lg:flex max-lg:w-full max-lg:items-center max-lg:gap-2">
        <ScanField />
        <SourceFreshness />
        <ShortcutsButton />
      </div>
      <div className="contents max-lg:ml-auto max-lg:flex max-lg:items-center max-lg:gap-2">
        {demo ? (
          <>
            <DemoBanner />
            <DemoRoleIndicator actor={actor} />
            <PresenterConsoleLink />
          </>
        ) : (
          // Locked build (no HLOS_MODE=demo, no identity provider): read only, no role switch, no presenter entry.
          <p role="note" className="inline-flex h-7 items-center gap-1.5 rounded-pill bg-warning-on-dark px-2.5 text-sm font-semibold text-shell">
            Locked: no sign-in configured, changes are refused
          </p>
        )}
      </div>
    </div>
  );
}
