"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Plus, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { AlertBanner } from "@/components/ui/alert-banner";
import { CommandButton } from "@/components/ui/command-button";
import { Field, Select } from "@/components/ui/field";
import { StatePill } from "@/components/ui/status-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { DoctorSwatch } from "@/components/domain/doctor-chip";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useFocusScanOnMount, useScanTarget, type ScanOutcome } from "@/lib/client/scan";
import { useCan } from "@/lib/client/shell-context";
import type { TrayDetail, TrayListRow } from "@/server/queries/materials";
import type { TrayView } from "@/server/domain/tray";
import { BENCH_BAND, BENCH_DECISION, BENCH_GRID, BENCH_WORK, failureToScan, useReadOnly } from "./shared";
import { traySlots } from "./tray-model";
import { TraySheet } from "./tray-sheet";
import { TrayDecision } from "./tray-decision";

type ScanResultDto = { result: string; accepted: boolean; message: string; scannedCount: number; expectedCount: number };

const ACTIVE = ["open", "assembling", "exception"];

/**
 * The scan field's line for a tray scan. Material that does not belong (unexpected,
 * canceled, unreadable) is amber with words and still announced as an alert: on the
 * severity ladder red is kept for a wrong block and patient identity.
 */
function toScanOutcome(r: ScanResultDto): ScanOutcome {
  if (r.result === "verified_expected") return { tone: "success", message: r.message };
  if (r.result === "duplicate") return { tone: "warning", message: r.message, sound: "mismatch" };
  return { tone: "warning", alert: true, message: r.message, sound: "mismatch" };
}

/**
 * The tray in hand, pinned under the top bar while scanning: its own label
 * (tray id and the dermatopathologist it goes to), progress, status and who
 * opened it. A tray spans several cases, so the identity is the tray itself.
 */
function TrayBand({ view, color, now }: { view: TrayView; color: string | null; now: string }) {
  const tray = view.tray;
  // Amber only for real exceptions (material that does not belong, slides canceled while on the tray);
  // slides not scanned yet are ordinary progress while the tray is being assembled.
  const exceptions = view.unresolved.length + view.counts.canceledOnTray;
  const leftToScan = view.isActive ? view.expected.filter((e) => !e.canceledOnTray && e.state !== "scanned" && e.state !== "canceled").length : 0;
  return (
    <section aria-label="Current tray" className={BENCH_BAND}>
      <div className="flex shrink-0 flex-col justify-center rounded-md border-[1.5px] border-ink bg-surface py-1 pr-3 pl-2.5 leading-5">
        <p className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-sm font-medium text-ink-muted">Tray</span>
          <span className="id-mono text-md font-semibold text-ink">{tray.display_id}</span>
        </p>
        <p className="flex items-center gap-1.5 whitespace-nowrap text-sm text-ink">
          <span className="text-ink-muted">Assigned dermatopathologist:</span>
          <DoctorSwatch color={color} />
          <span className="font-medium">{view.pathologistName}</span>
        </p>
        <p className="whitespace-nowrap text-xs text-ink-muted">
          Opened by {view.openedByName ?? "Unknown"} at <Timestamp iso={tray.opened_at} now={now} />
        </p>
      </div>

      <p className="flex items-baseline gap-2 text-sm text-ink-secondary">
        <span className="num-tabular text-xl font-semibold tracking-[-0.01em] text-ink">
          {view.counts.scanned} of {view.counts.expected}
        </span>{" "}
        <span>expected slides scanned</span>
      </p>

      {leftToScan ? <p className="text-sm text-ink-secondary">{leftToScan} left to scan</p> : null}
      {exceptions ? (
        <p className="inline-flex items-center gap-1.5 rounded-sm bg-warning-bg px-2 py-0.5 text-sm font-semibold text-warning-fg">
          <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />
          {exceptions} {exceptions === 1 ? "exception" : "exceptions"}
        </p>
      ) : null}

      <StatePill domain="tray" state={tray.status} />
    </section>
  );
}

function TrayWorkspace({ detail, now }: { detail: TrayDetail; now: string }) {
  const view = detail.view;
  const tray = view.tray;
  const readOnly = useReadOnly();
  const assemble = useCan("tray.assemble");
  const release = useCan("tray.releaseWithExceptions");
  const scanCmd = useCommand<ScanResultDto, { trayId: string; payload: string }>("tray.scan", { errorToast: false });
  const scanAllowed = view.isActive && !readOnly && assemble.allowed;
  const slots = useMemo(() => traySlots(view, detail.holds), [view, detail.holds]);

  useScanTarget(
    scanAllowed ? `Add to tray ${tray.display_id}` : null,
    async (value) => {
      const out = await scanCmd.run({ trayId: tray.id, payload: value });
      return out.ok ? toScanOutcome(out.result) : failureToScan(out.error);
    },
    { placeholder: "Scan one slide label" },
  );
  useFocusScanOnMount(scanAllowed);

  return (
    <div className="flex flex-col">
      <TrayBand view={view} color={detail.pathologistColor} now={now} />
      {/* Decision first in the DOM: the stacked layout (200% zoom) reads why the tray cannot be completed before the tray itself. */}
      <div className={BENCH_GRID}>
        <TrayDecision view={view} now={now} printJobs={detail.printJobs} holds={detail.holds} readOnly={readOnly} assemble={assemble} release={release} className={BENCH_DECISION} />
        <TraySheet
          view={view}
          slots={slots}
          bench={detail.bench}
          scanAllowed={scanAllowed}
          scanBlockedReason={view.isActive ? (readOnly ?? (assemble.allowed ? null : assemble.reason)) : null}
          now={now}
          className={BENCH_WORK}
        />
      </div>
    </div>
  );
}

