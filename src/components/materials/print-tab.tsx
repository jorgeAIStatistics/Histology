"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import { SidePanelLayout } from "@/components/ui/side-panel";
import { Table, THead, TBody, TR, TH, TD, TableMessageRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { AlertBanner } from "@/components/ui/alert-banner";
import { CommandButton } from "@/components/ui/command-button";
import { Field, Select } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { PresenterControls } from "@/components/ui/presenter-controls";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useSingleKey } from "@/lib/client/keyboard";
import type { PrinterView, PrintFilter, PrintJobDetail, PrintJobRowView, WorkOrderReviewView, listRecentWorkOrderReviews, slidesAwaitingLabel } from "@/server/queries/materials";
import { useToast } from "@/components/ui/toast";
import { useCan } from "@/lib/client/shell-context";
import { PrintJobPanel } from "./print-job-panel";
import { WorkOrderReviews } from "./workorder-review";
import { PrinterChip, PrinterStrip, printerName, useReadOnly } from "./shared";
import { PrintOutcome } from "./print-outcome";

const FILTERS: { key: PrintFilter; label: string }[] = [
  { key: "attention", label: "Needs attention + last 3 h" },
  { key: "today", label: "Today" },
  { key: "all", label: "All" },
];

function PrinterBehaviour({ printer }: { printer: PrinterView }) {
  const cmd = useCommand<{ status: string }, { printerId: string; status: string }>("printer.setStatus", {
    successToast: (_r, input) => `${printerName(printer.name)}: ${input.status === "online" ? "ready" : input.status === "offline" ? "unavailable" : "will time out after submission"} (simulated)`,
  });
  return (
    <Field label={`Demo control: ${printerName(printer.name)}`} className="w-[230px]">
      <Select size="sm" value={printer.status} disabled={cmd.pending} onChange={(e) => void cmd.run({ printerId: printer.id, status: e.target.value })}>
        <option value="online">Ready</option>
        <option value="offline">Unavailable</option>
        <option value="simulate_timeout">Time out after submission</option>
      </Select>
    </Field>
  );
}

type PrintResultDto = { outcome: string; displayId: string; state?: string; message: string; printerUnavailable?: boolean };

/** New labels: slides with no label yet (for example an additional slide just ordered). */
function LabelsToPrint({ awaiting, slidePrinter }: { awaiting: ReturnType<typeof slidesAwaitingLabel>; slidePrinter: PrinterView | null }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const readOnly = useReadOnly();
  const can = useCan("print.request");
  const toast = useToast();
  if (!awaiting.rows.length) return null;
  const offline = slidePrinter?.status === "offline";
  return (
    <details className="rounded-md border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-ink">
        Slide labels not yet printed ({awaiting.total}) <span className="font-normal text-ink-muted">(newly ordered additional slides first)</span>
      </summary>
      <div className="mt-2">
        <ul className="flex flex-col gap-1.5">
          {awaiting.rows.map((r) => (
            <li key={r.slideId} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line px-2 py-1.5">
              <span className="text-sm">
                <span className="id-mono font-medium">{r.label}</span>{" "}
                <span className="text-ink-muted">
                  ({r.physicalState.replace(/_/g, " ")}
                  {r.workOrderDisplayId ? (
                    <>
                      , work order <span className="id-mono">{r.workOrderDisplayId}</span>
                    </>
                  ) : null}
                  )
                </span>
              </span>
              <CommandButton
                command="print.request"
                input={{ targetType: "slide", targetId: r.slideId, kind: "slide_label", purpose: r.purpose }}
                size="sm"
                variant="secondary"
                pendingLabel="Sending..."
                aria-label={`${offline ? "Queue for later" : "Print label"}: ${r.label}`}
                disabledReason={readOnly ?? (can.allowed ? undefined : can.reason) ?? undefined}
                onSuccess={(res: PrintResultDto) =>
                  toast.show({
                    tone: res.outcome === "duplicate_prevented" ? "info" : res.printerUnavailable || res.state === "unknown_outcome" ? "warning" : "success",
                    title:
                      res.outcome === "duplicate_prevented"
                        ? "No second job created"
                        : res.printerUnavailable
                          ? `${res.displayId} queued (printer unavailable)`
                          : res.state === "unknown_outcome"
                            ? `${res.displayId}: outcome unknown (simulated timeout)`
                            : `${res.displayId} sent to the printer (simulated)`,
                    body: res.message,
                    action: { label: `Open ${res.displayId}`, onClick: () => startTransition(() => router.push(`/materials?tab=print&selected=${encodeURIComponent(res.displayId)}`, { scroll: false })) },
                  })
                }
              >
                {offline ? "Queue for later" : "Print label"}
              </CommandButton>
            </li>
          ))}
        </ul>
        {offline ? <p className="mt-2 text-xs text-warning-fg">The slide printer is unavailable (simulated): new jobs are kept in the queue until released.</p> : null}
      </div>
    </details>
  );
}

