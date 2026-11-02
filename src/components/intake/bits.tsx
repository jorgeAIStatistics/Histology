"use client";

import type { ReactNode } from "react";
import { useScan } from "@/lib/client/scan";
import { cn } from "@/lib/cn";
import type { Seg } from "./plan";

/** Text segments from the plan; identifiers set in the identifier mono and never broken across lines. */
export function Segs({ value, idClassName }: { value: Seg[]; idClassName?: string }) {
  return (
    <>
      {value.map((x, i) =>
        typeof x === "string" ? (
          <span key={i}>{x}</span>
        ) : (
          <span key={i} className={cn("id-mono whitespace-nowrap", idClassName)}>
            {x.id}
          </span>
        ),
      )}
    </>
  );
}

/**
 * One part of the item's record (routing, holds, owner and note, source order,
 * history): a heading and its content inside the record sheet, separated by a
 * hairline. Never a card inside a card.
 */
export function RecordSection({
  id,
  title,
  description,
  actions,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} tabIndex={-1} className={cn("scroll-mt-3 border-t border-line px-5 py-4 first:border-t-0 focus:outline-none max-xl:px-4", className)}>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 id={headingId} className="text-md font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h3>
          {description ? <p className="mt-0.5 max-w-[72ch] text-sm text-ink-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The next step split into its parts, so the decision column can pin the
 * step heading and the primary action and scroll only the body between them.
 * A control hands its parts to the frame it is given; outside the column
 * (e.g. "Also yours now", "Change decision") the parts simply stack.
 */
export interface StepParts {
  body?: ReactNode;
  action?: ReactNode;
}
export type StepFrame = (parts: StepParts) => ReactNode;

export const stackFrame: StepFrame = ({ body, action }) => (
  <div className="space-y-2">
    {body}
    {action}
  </div>
);

/** After an action, the hands go back to the scanner: return focus to the scan field. */
export function useBackToScan(): () => void {
  const scan = useScan();
  return () => window.setTimeout(() => scan.focus(), 0);
}
