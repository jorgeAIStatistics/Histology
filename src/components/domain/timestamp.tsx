import { fmtAge, fmtFull, fmtSmart } from "@/lib/time";
import { cn } from "@/lib/cn";

/**
 * Timestamp (spec §10 Times): "10:40 AM ET (12 min ago)" for today, with the
 * full date in the tooltip and a machine-readable <time datetime> in UTC.
 * Pass the DEMO now (server: readClock(db).now; client: useDemoNow()).
 */
export function Timestamp({
  iso,
  now,
  showAge = false,
  className,
  unknownText = "Unknown",
}: {
  iso: string | null | undefined;
  now: string;
  /** Append "(12 min ago)". */
  showAge?: boolean;
  className?: string;
  unknownText?: string;
}) {
  if (!iso) return <span className={cn("text-ink-muted", className)}>{unknownText}</span>;
  const age = fmtAge(iso, now);
  return (
    <time dateTime={iso} title={`${fmtFull(iso)} · UTC ${iso}`} className={cn("num-tabular whitespace-nowrap", className)}>
      {fmtSmart(iso, now)} ET
      {showAge ? <span className="text-ink-muted"> ({age === "just now" ? "just now" : `${age} ago`})</span> : null}
    </time>
  );
}
