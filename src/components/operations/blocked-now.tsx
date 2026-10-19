import Link from "next/link";
import { Check, CircleCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { plural } from "@/components/worklist/format";
import type { BlockedCategory, BlockedItem } from "@/server/queries/operations";
import { Tabs } from "@/components/ui/tabs";
import { IdText } from "@/components/domain/id-text";
import { BlockedTable, keepPart } from "./blocked-table";
import { IdentityMark } from "@/components/domain/identity-mark";
import { CLEAR_LABEL, FILTER_LABEL, type BlockedSummary } from "./summary";

export interface BlockedFilter {
  category: BlockedCategory | null;
  owner: { key: string; name: string } | null;
  overdueOnly: boolean;
}

const filterHref = (category: BlockedCategory | null, owner: string | null) => {
  const q = new URLSearchParams();
  if (category) q.set("category", category);
  if (owner) q.set("owner", owner);
  const s = q.toString();
  return `/operations${s ? `?${s}` : ""}#blocked`;
};

function emptyFilterText(f: BlockedFilter): string {
  if (f.overdueOnly) return "No clarification follow-ups are overdue right now.";
  const what = f.category ? CLEAR_LABEL[f.category] : null;
  if (what && f.owner) return `No ${what} for ${f.owner.name} right now.`;
  if (what) return `No ${what} right now.`;
  if (f.owner) return `Nothing blocked now for ${f.owner.name}. Routine source-system entry is listed below.`;
  return "Nothing matches this filter.";
}

/**
 * The focal area: what is blocked now. One sentence names the holds and the
 * other items waiting on a person and the one that has waited longest; the
 * table lists each with scope, reason, next step, owner, waiting since and
 * evidence. Categories with nothing waiting collapse into one "Clear now" line.
 */
export function BlockedNow({ summary, items, filter, now }: { summary: BlockedSummary; items: BlockedItem[]; filter: BlockedFilter; now: string }) {
  const { holds, others, identity, longest, overdue, counts, clear } = summary;
  const total = holds + others;
  const filtered = !!(filter.category || filter.owner || filter.overdueOnly);
  const ownerKey = filter.owner?.key ?? null;
  // The active category always has a tab (also when nothing is in it), so the filter in force is always marked.
  const shown = filter.category && !counts.some((c) => c.key === filter.category) ? [...counts, { key: filter.category, count: 0 }] : counts;
  const tabs = [
    { key: "all", label: "All", count: total, href: filterHref(null, ownerKey) },
    ...shown.map((c) => ({ key: c.key, label: FILTER_LABEL[c.key], count: c.count, href: filterHref(c.key, ownerKey) })),
  ];
  const identityIds = identity.map((b) => b.ref ?? b.item).join(", ");

  return (
    <section id="blocked" aria-labelledby="blocked-title" className="scroll-mt-24 rounded-lg border border-line bg-surface">
      <div className="px-5 pt-4 pb-3 max-xl:px-4">
        <h2 id="blocked-title" className="text-md font-bold tracking-[-0.01em] text-ink">
          Blocked now
        </h2>
        {total === 0 ? (
          <p className="mt-1 flex items-start gap-2 text-lg leading-7 text-ink-secondary">
            <CircleCheck className="mt-1 size-5 shrink-0 text-ink-muted" aria-hidden />
            Nothing is blocked or waiting on a person right now.
          </p>
        ) : (
          <>
            {/* The focal sentence: how many stop work, how many wait, and the patient-identity rung as its own clause that never breaks. */}
            <p className="mt-1 text-lg leading-7 font-semibold tracking-[-0.005em] text-pretty text-ink">
              {holds ? (
                <Link href={filterHref("holds", null)} className="underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                  {holds === 1 ? "1 hold stops" : `${holds} holds stop`} work
                </Link>
              ) : (
                "No holds are active"
              )}
              {others ? (
                <>
                  {holds ? " and " : "; "}
                  {others === 1 ? "1 other item waits" : `${others} other items wait`} on a person.
                </>
              ) : (
                "."
              )}
              {identity.length ? (
                <>
                  {" "}
                  <span className={cn("text-danger-fg", identity.length <= 2 && "whitespace-nowrap")}>
                    <IdentityMark className="mr-1.5 inline-block size-[22px] align-[-4px]" />
                    <IdText text={identityIds} /> {identity.length === 1 ? "concerns" : "concern"} patient identity.
                  </span>
                </>
              ) : null}
            </p>
            {longest || overdue ? (
              <p className="mt-1 text-base text-pretty text-ink-secondary">
                {longest ? (
                  <>
                    Waiting longest: <IdText text={longest.ref ?? longest.item} idClassName="text-ink" />
                    {longest.ref && longest.subject ? (
                      <>
                        {" ("}
                        <IdText text={keepPart(longest.subject)} />
                        {")"}
                      </>
                    ) : null}
                    , <span className="whitespace-nowrap">{longest.age}</span> with <span className="whitespace-nowrap">{longest.owner}</span>.
                  </>
                ) : null}
                {overdue ? (
                  <>
                    {" "}
                    <Link href="/operations?category=clarifications&overdue=1#blocked" scroll={false} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                      {overdue === 1 ? "1 clarification follow-up is overdue." : `${overdue} clarification follow-ups are overdue.`}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        )}
      </div>

      {total > 0 || filter.category ? (
        <Tabs items={tabs} active={filter.category ?? "all"} label="Blocked now by category" className="px-5 max-xl:px-4" />
      ) : null}

      {filtered ? (
        <p role="status" className={cn("border-b border-line px-5 text-sm max-xl:px-4", items.length ? "bg-surface-subtle py-1 text-ink-secondary" : "py-3 text-ink")}>
          {items.length ? (
            <>
              Showing {items.length} of {plural(total, "item")}
              {filter.category ? `: ${FILTER_LABEL[filter.category].toLowerCase()}` : ""}
              {filter.overdueOnly ? " whose follow-up time has passed" : ""}
              {filter.owner ? ` for ${filter.owner.name}` : ""}.
            </>
          ) : (
            emptyFilterText(filter)
          )}{" "}
          <Link href="/operations#blocked" scroll={false} className="inline-flex min-h-[var(--hlo-target-min)] items-center font-medium text-brand underline-offset-2 hover:underline">
            Show everything
          </Link>
        </p>
      ) : null}

      {items.length ? (
        <BlockedTable
          items={items}
          now={now}
          caption="Blocked now: holds and other items waiting on a person, with owner, waiting time and evidence; patient identity first, then holds, oldest first within each category"
        />
      ) : total === 0 ? (
        <p className="border-t border-line px-5 py-4 text-sm text-ink-secondary max-xl:px-4">
          Holds, overdue clarifications, unknown print outcomes, tray and routing exceptions, open block retrievals and reviews appear here with their owner,
          waiting time and evidence as soon as the records show them.
        </p>
      ) : null}

      {/* Zeros are said once, only on the unfiltered list (under a filter the one empty sentence above is enough). */}
      {clear.length && total > 0 && !filtered ? (
        <div className="flex items-start gap-1.5 border-t border-line px-5 py-2.5 text-sm text-ink-muted max-xl:px-4">
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p id="clear-now-label" className="shrink-0">
            Clear now:
          </p>
          <ul aria-labelledby="clear-now-label" className="flex flex-wrap gap-x-1">
            {clear.map((k, i) => (
              <li key={k}>
                no {CLEAR_LABEL[k]}
                {i < clear.length - 1 ? "," : "."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
