import Link from "next/link";
import type { NavCounts, ShellActor, ShellStaff } from "@/lib/client/types";
import { BrandMark } from "./brand-mark";
import { DemoBanner } from "./demo-banner";
import { JobNav } from "./job-nav";
import { PresenterMenu } from "./presenter-menu";
import { ScanField } from "./scan-field";
import { ShortcutsButton } from "./shortcuts-button";
import { SourceFreshness } from "./source-freshness";

/**
 * The hematoxylin top bar, the only chrome: mark, job navigation, the scan
 * field as the widest element (the bench's main input), source freshness (it
 * affects decisions), the always-visible Synthetic demo status, and one
 * presenter menu (role switch, demo clock, guided demo, settings, keys).
 */
export function TopBar({ actor, staff, counts }: { actor: ShellActor; staff: ShellStaff[]; counts: NavCounts }) {
  return (
    <div
      data-on-dark
      className="flex h-[var(--hlo-topbar-h)] min-w-0 items-center gap-3 bg-shell px-3 text-shell-fg max-[1439px]:gap-2 max-lg:flex-wrap max-lg:content-center max-lg:gap-y-1.5"
    >
      <Link
        href="/"
        className="flex shrink-0 items-center gap-2 rounded-md px-1 text-shell-fg"
        title="Histology Lab OS · Histology Redesigned · Lumen Bay Dermatopathology Laboratory (fictional)"
      >
        <BrandMark className="size-7" />
        <span className="text-base font-bold tracking-[-0.01em] max-[1719px]:sr-only">Histology Lab OS</span>
      </Link>
      <JobNav counts={counts} />
      {/* Below 1024px (tablet portrait, 200% zoom) the scan field takes its own full-width row. */}
      <div className="contents max-lg:order-last max-lg:flex max-lg:w-full max-lg:items-center max-lg:gap-2">
        <ScanField />
        <SourceFreshness />
        <ShortcutsButton />
      </div>
      <div className="contents max-lg:ml-auto max-lg:flex max-lg:items-center max-lg:gap-2">
        <DemoBanner />
        <PresenterMenu actor={actor} staff={staff} />
      </div>
    </div>
  );
}
