import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IllustrativeTag, ReadOnlyTag, SimulatedLabel } from "@/components/domain/honesty";

/**
 * Page header: h1 title (sentence case), optional description, tags and
 * actions. Use `simulated` only when the whole page shows a simulated
 * connector's data; `illustrative` for computed demo numbers.
 */
export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Connector name for a "Simulated: <connector>" tag, or true for plain "Simulated". */
  simulated?: string | boolean;
  /** true for "Illustrative: synthetic prior-day data", or custom text. */
  illustrative?: string | boolean;
  /** Shows the "Read only" tag (director roles). */
  readOnly?: boolean;
  /** Extra inline meta after the title, e.g. "Refreshing..." or a count line. */
  meta?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, simulated, illustrative, readOnly, meta, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-2", className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          {simulated ? <SimulatedLabel connector={typeof simulated === "string" ? simulated : undefined} /> : null}
          {illustrative ? <IllustrativeTag>{typeof illustrative === "string" ? illustrative : undefined}</IllustrativeTag> : null}
          {readOnly ? <ReadOnlyTag /> : null}
          {meta ? <span className="text-sm text-ink-muted">{meta}</span> : null}
        </div>
        {description ? <p className="mt-0.5 max-w-[80ch] text-sm text-ink-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Standard page body padding and vertical rhythm (24px between regions). */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-4 px-6 py-4 max-xl:px-4", className)}>{children}</div>;
}
