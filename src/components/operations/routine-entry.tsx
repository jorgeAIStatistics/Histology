import { cn } from "@/lib/cn";
import Link from "next/link";
import type { BlockedItem, OpsTile } from "@/server/queries/operations";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { plural } from "@/components/worklist/format";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { IdText } from "@/components/domain/id-text";
import { groupRoutine, longestWaiting, type RoutineGroup } from "./summary";

const ROW = "py-0.5 text-sm text-ink-secondary";

/**
 * Routine documentation queue, kept apart from the exceptions and quieter than
 * them: approved gross records awaiting manual entry in the (simulated) source
 * system. It leads with the work nobody owns; the attested-awaiting-
 * acknowledgment count is a quiet line, never a headline.
 */
export function RoutineEntry({
  items,
  allRoutine,
  pending,
  attested,
  now,
  ownerName,
}: {
  /** Routine items after the owner filter. */
  items: BlockedItem[];
  /** Every routine item (for the lead sentence). */
  allRoutine: BlockedItem[];
  pending: OpsTile | undefined;
  attested: OpsTile | undefined;
  now: string;
  ownerName: string | null;
}) {
  const unowned = allRoutine.filter((b) => !b.ownerId);
  const oldestUnowned = longestWaiting(unowned);
  const byOwner = new Map<string, number>();
  for (const b of allRoutine) if (b.ownerId) byOwner.set(b.owner, (byOwner.get(b.owner) ?? 0) + 1);
  const owned = [...byOwner.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <section id="routine" aria-labelledby="routine-title" className="scroll-mt-24 rounded-lg border border-line bg-surface">
      <div className="flex flex-col gap-1.5 px-5 pt-3.5 pb-3 max-xl:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="routine-title" className="text-md font-bold tracking-[-0.01em] text-ink">
            Source-system entry
          </h2>
          <SimulatedLabel connector="EMA-SIM" size="xs" />
        </div>
        <p className="max-w-[80ch] text-sm text-pretty text-ink-secondary">
          Routine documentation: approved gross records a histology assistant enters by hand in the source system. Approval already lets the material move on.
        </p>
        {allRoutine.length ? (
          <p className="max-w-[80ch] text-base text-pretty text-ink">
            {unowned.length ? (
              <>
                <span className="font-semibold">
                  {unowned.length === 1 ? "1 approved record has no entry task, so nobody owns it" : `${unowned.length} approved records have no entry task, so nobody owns them`}
                </span>
                <span className="text-ink-secondary">
                  {oldestUnowned ? (
                    <>
                      ; the longest has waited <span className="whitespace-nowrap">{oldestUnowned.age}.</span>
                    </>
                  ) : (
                    "."
                  )}
                </span>{" "}
              </>
            ) : (
              <span>Every record awaiting entry has an owner. </span>
            )}
            {owned.length ? (
              <span className="text-ink-secondary">
                {owned.map(([name, n], i) => (
                  <span key={name}>
                    {i ? (i === owned.length - 1 ? " and " : ", ") : ""}
                    {/* "6 more with Sam Ortiz" stays on one line, so a name never starts a line alone. */}
                    <span className="whitespace-nowrap">{`${n} ${unowned.length ? "more " : ""}with ${name}`}</span>
                  </span>
                ))}
                .
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-base text-ink-secondary">No approved record is waiting for source-system entry.</p>
        )}
        {attested?.value != null ? (
          <p className="max-w-[80ch] text-sm text-pretty text-ink-muted">
            {plural(attested.value, "more record")} {attested.value === 1 ? "was" : "were"} entered by staff and {attested.value === 1 ? "awaits" : "await"} the source&apos;s
            acknowledgment. {attested.caveat}
          </p>
        ) : null}
        <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {pending ? (
            <Link href={pending.href} className="inline-flex min-h-[var(--hlo-target-min)] items-center font-medium text-brand underline-offset-2 hover:underline">
              Open the entry queue
            </Link>
          ) : null}
          {attested ? (
            <Link href={attested.href} className="inline-flex min-h-[var(--hlo-target-min)] items-center font-medium text-brand underline-offset-2 hover:underline">
              Open the attested queue
            </Link>
          ) : null}
        </p>
      </div>
      {items.length ? (
        <RoutineTable groups={groupRoutine(items)} now={now} />
      ) : ownerName && allRoutine.length ? (
        <p className="border-t border-line px-5 py-4 text-sm text-ink-secondary max-xl:px-4">No source-system entry for {ownerName}.</p>
      ) : null}
    </section>
  );
}

/** Waiting time and its start on one line ("23 h 38 min since Oct 13, 11:22 AM ET"). */
function WaitingLine({ b, now }: { b: BlockedItem; now: string }) {
  if (!b.since) return <UnknownValue reason="no start time recorded" />;
  return (
    <span className="whitespace-nowrap">
      {/* Ages right-aligned in one measure so they compare down the column ("23 h 38 min" over "1 h 48 min"). */}
      <span className="num-tabular inline-block min-w-[5.75rem] text-right text-ink">{b.age}</span>{" "}
      <span className="text-ink-muted">since <Timestamp iso={b.since} now={now} /></span>
    </span>
  );
}

/** "D26-04792 part B": the record's own label (the subject's first clause), one inline box so the id and part stay together. */
const recordText = (b: BlockedItem) => (b.ref ? `${b.ref} ${b.subject?.split(" · ")[0] ?? ""}`.trim() : b.item);

function RecordLink({ b }: { b: BlockedItem }) {
  return (
    <Link href={b.itemHref} className="inline-flex min-h-[var(--hlo-target-min)] items-center whitespace-nowrap text-brand underline-offset-2 hover:underline">
      <span>
        <IdText text={recordText(b)} />
      </span>
    </Link>
  );
}

/** The group's shared status, owner and next step, said once above its rows. */
function GroupHeading({ group, first }: { group: RoutineGroup; first: boolean }) {
  const n = group.items.length;
  return (
    <tr>
      <th
        colSpan={3}
        scope="rowgroup"
        className={cn("border-b border-line bg-surface-subtle px-5 py-2 text-left text-sm font-normal text-ink-secondary max-xl:px-4", !first && "border-t")}
      >
        <span className="font-semibold text-ink">
          {group.ownerId
            ? `${group.owner} holds the entry task for ${n === 1 ? "this record" : `each of these ${n}`}.`
            : `No entry task, so nobody owns ${n === 1 ? "this record" : `these ${n}`}.`}
        </span>{" "}
        {group.status}. <span className="text-ink-muted">Next: </span>
        {group.ownerId ? lowerFirst(group.nextStep) : "a lead assigns each to a histology assistant"}.
      </th>
    </tr>
  );
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/**
 * One line per record. Records sharing an owner and status are grouped and
 * the status, owner and next step are said once in the group heading, so each
 * row carries only what differs: the record, how long it has waited, and the
 * record that shows it (the entry queue at that record when nobody owns it,
 * its entry task otherwise), at the row's end. Unowned first, oldest first.
 */
function RoutineTable({ groups, now }: { groups: RoutineGroup[]; now: string }) {
  return (
    <Table
      caption="Source-system entry: approved records awaiting manual entry, grouped by owner with the shared status said once; records nobody owns first, oldest first"
      scroll="page"
      wrapperClassName="rounded-none border-0 border-t"
      className="table-fixed"
    >
      <THead>
        <tr>
          <TH className="w-[11rem] pl-5 max-xl:pl-4">Record</TH>
          <TH>Waiting</TH>
          <TH align="right" className="w-[8.5rem] pr-5 max-xl:pr-4">
            Evidence
          </TH>
        </tr>
      </THead>
      {groups.map((g, gi) => (
        <TBody key={g.key}>
          <GroupHeading group={g} first={gi === 0} />
          {g.items.map((b) => (
            <TR key={b.key}>
              <TD className={cn(ROW, "pl-5 max-xl:pl-4")}>
                <RecordLink b={b} />
              </TD>
              <TD className={ROW}>
                <WaitingLine b={b} now={now} />
              </TD>
              <TD className={cn(ROW, "pr-5 text-right max-xl:pr-4")}>
                <Link href={b.evidenceHref} className="inline-flex min-h-[var(--hlo-target-min)] items-center whitespace-nowrap text-brand underline-offset-2 hover:underline">
                  <span>
                    {g.ownerId ? "Entry task" : "Entry queue"}
                    <span className="sr-only"> for {recordText(b)}</span>
                  </span>
                </Link>
              </TD>
            </TR>
          ))}
        </TBody>
      ))}
    </Table>
  );
}
