"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Hourglass, ScanLine, TriangleAlert, UserCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import type { QueueRow, SourceEntryRow, PartStateKey } from "@/server/queries/grossing";
import { useScanTarget, useFocusScanOnMount } from "@/lib/client/scan";
import { useSingleKey } from "@/lib/client/keyboard";
import { useCan, isReadOnlyRole, useActor } from "@/lib/client/shell-context";
import { CommandButton } from "@/components/ui/command-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR, TableCount } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageBody } from "@/components/ui/page-header";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { IdText } from "@/components/domain/id-text";
import { ReadOnlyTag, SimulatedLabel } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { PROCEDURE } from "@/lib/domain";
import { scanToGrossingHref } from "./model";
import { PART_STATE_LABEL, PartStateIcon } from "./parts-strip";

type Filter = "todo" | "held" | "approved" | "all";
type GroupKey = "now" | "held" | "awaiting" | "approved";

/** Rows grouped by who acts next: records a grosser can move now, held parts, parts not started, approved parts. */
const GROUPS: { key: GroupKey; title: string; note: string; states: PartStateKey[] }[] = [
  { key: "now", title: "Needs a grosser now", note: "Drafts, flagged drafts and reviewed records", states: ["needs_clarification", "draft", "operator_reviewed"] },
  { key: "held", title: "On hold", note: "Drafting can continue; approval waits for the hold", states: ["on_hold"] },
  { key: "awaiting", title: "Awaiting grossing", note: "No gross record yet", states: ["awaiting"] },
  { key: "approved", title: "Approved today or waiting for source entry", note: "Downstream work has started", states: ["approved_pending_entry", "approved_entered", "approved_acknowledged"] },
];
const FILTER_GROUPS: Record<Filter, GroupKey[]> = { todo: ["now", "held", "awaiting"], held: ["held"], approved: ["approved"], all: ["now", "held", "awaiting", "approved"] };
const COLS = 7;

/** "Dr. Elena Marsh" -> "Dr. Marsh" (the full name stays available to screen readers). */
function shortDoctor(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const parts = name.replace(/^Dr\.\s*/, "").split(/\s+/);
  return `Dr. ${parts[parts.length - 1]}`;
}

function partShort(state: PartStateKey): string {
  return state === "awaiting"
    ? "awaiting"
    : state === "on_hold"
      ? "on hold"
      : state === "approved_acknowledged"
        ? "acknowledged"
        : state === "approved_entered"
          ? "entered"
          : state.startsWith("approved")
            ? "approved"
            : state === "operator_reviewed"
              ? "reviewed"
              : state.replace(/_/g, " ");
}

/** The record state in words, with the open-value count for drafts (counts by kind, never a score). */
function recordText(r: QueueRow): string {
  const n = r.record?.blockerCount ?? 0;
  if ((r.state === "draft" || r.state === "on_hold") && r.record && n) return `${r.state === "on_hold" ? "On hold, draft" : "Draft"}, ${n}\u00A0open item${n === 1 ? "" : "s"}`;
  if (r.state === "on_hold") return r.record ? "On hold, draft ready" : "On hold, not started";
  if (r.state === "draft") return "Draft, ready for review";
  return PART_STATE_LABEL[r.state];
}

