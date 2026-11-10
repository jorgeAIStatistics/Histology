import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A storage location read as the walk to it: storage unit, drawer, box, slot.
 * Parsed from the location code ("CAB-2/DR-4/BX-11/S-14"); a code that is not
 * a cabinet path (bench, processor, outside) has no segments.
 */
const LEVEL: Record<string, string> = { CAB: "Cabinet", DR: "Drawer", BX: "Box", S: "Slot" };

export interface PathSegment {
  level: string;
  value: string;
}

export function locationSegments(code: string | null | undefined): PathSegment[] | null {
  if (!code) return null;
  const segs = code.split("/").map((p) => {
    const m = /^([A-Z]+)-(.+)$/.exec(p);
    return m && LEVEL[m[1]] ? { level: LEVEL[m[1]], value: m[2] } : null;
  });
  return segs.every(Boolean) ? (segs as PathSegment[]) : null;
}

/** "Cabinet 2, Drawer 4, Box 11, Slot 14" for sentences and screen readers. */
export function pathWords(segs: PathSegment[]): string {
  return segs.map((s) => `${s.level} ${s.value}`).join(", ");
}

export function LocationPath({ segments, size = "md", className }: { segments: PathSegment[]; size?: "md" | "sm"; className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-1 gap-y-1", className)} aria-label={`Location: ${pathWords(segments)}`}>
      {segments.map((s, i) => (
        <li key={`${s.level}-${i}`} className="flex items-center gap-1">
          {i ? <ChevronRight className="size-4 shrink-0 text-ink-muted" aria-hidden /> : null}
          <span className={cn("inline-flex items-baseline gap-1 whitespace-nowrap rounded-sm border border-line bg-surface", size === "md" ? "px-2 py-0.5" : "px-1.5")}>
            <span className="text-xs text-ink-muted">{s.level}</span>
            <span className={cn("id-mono font-semibold text-ink", size === "md" ? "text-base" : "text-sm")}>{s.value}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The box (the path without its slot) and the slot itself, so the slot can be set large where the hand goes. */
export function splitSlot(segments: PathSegment[]): { box: PathSegment[]; slot: PathSegment | null } {
  const last = segments[segments.length - 1];
  return last && last.level === "Slot" ? { box: segments.slice(0, -1), slot: last } : { box: segments, slot: null };
}

/**
 * A slot position set large: what the hand goes to. Reads "Slot 14". `across` lays the
 * word and the number on one line (the decision column, where height is short).
 */
export function SlotTile({ slot, across = false, className }: { slot: PathSegment; across?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 rounded-md border border-line-strong bg-surface-subtle text-center",
        across ? "items-baseline gap-1.5 px-2.5 py-1" : "flex-col items-center justify-center px-1 py-1.5",
        className,
      )}
    >
      <span className="text-xs text-ink-muted">{slot.level}</span>{" "}
      <span className={cn("id-mono font-semibold text-ink", across ? "text-xl leading-7" : "text-lg leading-6")}>{slot.value}</span>
    </span>
  );
}
