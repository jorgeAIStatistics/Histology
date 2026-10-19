import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Empty state (spec §6.0): what this is, why it is empty, how to start.
 * Never just "No data".
 */
export function EmptyState({
  title,
  children,
  action,
  icon: Icon = Inbox,
  className,
  compact,
}: {
  title: ReactNode;
  /** Why it is empty and how to start. */
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
  /** Smaller variant for table bodies and side panels. */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-md border border-line bg-surface text-center",
        compact ? "gap-1 px-4 py-6" : "gap-2 px-6 py-12",
        className,
      )}
    >
      <Icon className={cn("text-ink-muted", compact ? "size-5" : "size-6")} aria-hidden />
      <p className={cn("font-semibold text-ink", compact ? "text-sm" : "text-md")}>{title}</p>
      {children ? <div className="max-w-prose text-sm text-ink-secondary">{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
