"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Archive, Hand, Plus, ScanLine, SearchX, TriangleAlert, Truck, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { SimulatedLabel } from "@/components/domain/honesty";
import { IdText } from "@/components/domain/id-text";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useFocusScanOnMount, useScan, useScanTarget, type ScanOutcome } from "@/lib/client/scan";
import { useCan } from "@/lib/client/shell-context";
import type { PickGroup, RetrievalDetail, RetrievalFilter, RetrievalItemView, RetrievalListRow, custodyExceptions } from "@/server/queries/materials";
import { ReasonDialog } from "./print-dialogs";
import { BENCH_BAND, BENCH_DECISION, BENCH_GRID, BENCH_WORK, CutCover, CutCue, failureToScan, ScanHint, STICKY_COLUMN, useCutBelow, useFitColumn, useReadOnly } from "./shared";
import { retrievalWalk } from "./retrieval-model";
import { LocationPath, locationSegments, pathWords, SlotTile, splitSlot, type PathSegment } from "./location-path";

type RetrievalScanDto = { result: string; accepted: boolean; message: string; scannedLabel: string | null };

const ITEM_TONE: Record<string, "neutral" | "info" | "success" | "warning"> = {
  pending: "neutral",
  picked: "info",
  delivered: "success",
  returned: "success",
  not_found: "warning",
  missing_investigation: "warning",
};

const EVENT_TEXT: Record<string, string> = {
  stored: "Stored",
  location_confirmed: "Location confirmed",
  checked_out: "Checked out",
  returned: "Returned",
  sent_out: "Sent out",
  received_back: "Received back",
  missing_reported: "Reported missing",
  found: "Found",
  scan_mismatch: "Wrong block scanned (not accepted)",
};

/**
 * The scan field's line for a retrieval scan. A block that is not on the request (or
 * cannot be picked by this person) is amber, named in words and announced as an alert:
 * it is rejected and nothing changes. Red is kept for patient identity.
 */
function toScanOutcome(r: RetrievalScanDto): ScanOutcome {
  if (r.result === "picked") return { tone: "success", message: r.message };
  if (r.result === "duplicate") return { tone: "info", message: r.message, sound: null };
  return { tone: "warning", alert: true, message: r.message, sound: "mismatch" };
}

/** Last confirmed custody, said as who and when, never as live tracking. */
function LastConfirmed({ item, now }: { item: RetrievalItemView; now: string }) {
  if (!item.location.code) return <p className="text-sm text-ink-secondary">{item.location.text}</p>;
  return (
    <p className="text-sm text-ink">
      Last confirmed by <span className="font-medium">{item.location.confirmedBy ?? "Unknown"}</span> at{" "}
      {item.location.confirmedAt ? <Timestamp iso={item.location.confirmedAt} now={now} /> : "an unknown time"}
    </p>
  );
}

