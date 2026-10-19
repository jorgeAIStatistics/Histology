import Link from "next/link";
import { cn } from "@/lib/cn";
import { Table, THead, TBody, TH, TR, TD } from "@/components/ui/table";
import { CircleQuestionMark } from "lucide-react";
import { IllustrativeTag } from "@/components/domain/honesty";
import type { DurationSummary } from "@/server/queries/insights";
import { fmtMinutes } from "@/server/queries/insights";

export interface TimingRow {
  /** "Prior days" or "Today so far". */
  label: string;
  /** Honesty tag, e.g. "Illustrative: synthetic prior-day data" or "Today: synthetic demo data". */
  tag: string;
  summary: DurationSummary;
  /** The records behind the row, e.g. { href: "/clarifications", label: "Open Clarifications" }. */
  records?: { href: string; label: string };
}

/**
 * Median and 90th percentile for each data set, aligned in one table so the
 * illustrative prior days and today's demo records can be compared row
 * against row (design-spec §6.8). n, still-open and missing-event counts sit
 * beside the medians in their own column, never folded into them; every row
 * carries its own honesty tag. Replaces a grid of equal stat tiles.
 */
export function TimingTable({ caption, rows, className }: { caption: string; rows: TimingRow[]; className?: string }) {
  return (
    <Table caption={caption} wrapperClassName={cn("rounded-none border-x-0", className)}>
      <THead>
        <TR>
          <TH className="w-[30%]">Data set</TH>
          <TH align="right" className="w-[14%]">
            Median
          </TH>
          <TH align="right" className="w-[18%]">
            90th percentile
          </TH>
          <TH className="pl-6">Observations</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TimingTableRow key={r.label} row={r} />
        ))}
      </TBody>
    </Table>
  );
}

function TimingTableRow({ row }: { row: TimingRow }) {
  const s = row.summary;
  const none = s.n === 0;
  const oldest =
    s.stillOpen > 0
      ? s.stillOpenOldestMin !== null
        ? `oldest open ${fmtMinutes(s.stillOpenOldestMin)}${s.stillOpenAgeUnknown ? `; ${s.stillOpenAgeUnknown} with unknown age` : ""}`
        : "age of open items unknown"
      : null;
  // Pilot-proposal §6.1: missing events are reported as a number AND a percent, never as zero minutes.
  const missing = `${s.missing}${s.missingPct === null ? "" : ` (${s.missingPct}% of ${s.total})`}, not timed`;
  const range = !s.n
    ? null
    : s.minMin === s.maxMin
      ? s.n === 1
        ? `One observation: ${fmtMinutes(s.minMin)}`
        : `All ${s.n} at ${fmtMinutes(s.minMin)}`
      : `Range ${fmtMinutes(s.minMin)} to ${fmtMinutes(s.maxMin)}`;
  const p90Reason = s.p90Note ?? "Not available";
  return (
    <TR>
      <th scope="row" className="border-b border-line px-3 py-2.5 text-left align-top font-normal group-last/row:border-b-0">
        <span className="block text-sm font-semibold text-ink">{row.label}</span>
        <IllustrativeTag className="mt-1 max-w-full whitespace-normal">{row.tag}</IllustrativeTag>
        {row.records ? (
          <Link href={row.records.href} className="mt-1 flex min-h-[var(--hlo-target-min)] w-fit items-center text-sm text-brand underline-offset-2 hover:underline">
            {row.records.label}
          </Link>
        ) : null}
      </th>
      <TD numeric className="py-2.5 align-top">
        {none ? <UnknownCell reason="No completed observations" /> : <span className="text-md font-semibold text-ink">{fmtMinutes(s.medianMin)}</span>}
      </TD>
      <TD numeric wrap className="py-2.5 align-top">
        {s.p90Min === null ? (
          <UnknownCell reason={p90Reason} />
        ) : (
          <span className="text-md font-semibold text-ink">{fmtMinutes(s.p90Min)}</span>
        )}
      </TD>
      <TD wrap className="min-w-[13rem] py-2.5 pl-6 align-top">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-ink-muted">Completed</dt>
          <dd className="text-ink">n = {s.n}</dd>
          <dt className="text-ink-muted">Still open</dt>
          <dd className="text-ink">
            {s.stillOpen}
            {oldest ? <span className="text-ink-secondary">, {oldest}</span> : null}
          </dd>
          <dt className="text-ink-muted">Missing event data</dt>
          <dd className="text-ink">{missing}</dd>
          {range ? (
            <>
              <dt className="text-ink-muted">Spread</dt>
              <dd className="text-ink">{range}</dd>
            </>
          ) : null}
        </dl>
      </TD>
    </TR>
  );
}

/** "Unknown" in a number column: the word where the number would be, the reason under it. Never 0, blank or a dash. */
function UnknownCell({ reason }: { reason: string }) {
  return (
    <>
      <span className="inline-flex items-center gap-1 text-md font-semibold text-ink-muted">
        <CircleQuestionMark className="size-4 shrink-0" aria-hidden />
        Unknown
      </span>
      <span className="sr-only">, </span>
      <span className="block text-sm text-ink-muted">{reason}</span>
    </>
  );
}
