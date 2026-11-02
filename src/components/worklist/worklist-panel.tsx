"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CircleCheck, CircleDot } from "lucide-react";
import { cn } from "@/lib/cn";
import { GROSS_STATE, SOURCE_UPDATE_STATE, BLOCK_STATE, type BlockState } from "@/lib/domain";
import type { Role } from "@/lib/roles";
import { SidePanel } from "@/components/ui/side-panel";
import { StatusPill } from "@/components/ui/status-pill";
import { DoctorChip, DoctorSwatch } from "@/components/domain/doctor-chip";
import { IdChip } from "@/components/domain/chips";
import { PersonName } from "@/components/domain/person-name";
import { SpecimenLabel } from "@/components/domain/specimen-label";
import { SyntheticTag } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { PartTrackView, TaskEntry, WorklistGroup, WorklistRow } from "@/server/queries/worklist";
import { ChangeTags, HoldChip, StainText, UpdateOrigin } from "./cells";
import { tidyPlurals } from "./format";
import { TaskActions } from "./task-actions";

/**
 * Side panel for one worklist row. The case is set as its printed specimen label (part letters, its DataMatrix,
 * number, doctor; a provisional intake item keeps the dashed label with no code). The panel's heading names the
 * case for screen readers only (hideTitle), so the number is not printed twice under the label. Then
 * one sheet of hairline-separated sections: what can happen next, PAS and stains, holds with their scope,
 * each part with its physical and documentation tracks kept apart (blocks set as small labels), tasks with
 * claim and release, and the facts. Keeps the list beside it (?selected= in the URL, Esc closes).
 */
