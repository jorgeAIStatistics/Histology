import Link from "next/link";
import { ArrowRight, CircleCheck, CirclePause, Hourglass, Lock, TriangleAlert } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { fmtAge, fmtSmart } from "@/lib/time";
import { cn } from "@/lib/cn";
import { HoldBanner } from "@/components/domain/hold";
import { IdText } from "@/components/domain/id-text";
import { SpecimenLabel } from "@/components/domain/specimen-label";
import { Timestamp } from "@/components/domain/timestamp";
import type { CaseClarification, CaseDetail, CasePart } from "@/server/queries/case";
import { ReviewFlag } from "@/components/worklist/cells";
import { PasTag } from "@/components/domain/pas-tag";
import { partDescription, partHeading, partLines, partNext, railSteps, readinessLine, stainSource, taskTitleInPart, type PartNext } from "./format";
import { StepRail } from "./step-rail";
import { PartLocator } from "./part-locator";

type ActiveHold = CaseDetail["holdsAll"][number];

/** "Part A can continue." / "Parts A and C can continue." for the parts a hold does not touch. */
function otherPartsNote(c: CaseDetail, heldPart: string): string | null {
  const others = c.parts.filter((p) => p.designation !== heldPart && p.status !== "canceled" && !p.holds.length).map((p) => p.designation);
  if (!others.length) return null;
  return others.length === 1 ? `Part ${others[0]} can continue.` : `Parts ${others.slice(0, -1).join(", ")} and ${others[others.length - 1]} can continue.`;
}

/** What a hold inside a part's row covers, in words: the part, one block or slide, or everything from one intake item. */
function holdScopeWords(hold: ActiveHold): string {
  switch (hold.scopeType) {
    case "block":
    case "slide":
    case "work_order":
      return `for ${hold.target ?? hold.scopeLabel} only`;
    case "intake_item":
      return `for everything received with ${hold.scopeLabel}`;
    default:
      return "for this part only";
  }
}

