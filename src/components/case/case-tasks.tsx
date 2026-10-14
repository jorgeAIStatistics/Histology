import Link from "next/link";
import { Card, StatePill, StatusPill, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { IdChip, Timestamp } from "@/components/domain";
import type { Role } from "@/lib/roles";
import type { CaseDetail } from "@/server/queries/case";
import { TaskActions } from "@/components/worklist/task-actions";

/** Tasks (with owners, open first) and clarifications, each linked to its record. */
export function CaseTasks({ c, actor }: { c: CaseDetail; actor: { id: string; role: Role } }) {
  const now = c.generatedAt;
  return (
    <div className="flex flex-col gap-4">
      <Card title="Tasks" description="Who owns the next step. Done and canceled tasks stay listed for traceability." flush>
        {c.tasks.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-secondary">No tasks have been opened for this case.</p>
        ) : (
          <Table caption={`Tasks for ${c.identity.accessionNumber}, open first`} scroll="container" wrapperClassName="rounded-none border-0">
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
                const open = t.status === "open" || t.status === "in_progress";
                return (
                  <TR key={t.id} canceled={!open}>
                    <TD wrap className="min-w-56">
                      {t.href ? (
                        <Link href={t.href} className="font-medium text-brand underline-offset-2 hover:underline">
                          {t.title}
                        </Link>
                      ) : (
                        t.title
                      )}
                    </TD>
                    <TD>{t.partDesignation ? `Part ${t.partDesignation}` : <span className="text-ink-muted">Case</span>}</TD>
                    <TD>{t.ownerName ?? <span className="text-ink-muted">Unassigned ({(t.ownerRole ?? "role unknown").replace(/_/g, " ")})</span>}</TD>
                    <TD>
                      <StatusPill tone={open ? (t.status === "in_progress" ? "info" : "neutral") : t.status === "done" ? "success" : "neutral"}>
                        {t.status === "in_progress" ? "In progress" : t.status === "open" ? "Open" : t.status === "done" ? "Done" : "Canceled"}
                      </StatusPill>
                    </TD>
                    <TD wrap className="min-w-44">
                      {open ? <TaskActions task={t} actor={actor} /> : null}
                    </TD>
                    <TD>
                      <Timestamp iso={t.createdAt} now={now} />
                    </TD>
                    <TD wrap className="min-w-40">
                      {t.completedAt ? (
                        <>
                          <Timestamp iso={t.completedAt} now={now} />
                          {t.completedBy ? <span className="whitespace-nowrap text-ink-muted"> by {t.completedBy}</span> : null}
                          {t.closedNote ? <span className="block text-xs text-ink-muted">{t.closedNote}</span> : null}
                        </>
                      ) : (
                        <>
                          <span aria-hidden className="text-ink-muted">—</span>
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
      </Card>

      <Card title="Clarifications" description="Specimen-specific questions to the submitting office (notifications simulated).">
        {c.clarifications.length === 0 ? (
          <p className="text-sm text-ink-secondary">No clarifications were raised for this case or its intake items.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {c.clarifications.map((x) => (
              <li key={x.id}>
                <p className="flex flex-wrap items-center gap-2">
                  <IdChip kind="CLR" id={x.displayId} href={x.href} />
                  <StatePill domain="clarification" state={x.state} />
                  <span className="text-ink-secondary">{x.category}</span>
                  <span className="text-ink-secondary">· {x.subject}</span>
                </p>
                <p className="mt-0.5 text-ink">{x.question}</p>
                <p className="text-xs text-ink-secondary">
                  Lab owner: {x.labOwner ?? "Unknown"} · priority {x.priority} · opened <Timestamp iso={x.createdAt} now={now} />
                  {x.open && x.nextFollowUpAt ? (
                    <>
                      {" "}
                      · next follow-up <Timestamp iso={x.nextFollowUpAt} now={now} />
                    </>
                  ) : null}
                  {x.resolvedAt ? (
                    <>
                      {" "}
                      · resolved <Timestamp iso={x.resolvedAt} now={now} />
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
