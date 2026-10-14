"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ScanLine, UserCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { QueueRow, SourceEntryRow, PartStateKey } from "@/server/queries/grossing";
import { useScanTarget, useFocusScanOnMount } from "@/lib/client/scan";
import { useSingleKey } from "@/lib/client/keyboard";
import { useCan, isReadOnlyRole, useActor } from "@/lib/client/shell-context";
import { CommandButton } from "@/components/ui/command-button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TBody, TD, TH, THead, TR, TableCount } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { AlertBanner } from "@/components/ui/alert-banner";
import type { Tone } from "@/components/ui/tone";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { Timestamp } from "@/components/domain/timestamp";
import { PROCEDURE } from "@/lib/domain";
import { scanToGrossingHref } from "./model";

const STATE_PILL: Record<PartStateKey, { label: string; tone: Tone; icon?: LucideIcon }> = {
  awaiting: { label: "Awaiting grossing", tone: "neutral" },
  on_hold: { label: "On hold", tone: "hold" },
  draft: { label: "Draft", tone: "neutral" },
  needs_clarification: { label: "Needs clarification", tone: "warning" },
  operator_reviewed: { label: "Operator reviewed", tone: "info" },
  approved_pending_entry: { label: "Approved, source update pending", tone: "warning" },
  approved_entered: { label: "Approved, entered (staff attested)", tone: "info", icon: UserCheck },
  approved_acknowledged: { label: "Approved, source acknowledged (simulated)", tone: "success" },
  canceled: { label: "Canceled", tone: "neutral" },
};

type Filter = "todo" | "held" | "approved" | "all";
/** Default view: exceptions (held, needs clarification) first, then work to do. */
const TODO: PartStateKey[] = ["needs_clarification", "on_hold", "draft", "operator_reviewed", "awaiting"];

/** "Dr. Elena Marsh" -> "Dr. Marsh" (the full name stays available to screen readers). */
function shortDoctor(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const parts = name.replace(/^Dr\.\s*/, "").split(/\s+/);
  return `Dr. ${parts[parts.length - 1]}`;
}

function partShort(state: PartStateKey): string {
  return state === "awaiting" ? "awaiting grossing" : state === "on_hold" ? "on hold" : state.startsWith("approved") ? "approved" : state.replace(/_/g, " ");
}

/** "Open part" scan target for the queue view. */
function useOpenPartScan() {
  useScanTarget(
    "Open part",
    (value, { navigate }) => {
      const r = scanToGrossingHref(value);
      if ("error" in r) return { tone: "danger", message: r.error, alert: true };
      navigate(r.href);
      return { tone: "success", message: r.message };
    },
    { placeholder: "Scan a cassette label or type D26-04817 A" },
  );
}

export function GrossingQueue({ rows, sourceRows, view, now }: { rows: QueueRow[]; sourceRows: SourceEntryRow[]; view: "bench" | "source"; now: string }) {
  useOpenPartScan();
  useFocusScanOnMount(true);
  const todoCount = rows.filter((r) => TODO.includes(r.state)).length;
  const pendingEntry = sourceRows.filter((r) => r.sourceUpdateState !== "entered_attested").length;
  return (
    <div className="flex flex-col gap-3">
      <Tabs
        label="Grossing views"
        active={view}
        items={[
          { key: "bench", label: "Bench queue", count: todoCount, href: "/grossing" },
          { key: "source", label: "Source entry", count: pendingEntry, href: "/grossing?view=source" },
        ]}
      />
      {view === "bench" ? <BenchQueue rows={rows} now={now} /> : <SourceEntryQueue rows={sourceRows} now={now} />}
    </div>
  );
}

