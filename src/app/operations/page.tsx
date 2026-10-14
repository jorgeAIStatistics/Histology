import Link from "next/link";
import { getDb } from "@/server/db/db";
import { getActor } from "@/server/session";
import { getOperations, BLOCKED_CATEGORY_LABEL, type BlockedCategory } from "@/server/queries/operations";
import { AlertBanner, Card, PageBody, PageHeader } from "@/components/ui";
import { IllustrativeTag, StaleBanner } from "@/components/domain";
import { BlockedWorkTable, FreshnessPanel, HandoffSummary, OpsTiles } from "@/components/operations/operations-sections";
import { QueueAgeChart } from "@/components/operations/queue-age-chart";
import { FreshnessWatcher } from "@/components/worklist/freshness-watcher";

export const dynamic = "force-dynamic";
export const metadata = { title: "Operations" };

const CATEGORIES = Object.keys(BLOCKED_CATEGORY_LABEL) as BlockedCategory[];

export default async function OperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const actor = await getActor();
  const rawCategory = Array.isArray(sp.category) ? sp.category[0] : sp.category;
  const category = CATEGORIES.includes(rawCategory as BlockedCategory) ? (rawCategory as BlockedCategory) : null;
  const rawOwner = Array.isArray(sp.owner) ? sp.owner[0] : sp.owner;
  const rawOverdue = Array.isArray(sp.overdue) ? sp.overdue[0] : sp.overdue;
  const overdueOnly = category === "clarifications" && rawOverdue === "1";

  let data: ReturnType<typeof getOperations>;
  try {
    data = getOperations(getDb());
  } catch (e) {
    console.error("[operations] failed", e);
    return (
      <PageBody>
        <PageHeader title="Operations" />
        <AlertBanner tone="danger" title="Could not compute the operations view">
          The local demo database could not be read. Nothing was changed. Reload the page to try again.
        </AlertBanner>
      </PageBody>
    );
  }
  const now = data.generatedAt;
  const readOnly = actor.role === "director" || actor.role === "medical_director";
  let items = category ? data.blocked.filter((b) => b.category === category) : data.blocked;
  if (rawOwner) items = items.filter((b) => b.ownerId === rawOwner);
  if (overdueOnly) items = items.filter((b) => b.overdue);
  const categories = CATEGORIES.map((key) => ({ key, count: data.blocked.filter((b) => b.category === key).length })).filter((c) => c.count > 0);

  return (
    <PageBody>
      <PageHeader
        title="Operations"
        readOnly={readOnly}
        description="What is blocked right now, who owns the next step, how old it is, and the evidence. Every number opens the records behind it."
        meta={<IllustrativeTag>Synthetic demo data</IllustrativeTag>}
      />
      <FreshnessWatcher freshness={data.freshness} />
      <p className="-mt-3 text-sm text-ink-secondary" role="note">
        {data.note}
      </p>
      {data.freshness.sources
        .filter((s) => s.stale)
        .map((s) =>
          s.state === "offline" ? (
            <StaleBanner
              key={s.id}
              sourceName={s.tenantName ?? s.name}
              since={s.lastSuccessAt}
              now={now}
              detail="Counts below are computed from local records. Source acknowledgments and new orders cannot arrive until the simulated source is back."
            />
          ) : (
            <AlertBanner key={s.id} tone="warning" title={s.text}>
              Source-derived data may be out of date.
            </AlertBanner>
          ),
        )}

      <OpsTiles tiles={data.tiles} />

      <BlockedWorkTable items={items} total={data.blocked.length} category={category} categories={categories} now={now} />
      {rawOwner ? <p className="-mt-2 text-xs text-ink-muted">Showing items owned by one person. <Link href="/operations#blocked" className="font-medium text-brand underline-offset-2 hover:underline">Show everyone</Link></p> : null}
      {overdueOnly ? (
        <p className="-mt-2 text-xs text-ink-muted">
          Showing clarifications whose follow-up time has passed (the &quot;Clarifications overdue&quot; tile).{" "}
          <Link href="/operations?category=clarifications#blocked" className="font-medium text-brand underline-offset-2 hover:underline">
            Show every clarification that needs a person
          </Link>
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="Queue age by stage" description="Parts on today's worklist, by how long since their last recorded event." actions={<IllustrativeTag>Synthetic demo data</IllustrativeTag>}>
          <QueueAgeChart rows={data.queueAge.rows} bucketLabels={data.queueAge.bucketLabels} definition={data.queueAge.definition} partsCounted={data.queueAge.partsCounted} />
        </Card>
        <FreshnessPanel freshness={data.freshness} now={now} />
      </div>

      <HandoffSummary label={data.handoffs.label} lines={data.handoffs.lines} />
    </PageBody>
  );
}
