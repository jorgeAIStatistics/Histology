"use client";

import type { IntakeBench } from "@/server/queries/intake";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { CtrlEnterBadge } from "@/components/ui/ctrl-enter-badge";
import { PresenterControls } from "@/components/ui/presenter-controls";
import { CourierStrip, UnpackControls } from "./courier-strip";

/**
 * No item open: name the next item and how to open it (J, the button, or a
 * scan), then the courier reconciliation by office, which is the work of the
 * moment when nothing is selected. The presenter disclosure sits below one
 * full view of the bench work, so it is never in the first viewport.
 */
export function EmptyWorkspace({ bench, onOpenItem }: { bench: IntakeBench; onOpenItem: (displayId: string) => void }) {
  const first = bench.firstOpen;
  const active = bench.deliveries.find((d) => d.id === bench.activeDeliveryId) ?? null;
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      {/* At least one view tall: the presenter disclosure after it starts below the fold at every size. */}
      <div className="min-h-[calc(100dvh-var(--hlo-topbar-h))] space-y-4 p-5 max-xl:p-4">
        <section aria-labelledby="empty-title" className="rounded-lg border border-line bg-surface px-5 py-4">
          <h2 id="empty-title" className="text-xl font-semibold tracking-[-0.01em] text-ink">
            {first ? "Open the next arrival" : `No arrivals to review for ${active ? active.displayId : "the next courier"} yet`}
          </h2>
          {first ? (
            <>
              <p className="mt-1.5 text-base text-ink">
                Next in the queue: <span className="id-mono font-semibold">{first.displayId}</span>
                {first.patientName ? `, ${first.patientName}` : ""}
                {first.reason ? <span className="text-ink-secondary"> ({first.reason.toLowerCase()})</span> : <span className="text-ink-secondary"> (routine review)</span>}.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button variant="primary" aria-keyshortcuts="Control+Enter Meta+Enter J" data-intake-primary="" onClick={() => onOpenItem(first.displayId)}>
                  Open <span className="id-mono">{first.displayId}</span>
                  <CtrlEnterBadge onDark />
                </Button>
                <p className="flex flex-wrap items-center gap-1 text-sm text-ink-secondary">
                  or press <Kbd>J</Kbd>, or scan the bottle, the requisition or its order id.
                </p>
              </div>
              <p className="mt-2 text-sm text-ink-muted">Exceptions come first; routine items do not wait for them. A scan identifies the record; it never verifies the bottle.</p>
            </>
          ) : (
            <p className="mt-1.5 text-base text-ink-secondary">Record the courier arrival, then scan the first requisition or container.</p>
          )}
        </section>
        <CourierStrip deliveries={bench.deliveries} activeId={bench.activeDeliveryId} permissions={bench.permissions} now={bench.now} />
      </div>
      <div className="px-5 pb-5 max-xl:px-4 max-xl:pb-4">
        <PresenterControls>
          <UnpackControls delivery={active} permissions={bench.permissions} />
        </PresenterControls>
      </div>
    </div>
  );
}
