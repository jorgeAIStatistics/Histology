"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { Check, Circle, CircleDashed, CirclePause, ClipboardCheck, Hourglass, TriangleAlert, UserCheck, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { IdText } from "@/components/domain/id-text";
import type { PartStateKey } from "@/server/queries/grossing";

/** Part state in words (the link text starts "Part B: <state>"). */
export const PART_STATE_LABEL: Record<PartStateKey, string> = {
  awaiting: "Awaiting grossing",
  on_hold: "On hold",
  draft: "Gross draft",
  needs_clarification: "Needs clarification",
  operator_reviewed: "Operator reviewed",
  approved_pending_entry: "Approved, source entry pending",
  approved_entered: "Approved, entered (staff attested)",
  approved_acknowledged: "Approved, source acknowledged (simulated)",
  canceled: "Canceled",
};

/**
 * Icon on the severity ladder: amber only for "data may be wrong", hatched pause for a hold, quiet check when done.
 * Every record state has its own icon: reviewed (clipboard check), source entry pending (hourglass), entered by staff
 * attestation (person check, as in the source-entry view), acknowledged by the simulated source (check).
 */
export function PartStateIcon({ state, className }: { state: PartStateKey; className?: string }) {
  const c = cn("size-4 shrink-0", className);
  switch (state) {
    case "on_hold":
      return <CirclePause className={cn(c, "text-hold-solid")} aria-hidden />;
    case "needs_clarification":
      return <TriangleAlert className={cn(c, "text-warning-solid")} aria-hidden />;
    case "draft":
      return <CircleDashed className={cn(c, "text-ink-muted")} aria-hidden />;
    case "operator_reviewed":
      return <ClipboardCheck className={cn(c, "text-ink-secondary")} aria-hidden />;
    case "approved_pending_entry":
      return <Hourglass className={cn(c, "text-ink-muted")} aria-hidden />;
    case "approved_entered":
      return <UserCheck className={cn(c, "text-ink-secondary")} aria-hidden />;
    case "approved_acknowledged":
      return <Check className={cn(c, "text-ink-muted")} aria-hidden />;
    case "canceled":
      return <XCircle className={cn(c, "text-ink-muted")} aria-hidden />;
    default:
      return <Circle className={cn(c, "text-ink-muted")} aria-hidden />;
  }
}

/**
 * Every part of the case with its own state, so a finished part never reads as a finished case. The current part is
 * set in hematoxylin (the selected state); a held part carries the hold hatch. The state is written out in full at
 * every width (a touch tablet never shows a title): when the strip does not fit beside the heading it wraps to its
 * own row instead of shortening the words.
 */
export function PartsStrip({
  parts,
  currentPartId,
  onNavigate,
}: {
  parts: { partId: string; ref: string; designation: string; site: string; state: PartStateKey; holdIds: string[] }[];
  currentPartId: string;
  onNavigate?: (href: string) => (e: MouseEvent) => void;
}) {
  return (
    <nav aria-label="Parts of this case">
      <ul className="flex flex-wrap gap-1.5">
        {parts.map((p) => {
          const href = `/grossing?part=${encodeURIComponent(p.ref)}`;
          const current = p.partId === currentPartId;
          const held = p.state === "on_hold";
          return (
            <li key={p.partId}>
              <Link
                href={href}
                onClick={onNavigate?.(href)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-[max(2rem,var(--hlo-target-min))] items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm leading-5 transition-colors duration-[var(--hlo-duration-fast)]",
                  current
                    ? "border-shell bg-shell text-shell-fg [&_svg]:text-shell-muted"
                    : held
                      ? "hatch border-hold-border text-hold-fg hover:border-ink-muted"
                      : "border-line-strong bg-surface text-ink hover:bg-surface-subtle",
                )}
              >
                <PartStateIcon state={p.state} />
                <span>
                  <span className="font-semibold">Part {p.designation}:</span>{" "}
                  <span className={current ? "text-shell-fg" : "text-ink-secondary"}>
                    <IdText text={`${PART_STATE_LABEL[p.state]}${held && p.holdIds.length ? ` (${p.holdIds.join(", ")})` : ""}`} />
                  </span>
                </span>
                <span className="sr-only">{current ? " (current part)" : ""}, site {p.site}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
