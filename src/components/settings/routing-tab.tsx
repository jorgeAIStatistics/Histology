import Link from "next/link";
import { CircleCheck, Lock, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { Timestamp } from "@/components/domain/timestamp";
import { fmtDate, fmtDateTime } from "@/lib/time";
import type { RoutingSettings, RuleSetView } from "@/server/queries/settings";
import { CoverageForm, DraftDecision, DraftRuleSetForm, RetireCoverageButton } from "./routing-forms";

function SetStatus({ set }: { set: RuleSetView }) {
  if (set.status === "draft") return <StatusPill tone="info">Draft, needs approval</StatusPill>;
  if (set.discarded) return <StatusPill tone="neutral">Discarded draft</StatusPill>;
  if (set.status === "retired") return <StatusPill tone="neutral">Retired</StatusPill>;
  // Done is a quiet check (never green): the version in effect is settled, nothing to act on.
  if (set.inEffect)
    return (
      <StatusPill tone="neutral" icon={CircleCheck}>
        Approved, in effect
      </StatusPill>
    );
  return <StatusPill tone="info">Approved, starts later</StatusPill>;
}

/** "Dr. Elena Marsh" → "Dr. Marsh" (the full name stays in the tooltip). */
function shortDr(name: string): string {
  return name.startsWith("Dr. ") ? `Dr. ${name.split(" ").pop()}` : name;
}

/** "Oct 16–17" for whole days, otherwise "Oct 16, 9:00 AM – Oct 17, 5:00 PM ET". */
function coverageDates(startsAt: string, endsAt: string): string {
  const s = fmtDateTime(startsAt);
  const e = fmtDateTime(endsAt);
  const wholeDays = /12:00\s?AM$/.test(s) && /11:59\s?PM$/.test(e);
  if (!wholeDays) return `${s} – ${e} ET`;
  const sd = fmtDate(startsAt);
  const ed = fmtDate(endsAt);
  if (sd === ed) return sd;
  const [sm, sday] = sd.split(" ");
  const [em, eday] = ed.split(" ");
  return sm === em && sday && eday ? `${sm} ${sday}–${eday}` : `${sd} – ${ed}`;
}

function period(set: RuleSetView): string {
  if (set.discarded) return "Never in effect";
  return `${fmtDate(set.effectiveFrom)} → ${set.effectiveTo ? fmtDateTime(set.effectiveTo) : "open-ended"}`;
}

export function RoutingTab({
  data,
  draftOffice: requestedOffice,
  canEdit = true,
  canApprove = true,
}: {
  data: RoutingSettings;
  draftOffice?: string | null;
  /** routing.editRules (supervisor). Without it the draft form collapses to one line saying who drafts. */
  canEdit?: boolean;
  /** routing.approveRules (medical director, supervisor). Without it the coverage form is not offered. */
  canApprove?: boolean;
}) {
  const { current, latestApproved, draft, history, coverage, unknownOffices, now, pathologists } = data;
  // "Draft a rule" pre-selects an unknown office; once that office has an approved rule the pre-selection is dropped.
  const draftOffice = requestedOffice && unknownOffices.some((o) => o.officeId === requestedOffice) ? requestedOffice : null;
  // New drafts copy the newest approved version; it differs from `current` only when an approved version starts later.
  const base = latestApproved ?? current;
  const upcoming = latestApproved && latestApproved.id !== current?.id ? latestApproved : null;
  const upcomingCoverage = coverage.filter((c) => c.status === "approved" && c.endsAt > now);
  const coverageFor = (pathologistName: string) => upcomingCoverage.filter((c) => c.pathologistName === pathologistName);
  const nextVersion = Math.max(0, ...history.map((h) => h.version)) + 1;
  const officeOptions = data.offices.map((o) => ({ id: o.id, name: o.name, current: base?.rules.find((r) => r.officeId === o.id)?.pathologistName ?? null }));

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="grid grid-cols-1 content-start gap-4">
          <Card
            title={current ? <>Approved rules in effect: <span className="id-mono">v{current.version}</span></> : "No approved routing rules in effect"}
            description={
              current ? (
                <>
                  Effective {fmtDate(current.effectiveFrom)}
                  {current.approvedBy ? <>, approved by {current.approvedBy}{current.approvedAt ? ` on ${fmtDate(current.approvedAt)}` : ""}</> : null}. Each office routes to
                  one assigned dermatopathologist; suggestions at intake show this rule and version.
                </>
              ) : (
                "Every new item goes to the routing exception lane until a version is approved."
              )
            }
            actions={
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                <Lock className="size-3.5" aria-hidden /> Frozen once approved
              </span>
            }
            flush
          >
            {upcoming ? (
              <div className="border-b border-line px-4 py-2 text-sm text-ink-secondary">
                Approved <span className="id-mono">v{upcoming.version}</span> takes effect {fmtDateTime(upcoming.effectiveFrom)} ET. New drafts start from{" "}
                <span className="id-mono">v{upcoming.version}</span>.
              </div>
            ) : null}
            {current ? (
              <Table caption={`Routing rules v${current.version}: office to assigned dermatopathologist, with coverage exceptions`} wrapperClassName="rounded-none border-0">
                <THead>
                  <tr>
                    <TH>Office and source tenant</TH>
                    <TH>Assigned dermatopathologist</TH>
                    <TH>Planned coverage</TH>
                  </tr>
                </THead>
                <TBody>
                  {current.rules.map((r) => {
                    const cov = coverageFor(r.pathologistName);
                    return (
                      // Two-line cells get vertical padding so each row reads as one record between its hairlines.
                      <TR key={r.ruleId}>
                        <TD className="py-2">
                          {r.officeName} <span className="id-mono text-xs text-ink-muted">{r.officeCode}</span>
                          <span className="block text-xs text-ink-muted">{r.tenantName}</span>
                        </TD>
                        <TD className="py-2">
                          <DoctorChip name={r.pathologistName} color={r.pathologistColor} />
                        </TD>
                        <TD wrap className="py-2">
                          {cov.length ? (
                            cov.map((c) => (
                              <span key={c.id} className="block">
                                {c.activeNow ? <span className="font-semibold text-ink">Now: </span> : null}
                                {c.coveringName}, <span className="whitespace-nowrap">{coverageDates(c.startsAt, c.endsAt)}</span>
                              </span>
                            ))
                          ) : (
                            <span className="text-ink-muted">None</span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            ) : (
              <div className="p-4">
                <EmptyState title="No approved rules">Draft a version and have it approved by the medical director or the operations supervisor.</EmptyState>
              </div>
            )}
          </Card>
          <Card
            title="Coverage exceptions"
            description="Planned absences and who covers them. Applied to new items received during the period."
            flush
            footer={
              canApprove ? (
                <details>
                  <summary className="flex min-h-[max(2rem,var(--hlo-target-min))] cursor-pointer items-center text-sm font-medium text-brand">Add a coverage exception</summary>
                  <div className="mt-3">
                    <CoverageForm pathologists={pathologists} now={now} />
                  </div>
                </details>
              ) : (
                <p className="text-xs text-ink-secondary">The medical director or the operations supervisor adds and retires coverage exceptions.</p>
              )
            }
          >
            {coverage.length ? (
              <Table caption="Coverage exceptions, newest first" wrapperClassName="rounded-none border-0">
                <THead>
                  <tr>
                    <TH>Absent → covering</TH>
                    <TH>Period (ET)</TH>
                    <TH>Status</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </tr>
                </THead>
                <TBody>
                  {coverage.map((c) => (
                    <TR key={c.id} canceled={c.status !== "approved"}>
                      <TD wrap className="py-2">
                        <span className="flex flex-wrap items-center gap-x-1.5">
                          <DoctorChip name={c.pathologistName} color={c.pathologistColor} shortName={shortDr(c.pathologistName)} compact />
                          <span aria-hidden className="text-ink-muted">→</span>
                          <span className="sr-only">covered by</span>
                          <DoctorChip name={c.coveringName} color={c.coveringColor} shortName={shortDr(c.coveringName)} compact />
                        </span>
                        <span className="block text-xs text-ink-muted">{c.reason}</span>
                      </TD>
                      <TD>
                        <span className="whitespace-nowrap" title={`${fmtDateTime(c.startsAt)} – ${fmtDateTime(c.endsAt)} ET`}>
                          {coverageDates(c.startsAt, c.endsAt)}
                        </span>
                      </TD>
                      <TD>
                        {c.status !== "approved" ? (
                          <StatusPill tone="neutral" size="sm">Retired</StatusPill>
                        ) : c.activeNow ? (
                          <StatusPill tone="info" size="sm">In effect now</StatusPill>
                        ) : c.endsAt <= now ? (
                          <StatusPill tone="neutral" size="sm">Ended</StatusPill>
                        ) : (
                          <StatusPill tone="info" size="sm">Approved, upcoming</StatusPill>
                        )}
                      </TD>
                      <TD>{c.status === "approved" && c.endsAt > now ? <RetireCoverageButton coverageId={c.id} label={`${c.coveringName} for ${c.pathologistName}`} /> : null}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <div className="p-4">
                <EmptyState compact title="No coverage exceptions">Add one when a dermatopathologist has a planned absence.</EmptyState>
              </div>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 content-start gap-4">
          <Card
            title="Unknown offices"
            description="Offices without an approved rule. New items from them go to the routing exception lane; no dermatopathologist is guessed."
            flush
          >
            {unknownOffices.length ? (
              <ul className="divide-y divide-line">
                {unknownOffices.map((o) => (
                  <li key={o.key} className="flex items-start gap-3 px-4 py-3">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">
                        {o.name}
                        {o.tenantName ? <span className="ml-1 text-xs font-normal text-ink-muted">({o.tenantName})</span> : null}
                      </p>
                      <p className="text-sm text-ink-secondary">
                        {o.reason} Items in the exception lane now: <span className="num-tabular">{o.exceptionItems}</span>.
                      </p>
                    </div>
                    {o.officeId && !draft && canEdit ? (
                      <Link
                        className="inline-flex min-h-[max(2rem,var(--hlo-target-min))] shrink-0 items-center text-sm font-medium text-brand underline-offset-2 hover:underline"
                        href={`/settings?tab=routing&draftOffice=${encodeURIComponent(o.officeId)}#draft`}
                      >
                        Draft a rule
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4">
                <EmptyState compact title="Every office has an approved rule">
                  New offices appear here until a rule is approved for them.
                </EmptyState>
              </div>
            )}
          </Card>

          {draft ? (
            <Card
              title={<>Draft <span className="id-mono">v{draft.version}</span> waiting for approval</>}
              description={draft.notes ?? undefined}
            >
              <div className="grid grid-cols-1 gap-4">
                <Table caption={`Changes in draft v${draft.version} compared with v${draft.diffBaseVersion ?? "none"}`} captionVisible wrapperClassName="rounded-none border-x-0">
                  <THead>
                    <tr>
                      <TH>Office</TH>
                      <TH>{draft.diffBaseVersion && draft.diffBaseVersion !== current?.version ? `Approved (v${draft.diffBaseVersion})` : <>Now (v{draft.diffBaseVersion ?? "–"})</>}</TH>
                      <TH>Draft (v{draft.version})</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {(draft.diff ?? []).map((d) => (
                      <TR key={d.officeName}>
                        <TD>{d.officeName}</TD>
                        <TD>{d.from ?? <span className="text-ink-muted">No rule (exception lane)</span>}</TD>
                        <TD className="font-medium">{d.to ?? <span className="text-warning-fg">No rule (exception lane)</span>}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <DraftDecision ruleSetId={draft.id} version={draft.version} currentVersion={draft.diffBaseVersion ?? null} now={now} />
              </div>
            </Card>
          ) : (
            <Card title="Draft a new version" description="Approved rules cannot be edited. A change is a new version that needs a reason and approval.">
              {canEdit ? (
                <DraftRuleSetForm
                  key={draftOffice ?? "none"}
                  offices={officeOptions}
                  pathologists={pathologists}
                  nextVersion={nextVersion}
                  baseVersion={base?.version ?? null}
                  initialOfficeId={draftOffice}
                />
              ) : (
                <p className="flex items-start gap-2 text-sm text-ink-secondary">
                  <Lock className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                  <span>
                    The operations supervisor drafts a new version; the medical director or the supervisor approves it. There is no draft waiting for approval.
                  </span>
                </p>
              )}
            </Card>
          )}
        </div>
      </div>

      <Card title="Version history" description="Every version is kept. Approved and retired versions are read only (enforced by the database)." flush>
        <Table caption="Routing rule versions, newest first">
          <THead>
            <tr>
              <TH>Version</TH>
              <TH>Status</TH>
              <TH>Effective period</TH>
              <TH>Approved</TH>
              <TH>Notes</TH>
              <TH>Rules</TH>
            </tr>
          </THead>
          <TBody>
            {history.map((h) => (
              <TR key={h.id} selected={h.inEffect}>
                <TD className="id-mono font-medium">v{h.version}</TD>
                <TD>
                  <SetStatus set={h} />
                </TD>
                <TD wrap>{period(h)}</TD>
                <TD wrap>{h.approvedBy && h.approvedAt ? <>{h.approvedBy}, <Timestamp iso={h.approvedAt} now={now} /></> : <span className="text-ink-muted">Not approved</span>}</TD>
                <TD wrap className="max-w-[44ch] text-ink-secondary">
                  {h.notes ?? <span className="text-ink-muted">None</span>}
                </TD>
                <TD>
                  <details>
                    <summary className="flex min-h-[max(1.75rem,var(--hlo-target-min))] cursor-pointer items-center text-sm text-brand">
                      {h.rules.length} rule{h.rules.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-1 grid gap-0.5 text-sm">
                      {h.rules.map((r) => (
                        <li key={r.ruleId} className="flex items-center gap-2">
                          <span className="text-ink-secondary">{r.officeName}</span> → <DoctorChip name={r.pathologistName} color={r.pathologistColor} compact />
                        </li>
                      ))}
                    </ul>
                  </details>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <AlertBanner tone="info" title="How routing rules are used">
        Intake suggests a dermatopathologist from the version in effect when the item is received and shows the rule and version. An unknown office gets no suggestion. An override needs an
        accessioning lead or supervisor and a reason. Approving a new version does not re-route items already received. This demo&apos;s role selector is not authentication; the server checks
        the role on every change.
      </AlertBanner>
    </div>
  );
}
