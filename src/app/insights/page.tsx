import Link from "next/link";
import type { ReactNode } from "react";
import { getDb } from "@/server/db/db";
import { DEFINITIONS, P90_THRESHOLD_NOTE, fmtMinutes, getInsights, type DurationSummary, type InsightsData } from "@/server/queries/insights";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageBody } from "@/components/ui/page-header";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { IdText } from "@/components/domain/id-text";
import { IllustrativeTag } from "@/components/domain/honesty";
import { ChartCard } from "@/components/insights/chart-card";
import { ArrivalsChart, ColumnChart, DoctorChart, WorkAgeChart } from "@/components/insights/charts";
import { DefinitionDisclosure } from "@/components/insights/definition";
import { InsightsFilters, fmtDay } from "@/components/insights/filters";
import { TimingTable, type TimingRow } from "@/components/insights/timing-table";
import { ScenarioCalculator } from "@/components/insights/scenario-calculator";
import { fmtTime } from "@/lib/time";
import type { PathologistColor } from "@/lib/domain";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights" };

const PRIOR_TAG = "Illustrative: synthetic prior-day data";
const TODAY_TAG = "Today: synthetic demo data";

/** In-page index: the page is long, and a presenter jumps to one measure at a time. */
const MEASURES = [
  { id: "arrivals", label: "Arrivals by hour" },
  { id: "clarifications", label: "Clarification times" },
  { id: "gross-entry", label: "Approval to source entry" },
  { id: "entry-hours", label: "Entry time of day" },
  { id: "work-age", label: "Unresolved work age" },
  { id: "by-doctor", label: "Cases by dermatopathologist" },
  { id: "scenario-calculator", label: "Scenario calculator" },
] as const;

type SP = Promise<{ from?: string; to?: string; office?: string; doctor?: string }>;

