import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Card / Panel: white working surface with a hairline border. Borders come
 * first; the shadow only separates layers. Use `title` for a panel header
 * (h2 by default) and `actions` for header buttons.
 */
export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** Heading level for the title. */
  headingLevel?: 2 | 3 | 4;
  /** Remove body padding (tables that run edge to edge). */
  flush?: boolean;
  as?: ElementType;
  /** sheet: white working surface with a hairline (default); quiet: tinted, borderless secondary details; raised: floats above content. */
  variant?: "sheet" | "quiet" | "raised";
  className?: string;
  bodyClassName?: string;
  id?: string;
  "aria-label"?: string;
}

export function Card({
  title,
  description,
  actions,
  footer,
  children,
  headingLevel = 2,
  flush,
  as: Tag = "section",
  variant = "sheet",
  className,
  bodyClassName,
  id,
  ...rest
}: CardProps) {
  const H = `h${headingLevel}` as const;
  const headingId = id ? `${id}-title` : undefined;
  return (
    <Tag
      id={id}
      aria-labelledby={title && headingId ? headingId : undefined}
      aria-label={rest["aria-label"]}
      className={cn(
        "rounded-lg",
        variant === "sheet" ? "border border-line bg-surface" : variant === "quiet" ? "bg-surface-subtle" : "border border-line bg-surface shadow-2",
        className,
      )}
    >
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title ? (
              <H id={headingId} className="text-md font-bold tracking-[-0.01em] text-ink">
                {title}
              </H>
            ) : null}
            {description ? <p className="mt-0.5 text-sm text-ink-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(!flush && "p-4", bodyClassName)}>{children}</div>
      {footer ? <footer className="border-t border-line px-4 py-2.5">{footer}</footer> : null}
    </Tag>
  );
}

/** Alias: a Panel is a Card used as a page region. */
export const Panel = Card;

/** Definition list for label/value facts inside cards and side panels. */
export function FactList({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm", className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-ink-muted">{it.label}</dt>
          <dd className="min-w-0 text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