function OpenTray({ pathologists }: { pathologists: { id: string; name: string; ready: number }[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const readOnly = useReadOnly();
  const can = useCan("tray.assemble");
  const firstReady = pathologists.find((p) => p.ready > 0)?.id ?? pathologists[0]?.id ?? "";
  const [pid, setPid] = useState(firstReady);
  const selected = pathologists.find((p) => p.id === pid);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Open a new tray for" className="w-[280px]">
        <Select size="sm" value={pid} onChange={(e) => setPid(e.target.value)}>
          {pathologists.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.ready} slide{p.ready === 1 ? "" : "s"} ready)
            </option>
          ))}
        </Select>
      </Field>
      <CommandButton
        command="tray.open"
        input={{ pathologistId: pid }}
        size="sm"
        disabledReason={readOnly ?? (can.allowed ? (selected && selected.ready === 0 ? "No QC-reviewed slides with a scanned label are waiting for this pathologist." : undefined) : can.reason) ?? undefined}
        onSuccess={(r: { displayId: string; message: string }) => startTransition(() => router.push(`/materials?tab=trays&selected=${encodeURIComponent(r.displayId)}`, { scroll: false }))}
        successToast={(r: { displayId: string; message: string }) => r.message}
      >
        Open tray
      </CommandButton>
    </div>
  );
}

/** Tray picker: open trays first, then the most recent closed ones. The selected tray is set in hematoxylin. */
function TrayPicker({ trays, selectedId, pathologists, readOnly }: { trays: TrayListRow[]; selectedId: string | null; pathologists: { id: string; name: string; ready: number }[]; readOnly: string | null }) {
  const active = trays.filter((t) => ACTIVE.includes(t.status));
  const recent = trays.filter((t) => !ACTIVE.includes(t.status)).slice(0, 6);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pt-3 pb-1 max-xl:px-4">
      {/* Stacked page (200% zoom): one row that scrolls sideways, so the tray in hand is in the first view. */}
      <nav aria-label="Trays" className="min-w-0 stacked:flex-1">
        <ul className="flex flex-wrap items-center gap-1.5 stacked:-m-1 stacked:flex-nowrap stacked:overflow-x-auto stacked:p-1">
          {[...active, ...recent].map((t) => {
            const isSel = selectedId === t.id;
            return (
              <li key={t.id} className="shrink-0">
                <Link
                  href={`/materials?tab=trays&selected=${encodeURIComponent(t.displayId)}`}
                  scroll={false}
                  aria-current={isSel ? "page" : undefined}
                  className={cn(
                    "flex min-h-[max(2.25rem,var(--hlo-target-min))] items-center gap-2 rounded-md border px-2.5 text-sm",
                    isSel ? "border-shell bg-shell text-shell-fg" : "border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-subtle",
                  )}
                >
                  <DoctorSwatch color={t.pathologistColor} />
                  <span className="id-mono font-semibold">{t.displayId}</span>
                  <span className={isSel ? "text-shell-muted" : "text-ink-secondary"}>
                    {t.statusLabel.replace(/ —.*$/, "")}
                    {ACTIVE.includes(t.status) ? (
                      <>
                        , <span className="num-tabular">{t.scanned} of {t.expected}</span>
                      </>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {readOnly ? null : (
        <details className="group ml-auto shrink-0 open:basis-full">
          <summary className="flex min-h-[max(2.25rem,var(--hlo-target-min))] cursor-pointer list-none items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-brand hover:bg-brand-50 [&::-webkit-details-marker]:hidden">
            <Plus className="size-4" aria-hidden />
            Open a new tray
          </summary>
          <div className="mt-2 flex justify-end rounded-md border border-line bg-surface p-3">
            <OpenTray pathologists={pathologists} />
          </div>
        </details>
      )}
    </div>
  );
}

export function TrayTab({
  trays,
  detail,
  selectedMissing,
  pathologists,
  now,
}: {
  trays: TrayListRow[];
  detail: TrayDetail | null;
  selectedMissing: string | null;
  pathologists: { id: string; name: string; ready: number }[];
  now: string;
}) {
  const readOnly = useReadOnly();
  return (
    <div className="flex flex-col gap-2">
      <TrayPicker trays={trays} selectedId={detail?.view.tray.id ?? null} pathologists={pathologists} readOnly={readOnly} />
      {selectedMissing ? (
        <div className="px-6 max-xl:px-4">
          <AlertBanner tone="warning" title={`Tray ${selectedMissing} was not found.`}>
            Check the tray code, or choose a tray above. Nothing was changed.
          </AlertBanner>
        </div>
      ) : null}
      {detail ? (
        <TrayWorkspace key={detail.view.tray.id} detail={detail} now={now} />
      ) : (
        <div className="px-6 pb-6 max-xl:px-4">
          <EmptyState title="No tray is being assembled">
            Choose a tray above, or open a new tray for a dermatopathologist. A new tray lists the slides that are QC reviewed with a scanned label, each in its own position; every slide is then scanned individually.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