export function WorklistPanel({
  row,
  group,
  now,
  actor,
  closeHref,
  readOnly,
  preserveFocus,
}: {
  row: WorklistRow;
  group: WorklistGroup | null;
  now: string;
  actor: { id: string; name: string; role: Role };
  closeHref: string;
  readOnly: boolean;
  /** J/K moved the panel to this row: focus stays on the row in the list. */
  preserveFocus: boolean;
}) {
  const doctor =
    group && group.kind === "doctor" ? (
      <DoctorChip name={group.name} color={group.colorToken} showColorName />
    ) : group && group.kind === "no_doctor" ? (
      <span className="inline-flex items-center gap-1.5 text-ink-secondary">
        <DoctorSwatch color={null} />
        No active assigned dermatopathologist
      </span>
    ) : (
      <DoctorChip name={null} />
    );
  const letters = row.parts.filter((p) => p.status !== "canceled").map((p) => p.designation);
  const pasActive = row.stains.filter((s) => s.isPas);
  const otherStains = row.stains.filter((s) => !s.isPas);
  return (
    <SidePanel
      title={row.accessionNumber ? `Case ${row.accessionNumber}` : `Provisional intake item ${row.provisionalId}`}
      hideTitle
      identity={
        <SpecimenLabel
          size="md"
          status={row.accessionNumber ? "official" : "provisional"}
          id={row.accessionNumber ?? row.provisionalId!}
          parts={letters.length <= 3 ? letters : []}
          payload={row.accessionNumber ? row.labelPayload ?? undefined : undefined}
          lines={row.accessionNumber ? [doctor] : [doctor, "Official number: not issued"]}
        />
      }
      status={
        <StatusPill tone={row.holds.length ? "hold" : row.kind === "intake" ? "warning" : "neutral"}>
          {row.holds.length ? `On hold: ${row.stageLabel}` : row.stageLabel}
        </StatusPill>
      }
      fullRecordHref={row.accessionNumber ? row.href : undefined}
      closeHref={closeHref}
      focusKey={row.id}
      preserveFocus={preserveFocus}
      footer={
        row.kind === "intake" ? (
          <Link href={row.href} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
            Open in intake (routing exception lane)
          </Link>
        ) : (
          <p className="text-xs text-ink-muted">Readiness is derived from parts, blocks, slides, gross records and holds. One finished part never completes the case.</p>
        )
      }
    >
      <div className="flex flex-col divide-y divide-line">
        {row.routing ? (
          <PanelSection label="Routing" title={row.routing.status} titleClassName="text-warning-fg">
            <p className="text-ink">{row.routing.explanation}</p>
            <p className="mt-1 text-ink-secondary">No doctor is guessed. An accessioning lead or supervisor assigns one with a reason in Intake.</p>
          </PanelSection>
        ) : null}

        <PanelSection label="Readiness" title="What can happen next (derived)">
          {row.eligibleShort.length || row.blockedShort.length ? (
            <ul className="flex flex-col gap-1">
              {row.eligibleShort.map((e, i) => (
                <li key={`e${i}`} className="flex items-start gap-1.5 text-ink">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-ink-secondary" aria-hidden />
                  <span>
                    <span className="font-semibold text-ink">Eligible:</span> {tidyPlurals(e)}
                  </span>
                </li>
              ))}
              {row.blockedShort.map((b, i) => (
                <li key={`b${i}`} className="flex items-start gap-1.5 text-ink">
                  <CircleDot className="mt-0.5 size-4 shrink-0 text-hold-solid" aria-hidden />
                  <span>
                    <span className="font-medium text-hold-fg">Not ready:</span> {b}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-secondary">{row.readinessText}</p>
          )}
          <p className="mt-1.5 text-xs text-ink-muted">Blocks prepared / expected: {row.blocks.text}</p>
        </PanelSection>

        {pasActive.length || otherStains.length ? (
          <PanelSection label="PAS and stains" title={pasActive.length && otherStains.length ? "PAS and other work orders" : pasActive.length ? "PAS" : "Work orders"}>
            <ul className="flex flex-col gap-1">
              {[...pasActive, ...otherStains].map((s, i) => (
                <li key={`${s.workOrder ?? "req"}-${i}`} className={cn("rounded-sm px-1.5 py-1", s.isPas && !s.canceled && "bg-pas-row")}>
                  <StainText stain={s} />
                </li>
              ))}
            </ul>
          </PanelSection>
        ) : null}

        {row.holds.length ? (
          <PanelSection label="Holds" title="Holds">
            <ul className="flex flex-col gap-2">
              {row.holds.map((h) => (
                <li key={h.id} className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <HoldChip hold={h} />
                    <span className="id-mono text-xs text-ink-secondary">{h.displayId}</span>
                    <span className="text-xs text-ink-secondary">on {h.scopeLabel}</span>
                  </span>
                  <span className="text-ink">{h.reasonText}</span>
                  <span className="text-xs text-ink-secondary">
                    Blocks: {h.blocks.join(", ").replace(/_/g, " ")}. Placed <Timestamp iso={h.placedAt} now={now} />.
                    {h.clarificationId ? (
                      <>
                        {" "}
                        <Link href={`/clarifications?selected=${encodeURIComponent(h.clarificationDisplayId ?? h.clarificationId)}`} className="font-medium text-brand underline-offset-2 hover:underline">
                          Open clarification {h.clarificationDisplayId ?? ""}
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </PanelSection>
        ) : null}

        {row.parts.length ? (
          <PanelSection label="Parts" title={row.parts.length === 1 ? "Part, blocks and slides" : `${row.parts.length} parts, blocks and slides`}>
            <ul className="flex flex-col divide-y divide-line">
              {row.parts.map((p) => (
                <PartTracks key={p.partId} part={p} />
              ))}
            </ul>
          </PanelSection>
        ) : null}

        <PanelSection label="Tasks" title="Current task owner and open tasks">
          {row.tasks.length === 0 ? <p className="text-ink-secondary">None: no open task on this {row.kind === "case" ? "case" : "item"}.</p> : null}
          <ul className="flex flex-col divide-y divide-line">
            {row.tasks.map((t) => (
              <TaskLine key={t.id} task={t} actor={actor} now={now} />
            ))}
          </ul>
          {readOnly ? <p className="mt-1 text-xs text-ink-muted">The role switch is a demo selector, not a sign-in; the server checks every action.</p> : null}
        </PanelSection>

        {row.change ? (
          <PanelSection label="Changes since your acknowledgment" title={<ChangeHeading tags={row.changeTags} />}>
            <ul className="list-disc pl-5 text-ink-secondary">
              {row.changeSummaries.slice(-6).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </PanelSection>
        ) : null}

        <PanelSection label="Case facts" title="Case facts">
          <dl className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <Fact label="Patient">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {row.patientLabel} <SyntheticTag />
                <span className="text-xs text-ink-muted">{row.mrnLabel}</span>
              </span>
            </Fact>
            <Fact label="Assigned dermatopathologist">{doctor}</Fact>
            <Fact label="Submitting office">{row.office}</Fact>
            <Fact label="Ordering clinician">{row.clinician ?? "Unknown"}</Fact>
            <Fact label="Last confirmed update">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Timestamp iso={row.lastUpdate.at} now={now} showAge />
                <UpdateOrigin origin={row.lastUpdate.origin} />
                {row.lastUpdate.by ? <span className="text-ink-secondary">by {row.lastUpdate.by}</span> : null}
                {row.lastUpdate.summary ? <span className="block w-full text-xs text-ink-muted">{row.lastUpdate.summary}</span> : null}
              </span>
            </Fact>
          </dl>
        </PanelSection>
      </div>
    </SidePanel>
  );
}

/** One section of the panel's sheet: a heading and its content, separated from the next by a hairline. */
function PanelSection({ label, title, titleClassName, children }: { label: string; title: ReactNode; titleClassName?: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="py-3 first:pt-0">
      <h3 className={cn("mb-1.5 text-sm font-semibold text-ink", titleClassName)}>{title}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

function ChangeHeading({ tags }: { tags: WorklistRow["changeTags"] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {/* Each tag already reads "since your last acknowledgment" to screen readers. */}
      <ChangeTags tags={tags} /> <span aria-hidden>since your last acknowledgment</span>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}

function TaskLine({ task, actor, now }: { task: TaskEntry; actor: { id: string; role: Role }; now: string }) {
  return (
    <li className="py-2 first:pt-0">
      <p className="text-ink">{task.title}</p>
      <p className="mt-0.5 text-xs text-ink-secondary">
        <PersonName role="owner" name={task.ownerName ?? `Unassigned${task.ownerRole ? ` (${task.ownerRole.replace(/_/g, " ")})` : ""}`} />
        {task.ownerId === actor.id ? <span className="ml-1 font-semibold text-ink">(you)</span> : null}, {task.status === "in_progress" ? "in progress" : "open"} since{" "}
        <Timestamp iso={task.createdAt} now={now} />
        {task.priority !== "routine" ? `, ${task.priority}` : ""}
      </p>
      <div className="mt-1.5">
        <TaskActions task={task} actor={actor} />
      </div>
    </li>
  );
}

/** A block set as a small solid label (mono id), with its state in words beside it. */
function BlockLabel({ label, state }: { label: string; state: string }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span className="id-mono rounded-sm border border-ink-secondary bg-surface px-1 text-xs font-semibold text-ink">{label}</span>
      <span className="text-xs text-ink-secondary">{BLOCK_STATE[state as BlockState] ?? state}</span>
    </li>
  );
}

function PartTracks({ part }: { part: PartTrackView }) {
  const gross = part.documentation.grossState === "not_started" ? "No gross record yet" : GROSS_STATE[part.documentation.grossState as keyof typeof GROSS_STATE] ?? part.documentation.grossState;
  const source =
    part.documentation.grossState === "approved_for_downstream"
      ? SOURCE_UPDATE_STATE[part.documentation.sourceUpdateState as keyof typeof SOURCE_UPDATE_STATE] ?? part.documentation.sourceUpdateState
      : "Not applicable until approved";
  return (
    <li aria-label={`Part ${part.designation}`} className="flex flex-col gap-2 py-2.5 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex size-7 items-center justify-center rounded-sm border-[1.5px] border-ink text-md font-bold leading-none text-ink" aria-hidden>
          {part.designation}
        </span>
        <span className="font-semibold text-ink">
          <span className="sr-only">Part {part.designation}: </span>
          {part.site}
          {part.procedure ? <span className="font-normal text-ink-secondary">, {part.procedure.replace(/_/g, " ")}</span> : null}
        </span>
        <IdChip kind="ORD" id={part.sourceOrderRef} />
        {part.holds.map((h) => (
          <HoldChip key={h.id} hold={h} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <h4 className="text-xs font-semibold text-ink-muted">Physical</h4>
          <p className="text-ink">{part.stageLabel}</p>
          {part.physical.blocks.length ? (
            <ul className="mt-1 flex flex-col gap-1">
              {part.physical.blocks.map((b) => (
                <BlockLabel key={b.id} label={b.label} state={b.state} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">No blocks yet</p>
          )}
          {part.blocksPrepared || part.blocksExpected !== null ? (
            <p className="mt-1 text-xs text-ink-muted">
              Blocks {part.blocksPrepared} of {part.blocksExpected === null ? "Unknown" : part.blocksExpected}; slides {part.physical.slidesActive} active
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-muted">Expected blocks: Unknown until the gross record allocates cassettes</p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-semibold text-ink-muted">Documentation</h4>
          <p className="text-ink">{gross}</p>
          <p className="text-xs text-ink-secondary">{source}</p>
        </div>
      </div>
      {part.eligible.length || part.blockedBy.length ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {part.eligible.map((e, i) => (
            <li key={`e${i}`} className="text-ink">
              <span className="font-semibold text-ink">Eligible:</span> {tidyPlurals(e)}
            </li>
          ))}
          {part.blockedBy.map((b, i) => (
            <li key={`b${i}`} className="text-ink">
              <span className="font-medium text-hold-fg">Blocked:</span> {tidyPlurals(b)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
