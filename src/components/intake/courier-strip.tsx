"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, PackageOpen, Truck, TriangleAlert } from "lucide-react";
import type { DeliveryView, BenchPermissions } from "@/server/queries/intake";
import { Button } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { StatusPill } from "@/components/ui/status-pill";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/time";

interface ReceiveResult {
  displayId: string;
  duplicate: boolean;
  remaining: number;
  missingParts: string[];
  routingStatus: string;
  relatedCandidates: string[];
}

function deliveryPill(d: DeliveryView) {
  if (!d.arrivedAt) return <StatusPill tone="neutral" className="text-sm">Expected</StatusPill>;
  if (d.status === "reconciled") {
    const differs = (d.totals.missing ?? 0) > 0 || d.totals.extra > 0 || d.lines.some((l) => l.missingParts.length > 0);
    return differs ? <StatusPill tone="warning" className="text-sm">Unpacked with differences</StatusPill> : <StatusPill tone="success" className="text-sm">Unpacked and reconciled</StatusPill>;
  }
  return <StatusPill tone="info" className="text-sm">Arrived, unpacking</StatusPill>;
}

function ItemLinks({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <p className="text-sm text-ink-secondary">
      {ids.map((id, i) => (
        <span key={id}>
          {i ? ", " : ""}
          <Link className="id-mono underline underline-offset-2" href={`/intake?item=${encodeURIComponent(id)}`}>
            {id}
          </Link>
        </span>
      ))}
    </p>
  );
}

/**
 * Courier manifest strip (spec §6.1 region 1): one compact box per office —
 * expected vs received containers, missing and extra, or "Unknown (no source
 * manifest)". Unpacking controls are SIMULATED (the demo knows what is in the
 * courier bag; a real bench does not).
 */
export function CourierStrip({
  deliveries,
  activeId,
  permissions,
  now,
  itemSelected = false,
}: {
  deliveries: DeliveryView[];
  activeId: string | null;
  permissions: BenchPermissions;
  now: string;
  /** While an item is open the per-office boxes fold into one summary line, so the comparison stays above the fold. */
  itemSelected?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(activeId);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const d = deliveries.find((x) => x.id === selectedId) ?? deliveries.find((x) => x.id === activeId) ?? null;

  if (!deliveries.length) {
    return (
      <section aria-label="Courier deliveries" className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink-secondary">
        No courier deliveries are scheduled for today in this demo.
      </section>
    );
  }

  const hasBoxes = !!d && (d.lines.length > 0 || d.offManifest.length > 0);
  const open = hasBoxes && (userOpen ?? !itemSelected);
  const canUnpack = !!d && d.simTotal > 0 && permissions.receive;

  return (
    <section aria-labelledby="courier-title" className="rounded-md border border-line bg-surface shadow-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <h2 id="courier-title" className="inline-flex items-center gap-2 text-md font-semibold text-ink">
          <Truck className="size-4 text-ink-muted" aria-hidden />
          Courier manifest
        </h2>
        <div role="group" aria-label="Today's deliveries" className="flex flex-wrap gap-1">
          {deliveries.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={x.id === d?.id}
              onClick={() => setSelectedId(x.id)}
              className={cn(
                "rounded-sm border px-2 py-0.5 text-sm",
                // Tablet, item open, offices folded: only the delivery in view; "Show offices" brings the others back.
                itemSelected && !open && hasBoxes && x.id !== d?.id && "max-xl:hidden",
                x.id === d?.id
                  ? "border-brand bg-brand-50 font-semibold text-brand-ink"
                  : "border-line-strong bg-surface text-ink-secondary hover:bg-surface-subtle",
              )}
            >
              <span className="id-mono">{x.displayId}</span>
              {x.expectedAt ? <span className="ml-1">({fmtTime(x.expectedAt)} ET)</span> : null}
            </button>
          ))}
        </div>
        {d ? deliveryPill(d) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2 empty:hidden">
          {d && canUnpack && !d.arrivedAt ? (
            <CommandButton
              command="intake.receiveDelivery"
              input={{ deliveryId: d.id }}
              size="sm"
              variant="primary"
              pendingLabel="Recording..."
              successToast={`Courier ${d.displayId} arrival recorded`}
            >
              Record courier arrival
            </CommandButton>
          ) : null}
          {d && canUnpack && d.simRemaining > 0 ? (
            <span className="text-sm text-ink-secondary">
              {d.simRemaining} of {d.simTotal} still in the bag (simulated)
            </span>
          ) : null}
          {hasBoxes ? (
            <Button
              size="sm"
              variant="quiet"
              className="-my-0.5 h-7 shrink-0"
              aria-expanded={open}
              aria-controls="courier-offices"
              icon={open ? <ChevronUp /> : <ChevronDown />}
              onClick={() => setUserOpen(!open)}
            >
              {open ? "Hide offices" : `Show offices (${d!.lines.length + d!.offManifest.length})`}
            </Button>
          ) : null}
        </div>
      </div>
      {d ? <DeliveryLine d={d} now={now} compact={itemSelected && !open} /> : null}
      {d && open ? <ManifestGrid d={d} /> : null}
    </section>
  );
}

