import Link from "next/link";
import type { ShellActor, ShellStaff } from "@/lib/client/types";
import { ActingAs } from "./acting-as";
import { DemoClock } from "./demo-clock";
import { ScanField } from "./scan-field";
import { SourceFreshness } from "./source-freshness";

/**
 * Top bar (spec §5.1), 52px: wordmark, global scan field, source freshness,
 * demo clock, acting-as role selector.
 */
export function TopBar({ actor, staff }: { actor: ShellActor; staff: ShellStaff[] }) {
  return (
    <div className="flex h-[var(--hlo-topbar-h)] items-center gap-3 border-b border-line bg-surface px-4">
      <Link
        href="/"
        className="flex min-w-[8.5rem] shrink flex-col justify-center rounded-sm leading-tight max-xl:shrink-0"
        title="Histology Lab OS · Histology Redesigned · Lumen Bay Dermatopathology Laboratory (fictional)"
      >
        <span className="truncate text-base font-semibold text-ink">
          Histology Lab OS
          <span className="ml-1.5 text-xs font-normal text-ink-muted max-2xl:hidden">· Histology Redesigned</span>
        </span>
        <span className="truncate text-xs text-ink-muted max-xl:hidden">Lumen Bay Dermatopathology Laboratory (fictional)</span>
      </Link>
      <ScanField />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SourceFreshness />
        <DemoClock />
        <span aria-hidden className="mx-1 h-8 w-px bg-line" />
        <ActingAs actor={actor} staff={staff} />
      </div>
    </div>
  );
}
