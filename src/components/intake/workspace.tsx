"use client";

import { TriangleAlert } from "lucide-react";
import type { IntakeBench, ItemDetail } from "@/server/queries/intake";
import { StatePill } from "@/components/ui/status-pill";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Timestamp } from "@/components/domain/timestamp";
import { ReadOnlyTag } from "@/components/domain/honesty";
import { cn } from "@/lib/cn";
import { ComparisonPanel } from "./comparison-panel";
import { RelatedCard } from "./related-card";
import { RoutingCard } from "./routing-card";
import { AccessionBar } from "./accession-bar";
import { HoldsCard, MissingContainersCard } from "./holds-card";
import { NotesCard } from "./notes-card";
import { OrderCard } from "./order-card";
import { CorrectionCard } from "./correction-card";
import { HistoryCard } from "./history-card";
import type { ClarificationDraft } from "./clarification-dialog";

/**
 * Workspace for one intake item. Keyed by item id by the parent, so every
 * form resets when the scanned/selected item changes (no carry-over).
 * Tab order follows the bench steps: comparison → related orders → routing →
 * accession request, then holds, owner/note, source order and history.
 */
export function ItemWorkspace({
  bench,
  item,
  onRaise,
  readOnlyNote = null,
}: {
  bench: IntakeBench;
  item: ItemDetail;
  onRaise: (d: ClarificationDraft) => void;
  readOnlyNote?: string | null;
}) {
  const { permissions, now } = bench;
  // The courier is named in the strip above; repeat it only when the item came with a different delivery.
  const otherDelivery = item.delivery && item.delivery.id !== bench.activeDeliveryId ? item.delivery.displayId : null;
  return (
    <div className="space-y-3">
      {/* One status line: item state, receipt, and (for exceptions) why it waits. Exceptions never stop the bench. */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-surface px-3 py-1.5 text-sm",
          item.laneReasons.length ? "border-warning-border border-l-4 border-l-warning-solid" : "border-line",
        )}
      >
        {/* The identity chip is pinned in the identity bar above; this line adds status and receipt. */}
        <StatePill domain="intake" state={item.status} />
        <span className="text-ink-secondary">
          Received <Timestamp iso={item.receivedAt} now={now} /> by {item.receivedByName ?? "Unknown"}
          {otherDelivery ? (
            <>
              {" "}
              from courier <span className="id-mono">{otherDelivery}</span>
            </>
          ) : null}
        </span>
        {/* The office is in the identity bar; repeat it here only when it is an exception. */}
        {!item.office ? (
          <span className="text-warning-fg">&ldquo;{item.observedOfficeText ?? "Unknown"}&rdquo;: office not in directory</span>
        ) : item.office.status === "new_unreviewed" ? (
          <span className="text-warning-fg">{item.office.name}: new office, not yet reviewed</span>
        ) : null}
        {item.laneReasons.length ? (
          <span role="note" className="inline-flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
            <span>
              <span className="font-medium text-warning-fg">Exceptions lane: {item.laneReasons.join(" · ")}.</span>{" "}
              <span className="text-ink-secondary">Only this item waits.</span>
            </span>
          </span>
        ) : null}
        {readOnlyNote ? (
          <span className="inline-flex items-center gap-1.5 text-ink-secondary">
            <ReadOnlyTag />
            {readOnlyNote.replace(/^Read only:\s*/, "")}
          </span>
        ) : null}
      </div>

      {item.containers.length ? (
        item.containers.map((c) => <ComparisonPanel key={c.id} item={item} container={c} permissions={permissions} now={now} onRaise={onRaise} />)
      ) : (
        <AlertBanner tone="warning" title="No containers recorded for this item">
          Nothing was logged from the requisition's bag. Check the courier delivery.
        </AlertBanner>
      )}
      <MissingContainersCard item={item} permissions={permissions} onRaise={onRaise} />
      <RelatedCard item={item} permissions={permissions} now={now} onRaise={onRaise} />
      <RoutingCard item={item} permissions={permissions} pathologists={bench.pathologists} now={now} />
      <AccessionBar item={item} permissions={permissions} source={bench.source} now={now} />
      <HoldsCard item={item} now={now} />
      <NotesCard item={item} permissions={permissions} now={now} />
      <OrderCard item={item} now={now} />
      <CorrectionCard item={item} permissions={permissions} now={now} />
      <HistoryCard item={item} now={now} />
    </div>
  );
}
