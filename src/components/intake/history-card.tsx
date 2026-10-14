"use client";

import type { ItemDetail } from "@/server/queries/intake";
import { Card } from "@/components/ui/card";
import { Timeline, sourceFromOrigin, type TimelineEvent, type TimelineDetail } from "@/components/ui/timeline";

function detailRows(before: string | null, after: string | null): TimelineDetail[] | undefined {
  const parse = (s: string | null): Record<string, unknown> => {
    if (!s) return {};
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
    } catch {
      return { value: s };
    }
  };
  const b = parse(before);
  const a = parse(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  if (!keys.length) return undefined;
  const show = (v: unknown) => (v === null || v === undefined ? "None" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return keys.map((k) => ({ label: k.replace(/_/g, " "), before: k in b ? show(b[k]) : undefined, after: k in a ? show(a[k]) : undefined }));
}

/** Local audit trail for the item (newest first). */
export function HistoryCard({ item, now }: { item: ItemDetail; now: string }) {
  const events: TimelineEvent[] = item.audit.map((a) => ({
    id: a.id,
    at: a.at,
    actorName: a.actorName,
    // Simulator and system events are not done by a person in a role ("System, Operations supervisor" misleads).
    actorRole: a.origin === "simulator" || a.origin === "system" || a.actorName === "System" ? null : a.actorRole,
    summary: a.summary,
    source: sourceFromOrigin(a.origin),
    details: detailRows(a.before, a.after),
    reason: a.reason,
  }));
  return (
    <Card id="history" headingLevel={3} title="History" flush>
      <div className="px-4 py-3">
        <Timeline events={events} now={now} emptyText="No recorded events for this item yet." />
      </div>
    </Card>
  );
}