function BenchQueue({ rows, now }: { rows: QueueRow[]; now: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("todo");
  const shown = useMemo(
    () =>
      rows.filter((r) =>
        filter === "all" ? true : filter === "todo" ? TODO.includes(r.state) : filter === "held" ? r.state === "on_hold" || r.holds.length > 0 : r.state.startsWith("approved"),
      ),
    [rows, filter],
  );
  const [cursor, setCursor] = useState(0);
  const sel = Math.min(cursor, Math.max(0, shown.length - 1));
  const open = (r: QueueRow | undefined) => r && router.push(`/grossing?part=${encodeURIComponent(r.ref)}`);
  useSingleKey({
    j: () => setCursor((c) => Math.min(c + 1, shown.length - 1)),
    k: () => setCursor((c) => Math.max(c - 1, 0)),
    ArrowDown: () => setCursor((c) => Math.min(c + 1, shown.length - 1)),
    ArrowUp: () => setCursor((c) => Math.max(c - 1, 0)),
    Enter: (e) => {
      if ((e.target as HTMLElement | null)?.closest?.("a,button,[role=tab],summary")) return;
      open(shown[sel]);
    },
  });

  const counts = {
    todo: rows.filter((r) => TODO.includes(r.state)).length,
    held: rows.filter((r) => r.state === "on_hold" || r.holds.length > 0).length,
    approved: rows.filter((r) => r.state.startsWith("approved")).length,
    all: rows.length,
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          label="Queue filter"
          size="sm"
          idBase="gross-filter"
          active={filter}
          onChange={(k) => {
            setFilter(k as Filter);
            setCursor(0);
          }}
          items={[
            { key: "todo", label: "Open work and holds", count: counts.todo },
            { key: "held", label: "On hold", count: counts.held },
            { key: "approved", label: "Approved", count: counts.approved },
            { key: "all", label: "All parts", count: counts.all },
          ]}
        />
        <TableCount shown={shown.length} total={rows.length} noun="parts" />
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No parts to gross today" icon={ScanLine}>
          Parts appear here after accessioning. Scan a cassette label or type an accession and part (for example D26-04817 A) to open one.
        </EmptyState>
      ) : (
        <Table
          caption="Grossing queue. Sorted: needs clarification and held parts first, then drafts, reviewed, awaiting grossing, and approved parts."
          scroll="page"
          wrapperClassName="max-xl:[&_[data-priority='3']]:hidden"
        >
          <THead>
            <tr>
              <TH stickyFirst>Part</TH>
              <TH>Site, procedure</TH>
              <TH priority={2}>Dermatopathologist</TH>
              <TH>Status</TH>
              <TH>What is next</TH>
              <TH priority={3}>Other parts of the case</TH>
            </tr>
          </THead>
          <TBody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-ink-secondary">
                  Nothing in this filter. Choose another filter above.
                </td>
              </tr>
            ) : null}
            {shown.map((r, i) => {
              const pill = STATE_PILL[r.state];
              const approvalHold = r.holds.find((h) => h.blocksApproval);
              const next =
                r.state === "on_hold" && approvalHold
                  ? `${approvalHold.displayId}: ${approvalHold.reasonText}${approvalHold.clarificationDisplayId ? ` (${approvalHold.clarificationDisplayId})` : ""}. Drafting allowed; approval blocked.`
                  : r.state === "awaiting"
                    ? "Start gross record"
                    : r.state === "draft" || r.state === "needs_clarification"
                      ? r.record && r.record.blockerCount
                        ? `${r.record.blockerCount} item${r.record.blockerCount === 1 ? "" : "s"} to confirm before review`
                        : "Ready to mark reviewed"
                      : r.state === "operator_reviewed"
                        ? "Ready to approve for downstream use"
                        : r.state === "approved_pending_entry"
                          ? "Source-system entry pending (Sam Ortiz)"
                          : r.state === "approved_entered"
                            ? "Awaiting source acknowledgment (simulated)"
                            : "Gross documentation done; downstream work continues";
              const href = `/grossing?part=${encodeURIComponent(r.ref)}`;
              return (
                <TR key={r.partId} interactive selected={i === sel} hold={r.holds.length > 0} onClick={() => open(r)}>
                  <TD stickyFirst>
                    <Link href={href} onClick={(e) => e.stopPropagation()} className="rounded-sm text-ink underline-offset-2 hover:underline">
                      <span className="id-mono font-semibold">{r.accessionNumber}</span> <span className="font-medium">Part {r.designation}</span>
                    </Link>
                    {r.priority === "rush" ? <span className="ml-1.5 text-xs font-semibold text-danger-fg">Rush</span> : null}
                  </TD>
                  <TD wrap className="min-w-[9rem]">
                    {r.site}, {r.procedure ? PROCEDURE[r.procedure as keyof typeof PROCEDURE]?.toLowerCase() ?? r.procedure : "procedure unknown"}
                  </TD>
                  <TD priority={2}>
                    <DoctorChip name={r.pathologist?.name ?? null} color={r.pathologist?.color} compact shortName={shortDoctor(r.pathologist?.name)} />
                  </TD>
                  <TD>
                    <StatusPill tone={pill.tone} icon={pill.icon}>
                      {pill.label}
                    </StatusPill>
                  </TD>
                  <TD wrap className="min-w-[13rem] text-ink-secondary">
                    {next}
                  </TD>
                  <TD priority={3} wrap className="min-w-[9rem] text-xs text-ink-secondary">
                    {r.otherParts.length ? r.otherParts.map((o) => `${o.designation}: ${partShort(o.state)}`).join(" · ") : "None"}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <p className="text-xs text-ink-muted">
        J/K or arrow keys move, Enter opens. Times are demo-clock times (ET). Now: <Timestamp iso={now} now={now} />.
      </p>
    </div>
  );
}

/** "EMA-SIM Sunrise Coast (simulated source adapter)" -> "EMA-SIM Sunrise Coast" (the page says "simulated" once). */
function shortSource(name: string | null | undefined): string {
  return (name ?? "Source system").replace(/\s*\(simulated[^)]*\)\s*$/i, "");
}

function SourceEntryQueue({ rows, now }: { rows: SourceEntryRow[]; now: string }) {
  const actor = useActor();
  const canSource = useCan("gross.recordSourceEntry");
  const readOnly = isReadOnlyRole(actor.role);
  const canAttest = !readOnly && canSource.allowed;
  const pending = rows.filter((r) => r.sourceUpdateState !== "entered_attested");
  // Newest attestation first, so the entry just made is on top when the group is opened.
  const attested = rows
    .filter((r) => r.sourceUpdateState === "entered_attested")
    .sort((a, b) => (b.enteredAt ?? "").localeCompare(a.enteredAt ?? ""));
  const offline = [...new Map(rows.filter((r) => r.sourceStatus === "offline").map((r) => [r.sourceName ?? "", r])).values()];
  return (
    <div className="flex flex-col gap-3">
      <AlertBanner tone="info" title="Manual entry in the source system (simulated)">
        Approved descriptions are typed into the patient&apos;s source system by hand. &quot;Mark entered&quot; records your attestation; only the simulated source can
        acknowledge it.
      </AlertBanner>
      {offline.map((o) => {
        const n = pending.filter((r) => r.sourceName === o.sourceName).length;
        return (
          <AlertBanner key={o.sourceName} tone="warning" title={`${shortSource(o.sourceName)} unreachable (simulated outage)`}>
            {o.sourceLastSuccessAt ? (
              <>
                Last synced <Timestamp iso={o.sourceLastSuccessAt} now={now} showAge />.{" "}
              </>
            ) : null}
            {n ? `${n} description${n === 1 ? "" : "s"} for this source show "source unreachable". ` : ""}
            Attest only an entry you actually typed into the source; its acknowledgment waits until the source is back.
          </AlertBanner>
        );
      })}
      {!canAttest ? (
        <p className="text-sm text-ink-secondary">
          {readOnly ? "Read only: you can view this queue but not attest entries." : `${canSource.reason} Entries are attested by the histology assistant or a supervisor.`}
        </p>
      ) : null}

      <section aria-labelledby="se-pending" className="flex flex-col gap-1.5">
        <h2 id="se-pending" className="text-md font-semibold text-ink">
          Waiting for entry <span className="font-normal text-ink-secondary">({pending.length})</span>
        </h2>
        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting for source entry">
            Approved gross records appear here as soon as each part is approved, without waiting for the whole day&apos;s batch.
          </EmptyState>
        ) : (
          <Table caption="Approved gross descriptions waiting for source-system entry, oldest approval first." wrapperClassName="max-xl:[&_[data-priority='3']]:hidden">
            <THead>
              <tr>
                <TH stickyFirst>Part</TH>
                <TH>Approved</TH>
                <TH>Source update</TH>
                <TH priority={3}>Owner</TH>
                {canAttest ? <TH>Action</TH> : null}
              </tr>
            </THead>
            <TBody>
              {pending.map((r) => {
                const unreachable = r.sourceStatus === "offline";
                return (
                  <TR key={r.recordId}>
                    <TD stickyFirst>
                      <PartLink r={r} />
                    </TD>
                    <TD wrap>
                      <Timestamp iso={r.approvedAt} now={now} showAge />
                      <span className="block text-xs text-ink-muted">by {r.approvedBy ?? "Unknown"}</span>
                    </TD>
                    <TD wrap>
                      {r.sourceUpdateState === "failed" ? (
                        <StatusPill tone="danger" size="sm">Source update failed</StatusPill>
                      ) : (
                        <StatusPill tone="warning" size="sm">Source update pending</StatusPill>
                      )}
                      <span className={cn("block text-xs", unreachable ? "font-medium text-warning-fg" : "text-ink-muted")}>
                        {unreachable ? `Source unreachable: ${shortSource(r.sourceName)}` : shortSource(r.sourceName ?? r.tenantName)}
                      </span>
                    </TD>
                    <TD priority={3} className="text-ink-secondary">{r.taskOwner ?? "Unassigned"}</TD>
                    {canAttest ? (
                      <TD>
                        <CommandButton
                          command="gross.recordSourceEntry"
                          input={{ grossRecordId: r.recordId, expectedVersion: r.version }}
                          size="sm"
                          variant="secondary"
                          pendingLabel="Recording..."
                          successToast={`${r.accessionNumber} part ${r.designation}: entered (staff attested). Not acknowledged by the source yet.`}
                          aria-label={`Mark ${r.accessionNumber} part ${r.designation} entered in the source system (staff attestation)`}
                        >
                          Mark entered
                        </CommandButton>
                      </TD>
                    ) : null}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </section>

      {attested.length ? (
        <details className="group rounded-md border border-line bg-surface">
          <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium text-ink hover:bg-surface-subtle">
            Entered (staff attested), awaiting acknowledgment <span className="font-normal text-ink-secondary">({attested.length})</span>
            <span className="ml-2 font-normal text-ink-muted">Done on our side; newest first</span>
          </summary>
          <div className="border-t border-line p-2">
            <Table caption="Gross descriptions staff attested as entered, waiting for the simulated source to acknowledge them. Newest attestation first." className="text-sm">
              <THead>
                <tr>
                  <TH stickyFirst>Part</TH>
                  <TH>Entered (staff attested)</TH>
                  <TH priority={3}>Source system</TH>
                  <TH>Acknowledgment (simulated)</TH>
                </tr>
              </THead>
              <TBody>
                {attested.map((r) => {
                  const unreachable = r.sourceStatus === "offline";
                  return (
                    <TR key={r.recordId}>
                      <TD stickyFirst>
                        <PartLink r={r} />
                      </TD>
                      <TD wrap>
                        <StatusPill tone="info" icon={UserCheck} size="sm">
                          Entered (staff attested)
                        </StatusPill>
                        <span className="block text-xs text-ink-muted">
                          {r.enteredBy ?? "Unknown"}, <Timestamp iso={r.enteredAt} now={now} />
                        </span>
                      </TD>
                      <TD priority={3} className="text-ink-secondary">{shortSource(r.sourceName ?? r.tenantName)}</TD>
                      <TD wrap>
                        {readOnly ? (
                          <span className="text-xs text-ink-muted">Not acknowledged</span>
                        ) : unreachable ? (
                          <span className="text-xs text-warning-fg">Not acknowledged. Source unreachable; it cannot acknowledge until it is back.</span>
                        ) : (
                          <CommandButton
                            command="gross.simulateSourceAck"
                            input={{ grossRecordId: r.recordId }}
                            size="sm"
                            variant="quiet"
                            pendingLabel="Simulating..."
                            successToast="Simulated source acknowledgment recorded"
                            aria-label={`Simulate the source acknowledgment for ${r.accessionNumber} part ${r.designation} (demo)`}
                          >
                            Simulate acknowledgment
                          </CommandButton>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function PartLink({ r }: { r: SourceEntryRow }) {
  return (
    <span className="whitespace-nowrap">
      <Link href={`/grossing?part=${encodeURIComponent(r.ref)}`} className="rounded-sm text-ink underline-offset-2 hover:underline">
        <span className="id-mono font-semibold">{r.accessionNumber}</span> <span className="font-medium">Part {r.designation}</span>
      </Link>
      <span className="ml-1 text-xs text-ink-muted">v{r.recordVersion}</span>
    </span>
  );
}