/** The hold inside its part's row: hatched, scoped in words, with the clarification it waits on and who holds the next step. */
function PartHold({ hold, clar, note, now }: { hold: ActiveHold; clar: CaseClarification | undefined; note: string | null; now: string }) {
  const overdue = !!clar?.open && !!clar.nextFollowUpAt && Date.parse(clar.nextFollowUpAt) < Date.parse(now);
  const partOnly = holdScopeWords(hold) === "for this part only";
  return (
    <div className="hatch rounded-md border border-hold-border px-3 py-2.5 text-sm">
      <p className="flex items-start gap-2 font-semibold text-hold-fg">
        <CirclePause className="mt-0.5 size-4 shrink-0 text-hold-solid" aria-hidden />
        <span>
          Hold <span className="id-mono">{hold.displayId}</span>: {hold.reasonText}
        </span>
      </p>
      <p className="mt-0.5 pl-6 text-ink">
        Stops {hold.blocks.join(", ").replace(/_/g, " ")} {holdScopeWords(hold)}.{note && partOnly ? ` ${note}` : ""}
      </p>
      <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-0.5 pl-6 text-ink-secondary">
        {clar ? (
          <div className="flex gap-1.5">
            <dt>Clarification</dt>
            <dd>
              <Link href={clar.href} className="id-mono font-semibold text-brand-ink underline-offset-2 hover:underline">
                {clar.displayId}
              </Link>
              <span className="ml-1 text-ink">{clar.stateLabel.charAt(0).toLowerCase() + clar.stateLabel.slice(1)}</span>
            </dd>
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <dt>Waiting on</dt>
          <dd className="font-semibold text-ink">{hold.owner ?? "Unknown"}</dd>
        </div>
        {clar?.open && clar.nextFollowUpAt && !overdue ? (
          <div className="flex gap-1.5">
            <dt>Next follow-up</dt>
            <dd className="text-ink">
              <Timestamp iso={clar.nextFollowUpAt} now={now} />
            </dd>
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <dt>Placed</dt>
          <dd className="text-ink">
            <Timestamp iso={hold.placedAt} now={now} />
          </dd>
        </div>
      </dl>
      {overdue && clar?.nextFollowUpAt ? (
        <p className="mt-1.5 ml-6 inline-flex items-center gap-1.5 rounded-sm border border-warning-border bg-warning-bg px-2 py-0.5 font-semibold text-warning-fg">
          <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />
          Follow-up overdue since {fmtSmart(clar.nextFollowUpAt, now)} ET ({fmtAge(clar.nextFollowUpAt, now)})
        </p>
      ) : null}
      {hold.nextStep ? (
        <p className="mt-1 pl-6 text-ink-secondary">
          <span className="text-ink-muted">Next: </span>
          <IdText text={hold.nextStep} />
        </p>
      ) : null}
      <p className="mt-1 pl-6 text-xs text-ink-secondary">Released only by an authorized person with a reason; an office answer does not release it.</p>
    </div>
  );
}

/** The part's next step, who it waits on (or that no one is assigned), and where to do it. */
function NextStep({ next, now, readOnly }: { next: PartNext; now: string; readOnly: boolean }) {
  return (
    <div className="mt-1.5 flex flex-col gap-0.5">
      <p className="flex items-start gap-1.5 font-semibold text-ink">
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
        <span>
          <span className="sr-only">Next step: </span>
          <IdText text={next.action} />
        </span>
      </p>
      <p className="flex items-start gap-1.5 text-ink-secondary">
        <Hourglass className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
        <span>
          {next.who ? (
            <>
              Waiting on <span className="font-semibold text-ink">{next.who}</span>
              {next.whoNote ? `, ${next.whoNote}` : ""}
            </>
          ) : (
            <>Not assigned to anyone{next.whoNote ? `; ${next.whoNote}` : ""}</>
          )}
          {next.since ? (
            <>
              , since <Timestamp iso={next.since} now={now} />
            </>
          ) : null}
          {next.fromRecord ? ". No task is open." : "."}
        </span>
      </p>
      {next.note ? (
        <p className="pl-[1.375rem] text-ink-secondary">
          <IdText text={next.note} />
        </p>
      ) : null}
      {next.href ? (
        <ButtonLink href={next.href} variant="secondary" size="sm" className="mt-1 ml-[1.375rem] w-fit">
          {/* A read-only role can look, not act: the same link says View. */}
          {readOnly ? next.hrefLabel?.replace(/^Open in/, "View in") : next.hrefLabel}
        </ButtonLink>
      ) : null}
    </div>
  );
}

/**
 * One part as one row of the parts sheet: its specimen label and site, its
 * physical and documentation rails, and on the right its status and who it
 * waits on. A held part is hatched behind its label, on the exact rail step
 * the hold stops, and in a hold strip inside the row.
 */
function PartRow({ c, part, focused, readOnly }: { c: CaseDetail; part: CasePart; focused: boolean; readOnly: boolean }) {
  const now = c.generatedAt;
  const d = part.designation;
  const holds = c.holdsAll.filter((h) => h.status === "active" && part.holds.some((x) => x.id === h.id));
  // A whole-case hold still marks the steps it stops on this part's rails, but its strip is said once, above the parts,
  // never as "this part only" in every row.
  const stripHolds = holds.filter((h) => h.scopeType !== "accession");
  const heldIds = holds.map((h) => h.displayId);
  const physical = railSteps(part.physical.steps, holds, "physical");
  const documentation = railSteps(part.documentation.steps, holds, "documentation");
  const next = partNext(part, c.identity.accessionNumber);
  // Lines the hold strip, a rail step or the next step already say are not repeated.
  const lines = partLines(part, heldIds, next, c.identity.accessionNumber);
  const alsoOpen = part.openTasks.slice(1);
  const canceled = part.status === "canceled";
  const delivered = part.stage === "delivered";
  return (
    <section
      id={`part-${d}`}
      aria-labelledby={`part-${d}-title`}
      className={cn(
        "grid scroll-mt-40 grid-cols-1 gap-x-6 gap-y-3 border-t border-line px-5 py-4 first-of-type:border-t-0 max-xl:px-4",
        "md:grid-cols-[13.5rem_minmax(0,1fr)] xl:grid-cols-[12.5rem_minmax(0,1fr)_18rem]",
        focused && "bg-brand-50 outline-1 -outline-offset-1 outline-brand",
      )}
    >
      <h3 id={`part-${d}-title`} className="sr-only">
        Part {d}
      </h3>
      <div className={cn("min-w-0 md:row-start-1 xl:row-span-2", holds.length && "hatch -m-2 self-start rounded-md p-2")}>
        <SpecimenLabel
          size="md"
          status="official"
          id={c.identity.accessionNumber}
          parts={[d]}
          className="w-fit"
          lines={[
            <Link
              key="order"
              href={`?tab=source#order-${part.sourceOrderRef}`}
              aria-label={`Order ${part.sourceOrderRef}, ${part.sourceOrderTenant}`}
              className="text-brand-ink underline-offset-2 hover:underline"
            >
              Order <span className="id-mono">{part.sourceOrderRef}</span>
            </Link>,
          ]}
        />
        <p className={cn("mt-2 text-md leading-6 font-semibold", canceled ? "text-ink-muted line-through" : "text-ink")}>
          {partDescription(part.site, part.laterality, part.procedure)}
        </p>
        {part.originalDesignation !== d ? <p className="text-sm text-ink-secondary">Office wrote it as part {part.originalDesignation} (kept)</p> : null}
      </div>

      <div className="min-w-0 text-sm md:col-start-2 md:row-start-1 xl:col-start-3">
        <p className="flex items-center gap-1.5 text-md font-semibold text-ink">
          {holds.length ? (
            <>
              <CirclePause className="size-4 shrink-0 text-hold-solid" aria-hidden />
              <span>On hold</span>
              <span className="font-normal text-ink-secondary">{part.stageLabel.charAt(0).toLowerCase() + part.stageLabel.slice(1)}</span>
            </>
          ) : delivered ? (
            <>
              <CircleCheck className="size-4 shrink-0 text-ink-muted" aria-hidden />
              <span>{part.stageLabel}</span>
            </>
          ) : (
            <span>{canceled ? "Canceled" : partHeading(part.stageLabel, next)}</span>
          )}
        </p>
        {next ? <NextStep next={next} now={now} readOnly={readOnly} /> : null}
        {lines.length ? (
          <ul className={cn("flex flex-col gap-0.5 text-ink", next ? "mt-2 border-t border-line pt-1.5" : "mt-1")}>
            {lines.map((e, i) =>
              e.startsWith("Blocked:") ? (
                <li key={i} className="flex items-start gap-1.5 text-ink-secondary">
                  <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
                  <span>
                    <IdText text={e} />
                  </span>
                </li>
              ) : (
                <li key={i}>
                  <IdText text={readinessLine(e, d)} />
                </li>
              ),
            )}
          </ul>
        ) : null}
        {alsoOpen.length ? (
          <ul className="mt-1.5 flex flex-col gap-0.5 text-ink-secondary">
            {alsoOpen.map((t) => (
              <li key={t.id}>
                Also open: <IdText text={taskTitleInPart(t.title, c.identity.accessionNumber, d)} />,{" "}
                <span className="font-semibold text-ink">{t.ownerName ?? `unassigned (${(t.ownerRole ?? "role unknown").replace(/_/g, " ")})`}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!next && !lines.length && !alsoOpen.length && !delivered && !canceled ? <p className="mt-1 text-ink-muted">No open task for this part.</p> : null}
        {part.stains.length ? (
          <div className="mt-2">
            <p className="text-xs text-ink-muted">Additional work, from work orders and order lines</p>
            <ul className="mt-1 flex flex-col gap-1">
              {part.stains.map((s, i) => (
                <li key={`${s.workOrder ?? "line"}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {s.isPas ? (
                    <PasTag workOrder={s.workOrder ?? undefined} target={s.target.replace(" (block not yet assigned)", "")} canceled={s.canceled} />
                  ) : (
                    <span className={cn("text-ink", s.canceled && "line-through")}>
                      {s.kind === "levels" ? `Levels ${s.stain}` : s.kind === "recut" ? `Recut ${s.stain}` : s.stain}
                      {s.workOrder ? <span className="ml-1 id-mono text-ink-secondary">{s.workOrder}</span> : null}
                    </span>
                  )}
                  <span className="text-xs text-ink-secondary">
                    <IdText text={s.workOrder ? stainSource(s.authorization, s.sourceReference) : "On the order, no work order yet"} />
                  </span>
                  {s.needsReview ? <ReviewFlag /> : null}
                  {!s.isPas && s.canceled ? <span className="text-xs font-semibold text-ink-secondary">Canceled</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {stripHolds.length ? (
        <div className="flex min-w-0 flex-col gap-2 md:col-span-2 md:row-start-2 xl:col-span-2 xl:col-start-2">
          {stripHolds.map((h) => (
            <PartHold key={h.id} hold={h} clar={h.clarificationId ? c.clarifications.find((x) => x.id === h.clarificationId) : undefined} note={otherPartsNote(c, d)} now={now} />
          ))}
        </div>
      ) : null}

      <div className={cn("flex min-w-0 flex-col gap-2.5 md:col-span-2 xl:col-span-1 xl:col-start-2 xl:row-start-1", stripHolds.length ? "md:row-start-3" : "md:row-start-2")}>
        <StepRail title="Physical" steps={physical} columns="grid-cols-4 md:grid-cols-8" />
        <StepRail title="Documentation" steps={documentation} columns="grid-cols-2 sm:grid-cols-4" />
      </div>
    </section>
  );
}

export function CaseOverview({ c, focusPart, readOnly }: { c: CaseDetail; focusPart: string | null; readOnly: boolean }) {
  const now = c.generatedAt;
  const onParts = new Set(c.parts.flatMap((p) => p.holds.map((h) => h.id)));
  // Holds that are not on one part (the whole case, an intake item not tied to a part) keep the shared banner above the parts.
  const caseHolds = c.holdsAll.filter((h) => h.status === "active" && (h.scopeType === "accession" || !onParts.has(h.id)));
  const released = c.holdsAll.filter((h) => h.status !== "active");
  return (
    <div className="flex flex-col gap-5">
      {caseHolds.length ? (
        <div id="holds" className="flex scroll-mt-40 flex-col gap-2">
          {caseHolds.map((h) => {
            const clar = h.clarificationId ? c.clarifications.find((x) => x.id === h.clarificationId) : undefined;
            return (
              <HoldBanner
                key={h.id}
                scope={h.scopeType === "accession" ? `Whole case ${c.identity.accessionNumber}` : h.scopeLabel}
                reason={h.reasonText}
                now={now}
                clarification={clar ? { displayId: clar.displayId, href: clar.href, state: clar.stateLabel } : undefined}
                owner={h.owner}
                nextFollowUpAt={clar?.open ? clar.nextFollowUpAt : null}
                evidence={
                  <span className="text-xs text-ink-secondary">
                    <span className="id-mono">{h.displayId}</span> stops {h.blocks.join(", ").replace(/_/g, " ")}
                    {h.scopeType === "accession" ? " for every part of the case" : ""}. Placed <Timestamp iso={h.placedAt} now={now} />.
                    {h.nextStep ? (
                      <>
                        {" "}
                        Next: <IdText text={h.nextStep} />.
                      </>
                    ) : null}{" "}
                    Released only by an authorized person with a reason.
                  </span>
                }
              />
            );
          })}
        </div>
      ) : null}

      <section aria-labelledby="parts-title" className="rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line px-5 py-3 max-xl:px-4">
          <h2 id="parts-title" className="text-md font-bold text-ink">
            Where each part is
          </h2>
          <p className="text-sm text-ink-muted">Physical and documentation paths are kept apart. The case is complete only when every part is.</p>
        </header>
        <div id={!caseHolds.length && onParts.size ? "holds" : undefined} className="scroll-mt-40">
          {c.parts.map((p) => (
            <PartRow key={p.partId} c={c} part={p} focused={focusPart === p.designation} readOnly={readOnly} />
          ))}
        </div>
      </section>
      {focusPart && c.parts.some((p) => p.designation === focusPart) ? <PartLocator targetId={`part-${focusPart}`} /> : null}

      {released.length ? (
        <details className="group rounded-lg border border-line bg-surface px-5 py-3 text-sm max-xl:px-4">
          <summary className="cursor-pointer font-semibold text-ink">Released holds ({released.length})</summary>
          <ul className="mt-2 flex flex-col divide-y divide-line text-ink-secondary">
            {released.map((h) => (
              <li key={h.id} className="py-1.5">
                <span className="id-mono text-ink">{h.displayId}</span> on {h.scopeLabel}: {h.reasonText}. Released{" "}
                {h.releasedAt ? <Timestamp iso={h.releasedAt} now={now} /> : "at an unknown time"}
                {h.releasedBy ? ` by ${h.releasedBy}` : ""}
                {h.releaseReason ? `, reason: "${h.releaseReason}"` : ""}.
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <OperationalSummary c={c} />
    </div>
  );
}

/** The deterministic summary: each statement with links to the records that show it. */
export function OperationalSummary({ c }: { c: CaseDetail }) {
  return (
    <section id="summary" aria-labelledby="summary-title" className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line px-5 py-3 max-xl:px-4">
        <h2 id="summary-title" className="text-md font-bold text-ink">
          Operational summary
        </h2>
        <p className="text-sm text-ink-muted">{c.operationalSummary.label}</p>
      </header>
      <ul className="divide-y divide-line px-5 max-xl:px-4">
        {c.operationalSummary.items.map((it, i) => (
          <li key={i} className="grid grid-cols-1 gap-x-6 gap-y-0.5 py-2 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)]">
            <p className="max-w-[90ch] text-ink">
              <IdText text={it.text} />
            </p>
            <p className="text-ink-muted lg:text-right">
              <span className="sr-only">Evidence: </span>
              {it.evidence.map((e, j) => (
                <span key={j}>
                  {j ? ", " : ""}
                  <Link href={e.href} className="font-medium whitespace-nowrap text-brand-ink underline-offset-2 hover:underline">
                    <IdText text={e.label} />
                  </Link>
                </span>
              ))}
            </p>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-5 py-2 text-xs text-ink-muted max-xl:px-4">Built by fixed rules from the records on this page each time it loads. It does not interpret clinical content.</p>
    </section>
  );
}
