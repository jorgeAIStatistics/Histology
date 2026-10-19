import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TONE_CLASSES, TONE_ICON, type Tone } from "./tone";

/**
 * Status pill (spec §7): rounded pill, 14px icon plus the status name in
 * sentence case. One status pill per table row; other facts go in their own
 * columns as plain text. The icon is aria-hidden; the text is the name.
 */
export interface StatusPillProps {
  tone?: Tone;
  children: ReactNode;
  /** Override the tone's default icon. */
  icon?: LucideIcon;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}

export function StatusPill({ tone = "neutral", children, icon, size = "md", className, title }: StatusPillProps) {
  const Icon = icon ?? TONE_ICON[tone];
  const c = TONE_CLASSES[tone];
  return (
    <span
      title={title}
      className={cn(
        "hlo-pill inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-pill border font-medium",
        size === "md" ? "h-6 px-2 text-xs" : "h-5 px-1.5 text-xs",
        c.bg,
        c.fg,
        c.border,
        className,
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", c.solidText)} aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* State vocabulary for pills (spec §7, same wording everywhere).     */
/* Severity ladder (docs/redesign/visual-system.md): red is reserved   */
/* for patient identity; failures and missing material are amber.      */
/* ------------------------------------------------------------------ */

type PillDef = { label: string; tone: Tone };

export const PILL_STATES = {
  clarification: {
    drafted: { label: "Drafted", tone: "neutral" },
    sent: { label: "Sent", tone: "info" },
    delivery_unknown: { label: "Delivery unknown", tone: "warning" },
    delivery_failed: { label: "Delivery failed", tone: "warning" },
    delivered: { label: "Delivered", tone: "info" },
    acknowledged: { label: "Acknowledged", tone: "info" },
    answered: { label: "Answered", tone: "info" },
    reviewed: { label: "Reviewed", tone: "info" },
    resolved: { label: "Resolved", tone: "success" },
    canceled: { label: "Canceled", tone: "neutral" },
  },
  gross: {
    draft: { label: "Draft", tone: "neutral" },
    needs_clarification: { label: "Needs clarification", tone: "warning" },
    operator_reviewed: { label: "Operator reviewed", tone: "info" },
    approved_for_downstream: { label: "Approved for downstream use", tone: "success" },
    superseded: { label: "Superseded", tone: "neutral" },
  },
  sourceUpdate: {
    not_started: { label: "Not entered in source", tone: "neutral" },
    pending_entry: { label: "Source update pending", tone: "warning" },
    entered_attested: { label: "Source update pending", tone: "warning" },
    source_acknowledged: { label: "Source update acknowledged", tone: "success" },
    failed: { label: "Source update failed", tone: "warning" },
  },
  print: {
    planned: { label: "Planned", tone: "neutral" },
    queued: { label: "Queued", tone: "neutral" },
    submitted: { label: "Submitted", tone: "info" },
    acknowledged: { label: "Acknowledged", tone: "info" },
    completion_confirmed: { label: "Completion confirmed", tone: "success" },
    failed: { label: "Failed", tone: "warning" },
    unknown_outcome: { label: "Unknown outcome", tone: "warning" },
    canceled: { label: "Canceled", tone: "neutral" },
  },
  traySlide: {
    expected: { label: "Expected", tone: "neutral" },
    scanned_match: { label: "Scanned, matches", tone: "success" },
    missing: { label: "Missing", tone: "warning" },
    unexpected: { label: "Unexpected", tone: "warning" },
    duplicate: { label: "Duplicate", tone: "warning" },
    canceled: { label: "Canceled", tone: "neutral" },
  },
  tray: {
    open: { label: "Open", tone: "neutral" },
    assembling: { label: "Assembling", tone: "info" },
    exception: { label: "Exception", tone: "warning" },
    verified_complete: { label: "Complete", tone: "success" },
    released_with_exceptions: { label: "Released with exceptions", tone: "warning" },
    delivered: { label: "Delivered", tone: "success" },
  },
  routing: {
    suggested: { label: "Rule applied", tone: "neutral" },
    confirmed: { label: "Rule applied", tone: "neutral" },
    exception: { label: "Routing exception", tone: "warning" },
    overridden: { label: "Overridden", tone: "info" },
    superseded: { label: "Superseded", tone: "neutral" },
  },
  intake: {
    received: { label: "Received", tone: "neutral" },
    in_review: { label: "In review", tone: "info" },
    ready_for_accession: { label: "Ready to request accession", tone: "info" },
    accession_requested: { label: "Accession requested", tone: "info" },
    accessioned: { label: "Accessioned", tone: "success" },
    canceled: { label: "Canceled", tone: "neutral" },
  },
  retrieval: {
    open: { label: "Open", tone: "neutral" },
    picking: { label: "Picking", tone: "info" },
    partially_retrieved: { label: "Partially retrieved", tone: "warning" },
    retrieved: { label: "Retrieved", tone: "success" },
    delivered: { label: "Delivered", tone: "success" },
    canceled: { label: "Canceled", tone: "neutral" },
  },
  sync: {
    synced: { label: "Synced", tone: "success" },
    delayed: { label: "Delayed", tone: "warning" },
    offline: { label: "Offline", tone: "warning" },
    unknown: { label: "Unknown", tone: "neutral" },
  },
} as const satisfies Record<string, Record<string, PillDef>>;

export type PillDomain = keyof typeof PILL_STATES;

/**
 * `<StatePill domain="clarification" state="delivery_unknown" />` renders the
 * spec's wording and tone. Unknown states render as a neutral pill with the raw state.
 */
export function StatePill({
  domain,
  state,
  size,
  className,
  suffix,
}: {
  domain: PillDomain;
  state: string;
  size?: "sm" | "md";
  className?: string;
  /** Extra text after the label, e.g. a rule version: "Rule applied (v3)". */
  suffix?: string;
}) {
  const def = (PILL_STATES[domain] as Record<string, PillDef>)[state] ?? {
    label: state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    tone: "neutral" as Tone,
  };
  return (
    <StatusPill tone={def.tone} size={size} className={className}>
      {def.label}
      {suffix ? ` ${suffix}` : ""}
    </StatusPill>
  );
}

export function pillTone(domain: PillDomain, state: string): Tone {
  return ((PILL_STATES[domain] as Record<string, PillDef>)[state]?.tone ?? "neutral") as Tone;
}
