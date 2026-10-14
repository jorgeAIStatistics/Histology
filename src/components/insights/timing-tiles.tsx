import { StatTile } from "@/components/ui/stat-tile";
import type { DurationSummary } from "@/server/queries/insights";
import { fmtMinutes } from "@/server/queries/insights";

/**
 * Median + 90th percentile tile pair for one data set (design-spec §6.8):
 * n, still-open and missing-event counts are always shown beside the medians,
 * never folded into them.
 */
export function TimingTiles({
  label,
  summary,
  illustrative,
  href,
}: {
  label: string;
  summary: DurationSummary;
  /** Tag text, e.g. "Illustrative: synthetic prior-day data" or "Today: synthetic demo data". */
  illustrative: string;
  href?: string;
}) {
  const none = summary.n === 0;
  const oldest =
    summary.stillOpen > 0
      ? summary.stillOpenOldestMin !== null
        ? `oldest open ${fmtMinutes(summary.stillOpenOldestMin)}${summary.stillOpenAgeUnknown ? `; ${summary.stillOpenAgeUnknown} with unknown age` : ""}`
        : "age of open items unknown"
      : null;
  // Pilot-proposal §6.1: missing events are reported as a number AND a percent, never as zero minutes.
  const missingLine = `Missing event data: ${summary.missing}${summary.missingPct === null ? "" : ` (${summary.missingPct}% of ${summary.total})`}, not timed`;
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatTile
        label={`${label}: median`}
        value={none ? null : fmtMinutes(summary.medianMin)}
        unknownReason="no completed observations"
        n={summary.n}
        stillOpen={summary.stillOpen}
        caption={
          <>
            {oldest ? <span className="block">{oldest}</span> : null}
            <span className="block">{missingLine}</span>
          </>
        }
        illustrative={illustrative}
        href={href}
      />
      <StatTile
        label={`${label}: 90th percentile`}
        value={summary.p90Min === null ? null : fmtMinutes(summary.p90Min)}
        unknownReason={summary.p90Note ? summary.p90Note.charAt(0).toLowerCase() + summary.p90Note.slice(1) : "not available"}
        n={summary.n}
        caption={
          !summary.n
            ? null
            : summary.minMin === summary.maxMin
              ? summary.n === 1
                ? `one observation: ${fmtMinutes(summary.minMin)}`
                : `all ${summary.n} at ${fmtMinutes(summary.minMin)}`
              : `range ${fmtMinutes(summary.minMin)} to ${fmtMinutes(summary.maxMin)}`
        }
        illustrative={illustrative}
        href={href}
      />
    </div>
  );
}
