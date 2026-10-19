import Link from "next/link";
import { getDb } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { getActor } from "@/server/session";
import { CLARIFICATION_FILTERS, deskAttention, getClarificationDetail, listClarifications, parseFilter } from "@/server/queries/clarifications";
import { NOTIFY_SOURCE_ID } from "@/server/sim/notifications";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import { AlertBanner } from "@/components/ui/alert-banner";
import { ClarificationsWorkspace } from "@/components/clarifications/clarifications-workspace";
import { ROLE_LABEL } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clarifications" };

type SP = { tab?: string | string[]; selected?: string | string[] };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * /clarifications: specimen-specific questions to submitting offices, from
 * draft to a reviewed resolution. Holds stay on the affected material only.
 * Office messages are simulated; no real office is contacted.
 */
export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const tab = first(sp.tab);
  const selected = first(sp.selected)?.trim() || null;
  const actor = await getActor();
  const readOnly = actor.role === "director" || actor.role === "medical_director";
  const readOnlyNote = readOnly
    ? `Read only: ${ROLE_LABEL[actor.role]} can view but not change records. The people below can act. The simulated office answer is a presenter control available to any role.`
    : null;

  try {
    const db = getDb();
    const now = readClock(db).now;
    let queue = listClarifications(db, { filter: parseFilter(tab), actorId: actor.id, now });
    // A scanned or linked CLR (no tab in the URL) must appear in the list beside its record: fall back to "All".
    if (!tab && selected && !queue.rows.some((r) => r.displayId === selected || r.id === selected)) {
      queue = listClarifications(db, { filter: parseFilter("all"), actorId: actor.id, now });
    }
    const detail = selected ? getClarificationDetail(db, selected, { now, role: actor.role }) : null;
    // Nothing open: the landing pane leads with what needs attention across the whole desk, whatever the filter.
    const desk = selected ? null : deskAttention(queue.filter === "all" ? queue.rows : listClarifications(db, { filter: "all", actorId: actor.id, now }).rows);
    const notify = db.prepare("SELECT status, last_error FROM integration_source WHERE id = ?").get(NOTIFY_SOURCE_ID) as { status: string; last_error: string | null } | undefined;
    const banner =
      notify && notify.status === "offline" ? (
        <AlertBanner tone="warning" title="Office notifications unavailable (simulated outage)">
          Messages sent now are recorded as delivery failed and are not handed off. Questions, answers recorded by phone, reviews and resolutions still work.
        </AlertBanner>
      ) : null;
    return (
      <ClarificationsWorkspace
        banner={banner}
        filters={CLARIFICATION_FILTERS.map((f) => ({ key: f.key, label: f.label }))}
        queue={queue}
        detail={detail}
        desk={desk}
        selected={selected}
        now={now}
        readOnly={readOnly}
        readOnlyNote={readOnlyNote}
      />
    );
  } catch (e) {
    console.error("[clarifications] failed to load", e);
    return (
      <PageBody>
        <PageHeader title="Clarifications" simulated="notifications" readOnly={readOnly} />
        <AlertBanner
          tone="warning"
          blocking
          title="Could not load clarifications"
          action={
            <Link href={`/clarifications${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
              Retry
            </Link>
          }
        >
          The local demo database could not be read. Nothing was changed. Your filters are kept in the address bar.
        </AlertBanner>
      </PageBody>
    );
  }
}
