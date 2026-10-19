import type { PathologistColor } from "@/lib/domain";
import { cn } from "@/lib/cn";

/**
 * Doctor chip (spec §7): 12x12 rounded swatch plus the name in body text.
 * Never initials only, never text inside the swatch. Doctor colors are
 * identity, not status: they never appear inside a pill, banner or alert.
 * Unassigned: dashed empty swatch plus "Unassigned: routing exception".
 */
export const DOCTOR_SWATCH: Record<PathologistColor, string> = {
  teal: "bg-dr-teal",
  violet: "bg-dr-violet",
  amber: "bg-dr-amber",
};

export const DOCTOR_TINT: Record<PathologistColor, string> = {
  teal: "bg-dr-teal-tint",
  violet: "bg-dr-violet-tint",
  amber: "bg-dr-amber-tint",
};

export function isPathologistColor(v: unknown): v is PathologistColor {
  return v === "teal" || v === "violet" || v === "amber";
}

export function DoctorSwatch({ color, className }: { color?: PathologistColor | string | null; className?: string }) {
  if (!isPathologistColor(color)) {
    return <span aria-hidden className={cn("hlo-swatch inline-block size-3 shrink-0 rounded-[3px] border border-dashed border-ink-muted", className)} />;
  }
  return <span aria-hidden className={cn("hlo-swatch inline-block size-3 shrink-0 rounded-[3px]", DOCTOR_SWATCH[color], className)} />;
}

export interface DoctorChipProps {
  /** Full name, e.g. "Dr. Elena Marsh". Null/undefined = unassigned (routing exception). */
  name?: string | null;
  color?: PathologistColor | string | null;
  /** Compact name, e.g. "Dr. Marsh" (used when `compact`). */
  shortName?: string;
  compact?: boolean;
  /** Append the color name in muted text ("teal") for group headers and printed snapshots. */
  showColorName?: boolean;
  /** Prefix with the role ("Assigned dermatopathologist: "). */
  withRole?: boolean;
  className?: string;
}

export function DoctorChip({ name, color, shortName, compact, showColorName, withRole, className }: DoctorChipProps) {
  if (!name) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-ink-secondary", className)}>
        <DoctorSwatch color={null} />
        <span>Unassigned: routing exception</span>
      </span>
    );
  }
  const display = compact && shortName ? shortName : name;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-ink", className)}>
      <DoctorSwatch color={color} />
      <span>
        {withRole ? <span className="text-ink-muted">Assigned dermatopathologist: </span> : null}
        {compact && shortName ? (
          <>
            <span aria-hidden>{display}</span>
            <span className="sr-only">{name}</span>
          </>
        ) : (
          display
        )}
        {showColorName && isPathologistColor(color) ? <span className="ml-1 text-ink-muted">({color})</span> : null}
      </span>
    </span>
  );
}