/**
 * Presenter controls (demo) for the courier bag: unpack the next requisition
 * or all of them. A real bench does not know what is in the bag; these live in
 * the "Presenter controls (demo)" disclosure, not on the bench surface.
 */
export function UnpackControls({ delivery: d, permissions }: { delivery: DeliveryView | null; permissions: BenchPermissions }) {
  const router = useRouter();
  const unpack = useCommand<ReceiveResult, { deliveryId: string }>("intake.receivePhysicalItem", {
    errorToast: false,
    successToast: (r) =>
      r.duplicate
        ? `${r.displayId} was already unpacked. No duplicate was created.`
        : `${r.displayId} received${r.missingParts.length ? `; missing container for part ${r.missingParts.join(", ")}` : ""}${r.routingStatus === "exception" ? "; routing exception" : ""}${r.relatedCandidates.length ? `; possible related order ${r.relatedCandidates.join(", ")}` : ""}`,
    onSuccess: (r) =>
      router.push(`/intake?item=${encodeURIComponent(r.displayId)}`, {
        scroll: false,
      }),
  });
  if (!d || d.simTotal === 0 || !permissions.receive) return <p className="text-sm text-ink-muted">Nothing to unpack in this demo delivery.</p>;
  if (d.simRemaining === 0) return <p className="text-sm text-ink-muted">Courier {d.displayId}: every requisition is unpacked (simulated).</p>;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon={<PackageOpen />} loading={unpack.pending} loadingLabel="Unpacking..." onClick={() => void unpack.run({ deliveryId: d.id })}>
          Unpack next item (simulated)
        </Button>
        <CommandButton
          command="intake.receiveAll"
          input={{ deliveryId: d.id }}
          size="sm"
          pendingLabel="Unpacking..."
          successToast={(r) => {
            const res = r as { received: unknown[] };
            return `${res.received.length} requisition(s) unpacked (simulated)`;
          }}
        >
          Unpack all (simulated)
        </CommandButton>
      </div>
      <p className="text-sm text-ink-muted">
        {d.simRemaining} of {d.simTotal} requisitions still in the bag of courier <span className="id-mono">{d.displayId}</span>.
      </p>
      <CommandError error={unpack.error} />
    </div>
  );
}

/**
 * One line under the header: the totals and every office that needs attention,
 * so the grid can stay folded during item work. While an item is open
 * (`compact`) the courier, route and receiver move to the expanded view.
 * Unknown expectations are named as Unknown, never counted as zero.
 */
