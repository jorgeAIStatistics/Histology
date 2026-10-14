"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ScanLine, PackageCheck, ShieldAlert, Truck, Eye, LogOut } from "lucide-react";
import { Card } from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button, DisabledReason } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/components/ui/toast";
import { IdChip } from "@/components/domain/chips";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { SimulatedLabel } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useFocusScanOnMount, useScan, useScanTarget, type ScanOutcome } from "@/lib/client/scan";
import { useCan } from "@/lib/client/shell-context";
import type { BenchSlide, TrayDetail, TrayListRow } from "@/server/queries/materials";
import type { TrayExpectedView, TrayScanView, TrayView } from "@/server/domain/tray";
import { ContextBar, Divider, failureToScan, SectionTitle, useReadOnly } from "./shared";

type ScanResultDto = { result: string; accepted: boolean; message: string; scannedCount: number; expectedCount: number };

const EXPECTED_PILL: Record<string, { tone: "neutral" | "success" | "danger" | "warning"; text: string }> = {
  expected: { tone: "neutral", text: "Expected" },
  scanned: { tone: "success", text: "Scanned, matches" },
  missing: { tone: "danger", text: "Missing" },
  follows_separately: { tone: "warning", text: "Follows separately" },
  canceled: { tone: "neutral", text: "Canceled" },
};
const SCAN_PILL: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  verified_expected: "success",
  unexpected: "warning",
  duplicate: "warning",
  canceled_material: "neutral",
  unknown_identifier: "danger",
  invalid_payload: "danger",
};

/** A label code without its trailing check character ("HL1:S:...:K" -> "HL1:S:..."). */
function codeBody(code: string): string {
  const i = code.lastIndexOf(":");
  return i > 0 ? code.slice(0, i) : code;
}

function toScanOutcome(r: ScanResultDto): ScanOutcome {
  if (r.result === "verified_expected") return { tone: "success", message: r.message };
  if (r.result === "duplicate") return { tone: "warning", message: r.message, sound: "mismatch" };
  return { tone: "danger", alert: true, message: r.message };
}

