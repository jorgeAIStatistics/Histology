import Link from "next/link";
import { Card, StatTile, StatePill, Table, TableCount, Tabs, TBody, TD, TH, THead, TR, EmptyState } from "@/components/ui";
import { SimulatedLabel, Timestamp, UnknownValue } from "@/components/domain";
import type { FreshnessSummary } from "@/server/queries/worklist";
import { BLOCKED_CATEGORY_LABEL, type BlockedCategory, type BlockedItem, type HandoffLine, type OpsTile } from "@/server/queries/operations";

/** Exceptions first (first row), then the flow of work (second row). Unlisted tiles keep their order at the end. */
const TILE_ORDER = ["holds", "clarifications_overdue", "print_unknown", "trays_blocked", "routing_exceptions", "awaiting_gross", "source_pending", "source_attested", "retrieval_open"];

/** Status tiles: counts only, each linking to the records behind it. */
export function OpsTiles({ tiles }: { tiles: OpsTile[] }) {
  const rank = (k: string) => (TILE_ORDER.includes(k) ? TILE_ORDER.indexOf(k) : TILE_ORDER.length);
  const ordered = [...tiles].sort((a, b) => rank(a.key) - rank(b.key));
  return (
    <section aria-label="Status counts" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {ordered.map((t) => (
        <StatTile key={t.key} label={t.label} value={t.value} unknownReason={t.unknownReason} caption={t.caveat} href={t.href} />
      ))}
    </section>
  );
}

const SYNC_PILL: Record<string, string> = { current: "synced", delayed: "delayed", offline: "offline", unknown: "unknown" };

/** Source freshness per tenant (simulated adapters). Unknown stays Unknown; offline is stale. */
export function FreshnessPanel({ freshness, now }: { freshness: FreshnessSummary; now: string }) {
  return (
    <Card title="Source freshness" description="Per source-system tenant. Thresholds (5 and 15 min) are demo settings, not clinical rules.">
      <SimulatedLabel connector="source adapters" />
      <ul className="mt-3 flex flex-col gap-3">
        {freshness.sources.map((s) => (
          <li key={s.id} className="flex flex-col gap-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{s.tenantName ?? s.name}</span>
              <StatePill domain="sync" state={SYNC_PILL[s.state]} />
              {s.stale ? <span className="text-xs font-semibold text-warning-fg">Stale</span> : null}
            </div>
            <dl className="grid grid-cols-[8.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
              <dt className="text-ink-muted">Last successful sync</dt>
              <dd className="text-ink">{s.lastSuccessAt ? <Timestamp iso={s.lastSuccessAt} now={now} showAge /> : <UnknownValue reason="none recorded" />}</dd>
              <dt className="text-ink-muted">Last attempt</dt>
              <dd className="text-ink">{s.lastAttemptAt ? <Timestamp iso={s.lastAttemptAt} now={now} showAge /> : <UnknownValue />}</dd>
              {s.lastError ? (
                <>
                  <dt className="text-ink-muted">Last error</dt>
                  <dd className="text-ink">{s.lastError}</dd>
                </>
              ) : null}
            </dl>
            {s.state !== "current" || s.stale ? <p className={s.state === "offline" ? "text-xs text-danger-fg" : "text-xs text-warning-fg"}>{s.text}</p> : null}
          </li>
        ))}
        {freshness.sources.length === 0 ? <li className="text-sm text-ink-secondary">No source systems configured.</li> : null}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">
        Data as of: {freshness.dataAsOf ? <Timestamp iso={freshness.dataAsOf} now={now} /> : "Unknown"}. Local task completion never writes to a source system in this demo.
      </p>
    </Card>
  );
}

