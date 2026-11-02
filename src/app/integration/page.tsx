import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { getDb } from "@/server/db/db";
import { requireView } from "@/server/auth/guard";
import { loadSourceFreshness } from "@/server/queries/worklist";
import { roleCan } from "@/lib/roles";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageBody } from "@/components/ui/page-header";
import { ReadOnlyTag, SimulatedLabel } from "@/components/domain/honesty";
import { FreshnessWatcher } from "@/components/worklist/freshness-watcher";
import { GROUP_ORDER, loadIntegrationScreen, type ActionGroup } from "@/components/integration/data";
import { GroupSection, groupAnchor } from "@/components/integration/rows";
import { SourcesPanel } from "@/components/integration/sources";
import { RecentMessages } from "@/components/integration/messages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integration" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const COUNT_WORDS: Record<Exclude<ActionGroup, "info">, (n: number) => string> = {
  review: (n) => `${n} ${n === 1 ? "needs" : "need"} review`,
  waiting: (n) => `${n} waiting on the source`,
  failed: (n) => `${n} failed and retryable`,
};

const linkClass = "inline-flex min-h-[var(--hlo-target-min)] items-center font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand";

/**
 * /integration: what the simulated source systems sent, what this laboratory recorded, and what a person must
 * decide. Read only (the one action is the existing supervisor retry of a failed message). Grouped by what the
 * operator must do; raw messages stay behind a disclosure, shown as data.
 */
export default async function IntegrationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The one guard: signed in (or the demo role), with this screen's view permission, before any data is read.
  const actor = await requireView("view.integration");
  const sp = await searchParams;
  const includeInSync = first(sp.inSync) === "1";
  const allMessages = first(sp.messages) === "all";
  const readOnly = actor.role === "director" || actor.role === "medical_director";

  let data: ReturnType<typeof loadIntegrationScreen>;
  let freshness: ReturnType<typeof loadSourceFreshness>;
  try {
    const db = getDb();
    data = loadIntegrationScreen(db, { includeInSync, allMessages });
    freshness = loadSourceFreshness(db, data.now);
  } catch (e) {
    console.error("[integration] failed", e);
    return (
      <PageBody>
        <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Integration</h1>
        <AlertBanner tone="warning" title="Could not load the integration view">
          The local demo database could not be read. Nothing was changed. Reload the page to try again.
        </AlertBanner>
      </PageBody>
    );
  }

  const { now, rows, counts } = data;
  const byGroup = (g: ActionGroup) => rows.filter((r) => r.group === g);
  const actionable = (["review", "waiting", "failed"] as const).filter((g) => counts[g] > 0);
  const query = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    if (includeInSync) q.set("inSync", "1");
    if (allMessages) q.set("messages", "all");
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    return `/integration${s ? `?${s}` : ""}`;
  };

  return (
    <PageBody>
      <FreshnessWatcher freshness={freshness} />
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Integration</h1>
          <SimulatedLabel connector="source systems" />
          {readOnly ? <ReadOnlyTag /> : null}
        </div>
        <p className="max-w-[90ch] text-sm text-ink-muted">
          What the simulated source systems sent, what this laboratory recorded, and what a person must decide. A message never changes an issued
          specimen or the patient on file by itself: differences wait here for a review. Synthetic data only.
        </p>
      </header>

      <section aria-labelledby="integration-focus" className="rounded-lg border border-line bg-surface px-5 py-4 max-xl:px-4">
        <h2 id="integration-focus" className="sr-only">
          What needs doing
        </h2>
        {actionable.length ? (
          <p className="text-lg leading-7 font-semibold tracking-[-0.005em] text-pretty text-ink">
            {actionable.map((g, i) => (
              <span key={g}>
                {i > 0 ? (i === actionable.length - 1 ? " and " : ", ") : null}
                <Link href={`#${groupAnchor(g)}`} className="underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                  {COUNT_WORDS[g](counts[g])}
                </Link>
              </span>
            ))}
            .
          </p>
        ) : (
          <p className="flex items-start gap-2 text-lg leading-7 text-ink-secondary">
            <CircleCheck className="mt-1 size-5 shrink-0 text-ink-muted" aria-hidden />
            Nothing from the sources needs a person right now.
          </p>
        )}
        <p className="mt-1 text-sm text-ink-secondary">
          {data.compared.orders} source orders linked to work here were compared with what is recorded; {data.compared.inSync} agree.{" "}
          <Link href={`#${groupAnchor("info")}`} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
            {counts.info} informational
          </Link>
          .
        </p>
      </section>

      <SourcesPanel sources={data.sources} now={now} />

      {GROUP_ORDER.map((g) => (
        <GroupSection key={g} group={g} rows={byGroup(g)} now={now} canRetry={roleCan(actor.role, "integration.manage")}>
          {g === "info" ? (
            <>
              <p className="border-t border-line px-4 py-1 text-sm">
                {includeInSync ? (
                  <Link href={query({ inSync: null })} className={linkClass}>
                    Hide the comparisons that agree
                  </Link>
                ) : (
                  <Link href={query({ inSync: "1" })} className={linkClass}>
                    Also list the comparisons that agree ({data.compared.inSync} orders)
                  </Link>
                )}
              </p>
              <RecentMessages
                messages={data.messages.shown}
                total={data.messages.total}
                now={now}
                showAllHref={!allMessages && data.messages.shown.length < data.messages.total ? `${query({ messages: "all" })}#recent-messages-title` : null}
              />
            </>
          ) : null}
        </GroupSection>
      ))}
    </PageBody>
  );
}
