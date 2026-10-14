import { Clock } from "lucide-react";
import type { ReactNode } from "react";
import { fmtAge, fmtSmart } from "@/lib/time";
import { AlertBanner } from "@/components/ui/alert-banner";

/**
 * Stale-data banner (spec §6.0 Source offline, §7): warning tone, clock icon.
 * "EMA-SIM Sunrise Coast unreachable since 10:41 ET (11 min). Showing last
 * confirmed data." role="status" — announced once, not on every tick.
 */
export function StaleBanner({
  sourceName,
  since,
  now,
  detail,
  action,
  className,
}: {
  /** Tenant/source name, e.g. "EMA-SIM Sunrise Coast". */
  sourceName: string;
  /** Last successful contact (ISO). Null = unknown. */
  since: string | null;
  /** Demo now (ISO). */
  now: string;
  /** What is not shown / what still works, e.g. "New orders and changes since 10:41 are not shown." */
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const title = since
    ? `${sourceName} unreachable since ${fmtSmart(since, now)} ET (${fmtAge(since, now)}). Showing last confirmed data.`
    : `${sourceName} unreachable. Last successful sync unknown. Showing last confirmed data.`;
  return (
    <AlertBanner tone="warning" icon={Clock} title={title} action={action} className={className}>
      {detail}
    </AlertBanner>
  );
}