export function PrintTab({
  printers,
  rows,
  total,
  counts,
  filter,
  detail,
  selectedMissing,
  reviews,
  recent,
  awaiting,
  now,
}: {
  awaiting: ReturnType<typeof slidesAwaitingLabel>;
  printers: PrinterView[];
  rows: PrintJobRowView[];
  total: number;
  counts: Record<PrintFilter, number> & { unknown: number; queued: number; failed: number };
  filter: PrintFilter;
  detail: PrintJobDetail | null;
  selectedMissing: string | null;
  reviews: WorkOrderReviewView[];
  recent: ReturnType<typeof listRecentWorkOrderReviews>;
  now: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const readOnly = useReadOnly();
  const base = `/materials?tab=print&filter=${filter}`;
  const open = (displayId: string) => startTransition(() => router.push(hrefFor(displayId), { scroll: false }));
  const hrefFor = (displayId: string) => `${base}&selected=${encodeURIComponent(displayId)}`;
  const selectedId = detail?.job.id ?? null;
  const unknownRows = rows.filter((r) => r.state === "unknown_outcome");
  const checkRows = rows.filter((r) => r.needsOutputCheck);
  const offline = printers.filter((p) => p.status === "offline");

  const move = useCallback(
    (delta: number) => {
      if (!rows.length) return;
      const i = rows.findIndex((r) => r.id === selectedId);
      const next = rows[Math.min(rows.length - 1, Math.max(0, i < 0 ? 0 : i + delta))];
      open(next.displayId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedId, filter],
  );
  useSingleKey({ j: () => move(1), k: () => move(-1) });

  return (
    <SidePanelLayout panel={detail ? <PrintJobPanel detail={detail} now={now} closeHref={base} /> : null}>
      <div className="flex min-w-0 flex-col gap-3 px-6 py-4 max-xl:px-4">
      <PrinterStrip>
        {printers.map((p) => (
          <PrinterChip key={p.id} name={p.name} status={p.status} statusLabel={p.statusLabel} queued={p.queued} unknown={p.unknown} />
        ))}
      </PrinterStrip>

      {offline.map((p) => (
        <AlertBanner key={p.id} tone="warning" title={`${printerName(p.name)} is unavailable (simulated)`}>
          {p.queued
            ? `${p.queued} job${p.queued === 1 ? " is" : "s are"} queued. Release ${p.queued === 1 ? "it" : "them"} here once the printer is back; nothing prints before that.`
            : "New print requests are kept in the queue until the printer is back."}{" "}
          Jobs are never lost.
        </AlertBanner>
      ))}
      {printers
        .filter((p) => p.status !== "offline" && p.queued > 0)
        .map((p) => (
          <AlertBanner
            key={p.id}
            tone="info"
            title={`${printerName(p.name)} is available (simulated). ${p.queued} job${p.queued === 1 ? " is" : "s are"} still queued.`}
            action={
              !readOnly ? (
                <CommandButton command="print.release" input={{ printerId: p.id }} size="sm" pendingLabel="Releasing..." successToast={(r: { message: string }) => r.message}>
                  Release queued jobs
                </CommandButton>
              ) : null
            }
          >
            Queued jobs print only when someone releases them, so nothing prints unexpectedly.
          </AlertBanner>
        ))}

      {unknownRows.length ? (
        <AlertBanner tone="warning" title={`${unknownRows.length} print job${unknownRows.length === 1 ? "" : "s"} with an unknown outcome. Reconcile before any reprint.`}>
          {unknownRows.map((r, i) => (
            <span key={r.id}>
              {i ? ", " : ""}
              <Link href={hrefFor(r.displayId)} scroll={false} className="id-mono font-medium text-brand underline-offset-2 hover:underline">
                {r.displayId}
              </Link>{" "}
              ({r.targetLabel})
            </span>
          ))}
        </AlertBanner>
      ) : null}

      {checkRows.length ? (
        <AlertBanner tone="info" title={`${checkRows.length} job${checkRows.length === 1 ? "" : "s"} acknowledged by a printer that does not report completion. Record what came out before applying the label.`}>
          {checkRows.map((r, i) => (
            <span key={r.id}>
              {i ? ", " : ""}
              <Link href={hrefFor(r.displayId)} scroll={false} className="id-mono font-medium text-brand underline-offset-2 hover:underline">
                {r.displayId}
              </Link>{" "}
              ({r.targetLabel})
            </span>
          ))}
        </AlertBanner>
      ) : null}

      <WorkOrderReviews items={reviews} recent={recent} now={now} />
      <LabelsToPrint awaiting={awaiting} slidePrinter={printers.find((p) => p.kind === "slide") ?? null} />

        <div className="flex flex-col gap-2">
          <Tabs
            label="Print job filters"
            active={filter}
            size="sm"
            items={FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key], href: `/materials?tab=print&filter=${f.key}` }))}
          />
          {selectedMissing ? (
            <AlertBanner tone="warning" title={`Print job ${selectedMissing} was not found.`}>
              Check the ID, or choose a job from the list.
            </AlertBanner>
          ) : null}
          <p className="text-xs text-ink-muted">
            Showing {rows.length} of {total} job{total === 1 ? "" : "s"}. Problems first (unknown outcome, output not recorded, failed, queued), then newest. <Kbd>J</Kbd> and <Kbd>K</Kbd> move through the jobs.
          </p>
          {rows.length ? (
            <Table caption="Print jobs. Unknown outcome, failed and queued jobs first, then newest." scroll="container" maxHeight="calc(100vh - 220px)" hideP3={!!detail} wrapperClassName="max-xl:[&_[data-priority='3']]:hidden">
              <THead>
                <tr>
                  <TH stickyFirst>Print job</TH>
                  <TH>Label for</TH>
                  <TH priority={2}>Reason</TH>
                  <TH>Outcome</TH>
                  <TH priority={2}>Submitted</TH>
                  <TH priority={3}>Operator</TH>
                  <TH priority={3}>Printer</TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR
                    key={r.id}
                    interactive
                    selected={r.id === selectedId}
                    onClick={() => open(r.displayId)}
                  >
                    <TD stickyFirst>
                      <Link
                        href={hrefFor(r.displayId)}
                        scroll={false}
                        className="id-mono text-sm font-medium text-brand-ink underline-offset-2 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.displayId}
                      </Link>
                    </TD>
                    <TD>
                      <span className="id-mono">{r.targetLabel}</span>
                    </TD>
                    <TD priority={2} wrap className="min-w-[8rem]">
                      {r.purposeLabel}
                      {r.reprintOfDisplayId ? <span className="text-ink-muted"> (of <span className="id-mono">{r.reprintOfDisplayId}</span>)</span> : null}
                    </TD>
                    <TD wrap className="min-w-[9.5rem]">
                      <PrintOutcome row={r} />
                    </TD>
                    <TD priority={2}>{r.submittedAt ? <Timestamp iso={r.submittedAt} now={now} /> : <span className="text-ink-muted">Not submitted</span>}</TD>
                    <TD priority={3}>{r.requestedBy}</TD>
                    <TD priority={3}>{printerName(r.printerName)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <Table caption="Print jobs" scroll="container">
              <TBody>
                <TableMessageRow colSpan={7}>
                  <EmptyState compact title={filter === "attention" ? "Nothing needs attention" : "No print jobs"}>
                    {filter === "attention"
                      ? "No unknown outcomes, failures or queued jobs, and nothing printed in the last 3 hours. Labels are printed from a slide or block record."
                      : "Print jobs appear here when a label is requested for a slide, block or case."}
                  </EmptyState>
                </TableMessageRow>
              </TBody>
            </Table>
          )}
          <p className="text-xs text-ink-muted">Jobs go to simulated printers. Scan or type a print job number (PJ-…) in the scan field to open it.</p>
        </div>
        {/* The presenter's printer switches, at the foot of the bench like every other demo control. */}
        {!readOnly ? (
          <PresenterControls label="Simulate printer behaviour (demo)">
            <div className="flex flex-wrap gap-2">
              {printers.map((p) => (
                <PrinterBehaviour key={p.id} printer={p} />
              ))}
            </div>
            <p className="text-xs text-ink-muted">Also in Settings. No real printer is contacted.</p>
          </PresenterControls>
        ) : null}
      </div>
    </SidePanelLayout>
  );
}
