"use client";

import Link from "next/link";
import { FactList, SidePanel, StatusPill } from "@/components/ui";
import { AccessionChip, DoctorChip, DoctorSwatch, IdChip, PersonName, ProvisionalChip, SyntheticTag, Timestamp } from "@/components/domain";
import { GROSS_STATE, SOURCE_UPDATE_STATE, BLOCK_STATE, type BlockState } from "@/lib/domain";
import type { Role } from "@/lib/roles";
import type { PartTrackView, TaskEntry, WorklistGroup, WorklistRow } from "@/server/queries/worklist";
import { ChangeTags, StainText, UpdateOrigin } from "./cells";
import { TaskActions } from "./task-actions";

/**
 * Side panel for one worklist row: part-level detail with the physical and
 * documentation tracks shown separately, holds with scope, explicit stains,
 * tasks (claim / release) and the last confirmed update. Keeps list context.
 */
export function WorklistPanel({
  row,
  group,
  now,
  actor,
  closeHref,
  readOnly,
}: {
  row: WorklistRow;
  group: WorklistGroup | null;
  now: string;
  actor: { id: string; name: string; role: Role };
  closeHref: string;
  readOnly: boolean;
}) {
  const identity = row.accessionNumber ? <AccessionChip accession={row.accessionNumber} /> : <ProvisionalChip id={row.provisionalId!} />;
  return (
    <SidePanel
      title={row.accessionNumber ? `Case ${row.accessionNumber}` : `Provisional intake item ${row.provisionalId}`}
      identity={identity}
      status={<StatusPill tone={row.holds.length ? "hold" : row.kind === "intake" ? "warning" : "neutral"}>{row.holds.length ? `On hold · ${row.stageLabel}` : row.stageLabel}</StatusPill>}
      fullRecordHref={row.accessionNumber ? row.href : undefined}
      closeHref={closeHref}
      focusKey={row.id}
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
      <div className="flex flex-col gap-4">
        <FactList
          items={[
            {
              label: "Patient",
              value: (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {row.patientLabel} <SyntheticTag />
                  <span className="text-xs text-ink-muted">{row.mrnLabel}</span>
                </span>
              ),
            },
            { label: "Submitting office", value: row.office },
            { label: "Ordering clinician", value: row.clinician ?? "Unknown" },
            {
              label: "Assigned dermatopathologist",
              value:
                group && group.kind === "doctor" ? (
                  <DoctorChip name={group.name} color={group.colorToken} showColorName />
                ) : group && group.kind === "no_doctor" ? (
                  <span className="inline-flex items-center gap-1.5 text-ink-secondary">
                    <DoctorSwatch color={null} />
                    None active on this case (check the assignment)
                  </span>
                ) : (
                  <DoctorChip name={null} />
                ),
            },
            {
              label: "Last confirmed update",
              value: (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Timestamp iso={row.lastUpdate.at} now={now} showAge />
                  <UpdateOrigin origin={row.lastUpdate.origin} />
                  {row.lastUpdate.by ? <span className="text-ink-secondary">by {row.lastUpdate.by}</span> : null}
                  {row.lastUpdate.summary ? <span className="block w-full text-xs text-ink-muted">{row.lastUpdate.summary}</span> : null}
                </span>
              ),
            },
          ]}
        />

        {row.change ? (
          <section aria-label="Changes since your acknowledgment" className="rounded-md border border-line bg-surface-subtle p-2">
            <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
              {/* Each tag already reads "since your last acknowledgment" to screen readers. */}
              <ChangeTags tags={row.changeTags} /> <span aria-hidden>since your last acknowledgment</span>
            </h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink-secondary">
              {row.changeSummaries.slice(-6).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {row.routing ? (
          <section aria-label="Routing" className="rounded-md border border-dashed border-line-strong p-2 text-sm">
            <h3 className="font-semibold text-warning-fg">{row.routing.status}</h3>
            <p className="mt-0.5 text-ink">{row.routing.explanation}</p>
            <p className="mt-0.5 text-ink-secondary">No doctor is guessed. An accessioning lead or supervisor assigns one with a reason in Intake.</p>
          </section>
        ) : null}

        <section aria-label="Readiness">
          <h3 className="text-sm font-semibold text-ink">Readiness (derived)</h3>
          {row.eligibleShort.length ? (
            <ul className="mt-1 space-y-0.5 text-sm">
              {row.eligibleShort.map((e, i) => (
                <li key={i} className="text-success-fg">
                  Eligible: <span className="text-ink">{e}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {row.blockedShort.length ? (
            <ul className="mt-1 space-y-0.5 text-sm">
              {row.blockedShort.map((b, i) => (
                <li key={i} className="text-ink">
                  <span className="font-medium text-hold-fg">Not ready:</span> {b}
                </li>
              ))}
            </ul>
          ) : null}
          {!row.eligibleShort.length && !row.blockedShort.length ? <p className="mt-1 text-sm text-ink-secondary">{row.readinessText}</p> : null}
          <p className="mt-1 text-xs text-ink-muted">Blocks prepared / expected: {row.blocks.text}</p>
        </section>

        {row.parts.map((p) => (
          <PartTracks key={p.partId} part={p} />
        ))}

        {row.holds.length ? (
          <section aria-label="Holds">
            <h3 className="text-sm font-semibold text-ink">Holds</h3>
            <ul className="mt-1 space-y-1.5 text-sm">
              {row.holds.map((h) => (
                <li key={h.id} className="rounded-sm border-l-4 border-l-hold-solid bg-hold-bg px-2 py-1">
                  <span className="font-semibold text-hold-fg">
                    <span className="id-mono">{h.displayId}</span> on {h.scopeLabel}
                  </span>
                  <span className="block text-ink">{h.reasonText}</span>
                  <span className="block text-xs text-ink-secondary">
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
          </section>
        ) : null}

        <section aria-label="Tasks">
          <h3 className="text-sm font-semibold text-ink">Current task owner and open tasks</h3>
          {row.tasks.length === 0 ? <p className="mt-1 text-sm text-ink-secondary">None: no open task on this {row.kind === "case" ? "case" : "item"}.</p> : null}
          <ul className="mt-1 space-y-2">
            {row.tasks.map((t) => (
              <TaskLine key={t.id} task={t} actor={actor} now={now} />
            ))}
          </ul>
          {readOnly ? <p className="mt-1 text-xs text-ink-muted">The role switch is a demo selector, not a sign-in; the server checks every action.</p> : null}
        </section>
      </div>
    </SidePanel>
  );
}

function TaskLine({ task, actor, now }: { task: TaskEntry; actor: { id: string; role: Role }; now: string }) {
  return (
    <li className="rounded-md border border-line p-2 text-sm">
      <p className="text-ink">{task.title}</p>
      <p className="mt-0.5 text-xs text-ink-secondary">
        <PersonName role="owner" name={task.ownerName ?? `Unassigned${task.ownerRole ? ` (${task.ownerRole.replace(/_/g, " ")})` : ""}`} />
        {" · "}
        {task.status === "in_progress" ? "In progress" : "Open"} since <Timestamp iso={task.createdAt} now={now} />
        {task.priority !== "routine" ? ` · ${task.priority}` : ""}
      </p>
      <div className="mt-1.5">
        <TaskActions task={task} actor={actor} />
      </div>
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
    <section aria-label={`Part ${part.designation}`} className="rounded-md border border-line">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-subtle px-2 py-1.5">
        <span className="font-semibold text-ink">Part {part.designation}</span>
        <span className="text-sm text-ink-secondary">
          {part.site}
          {part.procedure ? `, ${part.procedure.replace(/_/g, " ")}` : ""}
        </span>
        <IdChip kind="ORD" id={part.sourceOrderRef} />
        {part.holds.length ? <StatusPill tone="hold">Hold</StatusPill> : null}
      </header>
      <div className="grid grid-cols-2 gap-2 p-2 text-sm">
        <div>
          <h4 className="text-xs font-semibold text-ink-muted">Physical</h4>
          <p className="text-ink">{part.stageLabel}</p>
          {part.physical.blocks.length ? (
            <ul className="mt-0.5 text-xs text-ink-secondary">
              {part.physical.blocks.map((b) => (
                <li key={b.id}>
                  <span className="id-mono">{b.label}</span>: {BLOCK_STATE[b.state as BlockState] ?? b.state}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-muted">No blocks yet</p>
          )}
          {part.blocksPrepared || part.blocksExpected !== null ? (
            <p className="text-xs text-ink-muted">
              Blocks {part.blocksPrepared} of {part.blocksExpected === null ? "Unknown" : part.blocksExpected}; slides {part.physical.slidesActive} active
            </p>
          ) : (
            <p className="text-xs text-ink-muted">Expected blocks: Unknown until the gross record allocates cassettes</p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-semibold text-ink-muted">Documentation</h4>
          <p className="text-ink">{gross}</p>
          <p className="text-xs text-ink-secondary">{source}</p>
        </div>
      </div>
      {part.eligible.length || part.blockedBy.length ? (
        <ul className="border-t border-line px-2 py-1.5 text-xs">
          {part.eligible.map((e, i) => (
            <li key={`e${i}`} className="text-success-fg">
              Eligible: <span className="text-ink">{e}</span>
            </li>
          ))}
          {part.blockedBy.map((b, i) => (
            <li key={`b${i}`} className="text-ink">
              <span className="font-medium text-hold-fg">Blocked:</span> {b}
            </li>
          ))}
        </ul>
      ) : null}
      {part.stains.length ? (
        <ul className="border-t border-line px-2 py-1.5">
          {part.stains.map((s, i) => (
            <li key={i}>
              <StainText stain={s} className="text-xs" />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
