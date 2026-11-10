import { Info, TriangleAlert } from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/time";
import type { ContactsSettings } from "@/server/queries/settings";
import { compactHours } from "./bits";
import { ContactEditButton } from "./contact-editor";

export function ContactsTab({ data }: { data: ContactsSettings }) {
  const { now, offices } = data;
  return (
    <div className="grid grid-cols-1 gap-4">
      <AlertBanner tone="info" title="Fictional contacts; every channel is simulated">
        This directory decides who a clarification goes to: the primary contact, or the backup while the primary is out. Reminders repeat at most every {data.reminderMinutes} min and a
        second reminder inside the {data.suppressionMinutes}-minute duplicate-suppression window is not sent. First follow-up is due after {data.followUpMinutes.urgent} min (urgent),{" "}
        {data.followUpMinutes.high} min (high) or {data.followUpMinutes.routine} min (routine), within office hours. These are demo defaults to agree with the offices, not clinical rules.
      </AlertBanner>
      {offices.length ? (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          {offices.map((o) => (
            <Card
              key={o.officeId}
              headingLevel={2}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {o.officeName}
                  <span className="id-mono text-xs font-normal text-ink-muted">{o.officeCode}</span>
                  {o.officeStatus === "new_unreviewed" ? (
                    <StatusPill tone="warning" size="sm">
                      New office, not reviewed
                    </StatusPill>
                  ) : null}
                </span>
              }
              description={`Source tenant: ${o.tenantName}. Hours: ${o.workingHours ? compactHours(o.workingHours) : "Unknown (not on file)"}.`}
              flush
            >
              <div className="border-b border-line px-4 py-2 text-sm">
                {o.routesTo ? (
                  <p>
                    New clarifications go to <span className="font-medium">{o.routesTo}</span>.
                  </p>
                ) : null}
                {o.coverageGap ? (
                  // A backup covering is information, not a warning; an uncovered office is amber (clarifications may not reach anyone).
                  <p className={o.coverageCovered ? "mt-0.5 flex items-start gap-1.5 text-ink-secondary" : "mt-0.5 flex items-start gap-1.5 text-warning-fg"}>
                    {o.coverageCovered ? (
                      <Info className="mt-0.5 size-4 shrink-0 text-info-solid" aria-hidden />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
                    )}
                    {o.coverageGap}
                  </p>
                ) : null}
              </div>
              {o.contacts.length ? (
                <Table caption={`Contacts for ${o.officeName}`} wrapperClassName="rounded-none border-0">
                  <THead>
                    <tr>
                      <TH>Contact</TH>
                      <TH>Availability</TH>
                      <TH>
                        <span className="sr-only">Edit</span>
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {o.contacts.map((c) => (
                      <TR key={c.id}>
                        <TD wrap className="py-2">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-medium">{c.name}</span>
                            {c.isPrimary ? <StatusPill size="sm" tone="info">Primary</StatusPill> : null}
                            {c.isEscalation ? <StatusPill size="sm" tone="neutral">Escalation</StatusPill> : null}
                            {!c.isPrimary && !c.isEscalation ? <span className="text-xs text-ink-muted">Backup / coverage</span> : null}
                          </span>
                          <span className="block text-sm text-ink-muted">
                            {c.role}, {c.channelName}
                          </span>
                          {c.categories.length ? <span className="block text-xs text-ink-muted">Covers only: {c.categories.join(", ")}</span> : null}
                          {c.unverified ? <span className="block text-xs text-warning-fg">Unverified contact: delivery outcome stays unknown</span> : null}
                        </TD>
                        <TD wrap className="min-w-[9rem] py-2">
                          {c.outUntil ? (
                            <span className={c.isOutNow ? "font-semibold text-ink" : "text-ink-secondary"}>
                              {c.isOutNow ? "Out until " : "Was out until "}
                              {fmtDateTime(c.outUntil)} ET
                            </span>
                          ) : (
                            <span className="text-ink-secondary">Available</span>
                          )}
                          <span className="block text-xs text-ink-muted">Backup: {c.backupName ?? "none"}</span>
                        </TD>
                        <TD className="text-right">
                          <ContactEditButton
                            officeName={o.officeName}
                            contact={{
                              id: c.id,
                              name: c.name,
                              role: c.role,
                              isPrimary: c.isPrimary,
                              isEscalation: c.isEscalation,
                              outUntil: c.outUntil,
                              backupId: c.backupId,
                              version: c.version,
                            }}
                            colleagues={o.contacts.filter((x) => x.id !== c.id).map((x) => ({ id: x.id, name: x.name }))}
                            now={now}
                          />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <div className="p-4">
                  <EmptyState compact title="No contacts on file">
                    Clarifications for this office cannot be sent until a contact is added. Ask the office who answers specimen questions.
                  </EmptyState>
                </div>
              )}
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState title="No offices in the directory">Offices appear here once they are configured.</EmptyState>
      )}
    </div>
  );
}
