"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { IntakeBench, ItemDetail, Lane } from "@/server/queries/intake";
import type { IntakeScanResolution } from "@/server/queries/intake";
import { resolveIntakeScanAction } from "@/app/intake/actions";
import { PageHeader } from "@/components/ui/page-header";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { CommandButton } from "@/components/ui/command-button";
import { EmptyState } from "@/components/ui/empty-state";
import { StaleBanner } from "@/components/domain/stale-banner";
import { IdentityBar } from "@/components/domain/identity-bar";
import { ProvisionalChip } from "@/components/domain/chips";
import { useScanTarget, useFocusScanOnMount, resolveFindRecord } from "@/lib/client/scan";
import { useSingleKey, isDialogOpen, isEditableTarget } from "@/lib/client/keyboard";
import { useActor, isReadOnlyRole } from "@/lib/client/shell-context";
import { ROLE_LABEL } from "@/lib/roles";
import { CourierStrip } from "./courier-strip";
import { ArrivalQueue, hrefFor } from "./arrival-queue";
import { ItemWorkspace } from "./workspace";
import { RaiseClarificationDialog, type ClarificationDraft } from "./clarification-dialog";

function identityFor(item: ItemDetail) {
  const single = item.containers.length === 1 ? item.containers[0] : null;
  const order = single?.orderRef ? item.orders.find((o) => o.sourceOrderId === single.orderRef) : item.orders[0];
  const part = single?.orderPartId ? order?.parts.find((p) => p.id === single.orderPartId) : order?.parts.length === 1 ? order.parts[0] : undefined;
  const lat = single?.comparison.find((r) => r.field === "laterality");
  const warning =
    lat && lat.status === "differs" && lat.pairs.includes("order≠observed")
      ? `Order says ${lat.order.original ?? "no side"}, bottle says ${lat.observed.original ?? "no side"}.`
      : undefined;
  const r = item.routing;
  const doctor = !r ? undefined : r.status === "exception" ? null : (r.final ?? r.suggested) ? { name: (r.final ?? r.suggested)!.name, color: (r.final ?? r.suggested)!.color } : null;
  return {
    identity: item.accession
      ? ({ kind: "accession", accession: item.accession.number, namespace: item.accession.namespace } as const)
      : ({ kind: "provisional", id: item.displayId } as const),
    // With a side mismatch the chip names the location without the side, then the two sides as written (spec §5.3), so the bar stays on one row.
    part: part
      ? {
          letter: part.designation,
          description: warning ? part.siteText.replace(/^(right|left|rt|lt|r|l)\.?\s+/i, "") : `${part.siteText}, ${part.procedure ?? "procedure unknown"}`,
          warning,
        }
      : null,
    patient: item.patient ? { name: item.patient.name, mrn: item.patient.mrn, tenant: item.patient.tenantName } : null,
    office: item.office?.name ?? (item.observedOfficeText ? `${item.observedOfficeText} (not in directory)` : null),
    doctor,
    holds: [...new Set(item.holds.map((h) => h.scopeLabel))],
  };
}

/**
 * /intake bench (design spec §6.1): courier manifest strip, arrival queue with
 * lanes, and the workspace for the selected item under a sticky identity bar.
 */
