import { CircleCheck, CircleDashed, CirclePause, List } from "lucide-react";
import { ButtonLink, Tabs, type TabItem } from "@/components/ui";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { IdText } from "@/components/domain/id-text";
import type { CaseDetail } from "@/server/queries/case";

/** "2026-10-14" → "Wed, Oct 14" (the lab day, no time zone shift). */
function fmtDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(d);
}

/**
 * Case band: the h1 with the case facts, the one focal sentence (the case is
 * never shown complete while any part is incomplete) with its readiness line,
 * people by role as a label/value list, and the section tabs on its lower edge.
 */
export function CaseBand({ c, tabs, activeTab, worklistHref, readiness }: { c: CaseDetail; tabs: TabItem[]; activeTab: string; worklistHref: string; readiness: string }) {
  const held = c.parts.some((p) => p.holds.length > 0);
  const issuer = c.identity.issuedBySystem.replace(/^Authoritative source simulator \((.+)\)$/, "$1");
  const owners = c.people.currentOwners;
  return (
    <section aria-labelledby="case-title" className="border-b border-line bg-surface px-6 pt-4 max-xl:px-4">
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
        <div className="min-w-0 max-w-[50rem] flex-1 basis-[30rem]">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 id="case-title" className="text-md font-bold text-ink">
              Case <span className="id-mono">{c.identity.accessionNumber}</span>
            </h1>
            <p className="text-sm text-ink-secondary">
              {c.parts.length} {c.parts.length === 1 ? "part" : "parts"} from {c.sourceDocuments.length} source {c.sourceDocuments.length === 1 ? "order" : "orders"}, received{" "}
              {fmtDay(c.identity.receivedDay)}.{c.identity.priority === "rush" ? <span className="ml-1 font-semibold text-ink">Rush.</span> : null}
            </p>
          </div>
          <p className="mt-2.5 flex items-start gap-2.5 text-xl leading-8 font-bold tracking-[-0.015em] text-ink">
            {c.summary.isComplete ? (
              <CircleCheck className="mt-1.5 size-5 shrink-0 text-ink-muted" aria-hidden />
            ) : held ? (
              <CirclePause className="mt-1.5 size-5 shrink-0 text-hold-solid" aria-hidden />
            ) : (
              <CircleDashed className="mt-1.5 size-5 shrink-0 text-ink-muted" aria-hidden />
            )}
            <span>{c.summary.text}</span>
          </p>
          <p className="mt-0.5 ml-[1.875rem] text-md text-ink-secondary">
            <IdText text={readiness} />
          </p>
          <p className="mt-1 ml-[1.875rem] text-sm text-ink-muted">
            Accession issued by {issuer} (simulated source), source case <span className="id-mono text-ink-secondary">{c.identity.sourceCaseId}</span>.
          </p>
        </div>

        <div className="min-w-0 basis-[30rem] max-xl:basis-full xl:max-w-[34rem]">
          <dl aria-label="People by role" className="grid w-full grid-cols-[minmax(9rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm leading-5 max-sm:grid-cols-1 md:max-xl:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
            <dt className="text-ink-muted">Ordering clinician</dt>
            <dd className="min-w-0 text-ink max-sm:mb-1">{c.people.orderingClinician ?? "Unknown"}</dd>
            <dt className="text-ink-muted">Dermatopathologist</dt>
            <dd className="min-w-0 max-sm:mb-1">
              {c.people.assignedPathologist ? (
                <DoctorChip name={c.people.assignedPathologist.name} color={c.people.assignedPathologist.colorToken} showColorName className="whitespace-normal" />
              ) : (
                <DoctorChip name={null} />
              )}
              {c.people.routing ? (
                <span className="block text-xs text-ink-muted">
                  {c.people.routing.status}: <IdText text={c.people.routing.explanation} />
                  {c.people.routing.overrideReason ? ` Reason: ${c.people.routing.overrideReason}` : ""}
                </span>
              ) : null}
            </dd>
            <dt className="text-ink-muted">Accessioner</dt>
            <dd className="min-w-0 text-ink max-sm:mb-1">{c.people.accessioners.length ? c.people.accessioners.join(", ") : "Unknown"}</dd>
            <dt className="text-ink-muted">Open tasks</dt>
            <dd className="min-w-0 text-ink">
              {owners.length ? (
                // Each part's row names its task; here only who holds open work, and the title of case-level tasks.
                <ul className="flex flex-wrap gap-x-3">
                  {owners.map((o, i) => (
                    <li key={i}>
                      <span className="font-semibold">{o.name}</span>
                      <span className="text-ink-secondary">
                        {o.part ? (
                          `, part ${o.part}`
                        ) : (
                          <>
                            : <IdText text={o.task} />
                          </>
                        )}
                        {i < owners.length - 1 ? ";" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-ink-secondary">None open</span>
              )}
            </dd>
          </dl>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <Tabs items={tabs} active={activeTab} label="Case sections" className="min-w-0 border-b-0" />
        <ButtonLink href={worklistHref} variant="quiet" size="sm" icon={<List className="size-4" aria-hidden />} className="mb-1.5">
          Show on worklist
        </ButtonLink>
      </div>
    </section>
  );
}
