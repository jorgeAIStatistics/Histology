"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CircleCheck, Hourglass, PackageCheck, ShieldAlert, TriangleAlert, Truck } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, DisabledReason } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { useToast } from "@/components/ui/toast";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import type { TrayExpectedView, TrayScanView, TrayView } from "@/server/domain/tray";
import { IdText } from "@/components/domain/id-text";
import { HoldPill } from "@/components/domain/hold";
import { CutCover, CutCue, STICKY_COLUMN, useCutBelow, useFitColumn } from "./shared";
import { blockedHeadline, trayPositions } from "./tray-model";

type Msg = { message: string };
const msg = (r: Msg) => r.message;

/** A label code without its trailing check character ("HL1:S:...:K" -> "HL1:S:..."). */
function codeBody(code: string): string {
  const i = code.lastIndexOf(":");
  return i > 0 ? code.slice(0, i) : code;
}

function DispositionDialog({ open, onClose, trayId, item }: { open: boolean; onClose: () => void; trayId: string; item: TrayExpectedView }) {
  const toast = useToast();
  const [disposition, setDisposition] = useState<"follows_separately" | "missing_investigation">("follows_separately");
  const [note, setNote] = useState("");
  const [blank, setBlank] = useState(false);
  const cmd = useCommand<Msg, { trayId: string; slideId: string; disposition: string; note: string }>("tray.setDisposition", { errorToast: false });
  const submit = async () => {
    if (!note.trim()) {
      setBlank(true);
      return;
    }
    const out = await cmd.run({
      trayId,
      slideId: item.slideId,
      disposition,
      note: note.trim(),
    });
    if (out.ok) {
      toast.show({
        tone: "success",
        title: "Disposition recorded",
        body: out.result.message,
      });
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
  const cmd = useCommand<Msg, { trayId: string; note: string; expectedVersion: number }>("tray.releaseWithExceptions", { errorToast: false });
  const outstanding = view.expected.filter((e) => e.state === "missing" || e.state === "follows_separately");
  const submit = async () => {
    if (!note.trim()) {
      setBlank(true);
      return;
    }
    // The tray version behind the list shown in this dialog: a newer scan or decision is refused as a conflict.
    const out = await cmd.run({ trayId: view.tray.id, note: note.trim(), expectedVersion: view.tray.version });
    if (out.ok) {
      toast.show({
        tone: "warning",
        title: `${view.tray.display_id} released with exceptions`,
        body: out.result.message,
      });
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
            <span className="id-mono font-medium">{e.label}</span>: {e.stateLabel.toLowerCase()}, {e.dispositionNote}
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

/** One expected slide that is not (or no longer) properly on the tray, with what can be done about it here. */
function MissingItem({
  item,
  position,
  active,
  canAct,
  reprintFrom,
  onDisposition,
}: {
  item: TrayExpectedView;
  position: number;
  active: boolean;
  canAct: boolean;
  reprintFrom: string | undefined;
  onDisposition: (e: TrayExpectedView) => void;
}) {
  const followUp = item.state === "follows_separately" || item.state === "missing";
  return (
    <li data-cut-row className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
      <p data-cut-unit className="flex items-start gap-2 text-sm">
        {item.canceledOnTray || item.state === "missing" ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
        ) : (
          <Hourglass className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
        )}
        <span className="min-w-0">
          <span className="id-mono font-medium text-ink">{item.label}</span>
          <span className="block text-ink-secondary">
            Position {position}:{" "}
            <IdText
              text={
                item.canceledOnTray
                  ? `canceled, still on the tray. ${item.canceledReason ?? ""} Take it off.`
                  : followUp
                    ? `${item.stateLabel.toLowerCase()}. ${item.dispositionNote ?? ""}${item.dispositionBy ? ` (${item.dispositionBy})` : ""}`
                    : "expected, not scanned yet."
              }
            />
          </span>
        </span>
      </p>
      {canAct ? (
        <div data-cut-unit className="flex flex-wrap items-center gap-2 pl-6">
          {item.canceledOnTray && item.scanId ? (
            <CommandButton command="tray.resolveScan" input={{ scanId: item.scanId, resolution: "removed_from_tray" }} size="sm" successToast={msg}>
              Removed from tray
            </CommandButton>
          ) : active ? (
            <Button size="sm" variant="secondary" onClick={() => onDisposition(item)}>
              {item.disposition ? "Change disposition" : "Record as not on tray…"}
            </Button>
          ) : null}
          {reprintFrom ? (
            <Link href={`/materials?tab=print&selected=${encodeURIComponent(reprintFrom)}`} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
              Label did not read: reprint from {reprintFrom}
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Scanned material that is not (or not yet) accepted onto the tray. */
function ExceptionItem({ scan, now, isSupervisor, canAct }: { scan: TrayScanView; now: string; isSupervisor: boolean; canAct: boolean }) {
  return (
    <li data-cut-row className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
      <div data-cut-unit className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <StatusPill size="sm" tone="warning">
          {scan.resultLabel}
        </StatusPill>
        <span className="id-mono font-medium text-ink">{scan.slideLabel ?? scan.payload}</span>
        <span className="text-ink-muted">
          scanned <Timestamp iso={scan.scannedAt} now={now} /> by {scan.scannedBy}
        </span>
      </div>
      {canAct ? (
        <div data-cut-unit className="flex flex-wrap gap-2">
          <CommandButton command="tray.resolveScan" input={{ scanId: scan.id, resolution: "removed_from_tray" }} size="sm" successToast={msg}>
            Removed from tray
          </CommandButton>
          {scan.result === "duplicate" ? (
            <CommandButton command="tray.resolveScan" input={{ scanId: scan.id, resolution: "same_slide_rescanned" }} size="sm" variant="quiet" successToast={msg}>
              Same slide scanned twice
            </CommandButton>
          ) : null}
          {scan.result === "unexpected" && isSupervisor ? (
            <CommandButton
              command="tray.resolveScan"
              input={{
                scanId: scan.id,
                resolution: "added_by_authorized_change",
              }}
              size="sm"
              variant="quiet"
              successToast={msg}
              confirm={{
                title: `Add ${scan.slideLabel} to the tray's list?`,
                body: "Only allowed for a QC-reviewed slide of this tray's pathologist. Recorded as an authorized change.",
                confirmLabel: "Add to list",
                cancelLabel: "Keep as unexpected",
              }}
            >
              Add to list (supervisor)
            </CommandButton>
          ) : null}
        </div>
      ) : null}
      {/* The action comes before the full sentence, so a short column keeps the thing to do in view. */}
      {scan.detail ? (
        <p data-cut-unit className="text-sm text-ink-secondary">
          <IdText text={scan.detail} />
        </p>
      ) : null}
    </li>
  );
}

function Headline({ view }: { view: TrayView }) {
  const t = view.tray;
  const blocked = blockedHeadline(view);
  if (blocked) {
    return (
      <h2 className="flex items-start gap-2 text-lg font-semibold leading-7 tracking-[-0.01em] text-ink">
        <TriangleAlert className="mt-1.5 size-5 shrink-0 text-warning-solid" aria-hidden />
        <span>{blocked}</span>
      </h2>
    );
  }
  const text = view.isActive
    ? "Every expected slide is scanned and nothing else is on the tray."
    : t.status === "verified_complete"
      ? `${t.display_id} is verified complete: every slide has its own matching scan.`
      : t.status === "released_with_exceptions"
        ? `${t.display_id} was released with exceptions. It is not verified complete.`
        : `${t.display_id} was delivered to ${view.pathologistName}.`;
  return (
    <h2 className="flex items-start gap-2 text-lg font-semibold leading-7 tracking-[-0.01em] text-ink">
      {t.status === "released_with_exceptions" ? (
        <TriangleAlert className="mt-1.5 size-5 shrink-0 text-warning-solid" aria-hidden />
      ) : (
        <CircleCheck className="mt-1.5 size-5 shrink-0 text-ink-muted" aria-hidden />
      )}
      <span>
        <IdText text={text} />
      </span>
    </h2>
  );
}

/**
 * The tray's decision column: why it cannot be completed (one sentence, the
 * screen's focal point), each item that blocks it with what can be done about
 * it here, then Mark tray complete with its reason. The server decides every
 * one of these; this column only shows the decision and its owner.
 */
export function TrayDecision({
  view,
  now,
  printJobs,
  holds,
  readOnly,
  assemble,
  release,
  className,
}: {
  view: TrayView;
  now: string;
  printJobs: Record<string, string>;
  /** Active holds that stop delivery, per expected slide (derived, read only). */
  holds: Record<string, { displayId: string; scopeLabel: string; reason: string }[]>;
  readOnly: string | null;
  assemble: { allowed: boolean; reason: string | null };
  release: { allowed: boolean; reason: string | null };
  className?: string;
}) {
  const [dispositionFor, setDispositionFor] = useState<TrayExpectedView | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const tray = view.tray;
  const canAct = !readOnly && assemble.allowed;
  const actReason = readOnly ?? (assemble.allowed ? null : `${assemble.reason} A histotechnologist, histology assistant or supervisor resolves tray scans.`);
  const unreadable = new Set(view.scans.filter((s) => s.result === "invalid_payload" || s.result === "unknown_identifier").map((s) => codeBody(s.payload)));
  const positions = trayPositions(view);
  const notOn = view.expected.filter((e) => e.canceledOnTray || (view.isActive && e.state !== "scanned" && e.state !== "canceled"));
  const outstanding = notOn.length + view.unresolved.length;
  const completeReason =
    readOnly ??
    (!assemble.allowed
      ? assemble.reason
      : view.completeBlockers.length
        ? `Resolve the ${outstanding || view.completeBlockers.length} item${(outstanding || view.completeBlockers.length) === 1 ? "" : "s"} above first.`
        : null);
  const releaseReason =
    readOnly ?? (!release.allowed ? "Only an operations supervisor can release a tray with exceptions." : view.releaseBlockers.length ? view.releaseBlockers[0] : null);
  const beforeDelivery = view.isActive || tray.status === "verified_complete" || tray.status === "released_with_exceptions";
  const heldSlides = view.expected.flatMap((e) => (holds[e.slideId] ?? []).map((h) => ({ e, h })));
  // After each new scan the column's items start from the top, where material that does not belong is listed first.
  const items = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLElement>(null);
  useFitColumn(column);
  const newestScan = view.scans[0]?.id ?? null;
  useEffect(() => {
    if (items.current) items.current.scrollTop = 0;
  }, [newestScan]);
  const cut = useCutBelow(items, `${newestScan}|${view.unresolved.length}|${view.expected.map((e) => e.state).join(",")}|${tray.status}`);

  return (
    <section ref={column} aria-label="What the tray needs" className={cn("flex min-w-0 flex-col self-start overflow-hidden rounded-lg border border-line bg-surface", STICKY_COLUMN, className)}>
      <div className="px-4 pt-3 pb-2.5">
        <Headline view={view} />
      </div>
      {/* The items scroll inside the column when they are many; the headline and the action stay in view, and a cut item is covered and counted. */}
      <div className="relative flex min-h-0 flex-col">
        <div ref={items} className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
          {!view.isActive && tray.close_note ? (
            <p data-cut-unit className="text-sm text-ink-secondary">
              <IdText text={tray.close_note} />
              {view.closedByName && !tray.close_note.includes(view.closedByName) ? ` (${view.closedByName})` : ""}
              {tray.closed_at ? (
                <>
                  {" "}
                  <Timestamp iso={tray.closed_at} now={now} className="text-ink-muted" />
                </>
              ) : null}
            </p>
          ) : null}

          {/* Material that does not belong is physically on the tray: it comes first. */}
          {view.unresolved.length ? (
            <section aria-labelledby="tray-exc" className="flex flex-col gap-2 border-t border-line pt-3">
              <h3 id="tray-exc" data-cut-unit className="text-sm font-semibold text-ink">
                Scanned material that does not belong ({view.unresolved.length})
              </h3>
              <ul className="flex flex-col divide-y divide-line">
                {view.unresolved.map((s) => (
                  <ExceptionItem key={s.id} scan={s} now={now} isSupervisor={release.allowed} canAct={canAct} />
                ))}
              </ul>
            </section>
          ) : null}

          {notOn.length ? (
            <section aria-labelledby="tray-not-on" className="flex flex-col gap-2 border-t border-line pt-3">
              <h3 id="tray-not-on" data-cut-unit className="text-sm font-semibold text-ink">
                Not on the tray yet ({notOn.length})
              </h3>
              <ul className="flex flex-col divide-y divide-line">
                {notOn.map((e) => (
                  <MissingItem
                    key={e.slideId}
                    item={e}
                    position={positions.get(e.slideId) ?? e.seq}
                    active={view.isActive}
                    canAct={canAct && (view.isActive || (e.canceledOnTray && beforeDelivery))}
                    reprintFrom={view.isActive && !e.disposition && unreadable.has(codeBody(e.identifier)) ? printJobs[e.slideId] : undefined}
                    onDisposition={setDispositionFor}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {actReason && (notOn.length || view.unresolved.length) ? (
            <p data-cut-unit className="text-sm text-ink-secondary">
              {actReason}
            </p>
          ) : null}
        </div>
        <CutCover height={cut.cover} scroller={items} />
      </div>
      <CutCue cut={cut} noun={["item", "items"]} />

      <div className={cn("flex shrink-0 flex-col items-stretch gap-2.5 border-t border-line px-4 py-3", view.isActive ? "bg-surface-subtle" : "")}>
        {heldSlides.length && beforeDelivery ? (
          <section aria-label="Delivery holds" className="space-y-1 text-sm text-ink-secondary">
            {heldSlides.map(({ e, h }) => (
              <p key={`${e.slideId}-${h.displayId}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <HoldPill holdId={h.displayId} scope={`position ${positions.get(e.slideId) ?? "?"}`} />
                <span>
                  <IdText text={`${e.label}: ${h.reason}`} />. The tray can be completed; Deliver is refused until the hold is released.
                </span>
              </p>
            ))}
          </section>
        ) : null}
        {view.isActive ? (
          <>
            <CommandButton
              command="tray.complete"
              input={{ trayId: tray.id, expectedVersion: tray.version }}
              variant="primary"
              icon={<PackageCheck className="size-4" aria-hidden />}
              size="block"
              wrapperClassName="items-stretch"
              disabledReason={
                completeReason ? (
                  readOnly || !assemble.allowed || !view.blockedSummary ? (
                    completeReason
                  ) : (
                    <>
                      <span className="sr-only">{view.blockedSummary}</span>
                      <span aria-hidden>{completeReason}</span>
                    </>
                  )
                ) : undefined
              }
              successToast={msg}
              pendingLabel="Checking..."
            >
              Mark tray complete
            </CommandButton>
            {readOnly ? null : !release.allowed ? (
              <p className="text-xs text-ink-secondary">Release with exceptions is for an operations supervisor; it never marks the tray verified.</p>
            ) : (
              <div className="flex flex-col items-start gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ShieldAlert className="size-4" aria-hidden />}
                  disabled={!!releaseReason}
                  reasonId={releaseReason ? `rel-${tray.id}` : undefined}
                  onClick={() => setReleaseOpen(true)}
                >
                  Release with exceptions
                </Button>
                {releaseReason ? (
                  <DisabledReason id={`rel-${tray.id}`} className="text-xs">
                    {releaseReason}
                  </DisabledReason>
                ) : null}
              </div>
            )}
          </>
        ) : tray.status === "verified_complete" || tray.status === "released_with_exceptions" ? (
          <CommandButton
            command="tray.deliver"
            input={{ trayId: tray.id }}
            variant="primary"
            icon={<Truck className="size-4" aria-hidden />}
            size="block"
            wrapperClassName="items-stretch"
            disabledReason={readOnly ?? (assemble.allowed ? undefined : assemble.reason) ?? undefined}
            successToast={msg}
            pendingLabel="Delivering..."
          >
            Deliver tray to {view.pathologistName}
          </CommandButton>
        ) : (
          <p className="text-sm text-ink-secondary">Delivered. Anything outstanding keeps its own task on Operations.</p>
        )}
      </div>

      {dispositionFor ? <DispositionDialog open onClose={() => setDispositionFor(null)} trayId={tray.id} item={dispositionFor} /> : null}
      <ReleaseDialog open={releaseOpen} onClose={() => setReleaseOpen(false)} view={view} />
    </section>
  );
}