function DeliveryLine({ d, now, compact }: { d: DeliveryView; now: string; compact?: boolean }) {
  const simulated = d.simTotal > 0;
  const arrived = !!d.arrivedAt;
  const final = d.unpackingComplete;
  const problems = d.lines.filter((l) => arrived && ((final && ((l.missing ?? 0) > 0 || l.extra > 0)) || l.missingParts.length > 0));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-sm text-ink-secondary">
      {simulated ? <SimulatedLabel connector="courier contents" size="xs" /> : null}
      {!compact || !arrived ? (
        <span>
          {d.courierName}
          {d.routeLabel ? ` · ${d.routeLabel}` : ""}
          {arrived ? (
            <>
              {" "}
              · arrived <Timestamp iso={d.arrivedAt!} now={now} />, received by {d.receivedByName ?? "Unknown"}
            </>
          ) : d.expectedAt ? (
            <>
              {" "}
              · expected <Timestamp iso={d.expectedAt} now={now} />
            </>
          ) : null}
        </span>
      ) : null}
      {arrived ? (
        <span className="num-tabular">
          Received <span className="font-medium text-ink">{d.totals.received}</span>
          {!final ? " so far" : ""} ·{" "}
          <span className="whitespace-nowrap">
            Expected {d.totals.expected === null ? <UnknownValue /> : <span className="font-medium text-ink">{d.totals.expected}</span>}
          </span>
          {d.totals.expected === null
            ? ` (${d.totals.unknownLines} ${d.totals.unknownLines === 1 ? "office" : "offices"} sent no manifest; ${d.totals.expectedKnownPart} on manifests)`
            : null}
          {final && d.totals.missing !== null ? (
            <>
              {" "}
              · Missing <span className={cn("font-medium", d.totals.missing > 0 ? "text-warning-fg" : "text-ink")}>{d.totals.missing}</span>
            </>
          ) : null}
          {final && d.totals.extra ? (
            <>
              {" "}
              · Extra <span className="font-medium text-warning-fg">{d.totals.extra}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {problems.map((l) => (
        <span key={l.id} className="inline-flex items-center gap-1 rounded-sm bg-warning-bg px-1.5 py-0.5 text-warning-fg">
          <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
          {l.officeName}:
          {l.missingParts.length
            ? l.missingParts.map((m, i) => (
                <span key={`${m.orderRef}-${m.designation}`}>
                  {i ? "," : ""} missing <span className="id-mono">{m.orderRef}</span> part {m.designation} (
                  <Link className="id-mono underline underline-offset-2" href={`/intake?item=${encodeURIComponent(m.intakeDisplay)}`}>
                    {m.intakeDisplay}
                  </Link>
                  )
                </span>
              ))
            : ` missing ${l.missing ?? 0}${l.extra ? `, extra ${l.extra}` : ""}`}
        </span>
      ))}
      {d.offManifest.map((g) => (
        <span key={g.officeName} className="inline-flex items-center gap-1 rounded-sm bg-warning-bg px-1.5 py-0.5 text-warning-fg">
          <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
          {g.officeName}: not on any manifest, received {g.received}
        </span>
      ))}
    </div>
  );
}

function ManifestGrid({ d }: { d: DeliveryView }) {
  if (!d.lines.length && !d.offManifest.length) {
    return <p className="px-3 py-2 text-sm text-ink-secondary">No office manifest lines were recorded for {d.displayId}. Expected quantities are unknown.</p>;
  }
  const arrived = !!d.arrivedAt;
  // Until every requisition is unpacked, counts are "so far": a shortfall is not yet a missing container.
  const final = d.unpackingComplete;
  return (
    <div id="courier-offices" className="border-t border-line px-3 py-2">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(205px,1fr))] gap-2">
        {d.lines.map((l) => {
          const problem = arrived && ((final && ((l.missing ?? 0) > 0 || l.extra > 0)) || l.missingParts.length > 0);
          return (
            <li key={l.id} className={cn("rounded-sm border px-2 py-1.5 text-sm", problem ? "border-warning-border bg-warning-bg" : "border-line bg-surface")}>
              <p className="flex items-center gap-1 font-medium text-ink">
                {problem ? <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden /> : null}
                <span className="truncate" title={l.officeName}>
                  {l.officeName}
                </span>
              </p>
              <p className="num-tabular text-sm text-ink-secondary">
                {/* "Expected Unknown" stays together; the reason may wrap. */}
                <span className="whitespace-nowrap">
                  Expected {l.expected === null ? <UnknownValue /> : <span className="font-medium text-ink">{l.expected}</span>}
                </span>
                {l.expected === null ? <span className="text-ink-muted"> (no source manifest)</span> : null} · Received <span className="font-medium text-ink">{arrived ? l.received : "not yet arrived"}</span>
                {arrived && !final ? <span> so far</span> : null}
                {arrived && final && l.expected !== null ? (
                  <>
                    {" "}
                    · Missing <span className={cn("font-medium", (l.missing ?? 0) > 0 ? "text-warning-fg" : "text-ink")}>{l.missing}</span>
                  </>
                ) : null}
                {arrived && final && l.extra > 0 ? (
                  <>
                    {" "}
                    · Extra <span className="font-medium text-warning-fg">{l.extra}</span>
                  </>
                ) : null}
              </p>
              {l.missingParts.map((m) => (
                <p key={`${m.orderRef}-${m.designation}`} className="text-sm text-warning-fg">
                  No container for <span className="id-mono">{m.orderRef}</span> part {m.designation} (
                  <Link className="underline underline-offset-2" href={`/intake?item=${encodeURIComponent(m.intakeDisplay)}`}>
                    {m.intakeDisplay}
                  </Link>
                  )
                </p>
              ))}
              {/* "No manifest received, expected quantity unknown" only repeats the Unknown above. */}
              {l.note && !(l.expected === null && /expected quantity unknown/i.test(l.note)) ? <p className="text-sm text-ink-muted">{l.note}</p> : null}
              {arrived ? <ItemLinks ids={l.items} /> : null}
            </li>
          );
        })}
        {d.offManifest.map((g) => (
          <li key={g.officeName} className="rounded-sm border border-warning-border bg-warning-bg px-2 py-1.5 text-sm">
            <p className="flex items-center gap-1 font-medium text-ink">
              <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
              {g.officeName}
            </p>
            <p className="text-sm text-warning-fg">Not on any manifest line · received {g.received} (extra)</p>
            <ItemLinks ids={g.items} />
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-sm text-ink-muted">
        {arrived && !final ? "Unpacking: missing and extra are counted when every requisition is unpacked. " : ""}A delivery with an unknown expectation is
        never shown as complete.
      </p>
    </div>
  );
}