/** Blocked work: item, what blocks it, next step, owner, waiting since, evidence. Exceptions first, then oldest first. */
export function BlockedWorkTable({
  items,
  total,
  category,
  categories,
  now,
}: {
  items: BlockedItem[];
  total: number;
  category: BlockedCategory | null;
  categories: { key: BlockedCategory; count: number }[];
  now: string;
}) {
  const tabs = [
    { key: "all", label: "All", count: total, href: "/operations#blocked" },
    ...categories.map((c) => ({ key: c.key, label: BLOCKED_CATEGORY_LABEL[c.key], count: c.count, href: `/operations?category=${c.key}#blocked` })),
  ];
  return (
    <section id="blocked" aria-labelledby="blocked-title" className="flex scroll-mt-40 flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="blocked-title" className="text-md font-semibold text-ink">
            Blocked and waiting work
          </h2>
          <p className="text-sm text-ink-secondary">Who owns the next step, how long it has waited, and the record that shows it. Holds and other exceptions first, routine source entry last; oldest first within each.</p>
        </div>
        <TableCount shown={items.length} total={total} noun="items" />
      </div>
      <Tabs items={tabs} active={category ?? "all"} label="Blocked work categories" size="sm" />
      {items.length === 0 ? (
        <EmptyState compact title={category ? `Nothing waiting in ${BLOCKED_CATEGORY_LABEL[category].toLowerCase()}` : "Nothing is blocked right now"}>
          Items appear here when a hold, overdue clarification, unknown print outcome, tray exception, routing exception, retrieval request or review is waiting on a person.
        </EmptyState>
      ) : (
        <Table caption="Blocked and waiting work: exceptions first, routine source entry last, oldest first within each category" scroll="page">
          <THead>
            <tr>
              <TH>Item</TH>
              <TH>What blocks it</TH>
              <TH>Next step</TH>
              <TH>Owner</TH>
              <TH align="right">Waiting since</TH>
              <TH>Evidence</TH>
            </tr>
          </THead>
          <TBody>
            {items.map((b) => (
              <TR key={b.key} hold={b.category === "holds"}>
                <TD wrap className="min-w-40 max-w-64 py-1.5 align-top">
                  <span className="block text-xs text-ink-muted">{BLOCKED_CATEGORY_LABEL[b.category]}</span>
                  <Link href={b.itemHref} className="font-medium text-brand underline-offset-2 hover:underline">
                    {b.ref ? (
                      <>
                        <span className="id-mono">{b.ref}</span>
                        {b.subject ? <span className="block text-sm font-normal text-ink-secondary">{b.subject}</span> : null}
                      </>
                    ) : (
                      b.item
                    )}
                  </Link>
                </TD>
                <TD wrap className="min-w-44 max-w-80 py-1.5 align-top text-ink-secondary">
                  {b.blocks}
                </TD>
                <TD wrap className="min-w-44 max-w-72 py-1.5 align-top">
                  {b.nextStep}
                </TD>
                <TD wrap className="min-w-24 py-1.5 align-top">
                  {b.owner}
                </TD>
                <TD numeric className="py-1.5 align-top">
                  {b.since ? (
                    <>
                      <Timestamp iso={b.since} now={now} />
                      <span className="block text-xs text-ink-muted">{b.age}</span>
                    </>
                  ) : (
                    <UnknownValue />
                  )}
                </TD>
                <TD wrap className="min-w-20 py-1.5 align-top">
                  <Link href={b.evidenceHref} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
                    {b.evidenceLabel}
                  </Link>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}

/** Deterministic pending-handoffs summary, computed from open tasks and holds (not AI). */
export function HandoffSummary({ label, lines }: { label: string; lines: HandoffLine[] }) {
  return (
    <Card title="Pending handoffs" description={label}>
      <ul className="flex flex-col gap-2 text-sm">
        {lines.map((l, i) => (
          <li key={i} className="text-ink">
            {l.text}{" "}
            <span className="text-xs text-ink-muted">
              Evidence:{" "}
              {l.evidence.map((e, j) => (
                <span key={j}>
                  {j ? ", " : ""}
                  <Link href={e.href} className="whitespace-nowrap font-medium text-brand underline-offset-2 hover:underline">
                    {e.label}
                  </Link>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">Sorted by name, not by workload. No rankings, scores or productivity measures.</p>
    </Card>
  );
}
