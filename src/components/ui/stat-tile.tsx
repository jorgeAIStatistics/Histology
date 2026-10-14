import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { IllustrativeTag, UnknownValue } from "@/components/domain/honesty";

/**
 * Stat tile (spec §7, §6.7): label, value (proportional figures), n, and
 * separate "Still open" / "Missing data" lines. The whole tile links to the
 * records behind the number. `value={null}` renders "Unknown" with the reason,
 * never 0. No sparklines, scores or percentages of "health".
 */
export interface StatTileProps {
  label: string;
  value: number | string | null | undefined;
  /** Shown with "Unknown" when value is null, e.g. "source unreachable since 10:41 ET". */
  unknownReason?: ReactNode;
  /** Unit after the value, e.g. "min". */
  unit?: string;
  /** Sample size for medians / percentiles. */
  n?: number | null;
  stillOpen?: number | null;
  missing?: number | null;
  /** Small caption under the value, e.g. "oldest 1 h 05 min". */
  caption?: ReactNode;
  /** true for the default "Illustrative: synthetic prior-day data", or custom text. */
  illustrative?: boolean | string;
  href?: string;
  className?: string;
}

export function StatTile({ label, value, unknownReason, unit, n, stillOpen, missing, caption, illustrative, href, className }: StatTileProps) {
  const isUnknown = value === null || value === undefined;
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-3 min-h-[3.375rem] text-sm font-medium text-ink-secondary">{label}</span>
        {href ? <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden /> : null}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        {isUnknown ? (
          <UnknownValue reason={unknownReason} className="text-sm" />
        ) : (
          <>
            <span className="text-2xl font-semibold text-ink">{value}</span>
            {unit ? <span className="text-sm text-ink-secondary">{unit}</span> : null}
          </>
        )}
      </div>
      {caption ? <p className="mt-0.5 text-xs text-ink-muted">{caption}</p> : null}
      {n !== undefined || stillOpen !== undefined || missing !== undefined ? (
        <ul className="mt-1.5 space-y-0.5 text-xs text-ink-secondary">
          {n !== undefined ? <li>n = {n ?? "Unknown"}</li> : null}
          {stillOpen !== undefined ? <li>Still open: {stillOpen ?? "Unknown"}</li> : null}
          {missing !== undefined ? <li>Missing event data: {missing ?? "Unknown"}</li> : null}
        </ul>
      ) : null}
      {illustrative ? (
        <div className="mt-2">
          <IllustrativeTag className="max-w-full shrink whitespace-normal">{typeof illustrative === "string" ? illustrative : "Illustrative"}</IllustrativeTag>
        </div>
      ) : null}
    </>
  );
  const shell = cn("block rounded-md border border-line bg-surface p-3 shadow-1", className);
  if (href) {
    return (
      <Link href={href} className={cn(shell, "transition-colors duration-[var(--hlo-duration-fast)] hover:border-brand hover:bg-brand-50")}>
        {body}
      </Link>
    );
  }
  return <div className={shell}>{body}</div>;
}