/** What happens next and who does it. */
function nextStep(r: QueueRow): { what: string; who: string } {
  const approvalHold = r.holds.find((h) => h.blocksApproval);
  const grosser = r.record?.grosser ?? "Grosser on duty";
  if (r.state === "on_hold" && approvalHold) {
    return {
      what: `${approvalHold.displayId}: ${approvalHold.reasonText}${approvalHold.clarificationDisplayId ? ` (${approvalHold.clarificationDisplayId})` : ""}. Drafting allowed; approval blocked.`,
      who: approvalHold.owner ?? "Owner unknown",
    };
  }
  switch (r.state) {
    case "awaiting":
      return { what: "Start the gross record", who: "Grosser on duty" };
    case "needs_clarification":
      return { what: "Record how the question was resolved", who: grosser };
    case "draft":
      return r.record && r.record.blockerCount
        ? { what: `Complete ${r.record.blockerCount}\u00A0open item${r.record.blockerCount === 1 ? "" : "s"} before review`, who: grosser }
        : { what: "Mark operator reviewed", who: grosser };
    case "operator_reviewed":
      return { what: "Approve for downstream use", who: grosser };
    case "approved_pending_entry":
      return { what: "Enter it in the source system by hand", who: r.sourceEntryOwner ?? "Histology assistant" };
    case "approved_entered":
      return { what: "Acknowledge the entry", who: "Simulated source" };
    case "approved_acknowledged":
      return { what: "Nothing left on the gross record", who: "None" };
    default:
      return { what: "No gross work", who: "None" };
  }
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

export function GrossingQueue({
  rows,
  sourceRows,
  view,
  now,
  readOnly = false,
  notice,
}: {
  rows: QueueRow[];
  sourceRows: SourceEntryRow[];
  view: "bench" | "source";
  now: string;
  readOnly?: boolean;
  /** A message from the server (part not found), shown above the queue. */
  notice?: ReactNode;
}) {
  useOpenPartScan();
  useFocusScanOnMount(true);
  const todoCount = rows.filter((r) => FILTER_GROUPS.todo.some((g) => GROUPS.find((x) => x.key === g)!.states.includes(r.state))).length;
  const pendingEntry = sourceRows.filter((r) => r.sourceUpdateState !== "entered_attested").length;
  const needNow = rows.filter((r) => GROUPS[0].states.includes(r.state)).length;
  const held = rows.filter((r) => r.state === "on_hold").length;
  const awaiting = rows.filter((r) => r.state === "awaiting").length;
  const lead = needNow ? `${needNow}\u00A0gross record${needNow === 1 ? " needs" : "s need"} a grosser now.` : "No gross record is waiting on a grosser.";
  const then = `${held}\u00A0part${held === 1 ? "" : "s"} on hold, ${awaiting}\u00A0awaiting grossing, ${pendingEntry}\u00A0approved description${pendingEntry === 1 ? "" : "s"} waiting for source entry.`;
  return (
    <div className="flex flex-col">
      <section aria-label="Grossing summary" className="border-b border-line bg-surface px-6 pt-4 max-xl:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Grossing</h1>
          {readOnly ? <ReadOnlyTag /> : null}
        </div>
        <p className="mt-1.5 max-w-[80ch] text-lg tracking-[-0.005em]">
          <span className="font-semibold text-ink">{lead}</span> <span className="text-ink-muted">{then}</span>
        </p>
        <p className="mt-1 max-w-[80ch] text-sm text-ink-secondary">
          One reviewed gross record per part; approved parts move on while unfinished parts stay visible. Scan a cassette label or type an accession and part (D26-04817 A)
          to open it.
        </p>
        <Tabs
          className="mt-3"
          label="Grossing views"
          active={view}
          items={[
            { key: "bench", label: "Bench queue", count: todoCount, href: "/grossing" },
            { key: "source", label: "Source entry", count: pendingEntry, href: "/grossing?view=source" },
          ]}
        />
      </section>
      <PageBody className="gap-4">
        {notice}
        {view === "bench" ? <BenchQueue rows={rows} now={now} /> : <SourceEntryQueue rows={sourceRows} now={now} />}
      </PageBody>
    </div>
  );
}

function BenchQueue({ rows, now }: { rows: QueueRow[]; now: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("todo");
  const groups = useMemo(
    () =>
      GROUPS.filter((g) => FILTER_GROUPS[filter].includes(g.key))
        .map((g) => ({ ...g, rows: rows.filter((r) => g.states.includes(r.state)) }))
        .filter((g) => g.rows.length),
    [rows, filter],
  );
  const shown = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
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
    todo: rows.filter((r) => FILTER_GROUPS.todo.some((g) => GROUPS.find((x) => x.key === g)!.states.includes(r.state))).length,
    held: rows.filter((r) => r.state === "on_hold").length,
    approved: rows.filter((r) => r.state.startsWith("approved")).length,
    all: rows.length,
  };

  if (rows.length === 0) {
    return (
      <EmptyState title="No parts to gross today" icon={ScanLine}>
        Parts appear here after accessioning. Scan a cassette label or type an accession and part (for example D26-04817 A) to open one.
      </EmptyState>
    );
  }

  let index = -1;
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
      <Table
        caption="Grossing queue, grouped by who acts next: records a grosser can move now, held parts, parts awaiting grossing, then approved parts."
        scroll="page"
        // Narrower than 1024px (a bench screen at 200% zoom) the owner folds into the next-step cell and the columns relax,
        // so every column still fits without sideways scrolling.
        wrapperClassName="max-xl:[&_[data-priority='3']]:hidden max-[68.75rem]:[&_[data-priority='2']]:hidden max-[63.99875rem]:[&_[data-col='owner']]:hidden"
      >
        <THead>
          <tr>
            <TH stickyFirst className="max-xl:min-w-[13.75rem] max-[63.99875rem]:min-w-0">
              Part
            </TH>
            <TH>Site, procedure</TH>
            <TH priority={2}>Dermatopathologist</TH>
            <TH>Gross record</TH>
            <TH>Next step</TH>
            <TH data-col="owner">Owner</TH>
            <TH priority={3}>Other parts of the case</TH>
          </tr>
        </THead>
        {groups.length === 0 ? (
          <TBody>
            <tr>
              <td colSpan={COLS} className="px-3 py-6 text-center text-sm text-ink-secondary">
                Nothing in this filter. Choose another filter above.
              </td>
            </tr>
          </TBody>
        ) : null}
        {groups.map((g) => (
          <TBody key={g.key}>
            <tr>
              <th colSpan={COLS} scope="colgroup" className="border-b border-line bg-surface-subtle px-3 pt-3 pb-1.5 text-left">
                <span className="text-sm font-semibold text-ink">{g.title}</span>{" "}
                <span className="text-sm font-normal text-ink-muted">
                  ({g.rows.length}) {g.note}
                </span>
              </th>
            </tr>
            {g.rows.map((r) => {
              index += 1;
              const i = index;
              const next = nextStep(r);
              const href = `/grossing?part=${encodeURIComponent(r.ref)}`;
              const amber = r.state === "needs_clarification";
              const selected = i === sel;
              const held = r.holds.length > 0;
              return (
                <TR key={r.partId} interactive selected={selected} hold={held} onClick={() => open(r)}>
                  <TD stickyFirst className="py-1.5">
                    <Link href={href} onClick={(e) => e.stopPropagation()} className="rounded-sm text-ink underline-offset-2 hover:underline">
                      <span className="id-mono font-semibold">{r.accessionNumber}</span> <span className="font-medium">Part {r.designation}</span>
                    </Link>
                    {r.priority === "rush" ? <span className="ml-1.5 text-xs font-semibold text-danger-fg">Rush</span> : null}
                    {/* Below 1280px the "Other parts" column folds into the part cell. */}
                    {r.otherParts.length ? (
                      <ul className="mt-0.5 flex flex-wrap gap-x-2 text-sm whitespace-normal text-ink-secondary min-[80rem]:hidden" aria-label="Other parts of the case">
                        {r.otherParts.map((o) => (
                          <li key={o.designation} className="inline-flex items-center gap-1">
                            <PartStateIcon state={o.state} className="size-3.5" />
                            <span className="font-medium text-ink">{o.designation}</span> {partShort(o.state)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </TD>
                  <TD wrap className="min-w-[9rem] py-1.5 max-[63.99875rem]:min-w-[7rem]">
                    {r.site}, {r.procedure ? (PROCEDURE[r.procedure as keyof typeof PROCEDURE]?.toLowerCase() ?? r.procedure) : "procedure unknown"}
                  </TD>
                  <TD priority={2}>
                    <DoctorChip name={r.pathologist?.name ?? null} color={r.pathologist?.color} compact shortName={shortDoctor(r.pathologist?.name)} />
                  </TD>
                  <TD wrap className="min-w-[10rem] py-1.5 max-[63.99875rem]:min-w-[8rem]">
                    <span className={cn("inline-flex items-start gap-1.5", amber ? "font-semibold text-warning-fg" : r.state === "approved_acknowledged" ? "text-ink-muted" : "text-ink")}>
                      <PartStateIcon state={r.state} className="mt-px" />
                      {recordText(r)}
                    </span>
                  </TD>
                  <TD wrap className="min-w-[13rem] py-1.5 text-ink-secondary max-[63.99875rem]:min-w-[9rem]">
                    <IdText text={next.what} />
                    <span className="mt-0.5 block text-ink min-[64rem]:hidden">Owner: {next.who}</span>
                  </TD>
                  <TD data-col="owner" className="text-ink">
                    {next.who}
                  </TD>
                  <TD priority={3} wrap className="min-w-[9rem]">
                    {r.otherParts.length ? (
                      <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5" aria-label="Other parts of the case">
                        {r.otherParts.map((o) => (
                          <li key={o.designation} className="inline-flex items-center gap-1 text-ink-secondary">
                            <PartStateIcon state={o.state} className="size-3.5" />
                            <span className="font-medium text-ink">{o.designation}</span> {partShort(o.state)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-ink-muted">None</span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        ))}
      </Table>
      <p className="text-sm text-ink-muted">
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
  const attested = rows.filter((r) => r.sourceUpdateState === "entered_attested").sort((a, b) => (b.enteredAt ?? "").localeCompare(a.enteredAt ?? ""));
  const offline = [...new Map(rows.filter((r) => r.sourceStatus === "offline").map((r) => [r.sourceName ?? "", r])).values()];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <p className="max-w-[80ch] text-base text-ink">
          Approved descriptions are typed into the patient&apos;s source system by hand. Mark entered records your attestation; only the simulated source can acknowledge it.
        </p>
        <SimulatedLabel connector="source system" />
      </div>
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
                        <span className="inline-flex items-center gap-1.5 font-semibold text-warning-fg">
                          <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden /> Source update failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-ink">
                          <Hourglass className="size-4 shrink-0 text-ink-muted" aria-hidden /> Source update pending
                        </span>
                      )}
                      <span className={cn("block text-xs", unreachable ? "font-medium text-warning-fg" : "text-ink-muted")}>
                        {unreachable ? `Source unreachable: ${shortSource(r.sourceName)}` : shortSource(r.sourceName ?? r.tenantName)}
                      </span>
                    </TD>
                    <TD priority={3} className="text-ink-secondary">
                      {r.taskOwner ?? "Unassigned"}
                    </TD>
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
          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 rounded-md px-3 py-2 text-sm font-medium text-ink hover:bg-surface-subtle">
            <UserCheck className="size-4 shrink-0 text-ink-muted" aria-hidden />
            Entered (staff attested), awaiting acknowledgment <span className="font-normal text-ink-secondary">({attested.length})</span>
            <span className="font-normal text-ink-muted">Done on our side; newest first</span>
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
                        <span className="inline-flex items-center gap-1.5 text-ink">
                          <UserCheck className="size-4 shrink-0 text-ink-muted" aria-hidden /> Entered (staff attested)
                        </span>
                        <span className="block text-xs text-ink-muted">
                          {r.enteredBy ?? "Unknown"}, <Timestamp iso={r.enteredAt} now={now} />
                        </span>
                      </TD>
                      <TD priority={3} className="text-ink-secondary">
                        {shortSource(r.sourceName ?? r.tenantName)}
                      </TD>
                      <TD wrap>
                        {/* Waiting on the (simulated) source system: nobody at the bench can acknowledge it. */}
                        {unreachable ? (
                          <span className="text-xs text-warning-fg">Not acknowledged. Source unreachable; it cannot acknowledge until it is back.</span>
                        ) : (
                          <span className="text-xs text-ink-secondary">Not acknowledged yet. Waiting for {shortSource(r.sourceName ?? r.tenantName)}.</span>
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
      <span className="ml-1 text-xs text-ink-muted">version {r.recordVersion}</span>
    </span>
  );
}

