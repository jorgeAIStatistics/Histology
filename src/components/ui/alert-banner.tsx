import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TONE_CLASSES, TONE_ICON, type AlertTone } from "./tone";

/**
 * Alert banner (spec §7): full width, tone border and tint (no side stripe), icon, title, body and
 * an optional action. Warning and danger banners are never auto-dismissed.
 * role="status" for info/success/warning; role="alert" only for a danger
 * banner that blocks the current action (`blocking`).
 */
export interface AlertBannerProps {
  tone: AlertTone;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons or links shown at the right (or below on narrow screens). */
  action?: ReactNode;
  /** Danger banners that block the current action are announced as alerts. */
  blocking?: boolean;
  icon?: LucideIcon;
  /** Heading level for the title (default: a <p>). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
  id?: string;
}

export function AlertBanner({ tone, title, children, action, blocking, icon, headingLevel, className, id }: AlertBannerProps) {
  const Icon = icon ?? TONE_ICON[tone];
  const c = TONE_CLASSES[tone];
  const role = tone === "danger" && blocking ? "alert" : "status";
  const TitleTag = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div
      id={id}
      role={role}
      className={cn("hlo-banner flex items-start gap-3 rounded-md border px-3 py-2.5", c.bg, c.border, className)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", c.solidText)} aria-hidden />
      <div className="min-w-0 flex-1">
        <TitleTag className={cn("text-sm font-semibold", c.fg)}>{title}</TitleTag>
        {children ? <div className="mt-0.5 text-sm text-ink">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">{action}</div> : null}
    </div>
  );
}
