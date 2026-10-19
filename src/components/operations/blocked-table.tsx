import Link from "next/link";
import { AlarmClock, Hourglass, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Timestamp } from "@/components/domain/timestamp";
import { UnknownValue } from "@/components/domain/honesty";
import { IdText } from "@/components/domain/id-text";
import { LabelRef } from "@/components/domain/specimen-label";
import { HoldPill } from "@/components/domain/hold";
import type { BlockedCategory, BlockedItem } from "@/server/queries/operations";
import { IdentityMark } from "@/components/domain/identity-mark";

/** The word each row leads with (singular, sentence case). */
export const CATEGORY_WORD: Record<BlockedCategory, string> = {
  holds: "Hold",
  clarifications: "Clarification",
  print: "Print outcome unknown",
  trays: "Tray exception",
  routing: "Routing exception",
  retrieval: "Block retrieval",
  review: "Review",
  integration: "Integration",
  source_entry: "Source-system entry",
};

/** Below 768px (200% zoom of a bench screen) owner, waiting and evidence fold into the first two cells; no column is squeezed. */
const WIDE_ONLY = "max-md:hidden";
const NARROW_ONLY = "md:hidden";

/**
 * Severity ladder (docs/redesign/visual-system.md): a hold is the shared hatched
 * HoldPill; data that may be wrong (unknown print outcome, tray mismatch) is
 * amber with a triangle; everything else is waiting on a person: neutral ink.
 * Patient identity (the top rung) is said beside the rung word with the shared red octagon.
 */
function Rung({ category }: { category: BlockedCategory }) {
  if (category === "holds") return <HoldPill />;
  const amber = category === "print" || category === "trays";
  return (
    <span className={cn("inline-flex items-center gap-1.5", amber ? "font-medium text-warning-fg" : "text-ink-muted")}>
      {amber ? <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden /> : <Hourglass className="size-3.5 shrink-0 text-ink-muted" aria-hidden />}
      {CATEGORY_WORD[category]}
    </span>
  );
}

const isIdLike = (label: string) => /^[A-Z]{1,4}-[A-Z0-9-]+$/.test(label);

/** "part B" never splits across lines (the line may still break between the accession and the part). */
export const keepPart = (t: string) => t.replace(/\bpart ([A-Z])\b/g, "part\u00a0$1");

function Waiting({ b, now }: { b: BlockedItem; now: string }) {
  return (
    <>
      {b.since ? (
        <>
          <span className="num-tabular block whitespace-nowrap text-sm font-semibold text-ink">{b.age}</span>{" "}
          <span className="block text-xs text-ink-muted">
            since <Timestamp iso={b.since} now={now} />
          </span>
        </>
      ) : (
        <UnknownValue reason="no start time recorded" />
      )}
      {b.overdue ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-ink">
          <AlarmClock className="size-3.5 shrink-0" aria-hidden />
          Follow-up overdue
        </span>
      ) : null}
    </>
  );
}

function Owner({ b }: { b: BlockedItem }) {
  return <span className={cn("text-sm text-ink", b.ownerId ? "font-medium" : "font-semibold")}>{b.owner || <UnknownValue />}</span>;
}

function Evidence({ b }: { b: BlockedItem }) {
  return (
    <Link href={b.evidenceHref} className={cn("inline-flex min-h-[var(--hlo-target-min)] items-start text-sm font-medium text-brand underline-offset-2 hover:underline", isIdLike(b.evidenceLabel) && "id-mono")}>
      <span>
        <IdText text={b.evidenceLabel} />
      </span>
    </Link>
  );
}

/**
 * Blocked now: what is blocked (the record as a label reference, its scope
 * beside it), why and the next step, owner, waiting since (demo clock) and
 * the record that shows it. Patient identity first, then the query's order
 * (holds first, oldest first within each category).
 */
export function BlockedTable({ items, caption, now }: { items: BlockedItem[]; caption: string; now: string }) {
  return (
    <Table caption={caption} scroll="page" wrapperClassName="rounded-none border-0" className="table-fixed">
      <THead>
        <tr>
          <TH className="w-[25%] pl-5 max-xl:pl-4 max-md:w-[42%]">Blocked item</TH>
          <TH>Why, and the next step</TH>
          <TH className={cn("w-[8.5rem] max-xl:w-[8rem]", WIDE_ONLY)}>Owner</TH>
          <TH className={cn("w-[8.5rem]", WIDE_ONLY)}>Waiting</TH>
          <TH className={cn("w-[8.5rem] pr-5 max-xl:w-[7.75rem] max-xl:pr-4", WIDE_ONLY)}>Evidence</TH>
        </tr>
      </THead>
      <TBody>
        {items.map((b) => {
          const showNext = b.nextStep && b.nextStep !== b.item;
          return (
            <TR key={b.key} hold={b.category === "holds"}>
              <TD wrap className="py-2.5 pl-5 align-top max-xl:pl-4">
                <span className="mb-1.5 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <Rung category={b.category} />
                  {b.identity ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-danger-fg">
                      <IdentityMark />
                      Patient identity
                    </span>
                  ) : null}
                </span>{" "}
                <Link href={b.itemHref} className="group/item block min-h-[var(--hlo-target-min)] text-sm leading-6 text-brand max-md:min-h-0">
                  {b.ref ? (
                    <>
                      <LabelRef id={b.ref} provisional={b.ref.startsWith("INT-")} className="mr-1 align-[1px] group-hover/item:border-brand" />{" "}
                      {b.subject ? (
                        <span className="underline-offset-2 group-hover/item:underline">
                          <IdText text={keepPart(b.subject)} />
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="font-medium underline-offset-2 group-hover/item:underline">
                      <IdText text={keepPart(b.item)} />
                    </span>
                  )}
                </Link>
                {/* Narrow (200% zoom): owner and waiting under the item, said with their labels. */}
                <dl className={cn("mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 text-xs", NARROW_ONLY)}>
                  <dt className="text-ink-muted">Owner</dt>
                  <dd>
                    <Owner b={b} />
                  </dd>
                  <dt className="text-ink-muted">Waiting</dt>
                  <dd>
                    <Waiting b={b} now={now} />
                  </dd>
                </dl>
              </TD>
              <TD wrap className="py-2.5 align-top max-md:pr-4">
                <p className="text-sm text-ink">
                  <IdText text={b.blocks} />
                </p>
                {showNext ? (
                  <p className="mt-1 text-sm text-ink-secondary">
                    <span className="text-ink-muted">Next: </span>
                    <IdText text={b.nextStep} />
                  </p>
                ) : null}
                {/* Where the material is (last confirmed, never live) and what evidence closes the item. */}
                <p className="mt-1 text-sm text-ink-secondary">
                  <span className="text-ink-muted">Where: </span>
                  <IdText text={b.where} />
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">{b.closesWhen}</p>
                <p className={cn("mt-1 text-sm", NARROW_ONLY)}>
                  <span className="text-ink-muted">Evidence: </span>
                  <Evidence b={b} />
                </p>
              </TD>
              <TD wrap className={cn("py-2.5 align-top", WIDE_ONLY)}>
                <Owner b={b} />
              </TD>
              <TD wrap className={cn("py-2.5 align-top", WIDE_ONLY)}>
                <Waiting b={b} now={now} />
              </TD>
              <TD wrap className={cn("py-2.5 pr-5 align-top max-xl:pr-4", WIDE_ONLY)}>
                <Evidence b={b} />
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
