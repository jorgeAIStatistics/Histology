"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { CircleCheck, CircleDashed, CirclePause, Clock, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PartStateKey } from "@/server/queries/grossing";

const LABEL: Record<PartStateKey, string> = {
  awaiting: "Awaiting grossing",
  on_hold: "On hold",
  draft: "Gross draft",
  needs_clarification: "Needs clarification",
  operator_reviewed: "Operator reviewed",
  approved_pending_entry: "Approved for downstream use",
  approved_entered: "Approved for downstream use",
  approved_acknowledged: "Approved for downstream use",
  canceled: "Canceled",
};

const ICON: Record<PartStateKey, typeof Clock> = {
  awaiting: Clock,
  on_hold: CirclePause,
  draft: CircleDashed,
  needs_clarification: TriangleAlert,
  operator_reviewed: CircleDashed,
  approved_pending_entry: CircleCheck,
  approved_entered: CircleCheck,
  approved_acknowledged: CircleCheck,
  canceled: CircleDashed,
};

const TONE: Record<PartStateKey, string> = {
  awaiting: "border-line-strong bg-surface text-ink",
  on_hold: "border-hold-border bg-hold-bg text-hold-fg",
  draft: "border-line-strong bg-surface text-ink",
  needs_clarification: "border-warning-border bg-warning-bg text-warning-fg",
  operator_reviewed: "border-info-border bg-info-bg text-info-fg",
  approved_pending_entry: "border-success-border bg-success-bg text-success-fg",
  approved_entered: "border-success-border bg-success-bg text-success-fg",
  approved_acknowledged: "border-success-border bg-success-bg text-success-fg",
  canceled: "border-line bg-surface-subtle text-ink-muted",
};

/** One chip per part of the case, so a finished part never reads as a finished case. */
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
      <ul className="flex flex-wrap gap-2">
        {parts.map((p) => {
          const Icon = ICON[p.state];
          const href = `/grossing?part=${encodeURIComponent(p.ref)}`;
          const current = p.partId === currentPartId;
          const extra = p.state === "on_hold" && p.holdIds.length ? ` (${p.holdIds.join(", ")})` : p.state === "approved_pending_entry" ? " · source entry pending" : p.state === "approved_entered" ? " · entered (staff attested)" : p.state === "approved_acknowledged" ? " · source acknowledged (simulated)" : "";
          return (
            <li key={p.partId}>
              <Link
                href={href}
                onClick={onNavigate?.(href)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-sm border px-2 py-1 text-sm",
                  TONE[p.state],
                  current ? "ring-2 ring-brand ring-offset-1" : "hover:underline",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="font-semibold">Part {p.designation}:</span>
                <span>
                  {LABEL[p.state]}
                  {extra}
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
