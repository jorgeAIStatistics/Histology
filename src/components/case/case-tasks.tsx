import Link from "next/link";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { LabelRef } from "@/components/domain/specimen-label";
import { IdText } from "@/components/domain/id-text";
import { SimulatedLabel } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { Role } from "@/lib/roles";
import type { CaseDetail } from "@/server/queries/case";
import { TaskActions } from "@/components/worklist/task-actions";

/** Tasks (with owners, open first) and clarifications, each linked to its record. */
export function CaseTasks({ c, actor }: { c: CaseDetail; actor: { id: string; role: Role } }) {
  const now = c.generatedAt;
  const open = c.tasks.filter((t) => t.status === "open" || t.status === "in_progress").length;
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="tasks-title" className="overflow-hidden rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3 max-xl:px-4">
          <h2 id="tasks-title" className="text-md font-bold text-ink">
            Tasks <span className="font-normal text-ink-secondary">({open} open)</span>
          </h2>
          <p className="text-sm text-ink-muted">Who owns each next step. Done and canceled tasks stay listed for traceability.</p>
        </header>
        {c.tasks.length === 0 ? (
          <p className="border-t border-line px-5 py-3 text-sm text-ink-secondary max-xl:px-4">No tasks have been opened for this case.</p>
        ) : (
          <Table caption={`Tasks for ${c.identity.accessionNumber}, open first`} wrapperClassName="rounded-none border-x-0 border-b-0">
            <THead>
              <tr>
                <TH>Task</TH>
                <TH>Part</TH>
                <TH>Owner</TH>
                <TH>Status</TH>
                {/* Action before the times, so Claim stays on screen on a 1024 px bench tablet. */}
                <TH>Action</TH>
                <TH>Opened</TH>
                <TH>Done</TH>
              </tr>
            </THead>
            <TBody>
              {c.tasks.map((t) => {
                const isOpen = t.status === "open" || t.status === "in_progress";
                return (
                  <TR key={t.id} canceled={!isOpen}>
                    <TD wrap className="min-w-64">
                      {t.href ? (
                        <Link href={t.href} className={isOpen ? "font-medium text-brand-ink underline-offset-2 hover:underline" : "text-ink-secondary underline-offset-2 hover:underline"}>
                          <IdText text={t.title} />
                        </Link>
                      ) : (
                        <IdText text={t.title} />
                      )}
                    </TD>
                    <TD>{t.partDesignation ? `Part ${t.partDesignation}` : <span className="text-ink-muted">Case</span>}</TD>
                    <TD>{t.ownerName ?? <span className="text-ink-muted">Unassigned ({(t.ownerRole ?? "role unknown").replace(/_/g, " ")})</span>}</TD>
                    <TD>
                      {isOpen ? (
                        <StatusPill tone={t.status === "in_progress" ? "info" : "neutral"}>{t.status === "in_progress" ? "In progress" : "Open"}</StatusPill>
                      ) : (
                        <span className="text-ink-muted">{t.status === "done" ? "Done" : "Canceled"}</span>
                      )}
                    </TD>
                    <TD wrap className="min-w-44">
                      {isOpen ? <TaskActions task={t} actor={actor} /> : null}
                    </TD>
                    <TD>
                      <Timestamp iso={t.createdAt} now={now} />
                    </TD>
                    <TD wrap className="min-w-40">
                      {t.completedAt ? (
                        <>
                          <Timestamp iso={t.completedAt} now={now} />
                          {t.completedBy ? <span className="whitespace-nowrap"> by {t.completedBy}</span> : null}
                          {t.closedNote ? <span className="block text-xs">{t.closedNote}</span> : null}
                        </>
                      ) : (
                        <>
                          <span aria-hidden className="text-ink-muted">
                            —
                          </span>
                          <span className="sr-only">Not done yet</span>
                        </>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="clarifications-title" className="rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-line px-5 py-3 max-xl:px-4">
          <div>
            <h2 id="clarifications-title" className="text-md font-bold text-ink">
              Clarifications
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">Specimen-specific questions to the submitting office.</p>
          </div>
          <SimulatedLabel connector="notifications" />
        </header>
        {c.clarifications.length === 0 ? (
          <p className="px-5 py-3 text-sm text-ink-secondary max-xl:px-4">No clarifications were raised for this case or its intake items.</p>
        ) : (
          <ul className="divide-y divide-line px-5 max-xl:px-4">
            {c.clarifications.map((x) => (
              <li key={x.id} className="grid grid-cols-1 gap-x-6 gap-y-1 py-3 text-sm lg:grid-cols-[minmax(0,1fr)_17rem]">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <LabelRef id={x.displayId} href={x.href} />
                    <StatePill domain="clarification" state={x.state} />
                    <span className="text-ink-secondary">{x.category}</span>
                  </p>
                  <p className="mt-1 text-ink-secondary">
                    <IdText text={x.subject} />
                  </p>
                  <p className="mt-0.5 max-w-[80ch] text-ink">{x.question}</p>
                </div>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 gap-y-0.5 text-ink">
                  <dt className="text-ink-muted">Lab owner</dt>
                  <dd>{x.labOwner ?? "Unknown"}</dd>
                  <dt className="text-ink-muted">Priority</dt>
                  <dd>{x.priority.charAt(0).toUpperCase() + x.priority.slice(1)}</dd>
                  <dt className="text-ink-muted">Opened</dt>
                  <dd>
                    <Timestamp iso={x.createdAt} now={now} />
                  </dd>
                  {x.open && x.nextFollowUpAt ? (
                    <>
                      <dt className="text-ink-muted">Next follow-up</dt>
                      <dd>
                        <Timestamp iso={x.nextFollowUpAt} now={now} />
                      </dd>
                    </>
                  ) : null}
                  {x.resolvedAt ? (
                    <>
                      <dt className="text-ink-muted">Resolved</dt>
                      <dd>
                        <Timestamp iso={x.resolvedAt} now={now} />
                      </dd>
                    </>
                  ) : null}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
