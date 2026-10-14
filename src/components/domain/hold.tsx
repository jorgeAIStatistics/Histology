import Link from "next/link";
import type { ReactNode } from "react";
import { CirclePause } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtFull, fmtSmart } from "@/lib/time";

/**
 * Hold (spec §7): hold tint, 4px hold stripe, pause icon. The scope is always
 * named. A hold banner cannot be dismissed; it is released only by resolving
 * the linked clarification.
 */
export interface HoldBannerProps {
  /** Scope in words, e.g. "Part B". */
  scope: string;
  /** Short reason for the title, e.g. "laterality mismatch". */
  reason: string;
  /** What else can continue, e.g. "Part A can continue." */
  otherScopeNote?: string;
  /** Evidence (order vs bottle values...). */
  evidence?: ReactNode;
  clarification?: { displayId: string; href?: string; state?: ReactNode };
  /** Current owner (person responsible for the next step). */
  owner?: string | null;
  /** Next follow-up time (ISO). */
  nextFollowUpAt?: string | null;
  /** Demo now (ISO) for time formatting. */
  now?: string;
  headingLevel?: 2 | 3 | 4;
  className?: string;
  children?: ReactNode;
}

export function HoldBanner({
  scope,
  reason,
  otherScopeNote,
  evidence,
  clarification,
  owner,
  nextFollowUpAt,
  now,
  headingLevel = 3,
  className,
  children,
}: HoldBannerProps) {
  const H = `h${headingLevel}` as const;
  const followUp = nextFollowUpAt ? (now ? `${fmtSmart(nextFollowUpAt, now)} ET` : fmtFull(nextFollowUpAt)) : null;
  return (
    <section
      role="status"
      className={cn("hlo-banner hlo-hold-stripe flex items-start gap-3 rounded-md border border-l-4 border-hold-border border-l-hold-solid bg-hold-bg px-3 py-2.5", className)}
    >
      <CirclePause className="mt-0.5 size-4 shrink-0 text-hold-solid" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <H className="font-semibold text-hold-fg">
          {scope} on hold: {reason}
        </H>
        <p className="mt-0.5 text-ink">
          Hold applies to {scope} only.{otherScopeNote ? ` ${otherScopeNote}` : ""}
        </p>
        {evidence ? <div className="mt-1 text-ink">{evidence}</div> : null}
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-ink-secondary">
          {clarification ? (
            <div className="flex gap-1">
              <dt>Clarification:</dt>
              <dd>
                {clarification.href ? (
                  <Link href={clarification.href} className="id-mono font-medium text-brand underline-offset-2 hover:underline">
                    {clarification.displayId}
                  </Link>
                ) : (
                  <span className="id-mono font-medium text-ink">{clarification.displayId}</span>
                )}
                {clarification.state ? <span className="ml-1">{clarification.state}</span> : null}
              </dd>
            </div>
          ) : null}
          <div className="flex gap-1">
            <dt>Owner:</dt>
            <dd className="text-ink">{owner ?? "Unknown"}</dd>
          </div>
          {followUp ? (
            <div className="flex gap-1">
              <dt>Next follow-up:</dt>
              <dd className="text-ink">
                <time dateTime={nextFollowUpAt!}>{followUp}</time>
              </dd>
            </div>
          ) : null}
        </dl>
        {children}
      </div>
    </section>
  );
}

/** Pill for tables and the identity bar: "Hold: Part B" in hold colors with a pause icon. */
export function HoldPill({ scope, className }: { scope?: string; className?: string }) {
  return (
    <span
      className={cn(
        "hlo-pill inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-pill border border-hold-border bg-hold-bg px-2 text-xs font-medium text-hold-fg",
        className,
      )}
    >
      <CirclePause className="size-3.5 shrink-0 text-hold-solid" aria-hidden />
      {scope ? `Hold: ${scope}` : "Hold"}
    </span>
  );
}

/** Solid "HOLD" tag (white on hold solid), for the printed snapshot and dense rows. */
export function HoldTag({ className }: { className?: string }) {
  return (
    <span className={cn("hlo-pill inline-flex h-5 shrink-0 items-center gap-1 rounded-sm bg-hold-solid px-1.5 text-xs font-semibold text-white", className)}>
      <CirclePause className="size-3 shrink-0" aria-hidden />
      HOLD
    </span>
  );
}