/** One requested block where it was last confirmed: the slot (position) first, then the block and what is known about it. */
function BlockItem({ item, total, now, requestDisplayId, canAct, inBox }: { item: RetrievalItemView; total: number; now: string; requestDisplayId: string; canAct: boolean; inBox: boolean }) {
  const [nfOpen, setNfOpen] = useState(false);
  const [code, setCode] = useState(item.location.code && item.location.code.startsWith("CAB-") ? item.location.code : "");
  const toast = useToast();
  const ret = useCommand<{ message: string }, { blockId: string; locationCode: string; note?: string }>("retrieval.return", { errorToast: false });
  const [foundNote, setFoundNote] = useState("");
  const wasMissing = item.availability === "missing";
  /** Checked out or sent outside the lab: the most recent confirmed custody is the holder, not the storage slot. */
  const away = item.status === "pending" && (item.availability === "checked_out" || item.availability === "sent_out");
  const segs = locationSegments(item.location.code);
  const slot = inBox && segs ? segs[segs.length - 1] : null;
  return (
    <li className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 px-4 py-3 max-xl:grid-cols-[4rem_minmax(0,1fr)] max-xl:px-3">
      {/* The position in the box (or where the block is instead), set large: it is what the hand goes to. */}
      {slot ? (
        <SlotTile slot={slot} className="self-start" />
      ) : (
        <div className={cn("flex flex-col items-center justify-center self-start rounded-md border px-1 py-1.5 text-center", away ? "border-warning-border bg-warning-bg" : "border-line-strong bg-surface-subtle")}>
          {away ? (
            <>
              <Hand className="size-5 text-warning-solid" aria-hidden />
              <span className="text-xs font-semibold text-warning-fg">{item.availability === "sent_out" ? "Sent out" : "Checked out"}</span>
            </>
          ) : (
            <>
              <Archive className="size-5 text-ink-muted" aria-hidden />
              <span className="text-xs text-ink-muted">{item.statusLabel}</span>
            </>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="num-tabular text-sm text-ink-secondary">
            Pick {item.benchSeq} of {total}
          </span>
          <span className="id-mono text-md font-semibold text-ink">{item.blockLabel}</span>
          <StatusPill size="sm" tone={ITEM_TONE[item.status] ?? "neutral"}>
            {item.statusLabel}
          </StatusPill>
          {item.custody.overdue ? (
            <StatusPill size="sm" tone="warning">
              Overdue return
            </StatusPill>
          ) : null}
          {item.availability === "sent_out" ? (
            <StatusPill size="sm" tone="warning">
              Outside send-out
            </StatusPill>
          ) : null}
        </div>

        {away ? (
          <>
            <p className="text-sm text-ink">
              Last confirmed custody: <span className="font-medium">{item.custody.summary}</span>
            </p>
            {item.location.code ? (
              <p className="text-sm text-ink-secondary">
                Home slot <span className="id-mono">{item.location.code}</span>; the block is not there while it is {item.availability === "sent_out" ? "sent out" : "checked out"}.
              </p>
            ) : null}
          </>
        ) : (
          <>
            {segs && !inBox ? <LocationPath segments={segs} size="sm" /> : null}
            <LastConfirmed item={item} now={now} />
            {item.location.code && !segs ? (
              <p className="text-xs text-ink-muted">
                Location code <span className="id-mono text-ink-secondary">{item.location.code}</span>
              </p>
            ) : null}
          </>
        )}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
          {away ? null : (
            <>
              <dt className="text-ink-muted">Custody now</dt>
              <dd className="text-ink">{item.custody.summary}</dd>
            </>
          )}
          {item.pickedAt ? (
            <>
              <dt className="text-ink-muted">Picked</dt>
              <dd className="text-ink">
                {item.pickedBy ?? "Unknown"}, <Timestamp iso={item.pickedAt} now={now} />
              </dd>
            </>
          ) : null}
          {item.note ? (
            <>
              <dt className="text-ink-muted">Note</dt>
              <dd className="text-ink">{item.note}</dd>
            </>
          ) : null}
        </dl>

        {item.status === "pending" && item.availability === "checked_out" && item.custody.holder ? (
          <p className="text-sm text-ink-secondary">
            {item.custody.holder} scans it for {requestDisplayId}, or a supervisor records the hand-off. A scan by anyone else is not accepted.
          </p>
        ) : null}
        {item.status === "pending" && item.availability === "sent_out" ? (
          <p className="text-sm text-ink-secondary">Request it back from the recipient; a scan here is treated as a conflicting record for a supervisor.</p>
        ) : null}

        {canAct && item.status === "pending" && item.availability !== "sent_out" ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="quiet" icon={<SearchX className="size-4" aria-hidden />} onClick={() => setNfOpen(true)}>
              {item.availability === "checked_out" ? "Not with the recorded holder…" : "Not at last location…"}
            </Button>
          </div>
        ) : null}
        {canAct && (item.status === "picked" || item.status === "delivered" || wasMissing) ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Return to slot" className="w-[260px]" hint="Confirms this block's slot only, not the rest of the box.">
              <Input mono value={code} onChange={(e) => setCode(e.target.value)} placeholder="CAB-2/DR-4/BX-11/S-14" />
            </Field>
            {wasMissing ? (
              <Field label="Where it was found" required className="w-[300px]" hint="Closes the missing-material investigation with this note.">
                <Input value={foundNote} onChange={(e) => setFoundNote(e.target.value)} placeholder="e.g. found in the embedding-station tray" />
              </Field>
            ) : null}
            <Button
              size="md"
              variant="secondary"
              icon={<Undo2 className="size-4" aria-hidden />}
              loading={ret.pending}
              onClick={async () => {
                const out = await ret.run({ blockId: item.blockId, locationCode: code, ...(wasMissing ? { note: foundNote } : {}) });
                if (out.ok) toast.show({ tone: "success", title: "Block returned", body: out.result.message });
              }}
            >
              Record return
            </Button>
            <CommandError error={ret.error} className="basis-full" />
          </div>
        ) : null}

        <details>
          <summary className="flex min-h-[max(2rem,var(--hlo-target-min))] w-fit cursor-pointer items-center text-sm font-medium text-brand">Custody history ({item.history.length})</summary>
          <ol className="mt-1 flex flex-col gap-1 text-sm">
            {item.history.map((h) => (
              <li key={h.id} className={h.event === "scan_mismatch" ? "text-warning-fg" : "text-ink"}>
                <Timestamp iso={h.at} now={now} className="text-xs text-ink-muted" />{" "}
                {h.event === "scan_mismatch" ? <TriangleAlert className="mb-0.5 inline size-3.5 text-warning-solid" aria-hidden /> : null} {EVENT_TEXT[h.event] ?? h.event}
                {h.holder ? `, to ${h.holder}` : ""}
                {h.locationCode ? (
                  <>
                    , <span className="id-mono">{h.locationCode}</span>
                  </>
                ) : null}
                {h.destination ? `, ${h.destination}` : ""}
                {h.actor ? <span className="text-ink-muted"> (by {h.actor})</span> : null}
                {h.note ? <span className="block text-xs text-ink-muted">{h.note}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      </div>

      <ReasonDialog
        open={nfOpen}
        onClose={() => setNfOpen(false)}
        title={item.availability === "checked_out" ? `${item.blockLabel} is not with ${item.custody.holder ?? "the recorded holder"}?` : `${item.blockLabel} is not at its last confirmed location?`}
        description={`Opens a missing-material investigation task. ${requestDisplayId} continues with the other blocks (partial retrieval).`}
        label="What was checked"
        placeholder="Slot empty; checked neighbouring slots and the box"
        confirmLabel="Open investigation"
        cancelLabel="Keep looking"
        command="retrieval.markNotFound"
        buildInput={(note) => ({ itemId: item.id, note })}
        successTitle={() => `Investigation opened for ${item.blockLabel}`}
      />
    </li>
  );
}

/** One stop on the walk: the box (as a path) and the blocks to take from it; or the blocks that are not in storage. */
function PickStop({ group, items, total, now, requestDisplayId, canAct }: { group: PickGroup; items: RetrievalItemView[]; total: number; now: string; requestDisplayId: string; canAct: boolean }) {
  const segs = locationSegments(group.key.startsWith("~") ? null : group.key);
  // Said once per stop: every location here is the last confirmed one, never live tracking.
  const caption = items.find((i) => i.location.caption)?.location.caption ?? null;
  return (
    <section aria-label={segs ? pathWords(segs) : group.label} className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-subtle px-4 py-2 max-xl:px-3">
        {segs ? (
          <LocationPath segments={segs} />
        ) : (
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Archive className="size-4 text-ink-muted" aria-hidden />
            {group.label}
          </p>
        )}{" "}
        <span className="ml-auto text-xs text-ink-muted">
          {items.length} block{items.length === 1 ? "" : "s"}
          {segs ? " in this box" : ""}
        </span>
        {caption ? <p className="basis-full text-xs text-ink-secondary">{caption}</p> : null}
      </div>
      <ul className="divide-y divide-line">
        {items.map((i) => (
          <BlockItem key={i.id} item={i} total={total} now={now} requestDisplayId={requestDisplayId} canAct={canAct} inBox={!!segs} />
        ))}
      </ul>
    </section>
  );
}

/** The request in hand, pinned while scanning. */
function RequestBand({ detail, now, mismatches }: { detail: RetrievalDetail; now: string; mismatches: number }) {
  const req = detail.request;
  return (
    <section aria-label="Current retrieval request" className={BENCH_BAND}>
      <div className="flex shrink-0 flex-col justify-center rounded-md border-[1.5px] border-ink bg-surface py-1 pr-3 pl-2.5 leading-5">
        <p className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-sm font-medium text-ink-muted">Retrieval request</span>
          <span className="id-mono text-md font-semibold text-ink">{req.displayId}</span>
        </p>
        <p className="whitespace-nowrap text-sm text-ink">
          <span className="text-ink-muted">Requested by</span> <span className="font-medium">{req.requestedBy}</span>
        </p>
      </div>
      <p className="flex items-baseline gap-2 text-sm text-ink-secondary">
        <span className="num-tabular text-xl font-semibold tracking-[-0.01em] text-ink">
          {req.picked} of {req.items}
        </span>{" "}
        picked
      </p>
      {req.exceptions ? (
        <p className="inline-flex items-center gap-1.5 rounded-sm bg-warning-bg px-2 py-0.5 text-sm font-semibold text-warning-fg">
          <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />
          {req.exceptions} not found
        </p>
      ) : null}
      {mismatches ? (
        <p className="inline-flex items-center gap-1.5 rounded-sm bg-warning-bg px-2 py-0.5 text-sm font-semibold text-warning-fg">
          <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />
          {mismatches} wrong scan{mismatches === 1 ? "" : "s"} rejected
        </p>
      ) : null}
      <StatePill domain="retrieval" state={req.status} />
      <dl className="ml-auto flex flex-wrap gap-x-5 gap-y-0.5 text-sm max-xl:ml-0">
        <div className="flex gap-1.5">
          <dt className="text-ink-muted">Destination</dt>
          <dd className="font-medium text-ink">{req.destination}</dd>
        </div>
        {req.dueAt ? (
          <div className="flex gap-1.5">
            <dt className="text-ink-muted">Needed by</dt>
            <dd className="text-ink">
              <Timestamp iso={req.dueAt} now={now} />
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

/** The walk to the next block in two steps: the box as a path, then the slot set large beside who last confirmed it. */
function NextWalk({ segments, confirmedBy, confirmedAt, now }: { segments: PathSegment[]; confirmedBy: string | null; confirmedAt: string | null; now: string }) {
  const { box, slot } = splitSlot(segments);
  return (
    <div className="flex flex-col gap-2">
      {box.length ? <LocationPath segments={box} size="sm" /> : null}
      <div className="flex items-center gap-3">
        {slot ? <SlotTile slot={slot} across /> : null}
        <p className="text-sm text-ink-secondary">
          Last confirmed by <span className="font-medium text-ink">{confirmedBy ?? "Unknown"}</span> at {confirmedAt ? <Timestamp iso={confirmedAt} now={now} /> : "an unknown time"}.
        </p>
      </div>
    </div>
  );
}

/** A requested block still to pick, with the simulated scanner's Scan for it. */
function PickRow({ label, payload, note, pending, apart = false }: { label: string; payload: string; note?: string; pending: boolean; apart?: boolean }) {
  const scan = useScan();
  return (
    <li data-cut-row={apart ? "apart" : ""} data-cut-unit className="flex items-center justify-between gap-2 py-0.5">
      <span className="min-w-0">
        <span className="id-mono text-sm font-medium text-ink">{label}</span>
        {note ? <span className="block text-xs text-ink-muted">{note}</span> : null}
      </span>
      <Button size="md" variant="secondary" icon={<ScanLine className="size-4" aria-hidden />} disabled={pending} onClick={() => void scan.submit(payload).then(() => scan.focus())}>
        Scan<span className="sr-only"> {label}</span>
      </Button>
    </li>
  );
}

/** The cue under a cut pick list counts what the headings count: blocks to pick, and the look-alike apart from them. */
function pickCue(rows: HTMLElement[]): string | null {
  const apart = rows.filter((r) => r.dataset.cutRow === "apart").length;
  const toPick = rows.length - apart;
  const parts = [toPick ? `${toPick} to pick` : null, apart ? `${apart} not on this request` : null].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} below` : null;
}

/**
 * The scan check: the next block and the walk to it, the last result in words, the blocks
 * still to pick (with the simulated scanner), and delivery always in view. In the bench frame the
 * middle scrolls inside the column; when a row is cut off it says how many more are below.
 */
function ScanCheck({
  detail,
  now,
  last,
  scanAllowed,
  readOnly,
  canPick,
  className,
}: {
  detail: RetrievalDetail;
  now: string;
  last: RetrievalScanDto | null;
  scanAllowed: boolean;
  readOnly: string | null;
  canPick: { allowed: boolean; reason: string | null };
  className?: string;
}) {
  const scan = useScan();
  const req = detail.request;
  const active = !["delivered", "canceled"].includes(req.status);
  const picked = detail.items.filter((i) => i.status === "picked").length;
  // The next block on the walk is the first one still to pick, in walking order.
  const { next, toPick } = retrievalWalk(detail);
  const nextSegs = next ? locationSegments(next.location.code) : null;
  // A new scan result is written at the head of the scrolling middle: bring it into view there,
  // even when the hand had scrolled down to the last block (bench tablet height).
  const middle = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (last && middle.current) middle.current.scrollTop = 0;
  }, [last]);
  const column = useRef<HTMLElement>(null);
  useFitColumn(column);
  const below = useCutBelow(middle, `${scanAllowed}|${toPick.map((p) => p.id).join(",")}|${last ? `${last.result}:${last.scannedLabel}` : ""}`);
  return (
    <section ref={column} aria-labelledby="scan-check-title" className={cn("flex min-w-0 flex-col self-start overflow-hidden rounded-lg border border-line bg-surface", STICKY_COLUMN, className)}>
      <div className="flex flex-col gap-2 px-4 pt-3.5 pb-2">
        <h2 id="scan-check-title" className="text-lg font-semibold leading-7 tracking-[-0.01em] text-ink">
          {!active ? (
            <IdText text={`${req.displayId} is ${req.statusLabel.toLowerCase()}.`} />
          ) : next ? (
            <>
              Next: <span className="id-mono">{next.blockLabel}</span>
            </>
          ) : (
            "Every requested block is accounted for."
          )}
        </h2>
        {active && next ? (
          nextSegs && next.availability === "in_storage" ? (
            <NextWalk segments={nextSegs} confirmedBy={next.location.confirmedBy} confirmedAt={next.location.confirmedAt} now={now} />
          ) : (
            <p className="text-sm text-ink-secondary">{next.custody.summary}</p>
          )
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-col">
        <div ref={middle} className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
          {last && !last.accepted && last.result !== "duplicate" ? (
            // Short: the scan field's line already carries the server's full sentence, and the list below says what is still to pick.
            <AlertBanner
              tone="warning"
              className="shrink-0"
              title={
                last.result === "mismatch"
                  ? "Wrong block: not accepted"
                  : last.result === "held_by_other"
                    ? "Recorded holder differs: not picked"
                    : last.result === "conflict"
                      ? "Conflicting custody records: not picked"
                      : "Scan not accepted"
              }
            >
              <IdText
                text={
                  last.result === "mismatch" && last.scannedLabel
                    ? `${last.scannedLabel} is not on ${req.displayId}. Nothing was changed.`
                    : last.message.replace(/^Mismatch\.\s*/, "")
                }
              />
            </AlertBanner>
          ) : last && last.accepted ? (
            <AlertBanner tone="success" title="Scanned, matches" className="shrink-0">
              <IdText text={last.message} />
            </AlertBanner>
          ) : null}

          {scanAllowed ? (
            <section aria-labelledby="rr-topick-title" className="flex flex-col gap-1.5 border-t border-line pt-3">
              <div data-cut-unit className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <h3 id="rr-topick-title" className="text-sm font-semibold text-ink">
                  Still to pick ({toPick.length})
                </h3>
                <SimulatedLabel connector="scanner" size="xs" />
              </div>
              {last ? null : (
                <p data-cut-unit className="text-sm text-ink-secondary">
                  A wrong block is rejected; nothing changes.
                </p>
              )}
              {toPick.length ? (
                <ul aria-labelledby="rr-topick-title" className="flex flex-col divide-y divide-line">
                  {toPick.map((p) => (
                    <PickRow key={p.id} label={p.blockLabel} payload={p.identifier} pending={scan.pending} />
                  ))}
                </ul>
              ) : null}
              {detail.sampleWrongBlock ? (
                <ul aria-label="Also on the bench" className="mt-1 flex flex-col border-t border-line-strong pt-0.5">
                  <PickRow label={detail.sampleWrongBlock.label} payload={detail.sampleWrongBlock.payload} note="Not on this request" pending={scan.pending} apart />
                </ul>
              ) : null}
            </section>
          ) : null}

          {detail.scanLog.length ? (
            <section aria-labelledby="rr-log-title" className="flex flex-col gap-1.5 border-t border-line pt-3">
              <h3 id="rr-log-title" data-cut-unit className="text-sm font-semibold text-ink">
                Scans and custody for this request
              </h3>
              <ol className="flex flex-col gap-1 text-sm">
                {detail.scanLog.map((l, i) => (
                  <li key={i} data-cut-unit className={cn("grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2", l.event === "scan_mismatch" ? "text-warning-fg" : "text-ink")}>
                    <Timestamp iso={l.at} now={now} className="text-xs leading-5 text-ink-muted" />
                    <span>
                      {l.event === "scan_mismatch" ? <TriangleAlert className="mr-1 mb-0.5 inline size-3.5 text-warning-solid" aria-hidden /> : null}
                      {EVENT_TEXT[l.event] ?? l.event}: <span className="id-mono">{l.blockLabel}</span>
                      {l.actor ? <span className="text-ink-muted"> ({l.actor})</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
        {/* The column ends at the last whole row: the cut one is covered, and the cue below says what follows. */}
        <CutCover height={below.cover} scroller={middle} />
      </div>
      <CutCue cut={below} noun={["block", "blocks"]} describe={pickCue} />

      <div className={cn("flex shrink-0 flex-col items-stretch gap-2 border-t border-line px-4 py-2.5", active ? "bg-surface-subtle" : "")}>
        {active ? (
          <CommandButton
            command="retrieval.deliver"
            input={{ requestId: req.id }}
            variant="primary"
            size="block"
            icon={<Truck className="size-4" aria-hidden />}
            wrapperClassName="items-stretch"
            disabledReason={readOnly ?? (!canPick.allowed ? canPick.reason : picked === 0 ? "Scan at least one requested block first." : undefined) ?? undefined}
            successToast={(r: { message: string }) => r.message}
            pendingLabel="Recording..."
          >
            Deliver to {req.destination}
          </CommandButton>
        ) : (
          <p className="text-sm text-ink-secondary">This request is {req.statusLabel.toLowerCase()}.</p>
        )}
        {/* Without the list above (read only, or no scan permission), the blocks still to pick are said here. */}
        {toPick.length && active && !scanAllowed ? <p className="text-sm text-ink-secondary">Still to pick: {toPick.map((p) => p.blockLabel).join(", ")}.</p> : null}
      </div>
    </section>
  );
}

function CustodyExceptions({ exceptions }: { exceptions: ReturnType<typeof custodyExceptions> }) {
  const groups = [
    { key: "overdue", title: "Overdue returns", rows: exceptions.overdue, amber: true },
    { key: "sent", title: "Outside send-outs", rows: exceptions.sentOut, amber: false },
    { key: "missing", title: "Missing-material investigations", rows: exceptions.missing, amber: true },
  ];
  return (
    <section aria-labelledby="custody-exc-title" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 id="custody-exc-title" className="text-sm font-semibold text-ink">
          Custody exceptions across all blocks
        </h2>
        <p className="text-xs text-ink-muted">Not only this request. Locations are last confirmed, not live.</p>
      </div>
      <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-1 px-4 py-2.5 text-sm">
            <p className={cn("flex items-center gap-1.5 font-medium", g.rows.length && g.amber ? "text-warning-fg" : "text-ink")}>
              {g.rows.length && g.amber ? <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden /> : null}
              {g.title} ({g.rows.length})
            </p>
            {g.rows.length ? (
              g.rows.map((o) => (
                <p key={o.label} className="text-xs text-ink-secondary">
                  <span className="id-mono text-ink">{o.label}</span>: {o.summary}
                </p>
              ))
            ) : (
              <p className="text-xs text-ink-muted">None</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function RequestWorkspace({ detail, now, exceptions }: { detail: RetrievalDetail; now: string; exceptions: ReturnType<typeof custodyExceptions> }) {
  const readOnly = useReadOnly();
  const canPick = useCan("retrieval.pick");
  const req = detail.request;
  const scanCmd = useCommand<RetrievalScanDto, { requestId: string; payload: string }>("retrieval.scan", { errorToast: false });
  const [last, setLast] = useState<RetrievalScanDto | null>(null);
  const active = !["delivered", "canceled"].includes(req.status);
  const scanAllowed = active && !readOnly && canPick.allowed;

  useScanTarget(
    scanAllowed ? `Check block for ${req.displayId}` : null,
    async (value) => {
      const out = await scanCmd.run({ requestId: req.id, payload: value });
      if (out.ok) setLast(out.result);
      return out.ok ? toScanOutcome(out.result) : failureToScan(out.error, "mismatch");
    },
    { placeholder: "Scan the block (cassette) label" },
  );
  useFocusScanOnMount(scanAllowed);

  const mismatches = detail.scanLog.filter((l) => l.event === "scan_mismatch").length;
  const byId = new Map(detail.items.map((i) => [i.id, i]));
  const canAct = !readOnly && canPick.allowed;

  return (
    <div className="flex flex-col">
      <RequestBand detail={detail} now={now} mismatches={mismatches} />
      {/* The scan check first in the DOM: the stacked layout (200% zoom) reads the next block and its walk before the full list. */}
      <div className={BENCH_GRID}>
        <ScanCheck detail={detail} now={now} last={last} scanAllowed={scanAllowed} readOnly={readOnly} canPick={canPick} className={BENCH_DECISION} />
        <div className={cn("flex min-w-0 flex-col gap-3", BENCH_WORK)}>
          {/* Said as on the tray tab: what a scan does here, and the key for the scan field. */}
          {scanAllowed ? (
            <div className="rounded-md border border-brand-100 bg-brand-50 px-4 py-2">
              <ScanHint lead="Scan each block as you take it from its slot." />
            </div>
          ) : null}
          <section aria-labelledby="rr-blocks-title" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 id="rr-blocks-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
                Requested blocks, in walking order
              </h2>
              <p className="text-xs text-ink-muted">Grouped by storage location. &ldquo;Pick 2 of 3&rdquo; is the order the receiving bench needs them.</p>
            </div>
            <p className="text-sm text-ink-secondary">
              {req.purpose}
              {req.workOrderDisplayId ? (
                <>
                  {" "}
                  Work order <span className="id-mono">{req.workOrderDisplayId}</span>.
                </>
              ) : null}
            </p>
            <div className="flex flex-col gap-3">
              {detail.pickList.map((g) => (
                <PickStop
                  key={g.key}
                  group={g}
                  items={g.items.map((x) => byId.get(x.itemId)).filter((x): x is RetrievalItemView => !!x)}
                  total={detail.items.length}
                  now={now}
                  requestDisplayId={req.displayId}
                  canAct={canAct}
                />
              ))}
            </div>
            <p className="text-xs text-ink-muted">{detail.overdueRule}</p>
          </section>
          <CustodyExceptions exceptions={exceptions} />
        </div>
      </div>
    </div>
  );
}

function NewRequestDialog({ open, onClose, blocks }: { open: boolean; onClose: () => void; blocks: { id: string; label: string; location: string | null }[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const toast = useToast();
  const [order, setOrder] = useState<string[]>([]);
  const [purpose, setPurpose] = useState("");
  const [destination, setDestination] = useState("Microtomy bench 2");
  const [blank, setBlank] = useState(false);
  const cmd = useCommand<{ displayId: string; message: string }, { blockIds: string[]; purpose: string; destination: string }>("retrieval.create", { errorToast: false });
  const toggle = (id: string) => setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const submit = async () => {
    if (!order.length || !purpose.trim()) {
      setBlank(true);
      return;
    }
    const out = await cmd.run({ blockIds: order, purpose: purpose.trim(), destination });
    if (out.ok) {
      toast.show({ tone: "success", title: `${out.result.displayId} created`, body: out.result.message });
      setOrder([]);
      setPurpose("");
      onClose();
      startTransition(() => router.push(`/materials?tab=retrieval&selected=${encodeURIComponent(out.result.displayId)}`, { scroll: false }));
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Request blocks from storage"
      description="Tick blocks in the order the receiving bench needs them. The pick list will group them by location."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Do not request
          </Button>
          <Button variant="primary" loading={cmd.pending} onClick={() => void submit()}>
            Create request
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset className="max-h-[260px] overflow-y-auto rounded-md border border-line p-2">
          <legend className="px-1 text-sm font-medium text-ink-secondary">Blocks (bench order follows the order you tick them)</legend>
          <ul className="flex flex-col gap-1">
            {blocks.map((b) => {
              const pos = order.indexOf(b.id);
              return (
                <li key={b.id}>
                  <label className="flex min-h-[max(2rem,var(--hlo-target-min))] items-center gap-2 text-sm">
                    <input type="checkbox" checked={pos >= 0} onChange={() => toggle(b.id)} className="accent-[var(--hlo-brand)]" />
                    <span className="num-tabular w-6 text-right text-xs text-ink-muted">{pos >= 0 ? pos + 1 : ""}</span>
                    <span className="id-mono font-medium">{b.label}</span>
                    <span className="text-xs text-ink-muted">{b.location ?? "Location unknown"}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {blank && !order.length ? (
          <p className="flex items-center gap-1.5 text-sm text-warning-fg">
            <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />
            Choose at least one block.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Purpose" required error={blank && !purpose.trim() ? "Say why the blocks are needed." : undefined}>
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Deeper levels for comparison" />
          </Field>
          <Field label="Destination" required>
            <Select value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option>Microtomy bench 1</option>
              <option>Microtomy bench 2</option>
              <option>Embedding center</option>
            </Select>
          </Field>
        </div>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}

const FILTERS: { key: RetrievalFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "overdue", label: "Overdue returns" },
  { key: "outside", label: "Requests with a send-out" },
  { key: "all", label: "All" },
];

export function RetrievalTab({
  rows,
  counts,
  filter,
  detail,
  selectedMissing,
  exceptions,
  blocks,
  now,
}: {
  rows: RetrievalListRow[];
  counts: Record<RetrievalFilter, number>;
  filter: RetrievalFilter;
  detail: RetrievalDetail | null;
  selectedMissing: string | null;
  exceptions: ReturnType<typeof custodyExceptions>;
  blocks: { id: string; label: string; location: string | null }[];
  now: string;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const readOnly = useReadOnly();
  const canRequest = useCan("retrieval.request");
  const base = `/materials?tab=retrieval&rfilter=${filter}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-3 pb-1 max-xl:px-4">
        <Tabs label="Retrieval filters" active={filter} size="sm" bare items={FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key], href: `/materials?tab=retrieval&rfilter=${f.key}` }))} />
        <nav aria-label="Retrieval requests" className="min-w-0">
          {rows.length ? (
            <ul className="flex flex-wrap items-center gap-1.5">
              {rows.map((r) => {
                const sel = detail?.request.id === r.id;
                return (
                  <li key={r.id}>
                    <Link
                      href={`${base}&selected=${encodeURIComponent(r.displayId)}`}
                      scroll={false}
                      aria-current={sel ? "page" : undefined}
                      className={cn(
                        "flex min-h-[max(2.25rem,var(--hlo-target-min))] items-center gap-2 rounded-md border px-2.5 text-sm",
                        sel ? "border-shell bg-shell text-shell-fg" : "border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-subtle",
                      )}
                    >
                      <span className="id-mono font-semibold">{r.displayId}</span>
                      <span className={sel ? "text-shell-muted" : "text-ink-secondary"}>
                        {r.statusLabel}, <span className="num-tabular">{r.picked} of {r.items}</span> picked
                        {r.hasOverdue ? ", overdue checkout" : ""}
                        {r.hasOutside ? ", send-out" : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-ink-secondary">
              {filter === "open" ? "No open requests." : filter === "overdue" ? "No requests with an overdue return." : filter === "outside" ? "No requests include an outside send-out." : "No requests yet."}
            </p>
          )}
        </nav>
        {readOnly ? null : (
          <div className="ml-auto flex flex-col items-end gap-0.5">
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" aria-hidden />} disabled={!canRequest.allowed} reasonId={canRequest.allowed ? undefined : "rr-request-reason"} onClick={() => setNewOpen(true)}>
              Request blocks
            </Button>
            {canRequest.allowed ? null : (
              <p id="rr-request-reason" className="text-xs text-ink-secondary">
                {canRequest.reason}
              </p>
            )}
          </div>
        )}
      </div>
      {selectedMissing ? (
        <div className="px-6 max-xl:px-4">
          <AlertBanner tone="warning" title={`Retrieval request ${selectedMissing} was not found.`}>
            Check the request number, or choose one above. Nothing was changed.
          </AlertBanner>
        </div>
      ) : null}
      {detail ? (
        <RequestWorkspace key={detail.request.id} detail={detail} now={now} exceptions={exceptions} />
      ) : (
        <div className="flex flex-col gap-4 px-6 pb-6 max-xl:px-4">
          <EmptyState title="No retrieval request selected">
            Choose a request above to see the walk to each block, where it was last confirmed and by whom, and the scan check. New requests appear when a pathologist or histotech asks for blocks from storage.
          </EmptyState>
          <CustodyExceptions exceptions={exceptions} />
        </div>
      )}
      <NewRequestDialog open={newOpen} onClose={() => setNewOpen(false)} blocks={blocks} />
    </div>
  );
}
