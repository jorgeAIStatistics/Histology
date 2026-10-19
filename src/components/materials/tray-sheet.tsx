"use client";

import { useRef, useState } from "react";
import { Ban, CircleCheck, CirclePause, Eye, Hourglass, LogOut, ScanLine, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { SimulatedLabel } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { useScan } from "@/lib/client/scan";
import type { BenchSlide } from "@/server/queries/materials";
import type { TrayView } from "@/server/domain/tray";
import { labelLines, slotForScan, type TraySlot } from "./tray-model";
import { IdText } from "@/components/domain/id-text";
import { ScanHint } from "./shared";

const SCAN_TONE: Record<string, "success" | "warning" | "neutral"> = {
  verified_expected: "success",
  unexpected: "warning",
  duplicate: "warning",
  canceled_material: "neutral",
  unknown_identifier: "warning",
  invalid_payload: "warning",
};

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
  if (ended) return <p className="text-sm text-ink-secondary">Session ended: the scan field is back to &ldquo;Find record&rdquo;. Reload the tray to scan again.</p>;
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

/** What a scan does here, said once, above the tray. */
function ScanCue({ view, scanAllowed, blockedReason }: { view: TrayView; scanAllowed: boolean; blockedReason: string | null }) {
  if (!scanAllowed) {
    return (
      <p className="flex items-start gap-2 border-b border-line px-4 py-2.5 text-sm text-ink-secondary">
        <ScanLine className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
        <span>
          <IdText text={blockedReason ?? `${view.tray.display_id} is ${view.statusLabel.toLowerCase()}; it no longer accepts scans.`} />
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-brand-100 bg-brand-50 px-4 py-2">
      <ScanHint lead="Scan each slide as you lay it in." />
      <EndSession view={view} />
    </div>
  );
}

const SLIDE_ICON = {
  scanned: CircleCheck,
  empty: null,
  missing: TriangleAlert,
  follows: Hourglass,
  canceled: Ban,
  remove: TriangleAlert,
} as const;

/**
 * One position of the tray: an empty well (dashed) or the slide lying in it, its label end up.
 * In the off-list lane (`lane`), a narrow side column lays the slide on its side (label end, then
 * its state) so the simulated bench and its Scan action stay in the first viewport on a bench tablet.
 */
function Slot({ slot, located, lane = false, className }: { slot: TraySlot; located: boolean; lane?: boolean; className?: string }) {
  const lines = slot.isSlideLabel ? labelLines(slot.label) : null;
  const Icon = SLIDE_ICON[slot.state];
  const amber = slot.tone === "amber";
  const held = slot.holds.length > 0;
  return (
    <li className={cn("flex min-w-0 flex-col items-stretch gap-1", className)}>
      <span className="sr-only">{slot.sr}</span>
      <div
        aria-hidden
        className={cn(
          "flex flex-1 flex-col overflow-hidden rounded-[4px]",
          lane && "@max-[30rem]/side:flex-row",
          slot.onTray
            ? cn("bg-surface shadow-1", amber ? "border-[1.5px] border-warning-solid" : "border border-line-strong")
            : amber
              ? "border-[1.5px] border-dashed border-warning-solid bg-warning-bg"
              : "border-[1.5px] border-dashed border-ink-muted",
          located && "animate-scan-ping",
        )}
      >
        {/* Label end: what is printed on the slide's label (ghosted while the position is empty). */}
        <div
          className={cn(
            "flex min-h-[4.25rem] flex-col items-center justify-center gap-px px-1 py-1.5 text-center",
            slot.onTray ? "border-b border-line" : "",
            lane && "@max-[30rem]/side:w-[5.25rem] @max-[30rem]/side:shrink-0 @max-[30rem]/side:border-r @max-[30rem]/side:border-b-0",
          )}
        >
          {lines ? (
            <>
              <span className={cn("id-mono text-xs leading-4", slot.onTray ? "text-ink-secondary" : "text-ink-muted", slot.state === "canceled" && "line-through")}>{lines.accession}</span>
              <span className={cn("id-mono text-base font-semibold leading-5", slot.onTray ? "text-ink" : "text-ink-muted", slot.state === "canceled" && "line-through")}>
                {lines.position}
              </span>
              <span className={cn("font-mono text-xs leading-4 [overflow-wrap:anywhere]", slot.onTray ? "text-ink-secondary" : "text-ink-muted")}>{lines.rest}</span>
            </>
          ) : (
            <span className="text-md font-semibold text-warning-fg">?</span>
          )}
        </div>
        {/* Glass: the state of this position, in words. */}
        <div
          className={cn(
            "flex min-h-[3.5rem] flex-1 flex-col items-center gap-0.5 px-1 py-2 text-center text-xs leading-4",
            lane && "@max-[30rem]/side:justify-center",
            slot.onTray ? (amber ? "bg-warning-bg" : "bg-brand-50") : "",
            held && "hatch",
          )}
        >
          {Icon ? <Icon className={cn("size-4 shrink-0", amber ? "text-warning-solid" : "text-ink-muted")} /> : null}
          {/* Done is a quiet check and the scan time (the key says what it means); every other state is said in words. */}
          {slot.state === "scanned" ? null : (
            <span className={cn(amber ? "font-semibold text-warning-fg" : slot.tone === "muted" ? "text-ink-muted" : "font-medium text-ink-secondary")}>{slot.words}</span>
          )}
          {slot.detail ? <span className={amber ? "text-warning-fg" : slot.state === "scanned" ? "num-tabular text-ink-secondary" : "text-ink-muted"}>{slot.detail}</span> : null}
          {slot.scannedTwice ? (
            <span className="inline-flex items-center gap-0.5 font-semibold text-warning-fg">
              <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" />
              Twice
            </span>
          ) : null}
          {held ? (
            <span className="inline-flex items-center gap-0.5 font-semibold text-hold-fg">
              <CirclePause className="size-3.5 shrink-0 text-hold-solid" />
              Hold
            </span>
          ) : null}
        </div>
      </div>
      <span aria-hidden className={cn("text-center text-xs leading-4", slot.position === null ? "font-semibold text-warning-fg" : "id-mono text-ink-muted", lane && "@max-[30rem]/side:hidden")}>
        {slot.position ?? "Not listed"}
      </span>
    </li>
  );
}

function Legend({ slots }: { slots: TraySlot[] }) {
  const has = (p: (s: TraySlot) => boolean) => slots.some(p);
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary" aria-label="Key">
      <li className="inline-flex items-center gap-1.5">
        <CircleCheck className="size-3.5 text-ink-muted" aria-hidden />
        Slide on the tray, scan matched (time of the scan)
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-3.5 w-2.5 rounded-[2px] border border-dashed border-ink-muted" />
        Empty position, not scanned yet
      </li>
      {has((s) => s.tone === "amber") ? (
        <li className="inline-flex items-center gap-1.5">
          <TriangleAlert className="size-3.5 text-warning-solid" aria-hidden />
          Needs a person: take it off or record it
        </li>
      ) : null}
      {has((s) => s.holds.length > 0) ? (
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="hatch h-3.5 w-2.5 rounded-[2px] border border-hold-border" />
          On hold
        </li>
      ) : null}
    </ul>
  );
}

/** Slides on the bench next to the tray (SIMULATED scanner). Clicking Scan sends that label to the scan field's target. */
function Bench({ bench }: { bench: BenchSlide[] }) {
  const scan = useScan();
  const [found, setFound] = useState<Record<string, boolean>>({});
  return (
    <section aria-labelledby="bench-title" className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="bench-title" className="text-sm font-semibold text-ink">
          On the bench, not on the tray
        </h3>
        <SimulatedLabel connector="scanner" size="xs" />
      </div>
      {bench.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-1.5">
          {bench.map((b) => {
            const hidden = b.hiddenUntilFound && !found[b.key];
            const text = b.label.replace(/\s*\(.*\)$/, "");
            const aside = /\((.*)\)$/.exec(b.label)?.[1] ?? null;
            return (
              <li key={b.key} className={cn("flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 rounded-md border px-2.5 py-1.5", hidden ? "border-dashed border-line-strong" : "border-line bg-surface")}>
                <div className="min-w-0">
                  <p className={cn("text-sm", hidden ? "text-ink-muted" : "text-ink")}>
                    <span className="id-mono font-medium">
                      {labelLines(text).accession} {labelLines(text).position}
                    </span>{" "}
                    <span className="inline-block font-mono">{labelLines(text).rest}</span>
                    {aside ? <span className="text-ink-secondary"> ({aside})</span> : null}
                  </p>
                  {/* An expected slide needs no note: the heading already says it is on the bench and not on the tray. */}
                  {b.kind === "expected" ? null : (
                    <p className="text-xs text-ink-muted">{hidden ? "Not on the bench yet." : b.kind === "missing" ? "Found and brought to the bench" : b.note}</p>
                  )}
                </div>
                {hidden ? (
                  <Button size="md" variant="quiet" icon={<Eye className="size-4" aria-hidden />} onClick={() => setFound((f) => ({ ...f, [b.key]: true }))}>
                    Found it<span className="sr-only"> {b.label}</span>
                  </Button>
                ) : (
                  <Button size="md" variant="secondary" icon={<ScanLine className="size-4" aria-hidden />} disabled={scan.pending} onClick={() => void scan.submit(b.payload).then(() => scan.focus())}>
                    Scan<span className="sr-only"> {b.label}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-secondary">Nothing for this tray is left on the bench.</p>
      )}
      <p className="text-xs text-ink-muted">Synthetic slides for the demo. Scan sends the slide&apos;s label to the scan field (or scan or type one there); Found it simulates finding a missing slide.</p>
    </section>
  );
}

/**
 * Material scanned onto the tray that is not on its list, in its own lane at the
 * head of the side column (beside the tray on a bench tablet, under it on wider
 * screens), so it is never a wrapped eleventh slot below the fold.
 */
function OffList({ slots, located }: { slots: TraySlot[]; located: string | null }) {
  return (
    <div role="group" aria-labelledby="tray-offlist-title" className="flex min-w-0 shrink-0 flex-col gap-2 @min-[30rem]/side:max-w-[50%]">
      <h3 id="tray-offlist-title" className="flex items-start gap-1.5 text-sm font-semibold text-warning-fg">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
        <span>On the tray, not on its list ({slots.length})</span>
      </h3>
      <ol className="flex flex-wrap gap-x-1.5 gap-y-2.5">
        {slots.map((s) => (
          <Slot key={s.key} slot={s} located={located === s.key} lane className="w-[5.25rem] @max-[30rem]/side:w-full" />
        ))}
      </ol>
    </div>
  );
}

function ScanLog({ view, now }: { view: TrayView; now: string }) {
  if (!view.scans.length) return <p className="px-4 py-3 text-sm text-ink-secondary">No scans yet. Scan the first slide.</p>;
  return (
    <details className="group px-4 py-2.5">
      <summary className="flex min-h-[max(2rem,var(--hlo-target-min))] cursor-pointer items-center gap-2 text-sm font-medium text-ink">
        Scan log <span className="font-normal text-ink-muted">{view.scans.length} scan{view.scans.length === 1 ? "" : "s"}, newest first, every scan kept</span>
      </summary>
      <ol className="mt-1.5 flex max-h-[240px] flex-col gap-1 overflow-y-auto text-sm">
        {view.scans.slice(0, 40).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2">
            <Timestamp iso={s.scannedAt} now={now} className="w-[5.5rem] text-xs text-ink-muted" />
            <StatusPill size="sm" tone={SCAN_TONE[s.result] ?? "neutral"}>
              {s.resultLabel}
            </StatusPill>
            <span className="id-mono">{s.slideLabel ?? s.payload}</span>
            {s.resolutionLabel ? <span className="text-xs text-ink-muted">{s.resolutionLabel}</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * The tray as it sits on the bench: the scan cue, one slot per position on the
 * tray's list (bound to tray_expected_slide.seq), then a side column with the
 * material that is on the tray but not on its list and the simulated bench, and the log.
 */
export function TraySheet({
  view,
  slots,
  bench,
  scanAllowed,
  scanBlockedReason,
  now,
  className,
}: {
  view: TrayView;
  slots: TraySlot[];
  bench: BenchSlide[];
  scanAllowed: boolean;
  scanBlockedReason: string | null;
  now: string;
  className?: string;
}) {
  // The newest scan is located on the tray (a short ring), but not on first load.
  const newest = view.scans[0];
  const firstNewest = useRef(newest?.id ?? null);
  const located = newest && newest.id !== firstNewest.current ? slotForScan(slots, newest) : null;
  const listed = slots.filter((s) => s.position !== null);
  const offList = slots.filter((s) => s.position === null);
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg border border-line bg-surface", className)}>
      <ScanCue view={view} scanAllowed={scanAllowed} blockedReason={scanBlockedReason} />
      <div className="@container flex flex-col gap-4 px-4 pt-3 pb-4">
        <section aria-labelledby="tray-sheet-title" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="tray-sheet-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
              Expected slides, by tray position
            </h2>
            <p className="text-xs text-ink-muted">
              <IdText text={`${listed.length} position${listed.length === 1 ? "" : "s"} on ${view.tray.display_id}'s list. Each slide needs its own scan; one tray scan never verifies the slides on it.`} />
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-x-4 gap-y-4">
            <div className="inline-grid max-w-full gap-2">
              <div className="rounded-lg border border-line-strong bg-surface-sunken p-2.5 shadow-[inset_0_1px_3px_rgb(21_26_48/0.10)]">
                <ol className="grid grid-cols-[repeat(5,5.25rem)] gap-x-1.5 gap-y-2.5 @min-[58rem]:grid-cols-[repeat(10,5.25rem)]">
                  {listed.map((s) => (
                    <Slot key={s.key} slot={s} located={located === s.key} />
                  ))}
                </ol>
              </div>
              {/* w-0 min-w-full: the key wraps to the tray's width instead of widening it. */}
              <div className="w-0 min-w-full">
                <Legend slots={slots} />
              </div>
            </div>
            {offList.length || scanAllowed ? (
              // Beside the tray on a bench tablet (narrow: the lane's slides lie on their side), under it on wider
              // screens (wide: the lane and the bench side by side). Either way the bench's first Scan stays in view.
              <div className="@container/side min-w-[10rem] flex-1 basis-[10rem]">
                <div className="flex flex-col gap-4 @min-[30rem]/side:flex-row @min-[30rem]/side:items-start @min-[30rem]/side:gap-6">
                  {offList.length ? <OffList slots={offList} located={located} /> : null}
                  {scanAllowed ? <Bench bench={bench} /> : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>
      <div className="border-t border-line">
        <ScanLog view={view} now={now} />
      </div>
    </div>
  );
}