function DispositionDialog({ open, onClose, trayId, item }: { open: boolean; onClose: () => void; trayId: string; item: TrayExpectedView }) {
  const toast = useToast();
  const [disposition, setDisposition] = useState<"follows_separately" | "missing_investigation">("follows_separately");
  const [note, setNote] = useState("");
  const [blank, setBlank] = useState(false);
  const cmd = useCommand<{ message: string }, { trayId: string; slideId: string; disposition: string; note: string }>("tray.setDisposition", { errorToast: false });
  const submit = async () => {
    if (!note.trim()) {
      setBlank(true);
      return;
    }
    const out = await cmd.run({ trayId, slideId: item.slideId, disposition, note: note.trim() });
    if (out.ok) {
      toast.show({ tone: "success", title: "Disposition recorded", body: out.result.message });
      setNote("");
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${item.label} is not on the tray`}
      description="Record what happens to this slide. A task is opened for you. The tray can then only be released with exceptions by a supervisor; it never becomes verified complete without this slide's own scan."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep as expected
          </Button>
          <Button variant="primary" loading={cmd.pending} onClick={() => void submit()}>
            Record disposition
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Disposition" required>
          <Select value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)}>
            <option value="follows_separately">Follows separately (still being prepared or found elsewhere)</option>
            <option value="missing_investigation">Missing: open an investigation</option>
          </Select>
        </Field>
        <Field label="Note" required error={blank ? "Say where the slide is or what was checked." : undefined}>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Still at the coverslipper; will walk it over" />
        </Field>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}

function ReleaseDialog({ open, onClose, view }: { open: boolean; onClose: () => void; view: TrayView }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [blank, setBlank] = useState(false);
  const cmd = useCommand<{ message: string }, { trayId: string; note: string }>("tray.releaseWithExceptions", { errorToast: false });
  const outstanding = view.expected.filter((e) => e.state === "missing" || e.state === "follows_separately");
  const submit = async () => {
    if (!note.trim()) {
      setBlank(true);
      return;
    }
    const out = await cmd.run({ trayId: view.tray.id, note: note.trim() });
    if (out.ok) {
      toast.show({ tone: "warning", title: `${view.tray.display_id} released with exceptions`, body: out.result.message });
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      title={`Release ${view.tray.display_id} with exceptions?`}
      description="The tray is NOT verified complete. The outstanding items below stay listed for the recipient, with their tasks open."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep tray open
          </Button>
          <Button variant="primary" loading={cmd.pending} onClick={() => void submit()}>
            Release with exceptions
          </Button>
        </>
      }
    >
      <ul className="mb-3 flex flex-col gap-1 text-sm">
        {outstanding.map((e) => (
          <li key={e.slideId}>
            <span className="id-mono font-medium">{e.label}</span>: {e.stateLabel.toLowerCase()} — {e.dispositionNote}
          </li>
        ))}
      </ul>
      <Field label="Supervisor note" required error={blank ? "A note is required." : undefined}>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Dr. Marsh agreed to start; A1-2 follows" />
      </Field>
      <CommandError error={cmd.error} className="mt-2" />
    </Dialog>
  );
}

function ExceptionRow({ scan, now, isSupervisor, blockedReason }: { scan: TrayScanView; now: string; isSupervisor: boolean; blockedReason: string | null }) {
  return (
    <li className="rounded-md border border-warning-border bg-warning-bg p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill size="sm" tone={SCAN_PILL[scan.result] ?? "warning"}>
          {scan.resultLabel}
        </StatusPill>
        <span className="id-mono text-sm font-medium">{scan.slideLabel ?? scan.payload}</span>
        <span className="text-xs text-ink-muted">
          scanned <Timestamp iso={scan.scannedAt} now={now} /> by {scan.scannedBy}
        </span>
      </div>
      {scan.detail ? <p className="mt-1 text-sm text-ink-secondary">{scan.detail}</p> : null}
      {blockedReason ? <p className="mt-1.5 text-xs text-ink-secondary">{blockedReason}</p> : null}
      {blockedReason ? null : (
        <div className="mt-1.5 flex flex-wrap gap-2">
          <CommandButton command="tray.resolveScan" input={{ scanId: scan.id, resolution: "removed_from_tray" }} size="sm" successToast={(r: { message: string }) => r.message}>
            Removed from tray
          </CommandButton>
          {scan.result === "duplicate" ? (
            <CommandButton command="tray.resolveScan" input={{ scanId: scan.id, resolution: "same_slide_rescanned" }} size="sm" variant="quiet" successToast={(r: { message: string }) => r.message}>
              Same slide scanned twice
            </CommandButton>
          ) : null}
          {scan.result === "unexpected" && isSupervisor ? (
            <CommandButton
              command="tray.resolveScan"
              input={{ scanId: scan.id, resolution: "added_by_authorized_change" }}
              size="sm"
              variant="quiet"
              successToast={(r: { message: string }) => r.message}
              confirm={{ title: `Add ${scan.slideLabel} to the tray's list?`, body: "Only allowed for a QC-reviewed slide of this tray's pathologist. Recorded as an authorized change.", confirmLabel: "Add to list", cancelLabel: "Keep as unexpected" }}
            >
              Add to list (supervisor)
            </CommandButton>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** Ends the scan session for this tray (the scan field returns to "Find record"). Asks first if anything is unresolved. */
function EndSession({ view }: { view: TrayView }) {
  const scan = useScan();
  const [open, setOpen] = useState(false);
  const [ended, setEnded] = useState(false);
  const outstanding = view.completeBlockers.length;
  const end = () => {
    scan.resetTarget();
    setEnded(true);
    setOpen(false);
    scan.setResult({ tone: "info", message: `Tray session for ${view.tray.display_id} ended. The tray stays ${view.statusLabel.toLowerCase()}; nothing was marked verified.` });
  };
  if (ended) return <p className="text-xs text-ink-muted">Tray session ended: the scan field is back to &quot;Find record&quot;. Reload the tray to scan again.</p>;
  return (
    <>
      <Button size="sm" variant="quiet" icon={<LogOut className="size-4" aria-hidden />} onClick={() => (outstanding ? setOpen(true) : end())}>
        End tray session
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        role="alertdialog"
        title={`End the session with ${outstanding} unresolved item${outstanding === 1 ? "" : "s"}?`}
        description={`${view.tray.display_id} stays open with its exceptions listed. Nothing is marked verified and no slide is delivered.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Keep scanning
            </Button>
            <Button variant="primary" onClick={end}>
              End session
            </Button>
          </>
        }
      >
        <ul className="list-disc pl-5 text-sm">
          {view.completeBlockers.slice(0, 8).map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

function SimulatedScanner({ bench, active, readOnly }: { bench: BenchSlide[]; active: boolean; readOnly: string | null }) {
  const scan = useScan();
  const [found, setFound] = useState<Record<string, boolean>>({});
  if (!active) return null;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Simulated scanner <SimulatedLabel connector="scanner" size="xs" />
        </span>
      }
      description="Slides on the bench next to the tray (synthetic). Click Scan, or scan or type a label in the scan field."
      headingLevel={3}
    >
      {bench.length ? (
        <ul className="flex flex-col gap-1.5">
          {bench.map((b) => {
            const hidden = b.hiddenUntilFound && !found[b.key];
            return (
              <li key={b.key} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line px-2 py-1.5">
                <div className="min-w-0">
                  <p className={`text-sm ${hidden ? "text-ink-muted" : "text-ink"}`}>
                    <span className="id-mono font-medium">{b.label.replace(/\s*\(.*\)$/, "")}</span>
                    {/\(.*\)$/.test(b.label) ? <span className="text-xs text-ink-secondary"> {/\((.*)\)$/.exec(b.label)![0]}</span> : null}
                  </p>
                  <p className="text-xs text-ink-muted">{hidden ? b.note : b.kind === "missing" ? "Found and brought to the bench" : b.note}</p>
                </div>
                {hidden ? (
                  <Button size="sm" variant="quiet" icon={<Eye className="size-4" aria-hidden />} onClick={() => setFound((f) => ({ ...f, [b.key]: true }))}>
                    Found it<span className="sr-only"> {b.label}</span>
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" icon={<ScanLine className="size-4" aria-hidden />} disabled={!!readOnly || scan.pending} onClick={() => void scan.submit(b.payload).then(() => scan.focus())}>
                    Scan<span className="sr-only"> {b.label}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-secondary">No unscanned slides are on the bench for this tray.</p>
      )}
    </Card>
  );
}

function TrayWorkspace({ view, bench, color, now, printJobs }: { view: TrayView; bench: BenchSlide[]; color: string | null; now: string; printJobs: Record<string, string> }) {
  const readOnly = useReadOnly();
  const canAssemble = useCan("tray.assemble");
  const canRelease = useCan("tray.releaseWithExceptions");
  const [dispositionFor, setDispositionFor] = useState<TrayExpectedView | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const tray = view.tray;
  const scanCmd = useCommand<ScanResultDto, { trayId: string; payload: string }>("tray.scan", { errorToast: false });
  const scanAllowed = view.isActive && !readOnly && canAssemble.allowed;

  useScanTarget(scanAllowed ? `Add to tray ${tray.display_id}` : null, async (value) => {
    const out = await scanCmd.run({ trayId: tray.id, payload: value });
    return out.ok ? toScanOutcome(out.result) : failureToScan(out.error);
  }, { placeholder: "Scan one slide label" });
  useFocusScanOnMount(scanAllowed);

  const completeReason = readOnly ?? (!canAssemble.allowed ? canAssemble.reason : view.completeBlockers.length ? view.blockedSummary ?? "Not every expected slide is scanned." : null);
  const releaseReason = readOnly ?? (!canRelease.allowed ? "Only an operations supervisor can release a tray with exceptions." : view.releaseBlockers.length ? view.releaseBlockers[0] : null);
  // Exceptions first (spec principle 3): slides still to resolve, then canceled, then scanned; list order within each group.
  const rank = (e: TrayExpectedView) => (e.canceledOnTray ? 0 : e.state === "scanned" ? 3 : e.state === "canceled" ? 2 : 1);
  const expectedRows = [...view.expected].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
  const unreadableBodies = new Set(view.scans.filter((sc) => sc.result === "invalid_payload" || sc.result === "unknown_identifier").map((sc) => codeBody(sc.payload)));
  const canAct = !readOnly && canAssemble.allowed;
  const actReason = readOnly ?? (canAssemble.allowed ? null : `${canAssemble.reason} A histotechnologist, histology assistant or supervisor resolves tray scans.`);
  const beforeDelivery = view.isActive || tray.status === "verified_complete" || tray.status === "released_with_exceptions";

  return (
    <div className="flex flex-col gap-3">
      <ContextBar label="Current tray" bleed>
        <IdChip kind="TRY" id={tray.display_id} showKind />
        <StatePill domain="tray" state={tray.status} />
        <Divider />
        <DoctorChip name={view.pathologistName} color={color} withRole className="text-sm" />
        <Divider />
        <span className="text-sm text-ink">
          <span className="num-tabular font-semibold">{view.counts.scanned}</span> of <span className="num-tabular">{view.counts.expected}</span> expected slides scanned
          {view.counts.unresolved ? <span className="text-warning-fg"> · {view.counts.unresolved} to resolve</span> : null}
        </span>
        <span className="ml-auto text-xs text-ink-muted">
          Opened by {view.openedByName ?? "Unknown"} <Timestamp iso={tray.opened_at} now={now} />
        </span>
      </ContextBar>

      {view.isActive && view.blockedSummary ? (
        <AlertBanner tone="warning" title={view.blockedSummary} headingLevel={2}>
          Scan each slide individually, remove material that does not belong, or record a missing slide as following separately. A supervisor may then release the tray with exceptions.
        </AlertBanner>
      ) : null}
      {!view.isActive ? (
        <AlertBanner tone={tray.status === "released_with_exceptions" ? "warning" : "success"} title={`${tray.display_id}: ${view.statusLabel}`}>
          {tray.close_note ?? "Closed."}
          {view.closedByName && !(tray.close_note ?? "").includes(view.closedByName) ? ` (${view.closedByName})` : ""}
        </AlertBanner>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          {view.unresolved.length ? (
            <section aria-labelledby="exc-title" className="flex flex-col gap-1.5">
              <SectionTitle id="exc-title">Scanned material that does not belong ({view.unresolved.length})</SectionTitle>
              <ul className="flex flex-col gap-1.5">
                {view.unresolved.map((s) => (
                  <ExceptionRow key={s.id} scan={s} now={now} isSupervisor={canRelease.allowed} blockedReason={actReason} />
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="exp-title" className="flex flex-col gap-1.5">
            <SectionTitle id="exp-title" aside="Each slide needs its own scan. One tray scan never verifies the slides on it.">
              Expected slides
            </SectionTitle>
            <Table caption={`Expected slides for ${tray.display_id}. Not yet scanned first, then scanned; # is the list order.`} scroll="container" maxHeight="440px">
              <THead>
                <tr>
                  <TH align="right">#</TH>
                  <TH stickyFirst>Slide</TH>
                  <TH>State</TH>
                  <TH>Details</TH>
                </tr>
              </THead>
              <TBody>
                {expectedRows.map((e) => {
                  const pill = e.canceledOnTray ? { tone: "danger" as const, text: "Canceled, on the tray" } : EXPECTED_PILL[e.state];
                  const open = view.isActive && e.state !== "scanned" && e.state !== "canceled";
                  // A reprint is offered only for a slide that is here but whose label did not read (spec 6.5): an
                  // unreadable scan whose code matches this slide's code apart from the check character. Never for a missing slide.
                  const pj = open && !e.disposition && unreadableBodies.has(codeBody(e.identifier)) ? printJobs[e.slideId] : undefined;
                  return (
                    <TR key={e.slideId} canceled={e.state === "canceled"}>
                      <TD numeric className="text-ink-muted">{e.seq}</TD>
                      <TD stickyFirst>
                        <span className="id-mono font-medium">{e.label}</span>
                      </TD>
                      <TD>
                        <StatusPill size="sm" tone={pill.tone}>
                          {pill.text}
                        </StatusPill>
                      </TD>
                      <TD wrap className="text-sm text-ink-secondary">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {e.state === "scanned" ? (
                            <span className="whitespace-nowrap">
                              <Timestamp iso={e.scannedAt} now={now} /> · {e.scannedBy}
                            </span>
                          ) : e.state === "canceled" ? (
                            <span>{e.canceledOnTray ? `${e.canceledReason}. It was scanned onto the tray before that: take it off.` : e.canceledReason}</span>
                          ) : e.disposition ? (
                            <span>
                              {e.dispositionNote} ({e.dispositionBy ?? "Unknown"})
                            </span>
                          ) : (
                            <span>Not scanned yet</span>
                          )}
                          {e.canceledOnTray && e.scanId && beforeDelivery && canAct ? (
                            <CommandButton command="tray.resolveScan" input={{ scanId: e.scanId, resolution: "removed_from_tray" }} size="sm" variant="secondary" successToast={(r: { message: string }) => r.message}>
                              Removed from tray
                            </CommandButton>
                          ) : null}
                          {open && canAct ? (
                            <Button size="sm" variant="secondary" onClick={() => setDispositionFor(e)}>
                              {e.disposition ? "Change disposition" : "Record as not on tray…"}
                            </Button>
                          ) : null}
                          {pj ? (
                            <Link href={`/materials?tab=print&selected=${encodeURIComponent(pj)}`} className="text-xs font-medium text-brand underline-offset-2 hover:underline">
                              Label did not read: reprint from {pj}
                            </Link>
                          ) : null}
                        </span>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </section>


          <section aria-labelledby="log-title" className="flex flex-col gap-1.5">
            <SectionTitle id="log-title" aside="Newest first. Every scan is kept.">
              Scan log
            </SectionTitle>
            {view.scans.length ? (
              <ol className="flex max-h-[240px] flex-col gap-1 overflow-y-auto rounded-md border border-line bg-surface p-2 text-sm">
                {view.scans.slice(0, 40).map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <Timestamp iso={s.scannedAt} now={now} className="text-xs text-ink-muted" />
                    <StatusPill size="sm" tone={SCAN_PILL[s.result] ?? "neutral"}>
                      {s.resultLabel}
                    </StatusPill>
                    <span className="id-mono">{s.slideLabel ?? s.payload}</span>
                    {s.resolutionLabel ? <span className="text-xs text-ink-muted">· {s.resolutionLabel}</span> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-ink-secondary">No scans yet. Scan the first slide.</p>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-3">
          <SimulatedScanner bench={bench} active={scanAllowed} readOnly={null} />
          <Card title="Tray actions" headingLevel={3}>
            <div className="flex flex-col gap-2">
              {view.isActive ? (
                <>
                  <CommandButton
                    command="tray.complete"
                    input={{ trayId: tray.id, expectedVersion: tray.version }}
                    variant="primary"
                    icon={<PackageCheck className="size-4" aria-hidden />}
                    disabledReason={completeReason ?? undefined}
                    successToast={(r: { message: string }) => r.message}
                    pendingLabel="Checking..."
                  >
                    Mark tray complete
                  </CommandButton>
                  <div className="flex flex-col items-start gap-1">
                    <Button variant="secondary" icon={<ShieldAlert className="size-4" aria-hidden />} disabled={!!releaseReason} reasonId={releaseReason ? `rel-${tray.id}` : undefined} onClick={() => setReleaseOpen(true)}>
                      Release with exceptions
                    </Button>
                    {releaseReason ? <DisabledReason id={`rel-${tray.id}`} className="text-xs">{releaseReason}</DisabledReason> : null}
                  </div>
                </>
              ) : tray.status === "verified_complete" || tray.status === "released_with_exceptions" ? (
                <CommandButton
                  command="tray.deliver"
                  input={{ trayId: tray.id }}
                  variant="primary"
                  icon={<Truck className="size-4" aria-hidden />}
                  disabledReason={readOnly ?? (canAssemble.allowed ? undefined : canAssemble.reason) ?? undefined}
                  successToast={(r: { message: string }) => r.message}
                  pendingLabel="Delivering..."
                >
                  Deliver tray to {view.pathologistName}
                </CommandButton>
              ) : (
                <p className="text-sm text-ink-secondary">This tray was delivered. Outstanding items keep their own tasks.</p>
              )}
            </div>
          </Card>
          {scanAllowed ? (
            <div className="flex flex-col items-start gap-1">
              <p className="text-xs text-ink-muted">
                The scan field (top bar) is set to &quot;Add to tray {tray.display_id}&quot;. Press <Kbd>/</Kbd> to focus it.
              </p>
              <EndSession view={view} />
            </div>
          ) : null}
        </div>
      </div>

      {dispositionFor ? <DispositionDialog open onClose={() => setDispositionFor(null)} trayId={tray.id} item={dispositionFor} /> : null}
      <ReleaseDialog open={releaseOpen} onClose={() => setReleaseOpen(false)} view={view} />
    </div>
  );
}

function OpenTray({ pathologists }: { pathologists: { id: string; name: string; ready: number }[] }) {
  const router = useRouter();
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
        onSuccess={(r: { displayId: string; message: string }) => router.push(`/materials?tab=trays&selected=${encodeURIComponent(r.displayId)}`, { scroll: false })}
        successToast={(r: { displayId: string; message: string }) => r.message}
      >
        Open tray
      </CommandButton>
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
  const active = trays.filter((t) => ["open", "assembling", "exception"].includes(t.status));
  const recent = trays.filter((t) => !["open", "assembling", "exception"].includes(t.status)).slice(0, 6);
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Trays" className="flex flex-wrap items-center gap-2">
        {[...active, ...recent].map((t) => {
          const isSel = detail?.view.tray.id === t.id;
          return (
            <Link
              key={t.id}
              href={`/materials?tab=trays&selected=${encodeURIComponent(t.displayId)}`}
              scroll={false}
              aria-current={isSel ? "page" : undefined}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm ${isSel ? "border-brand bg-brand-50" : "border-line bg-surface hover:bg-surface-subtle"}`}
            >
              <span className="id-mono font-medium">{t.displayId}</span>
              <StatePill domain="tray" state={t.status} size="sm" />
              <span className="num-tabular text-xs text-ink-muted">
                {t.scanned}/{t.expected}
              </span>
            </Link>
          );
        })}
        {readOnly ? null : (
        <details className="group ml-auto open:basis-full">
          <summary className="cursor-pointer text-sm font-medium text-brand">Open a new tray…</summary>
          <div className="mt-2 flex justify-end">
            <OpenTray pathologists={pathologists} />
          </div>
        </details>
        )}
      </nav>
      {selectedMissing ? (
        <AlertBanner tone="warning" title={`Tray ${selectedMissing} was not found.`}>
          Check the tray code, or choose a tray above.
        </AlertBanner>
      ) : null}
      {detail ? (
        <TrayWorkspace key={detail.view.tray.id} view={detail.view} bench={detail.bench} color={detail.pathologistColor} now={now} printJobs={detail.printJobs} />
      ) : (
        <EmptyState title="No tray selected">
          Choose a tray above, or open a new tray for a dermatopathologist. A tray lists the slides that are QC reviewed with a scanned label; each must then be scanned individually.
        </EmptyState>
      )}
    </div>
  );
}
