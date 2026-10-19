import { getDb } from "@/server/db/db";
import { getActor } from "@/server/session";
import { getOperations, type BlockedCategory } from "@/server/queries/operations";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageBody } from "@/components/ui/page-header";
import { IllustrativeTag, ReadOnlyTag } from "@/components/domain/honesty";
import { StaleBanner } from "@/components/domain/stale-banner";
import { FreshnessWatcher } from "@/components/worklist/freshness-watcher";
import { BenchPath } from "@/components/operations/bench-path";
import { BlockedNow } from "@/components/operations/blocked-now";
import { RoutineEntry } from "@/components/operations/routine-entry";
import { OwnerQueue } from "@/components/operations/owner-queue";
import { SourceFreshness } from "@/components/operations/source-freshness";
import { EXCEPTION_CATEGORIES, matchesOwner, summarizeBlocked } from "@/components/operations/summary";

export const dynamic = "force-dynamic";
export const metadata = { title: "Operations" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function OperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const actor = await getActor();
  const readOnly = actor.role === "director" || actor.role === "medical_director";
  const rawCategory = first(sp.category);
  const category = EXCEPTION_CATEGORIES.includes(rawCategory as BlockedCategory) ? (rawCategory as BlockedCategory) : null;
  const owner = first(sp.owner) || null;
  const overdueOnly = category === "clarifications" && first(sp.overdue) === "1";

  let data: ReturnType<typeof getOperations>;
  try {
    data = getOperations(getDb());
  } catch (e) {
    console.error("[operations] failed", e);
    return (
      <PageBody>
        <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Operations</h1>
        <AlertBanner tone="warning" title="Could not load the operations view">
          The local demo database could not be read. Nothing was changed. Reload the page to try again.
        </AlertBanner>
      </PageBody>
    );
  }

  const now = data.generatedAt;
  const summary = summarizeBlocked(data.blocked);
  const ownerRow = owner ? data.owners.rows.find((r) => r.key === owner || r.ownerId === owner) ?? null : null;
  const ownerFilter = owner ? { key: owner, name: ownerRow?.owner ?? "this person" } : null;
  const exceptions = summary.exceptions.filter((b) => (!category || b.category === category) && matchesOwner(b, owner) && (!overdueOnly || b.overdue));
  const routine = summary.routine.filter((b) => matchesOwner(b, owner));
  const tile = (key: string) => data.tiles.find((t) => t.key === key);
  const staleSources = data.freshness.sources.filter((s) => s.stale);

  return (
    <PageBody>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Operations</h1>
          <IllustrativeTag>Synthetic demo data</IllustrativeTag>
          {readOnly ? <ReadOnlyTag /> : null}
        </div>
        <p role="note" className="max-w-[90ch] text-sm text-ink-muted">
          {data.note}
        </p>
      </header>
      <FreshnessWatcher freshness={data.freshness} />
      {staleSources.map((s) =>
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
            Source-derived data may be out of date. Counts below are computed from local records.
          </AlertBanner>
        ),
      )}

      <BenchPath stages={data.path.stages} definition={data.path.definition} now={now} />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_21rem] min-[1500px]:grid-cols-[minmax(0,1fr)_23rem]">
        <BlockedNow summary={summary} items={exceptions} filter={{ category, owner: ownerFilter, overdueOnly }} now={now} />
        <aside
          aria-label="Owners and sources"
          className="grid min-w-0 grid-cols-1 items-start gap-5 md:grid-cols-2 xl:sticky xl:top-[calc(var(--hlo-chrome-h)+1.25rem)] xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:grid-cols-1"
        >
          <OwnerQueue rows={data.owners.rows} bucketLabels={data.owners.bucketLabels} definition={data.owners.definition} activeKey={ownerRow?.key ?? null} />
          <SourceFreshness freshness={data.freshness} now={now} />
        </aside>
        <div className="min-w-0 xl:col-start-1 xl:row-start-2">
          <RoutineEntry items={routine} allRoutine={summary.routine} pending={tile("source_pending")} attested={tile("source_attested")} now={now} ownerName={ownerFilter?.name ?? null} />
        </div>
      </div>
    </PageBody>
  );
}
