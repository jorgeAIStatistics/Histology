"use client";

import { useMemo, useState } from "react";
import { Select } from "@/components/ui/field";
import { Timeline, sourceFromOrigin, type TimelineEvent } from "@/components/ui/timeline";
import { IdText } from "@/components/domain/id-text";
import type { HistoryEvent } from "@/server/queries/case";
import { actionLabel } from "./format";
import { plural } from "@/components/worklist/format";

/**
 * Case history: the local audit timeline, filterable by part, actor and
 * origin (Local / Source (simulated) / Demo / ...). Each event carries an
 * anchor (#ev-<id>) so the operational summary can link to its evidence.
 */
export function CaseHistory({ events, filters, now }: { events: HistoryEvent[]; filters: { parts: string[]; actors: string[]; origins: string[] }; now: string }) {
  const [part, setPart] = useState("");
  const [actor, setActor] = useState("");
  const [origin, setOrigin] = useState("");
  const shown = useMemo(
    () => events.filter((e) => (!part || e.parts.includes(part)) && (!actor || e.actorName === actor) && (!origin || e.originLabel === origin)),
    [events, part, actor, origin],
  );
  const timeline: TimelineEvent[] = shown.map((e) => ({
    id: e.id,
    at: e.at,
    actorName: e.actorName,
    actorRole: e.actorRole,
    summary: <IdText text={e.summary} />,
    source: e.originLabel === "Simulated office reply" ? "office" : sourceFromOrigin(e.origin),
    object: (
      <span id={`ev-${e.id}`} className="scroll-mt-40 text-xs text-ink-muted">
        {actionLabel(e.action)}
        {e.parts.length ? `, part ${e.parts.join(", ")}` : ""}
      </span>
    ),
    reason: e.reason,
    details:
      e.before || e.after
        ? [{ label: "Recorded values", before: e.before ? <code className="break-all">{e.before}</code> : undefined, after: e.after ? <code className="break-all">{e.after}</code> : undefined }]
        : undefined,
  }));
  return (
    // A plain sheet, not a region: the Timeline inside is the one region named "History".
    <div className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-3 max-xl:px-4">
        <h2 id="history-title" className="text-md font-bold text-ink">
          History
        </h2>
        <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filter history">
          <label className="flex flex-col gap-0.5 text-xs text-ink-muted">
            Part
            <Select size="sm" value={part} onChange={(e) => setPart(e.target.value)} className="w-32">
              <option value="">All parts</option>
              {filters.parts.map((p) => (
                <option key={p} value={p}>
                  Part {p}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-ink-muted">
            Actor
            <Select size="sm" value={actor} onChange={(e) => setActor(e.target.value)} className="w-48">
              <option value="">Everyone</option>
              {filters.actors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-ink-muted">
            Origin
            <Select size="sm" value={origin} onChange={(e) => setOrigin(e.target.value)} className="w-52">
              <option value="">All origins</option>
              {filters.origins.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </label>
          <p className="pb-2 text-sm text-ink-muted" aria-live="polite">
            Showing {shown.length} of {plural(events.length, "event")}
          </p>
        </div>
      </header>
      <div className="px-5 pt-2 pb-3 max-xl:px-4">
        {/* No title: the region keeps the name "History" and the sheet heading above is the only visible one. */}
        <Timeline events={timeline} now={now} emptyText="No events match these filters." />
      </div>
    </div>
  );
}
