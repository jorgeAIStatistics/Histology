import Link from "next/link";
import { CircleCheck, CircleDot, Circle, CircleQuestionMark, Minus, TriangleAlert } from "lucide-react";
import { fmtAge, fmtSmart } from "@/lib/time";
import { cn } from "@/lib/cn";
import { Card, StatusPill } from "@/components/ui";
import { DoctorChip, HoldBanner, IdChip, PersonName, Timestamp } from "@/components/domain";
import type { CaseDetail, CasePart, TrackStep } from "@/server/queries/case";
import { PartsCell, StainText } from "@/components/worklist/cells";

const STEP_ICON = { done: CircleCheck, current: CircleDot, todo: Circle, unknown: CircleQuestionMark, na: Minus } as const;
const STEP_WORD = { done: "Done", current: "In progress", todo: "Not yet", unknown: "Unknown", na: "Not applicable" } as const;

/** One progress track as an ordered list; state is always written in words. */
export function Track({ title, steps, summary, columns = 1 }: { title: string; steps: TrackStep[]; summary: string; columns?: 1 | 2 }) {
  return (
    <div className="min-w-0">
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <p className="text-xs text-ink-muted">{summary}</p>
      {/* Reading order stays top to bottom: in two columns the list continues at the top of the second column. */}
      <ol className={cn("mt-1.5", columns === 2 ? "gap-x-6 sm:columns-2 [&>li]:mb-1 [&>li]:break-inside-avoid" : "flex flex-col gap-1")}>
        {steps.map((s, i) => {
          const Icon = STEP_ICON[s.state];
          // A detail repeated from the step before ("No blocks yet" on three steps) is said once.
          const detail = s.detail && !(i > 0 && steps[i - 1].detail === s.detail && s.state === steps[i - 1].state) ? s.detail : null;
          return (
            <li key={s.key} className="flex items-start gap-2 text-sm">
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  s.state === "done" ? "text-success-solid" : s.state === "current" ? "text-info-solid" : "text-ink-muted",
                )}
                aria-hidden
              />
              <span className={cn("min-w-0", s.state === "todo" || s.state === "na" ? "text-ink-secondary" : "text-ink")}>
                {s.label}
                <span className="sr-only">: {STEP_WORD[s.state]}</span>
                {detail ? <span className="ml-1 text-xs text-ink-muted">({detail})</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PartCard({ part, focused, now }: { part: CasePart; focused: boolean; now: string }) {
  return (
    <section
      id={`part-${part.designation}`}
      aria-labelledby={`part-${part.designation}-title`}
      className={cn("scroll-mt-40 rounded-md border bg-surface shadow-1", focused ? "border-brand" : "border-line", part.holds.length && "border-l-4 border-l-hold-solid")}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 id={`part-${part.designation}-title`} className="text-md font-semibold text-ink">
          Part {part.designation}
        </h3>
        <span className="text-sm text-ink-secondary">
          {part.site}
          {/* "Left upper back" already says the side: it is not repeated. */}
          {part.laterality && !part.site.toLowerCase().includes(part.laterality.toLowerCase()) ? ` · ${part.laterality}` : ""}
          {part.procedure ? ` · ${part.procedure}` : ""}
        </span>
        <IdChip kind="ORD" id={part.sourceOrderRef} tenant={part.sourceOrderTenant} href="?tab=source" />
        {part.originalDesignation !== part.designation ? (
          <span className="text-xs text-ink-muted">Office wrote it as part {part.originalDesignation} (kept)</span>
        ) : null}
        <span className="ml-auto">
          <StatusPill tone={part.holds.length ? "hold" : part.status === "canceled" ? "neutral" : "info"}>{part.holds.length ? `On hold · ${part.stageLabel}` : part.stageLabel}</StatusPill>
        </span>
      </header>
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Track title="Physical" steps={part.physical.steps} summary={part.physical.summary} columns={2} />
        <Track title="Documentation" steps={part.documentation.steps} summary={part.documentation.summary} />
      </div>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3 text-sm">
        <div>
          <h4 className="text-sm font-semibold text-ink">Readiness (derived)</h4>
          <ul className="mt-0.5 list-disc pl-5 text-ink">
            {part.explanation.map((e, i) => (
              <li key={i} className={e.startsWith("Blocked:") ? "text-hold-fg" : undefined}>
                {e}
              </li>
            ))}
          </ul>
        </div>
        {part.stains.length ? (
          <div>
            <h4 className="text-sm font-semibold text-ink">Additional work (from work orders and order lines only)</h4>
            <ul className="mt-0.5">
              {part.stains.map((s, i) => (
                <li key={i}>
                  <StainText stain={s} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-ink-secondary">
          <PersonName role="owner" name={part.owner ? part.owner.ownerName ?? `Unassigned (${(part.owner.ownerRole ?? "role unknown").replace(/_/g, " ")})` : "None (no open task for this part)"} />
          {part.owner ? <span className="text-xs text-ink-muted"> · {part.owner.title} · since <Timestamp iso={part.owner.createdAt} now={now} /></span> : null}
        </p>
      </div>
    </section>
  );
}

export function CaseOverview({ c, focusPart }: { c: CaseDetail; focusPart: string | null }) {
  const now = c.generatedAt;
  const activeHolds = c.holdsAll.filter((h) => h.status === "active");
  const released = c.holdsAll.filter((h) => h.status !== "active");
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card title="Case status" description="Derived from every part. A case is never shown as complete while any part is incomplete.">
          <p className={cn("text-sm font-medium", c.summary.isComplete ? "text-success-fg" : "text-ink")}>{c.summary.text}</p>
          <p className="mt-1 text-sm text-ink-secondary">{c.summary.readinessText}</p>
          <p className="mt-1 text-xs text-ink-muted">Parts: {c.worklistRow ? <PartsCell row={c.worklistRow} /> : c.summary.partsSummary}</p>
        </Card>
        <Card title="People by role" description="Four different roles, recorded separately.">
          <ul className="flex flex-col gap-1.5 text-sm">
            <li>
              <PersonName role="ordering_clinician" name={c.people.orderingClinician} />
            </li>
            <li>
              {c.people.assignedPathologist ? (
                <DoctorChip name={c.people.assignedPathologist.name} color={c.people.assignedPathologist.colorToken} withRole showColorName />
              ) : (
                <span>
                  <span className="text-ink-muted">Assigned dermatopathologist: </span>
                  <DoctorChip name={null} />
                </span>
              )}
              {c.people.routing ? (
                <span className="block text-xs text-ink-muted">
                  {c.people.routing.status}: {c.people.routing.explanation}
                  {c.people.routing.overrideReason ? ` Reason: ${c.people.routing.overrideReason}` : ""}
                </span>
              ) : null}
            </li>
            <li>
              <PersonName role="accessioner" name={c.people.accessioners.length ? c.people.accessioners.join(", ") : null} />
            </li>
            <li>
              <span className="text-ink-muted">Current task owner: </span>
              {c.people.currentOwners.length ? (
                <ul className="mt-0.5 list-disc pl-5">
                  {c.people.currentOwners.map((o, i) => (
                    <li key={i}>
                      {o.name}
                      <span className="text-ink-secondary">
                        {o.part ? ` (part ${o.part})` : ""}: {o.task}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span>None (no open task)</span>
              )}
            </li>
          </ul>
        </Card>
      </div>

      <section id="holds" aria-label="Holds" className="flex scroll-mt-40 flex-col gap-2">
        {activeHolds.map((h) => {
          const clar = h.clarificationId ? c.clarifications.find((x) => x.id === h.clarificationId) : undefined;
          const others = c.parts.filter((p) => !h.scopeLabel.toLowerCase().includes(`part ${p.designation.toLowerCase()}`)).map((p) => p.designation);
          const otherNote =
            others.length && others.length < c.parts.length
              ? others.length === 1
                ? `Part ${others[0]} can continue.`
                : `Parts ${others.slice(0, -1).join(", ")} and ${others[others.length - 1]} can continue.`
              : undefined;
          // A follow-up time that has passed is overdue, never shown as if it were still coming (same rule as Operations).
          const followUpOverdue = !!clar?.open && !!clar.nextFollowUpAt && Date.parse(clar.nextFollowUpAt) < Date.parse(now);
          return (
            <HoldBanner
              key={h.id}
              scope={h.scopeLabel}
              reason={h.reasonText}
              now={now}
              otherScopeNote={otherNote}
              clarification={clar ? { displayId: clar.displayId, href: clar.href, state: `· ${clar.stateLabel}` } : undefined}
              owner={clar?.labOwner ?? null}
              nextFollowUpAt={followUpOverdue ? null : clar?.nextFollowUpAt ?? null}
              evidence={
                <span className="text-xs text-ink-secondary">
                  <span className="id-mono">{h.displayId}</span> blocks {h.blocks.join(", ").replace(/_/g, " ")}. Placed <Timestamp iso={h.placedAt} now={now} />. Released only by an
                  authorized person with a reason; an office answer does not release it.
                </span>
              }
            >
              {followUpOverdue && clar?.nextFollowUpAt ? (
                <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-sm border border-warning-border bg-warning-bg px-2 py-0.5 text-sm font-semibold text-warning-fg">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  Follow-up overdue since {fmtSmart(clar.nextFollowUpAt, now)} ET ({fmtAge(clar.nextFollowUpAt, now)})
                </p>
              ) : null}
            </HoldBanner>
          );
        })}
        {released.length ? (
          <details className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium text-ink">Released holds ({released.length})</summary>
            <ul className="mt-1 flex flex-col gap-1 text-ink-secondary">
              {released.map((h) => (
                <li key={h.id}>
                  <span className="id-mono">{h.displayId}</span> on {h.scopeLabel}: {h.reasonText}. Released {h.releasedAt ? <Timestamp iso={h.releasedAt} now={now} /> : "at an unknown time"}
                  {h.releasedBy ? ` by ${h.releasedBy}` : ""}
                  {h.releaseReason ? `, reason: "${h.releaseReason}"` : ""}.
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <div className="flex flex-col gap-4">
        {c.parts.map((p) => (
          <PartCard key={p.partId} part={p} focused={focusPart === p.designation} now={now} />
        ))}
      </div>

      <OperationalSummary c={c} />
    </div>
  );
}

export function OperationalSummary({ c }: { c: CaseDetail }) {
  return (
    <Card title="Operational summary" description={c.operationalSummary.label} id="summary">
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-ink">
        {c.operationalSummary.items.map((it, i) => (
          <li key={i}>
            {it.text}{" "}
            <span className="text-xs text-ink-muted">
              Evidence:{" "}
              {it.evidence.map((e, j) => (
                <span key={j}>
                  {j ? ", " : ""}
                  <Link href={e.href} className="whitespace-nowrap font-medium text-brand underline-offset-2 hover:underline">
                    {e.label}
                  </Link>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-ink-muted">Built by fixed rules from the records on this page each time it loads. It does not interpret clinical content.</p>
    </Card>
  );
}
