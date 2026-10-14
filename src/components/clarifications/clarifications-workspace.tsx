"use client";

import { useState, type ReactNode } from "react";
import { SidePanelLayout } from "@/components/ui/side-panel";
import { PageBody } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { ClarificationQueue, selectionHref } from "./clarification-queue";
import { ClarificationNotFound, ClarificationPanel } from "./clarification-panel";
import type { ClarificationDetail, ClarificationFilter, ClarificationQueue as Queue } from "@/server/queries/clarifications";

export interface FilterTab {
  key: ClarificationFilter;
  label: string;
}

/**
 * /clarifications workspace: saved-filter tabs (kept in the URL), the queue
 * table, and the side panel for ?selected=<CLR id>. The list keeps its
 * scroll and selection while the panel is open.
 */
export function ClarificationsWorkspace({
  header,
  banner,
  filters,
  queue,
  detail,
  selected,
  now,
  readOnlyNote,
}: {
  header: ReactNode;
  banner?: ReactNode;
  filters: FilterTab[];
  queue: Queue;
  detail: ClarificationDetail | null;
  selected: string | null;
  now: string;
  readOnlyNote: string | null;
}) {
  const [listDriven, setListDriven] = useState(false);
  const closeHref = selectionHref(queue.filter, null);
  const panel = selected ? (
    detail ? (
      <ClarificationPanel detail={detail} now={now} closeHref={closeHref} readOnlyNote={readOnlyNote} preserveFocus={listDriven} />
    ) : (
      <ClarificationNotFound selected={selected} closeHref={closeHref} />
    )
  ) : undefined;

  return (
    <SidePanelLayout panel={panel}>
      <PageBody>
        {header}
        {banner}
        <Tabs
          label="Clarification filters"
          active={queue.filter}
          items={filters.map((f) => ({ key: f.key, label: f.label, count: queue.counts[f.key], href: selectionHref(f.key, selected) }))}
        />
        {/* J/K keep focus in the list (the panel follows); a click or Enter moves focus to the panel heading. */}
        <ClarificationQueue
          rows={queue.rows}
          filter={queue.filter}
          selected={selected}
          now={now}
          total={queue.total}
          sortNote={queue.sortNote}
          panelOpen={Boolean(panel)}
          onNavigate={(source) => setListDriven(source === "keys")}
        />
      </PageBody>
    </SidePanelLayout>
  );
}