export function IntakeBenchView({ bench, initialLane }: { bench: IntakeBench; initialLane: Lane }) {
  const router = useRouter();
  const [lane, setLane] = useState<Lane>(initialLane);
  useEffect(() => setLane(initialLane), [initialLane]);
  const [draft, setDraft] = useState<ClarificationDraft | null>(null);
  const [matches, setMatches] = useState<Extract<IntakeScanResolution, { kind: "items" }> | null>(null);
  const [unpack, setUnpack] = useState<Extract<IntakeScanResolution, { kind: "unpack" }> | null>(null);
  const item = bench.selected;
  const actor = useActor();
  const readOnly = isReadOnlyRole(actor.role);

  useFocusScanOnMount();
  useScanTarget(
    "Find intake item",
    async (value, { navigate }) => {
      const r = await resolveIntakeScanAction(value);
      setMatches(null);
      setUnpack(null);
      switch (r.kind) {
        case "item":
          navigate(`/intake?item=${encodeURIComponent(r.displayId)}`);
          return { tone: "success", message: `${r.message} A scan identifies the record; it does not verify the container.` };
        case "items":
          setMatches(r);
          return { tone: "info", message: r.message };
        case "case":
          navigate(`/cases/${encodeURIComponent(r.accession)}`);
          return { tone: "info", message: r.message };
        case "unpack":
          setUnpack(r);
          return { tone: "info", message: `${r.message} Choose "Unpack this requisition (simulated)" on the page.` };
        default: {
          const f = resolveFindRecord(value);
          if ("href" in f && !f.href.startsWith("/intake")) {
            navigate(f.href);
            return { tone: "info", message: f.message };
          }
          return { tone: "warning", message: r.message };
        }
      }
    },
    { placeholder: "Scan order id, INT id or label text" },
  );

  // J / K move through the current lane.
  const laneRows = useMemo(() => bench.queue.filter((q) => q.lane === lane), [bench.queue, lane]);
  const move = useCallback(
    (delta: number) => {
      if (!laneRows.length) return;
      const idx = item ? laneRows.findIndex((q) => q.id === item.id) : -1;
      const next = laneRows[Math.max(0, Math.min(laneRows.length - 1, idx < 0 ? 0 : idx + delta))];
      if (next && next.id !== item?.id) router.push(hrefFor(next, lane), { scroll: false });
    },
    [laneRows, item, lane, router],
  );
  useSingleKey({ j: () => move(1), k: () => move(-1), ArrowDown: () => move(1), ArrowUp: () => move(-1) });

  // Ctrl/Cmd+Enter: run the current step's primary action (first enabled step button in bench order).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || isDialogOpen() || isEditableTarget(e.target)) return;
      const steps = Array.from(document.querySelectorAll<HTMLElement>("[data-intake-step]"));
      for (const el of steps) {
        const btn = el.tagName === "BUTTON" ? (el as HTMLButtonElement) : el.querySelector<HTMLButtonElement>("button");
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.focus();
          btn.click();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const changeLane = (l: Lane) => {
    setLane(l);
    const params = new URLSearchParams();
    if (item) params.set("item", item.displayId);
    params.set("lane", l);
    router.replace(`/intake?${params.toString()}`, { scroll: false });
  };

  // The sticky queue sits under the identity bar, whose height changes (one row, or two with holds / on a tablet).
  const benchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = benchRef.current;
    if (!root) return;
    const bar = item ? document.querySelector<HTMLElement>('section[aria-label="Current case"]') : null;
    const apply = () => root.style.setProperty("--intake-idbar-h", `${bar ? bar.offsetHeight : 0}px`);
    apply();
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [item]);

  const id = item ? identityFor(item) : null;
  const active = bench.deliveries.find((d) => d.id === bench.activeDeliveryId) ?? null;

  return (
    <>
      {item && id ? (
        <IdentityBar
          identity={id.identity}
          part={id.part}
          patient={id.patient}
          office={id.office}
          doctor={id.doctor}
          holds={id.holds}
          contextKey={item.id}
          className="gap-x-2 px-4"
          announcement={`Now working on provisional intake item ${item.displayId}${id.part ? ` Part ${id.part.letter}` : ""}`}
        />
      ) : null}
      <div ref={benchRef} className="space-y-3 px-4 py-3 max-xl:px-3">
        {/* While an item is open the identity bar names it and the comparison needs the height (spec §5.2): the page title is
            kept for screen readers only; the courier strip and the accession bar carry their own Simulated labels, and the
            item's status line says "Read only" for the director roles. */}
        <PageHeader
          className={item ? "sr-only" : undefined}
          title="Intake"
          meta={
            readOnly
              ? `Read only: ${ROLE_LABEL[actor.role]} can view but not change records. Provisional IDs are not accession numbers.`
              : "Arrival, reconciliation and routing. Provisional IDs are not accession numbers."
          }
          simulated="courier contents and accession source"
          readOnly={readOnly}
        />
        {!bench.source.available ? (
          <StaleBanner
            sourceName="EMA-SIM Sunrise Coast (accession source)"
            since={bench.source.lastSuccessAt}
            now={bench.now}
            detail="Request accession is unavailable. Verification, routing and related-order review still work locally."
          />
        ) : null}
        <CourierStrip deliveries={bench.deliveries} activeId={bench.activeDeliveryId} permissions={bench.permissions} now={bench.now} itemSelected={!!item} />

        {unpack ? (
          <AlertBanner
            tone="info"
            title={unpack.message}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <CommandButton
                  command="intake.receivePhysicalItem"
                  input={{ deliveryId: unpack.deliveryId, physicalItemId: unpack.physicalItemId }}
                  size="sm"
                  variant="primary"
                  pendingLabel="Unpacking..."
                  disabledReason={bench.permissions.receive ? undefined : "Your demo role cannot receive items."}
                  onSuccess={(r) => {
                    setUnpack(null);
                    router.push(`/intake?item=${encodeURIComponent((r as { displayId: string }).displayId)}`, { scroll: false });
                  }}
                >
                  Unpack this requisition (simulated)
                </CommandButton>
                <Button size="sm" variant="secondary" onClick={() => setUnpack(null)}>
                  Not now
                </Button>
              </div>
            }
          >
            Unpacking logs the requisition and its containers from courier {unpack.deliveryDisplay}. It does not verify them.
          </AlertBanner>
        ) : null}
        {matches ? (
          <AlertBanner tone="info" title={matches.message} action={<Button size="sm" variant="secondary" onClick={() => setMatches(null)}>Close</Button>}>
            <ul className="mt-1 flex flex-wrap gap-2">
              {matches.matches.map((m) => (
                <li key={m.displayId} className="flex items-center gap-1.5 text-sm">
                  <ProvisionalChip id={m.displayId} compact />
                  <span className="text-ink-secondary">{m.label}</span>
                </li>
              ))}
            </ul>
          </AlertBanner>
        ) : null}
        {bench.selectedNotFound ? (
          <AlertBanner tone="warning" title={`No intake item "${bench.selectedNotFound}"`}>
            Check the id, or scan the requisition order id instead.
          </AlertBanner>
        ) : null}

        <div className="grid grid-cols-[312px_minmax(0,1fr)] items-start gap-3 max-xl:grid-cols-[280px_minmax(0,1fr)]">
          <ArrivalQueue queue={bench.queue} counts={bench.counts} lane={lane} onLaneChange={changeLane} selectedId={item?.id ?? null} />
          <section aria-label="Intake workspace" className="min-w-0">
            <h2 className="sr-only">{item ? `Provisional intake item ${item.displayId}` : "Intake workspace"}</h2>
            {item ? (
              <ItemWorkspace key={item.id} bench={bench} item={item} onRaise={setDraft} readOnlyNote={readOnly ? `Read only: ${ROLE_LABEL[actor.role]} can view but not change records.` : null} />
            ) : (
              <EmptyState title={bench.queue.some((q) => q.lane !== "done") ? "Select an arrival" : `No arrivals recorded for the ${active ? active.displayId : "next"} courier yet`}>
                {bench.queue.some((q) => q.lane !== "done")
                  ? "Choose an item from the queue, or scan an order id, a provisional intake id or the bottle label text. The comparison, related orders, routing and accession request appear here."
                  : "Record the courier arrival, then unpack the next requisition (simulated) or scan the first container."}
              </EmptyState>
            )}
          </section>
        </div>
      </div>
      <RaiseClarificationDialog draft={draft} onClose={() => setDraft(null)} />
    </>
  );
}