export default async function InsightsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  let data: InsightsData;
  try {
    data = getInsights(getDb(), { from: sp.from, to: sp.to, office: sp.office || null, doctor: sp.doctor || null });
  } catch (e) {
    console.error("[insights] failed", e);
    return (
      <PageBody>
        <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Insights</h1>
        <AlertBanner tone="warning" title="Could not compute the insight measures">
          The local demo database could not be read. Nothing was changed. Reload the page; if it keeps failing, reset the demo data in Settings.
        </AlertBanner>
      </PageBody>
    );
  }

  const asOfLabel = `${fmtTime(data.asOf)} ET`;
  const range = data.priorDays.length ? `${fmtDay(data.priorDays[0])} to ${fmtDay(data.priorDays[data.priorDays.length - 1])}` : "no days";
  const nDays = data.priorDays.length;
  const todayArrivals = data.arrivals.bins.filter((b) => b.today > 0);

  return (
    <PageBody>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Insights</h1>
          <IllustrativeTag>Synthetic data only</IllustrativeTag>
        </div>
        {/* The page's one focal line (lg): the honesty statement, before any number. */}
        <p className="max-w-[60ch] text-lg font-semibold tracking-[-0.01em] text-ink">Nothing on this page is observed lab performance.</p>
        <p className="-mt-1 max-w-[95ch] text-md text-ink-secondary">How a pilot would measure the bench, with every definition visible.</p>
        <div role="note" aria-label="How to read these numbers" className="flex max-w-[110ch] flex-col gap-1 text-sm text-ink-secondary">
          <p>
            Charts tagged “{PRIOR_TAG}” use generated events for {nDays} prior working days ({range}). Figures tagged “{TODAY_TAG}” come from this demo session’s
            synthetic records at demo clock {asOfLabel}. The two are never mixed. No savings, scores or rankings are shown; the scenario calculator at the bottom starts blank.
          </p>
          <p>
            Median and 90th percentile use the nearest-rank method; still-open items and missing event data are always shown separately. {P90_THRESHOLD_NOTE}
          </p>
        </div>
        <nav aria-label="Measures on this page">
          <ul className="flex flex-wrap gap-x-1 gap-y-0.5 text-sm">
            {MEASURES.map((m) => (
              <li key={m.id}>
                <a
                  href={`#${m.id}`}
                  className="inline-flex min-h-[max(2rem,var(--hlo-target-min))] items-center rounded-sm px-2 text-brand underline-offset-2 hover:bg-brand-50 hover:underline"
                >
                  {m.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <InsightsFilters days={data.options.days} offices={data.options.offices} doctors={data.options.doctors} value={data.filters} />

      {nDays === 0 ? (
        <EmptyState title="No illustrative prior-day events in this database">
          The seed generates example events for prior days. Reset the demo data in Settings to regenerate them. Today’s figures below still work.
        </EmptyState>
      ) : null}

      <div className="grid grid-cols-1 gap-5">
        <ChartCard
          id="arrivals"
          title="Arrivals by hour"
          subtitle={`Mean arrivals per day, by clock hour (ET), over ${nDays} illustrative day${nDays === 1 ? "" : "s"}. Courier times shape the peaks.`}
          chart={<ArrivalsChart bins={data.arrivals.bins} days={Math.max(1, nDays)} />}
          table={{
            caption: "Arrivals by hour: illustrative prior-day mean and today's count",
            columns: [
              { key: "hour", label: "Hour (ET)" },
              { key: "mean", label: "Mean per day (illustrative)", numeric: true },
              { key: "total", label: `Total over ${nDays} days (illustrative)`, numeric: true },
              { key: "today", label: "Today so far (demo data)", numeric: true },
            ],
            rows: [
              ...data.arrivals.bins.map((b) => ({ hour: b.label, mean: b.priorMean, total: b.priorTotal, today: b.today })),
              {
                hour: "Arrival time not recorded (not plotted)",
                mean: "Not applicable",
                total: data.arrivals.priorUnknownTime,
                today: data.arrivals.todayUnknownTime,
              },
            ],
          }}
          aside={
            <TodayFigures note="Intake items received on the demo day.">
              {todayArrivals.length ? (
                <ul className="divide-y divide-line text-sm">
                  {todayArrivals.map((b) => (
                    <li key={b.hour} className="flex items-baseline justify-between gap-2 py-1.5">
                      <span className="text-ink-secondary">{b.label} hour</span>
                      <span className="num-tabular font-semibold text-ink">{b.today}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">No arrivals recorded today yet.</p>
              )}
              <p className="mt-2 text-sm text-ink-muted">
                Total today: {data.arrivals.todayArrivals}
                {data.arrivals.todayUnknownTime ? `; ${data.arrivals.todayUnknownTime} with unknown arrival time` : ""}. The 11:00 courier appears after it is received
                (guided demo step 1).
              </p>
            </TodayFigures>
          }
          definition={<DefinitionDisclosure def={DEFINITIONS.arrivals} />}
        />

        <Card
          id="clarifications"
          title="Clarification acknowledgement and resolution time"
          description="Median and 90th percentile with n, the illustrative prior days set against today. Still-open items and missing event data are counted beside the medians, never inside them."
          flush
          footer={
            <>
              <DefinitionDisclosure def={DEFINITIONS.clarAck} />
              <DefinitionDisclosure def={DEFINITIONS.clarResolve} />
            </>
          }
        >
          <TimingSection
            heading="Acknowledgement: sent to first office acknowledgement or reply"
            rows={timingRows(data.clarAck.prior, data.clarAck.today, { href: "/clarifications", label: "Open Clarifications" })}
            note={excludedNote([
              [data.clarAck.todayNotSent, "drafted but not sent yet: not in the denominator"],
              [data.clarAck.todayCanceledBeforeSend, "canceled before sending: excluded"],
              [data.clarAck.todayCanceledUnacknowledged, "canceled after sending, never acknowledged: no end event, not timed"],
            ])}
          />
          <TimingSection
            heading="Resolution: sent to reviewed resolution (an answer is not a resolution)"
            rows={timingRows(data.clarResolve.prior, data.clarResolve.today, { href: "/clarifications", label: "Open Clarifications" })}
            note={excludedNote([[data.clarResolve.todayCanceledAfterSend, "canceled after sending: never resolved, excluded"]])}
          />
          <p className="max-w-[100ch] px-4 py-3 text-sm text-ink-secondary">
            Office results are for collaboration, not blame. Faster responses need an agreement with the offices about ownership and escalation; more notifications alone may
            only add noise.
          </p>
        </Card>

        <ChartCard
          id="gross-entry"
          title="Gross approval to source-system entry delay"
          subtitle="How long approved gross records wait before the description is entered in the source system."
          chart={
            <ColumnChart
              data={data.grossEntry.histogram.map((h) => ({ label: h.label, count: h.count }))}
              label={`Histogram of delays from approval to source entry, n = ${data.grossEntry.prior.n}`}
              valueLabel="parts"
            />
          }
          table={{
            caption: "Delay from gross approval to source entry, illustrative prior days",
            columns: [
              { key: "bucket", label: "Delay" },
              { key: "count", label: "Parts (illustrative)", numeric: true },
            ],
            rows: [
              ...data.grossEntry.histogram.map((h) => ({ bucket: h.label, count: h.count })),
              { bucket: "Still waiting for entry (not timed)", count: data.grossEntry.prior.stillOpen },
              { bucket: "Missing or invalid event data (not timed)", count: data.grossEntry.prior.missing },
            ],
          }}
          below={
            <section aria-labelledby="gross-entry-compare">
              <h3 id="gross-entry-compare" className="mb-2 text-sm font-semibold text-ink">
                Delay, prior days against today
              </h3>
              <TimingTable
                caption="Delay from gross approval to source entry: median and 90th percentile, prior days and today"
                rows={timingRows(data.grossEntry.prior, data.grossEntry.today, { href: "/worklist", label: "Open the Worklist" })}
              />
            </section>
          }
          footnote={
            <>
              In the illustrative events, <strong>{data.grossEntry.eveningEntries}</strong> of <strong>{data.grossEntry.priorEntries}</strong> source entries were made at
              or after 18:00 ET. The generator was written to show how this measure would expose the evening batch entry pattern described by the lab; it is not a measurement.
              Today, “entered” means staff attested a manual entry; it is not a source acknowledgement. To find the real constraint, grossing work, transcription,
              verification, batch waiting and integration lag must be measured separately.
            </>
          }
          definition={<DefinitionDisclosure def={DEFINITIONS.grossEntry} />}
        />

        <ChartCard
          id="entry-hours"
          title="Time of day source entries were made"
          subtitle="Count of source-system entries by clock hour (ET). Companion to the delay chart."
          chart={<ColumnChart data={data.grossEntry.entryHours.map((h) => ({ label: h.label, count: h.count }))} label="Source entries by hour of day" valueLabel="entries" titleSuffix=" ET hour" />}
          table={{
            caption: "Source entries by hour of day, illustrative prior days",
            columns: [
              { key: "hour", label: "Hour (ET)" },
              { key: "count", label: "Entries (illustrative)", numeric: true },
            ],
            rows: data.grossEntry.entryHours.map((h) => ({ hour: h.label, count: h.count })),
          }}
          definition={<DefinitionDisclosure def={DEFINITIONS.grossEntry} />}
        />

        <ChartCard
          id="work-age"
          title="Unresolved work age"
          tag={`Synthetic demo data: snapshot at demo clock ${asOfLabel}`}
          subtitle={`${data.workAge.total} open items right now${data.workAge.unreadableTypes ? ` (plus ${data.workAge.unreadableTypes} type${data.workAge.unreadableTypes === 1 ? "" : "s"} that could not be read: Unknown)` : ""}, by type, age and owning role. Each type links to the records behind it. Not a staff ranking.`}
          chart={
            <WorkAgeChart
              rows={data.workAge.rows.flatMap((r) => (r.count === null ? [] : [{ label: r.label, buckets: r.buckets, count: r.count, ageUnknown: r.ageUnknown }]))}
            />
          }
          table={{
            caption: "Open work by type and age, synthetic demo snapshot",
            columns: [
              { key: "type", label: "Type" },
              { key: "owner", label: "Owning role (may close it)" },
              { key: "count", label: "Open", numeric: true },
              { key: "b0", label: "Under 1 h", numeric: true },
              { key: "b1", label: "1 to 4 h", numeric: true },
              { key: "b2", label: "4 to 8 h", numeric: true },
              { key: "b3", label: "Over 8 h", numeric: true },
              { key: "unknown", label: "Age unknown", numeric: true },
              { key: "median", label: "Median age" },
              { key: "p90", label: "90th percentile age" },
              { key: "oldest", label: "Oldest" },
            ],
            rows: data.workAge.rows.map((r) => {
              const typeCell = (
                <Link href={r.link} className="text-brand underline-offset-2 hover:underline">
                  {r.label}
                </Link>
              );
              if (r.count === null) {
                const u = r.readError ?? "Unknown";
                return { type: typeCell, owner: r.ownerRoles, count: u, b0: u, b1: u, b2: u, b3: u, unknown: u, median: u, p90: u, oldest: u };
              }
              return {
                type: typeCell,
                owner: r.ownerRoles,
                count: r.count,
                b0: r.buckets[0],
                b1: r.buckets[1],
                b2: r.buckets[2],
                b3: r.buckets[3],
                unknown: r.ageUnknown,
                median: r.count ? fmtMinutes(r.medianMin) : "None open",
                p90: r.count ? (r.p90Min === null ? r.p90Note ?? "Unknown" : fmtMinutes(r.p90Min)) : "None open",
                oldest: r.oldestRef ? <IdText text={`${r.oldestRef} (${fmtMinutes(r.oldestMin)})`} /> : r.count ? "Unknown" : "None open",
              };
            }),
          }}
          below={
            <ul className="grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3" aria-label="Open work by type, with the records behind each count">
              {data.workAge.rows.map((r) => (
                <li key={r.type} className="border-t border-line py-2 text-sm">
                  <Link href={r.link} className="flex min-h-[max(1.75rem,var(--hlo-target-min))] items-center justify-between gap-2 font-medium text-ink underline-offset-2 hover:text-brand hover:underline">
                    <span>{r.label}</span>
                    <span className="num-tabular font-semibold">{r.count === null ? "Unknown" : r.count}</span>
                  </Link>
                  <p className="text-ink-muted">
                    {r.count === null ? (
                      `${r.readError ?? "Unknown"}. Not counted as zero.`
                    ) : r.count === 0 ? (
                      "None open."
                    ) : (
                      <IdText
                        text={`Median age ${fmtMinutes(r.medianMin)}; oldest ${r.oldestRef ?? "Unknown"}${r.oldestMin !== null ? ` (${fmtMinutes(r.oldestMin)})` : ""}${r.ageUnknown ? `; ${r.ageUnknown} with unknown age` : ""}.`}
                      />
                    )}
                  </p>
                  <p className="text-ink-muted">Owner: {r.ownerRoles}</p>
                </li>
              ))}
            </ul>
          }
          definition={<DefinitionDisclosure def={DEFINITIONS.workAge} />}
        />

        <ChartCard
          id="by-doctor"
          title="Cases by assigned dermatopathologist"
          subtitle={`Mean cases per day over ${nDays} illustrative day${nDays === 1 ? "" : "s"}. Doctor names are written on every bar; color is never the only cue. Workload distribution, not performance.`}
          chart={<DoctorChart rows={data.byDoctor.rows} days={Math.max(1, nDays)} />}
          table={{
            caption: "Cases by assigned dermatopathologist",
            columns: [
              { key: "doctor", label: "Assigned dermatopathologist" },
              { key: "mean", label: "Mean per day (illustrative)", numeric: true },
              { key: "total", label: "Total (illustrative)", numeric: true },
            ],
            rows: data.byDoctor.rows.map((r) => ({ doctor: r.name, mean: r.priorMean, total: r.priorTotal })),
          }}
          aside={
            <TodayFigures title="Accessioned today" note="Every dermatopathologist, whatever the filter.">
              <ul className="divide-y divide-line text-sm">
                {data.byDoctor.todayRows.map((r) => (
                  <li key={r.id ?? "none"} className="flex items-center justify-between gap-2 py-1.5">
                    <DoctorChip name={r.id ? r.name : null} color={(r.color as PathologistColor | null) ?? undefined} compact />
                    <span className="num-tabular font-semibold text-ink">{r.today}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-ink-muted">
                Waiting for routing review (unknown office, not accessioned): {data.byDoctor.todayRoutingExceptions}. These are never assigned by guess.
              </p>
            </TodayFigures>
          }
          definition={<DefinitionDisclosure def={DEFINITIONS.byDoctor} />}
        />

        <ScenarioCalculator />
      </div>
    </PageBody>
  );
}

function timingRows(prior: DurationSummary, today: DurationSummary, records: { href: string; label: string }): TimingRow[] {
  return [
    { label: "Prior days", tag: PRIOR_TAG, summary: prior },
    { label: "Today so far", tag: TODAY_TAG, summary: today, records },
  ];
}

/** "2 drafted but not sent yet: …; 1 canceled …" — only the non-zero parts, or null. */
function excludedNote(parts: [number, string][]): string | null {
  const shown = parts.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`);
  return shown.length ? `Today: ${shown.join("; ")}.` : null;
}

/** One timing comparison inside the clarification sheet: its question, the aligned table, and today's exclusions. */
function TimingSection({ heading, rows, note }: { heading: string; rows: TimingRow[]; note?: string | null }) {
  return (
    <section aria-label={heading} className="border-b border-line">
      <h3 className="px-4 pt-3 pb-2 text-sm font-semibold text-ink">{heading}</h3>
      <TimingTable caption={`${heading}: median and 90th percentile, prior days and today`} rows={rows} className="border-b-0" />
      {note ? <p className="border-t border-line px-4 py-2 text-sm text-ink-muted">{note}</p> : null}
    </section>
  );
}

/** Today's demo-record figures beside a prior-day chart, behind the sheet's hairline (never a box). */
function TodayFigures({ title = "Today so far", note, children }: { title?: string; note: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <IllustrativeTag className="mt-1">{TODAY_TAG}</IllustrativeTag>
      <p className="mt-1 mb-2 text-sm text-ink-muted">{note}</p>
      {children}
    </section>
  );
}
