"use client";

import type { MouseEvent, ReactNode } from "react";
import { Check } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { HoldPill } from "@/components/domain/hold";
import { LabelRef } from "@/components/domain/specimen-label";
import type { ClarificationListRow, DeskAttention } from "@/server/queries/clarifications";
import { FlagChip } from "./clarification-queue";
import { holdScopeWords, materialWords, rowFlag } from "./ladder";

/**
 * Nothing open: the desk's own triage, whatever filter the queue shows.
 * Overdue and undelivered questions lead in amber words, then the office
 * answers a lead must review or resolve. Each row leads with its material's
 * label (dashed while provisional) and has its own open action.
 */

function DeskRow({ r, href, onOpen }: { r: ClarificationListRow; href: string; onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void }) {
  const m = r.material;
  const words = materialWords(m);
  return (
    <li className="flex items-center gap-x-4 border-t border-line px-5 py-3 first:border-t-0 max-xl:px-4">
      <div className="min-w-0 flex-1">
        {/* Bench width: the label sits in its own column; on the tablet it leads the title line. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex shrink-0 items-center gap-2 xl:w-[14.5rem]">
            <LabelRef id={m.labelId} provisional={m.kind === "provisional"} />
            {words ? <span className="text-sm font-semibold whitespace-nowrap text-ink">{words}</span> : null}
          </span>
          <span className="text-base leading-6 font-semibold text-ink">
            {r.categoryLabel} question <span className="id-mono ml-1 text-sm font-normal whitespace-nowrap text-ink-muted">{r.displayId}</span>
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 xl:pl-[15.25rem]">
          <FlagChip flag={rowFlag(r)} />
          {r.activeHolds.length ? <HoldPill scope={holdScopeWords(r.activeHolds[0].scopeShort)} /> : null}
          <span className="text-sm text-ink-secondary">{r.officeName}</span>
        </div>
      </div>
      <ButtonLink href={href} scroll={false} variant="secondary" onClick={(e) => onOpen(e, r.displayId)}>
        Open <span className="id-mono">{r.displayId}</span>
      </ButtonLink>
    </li>
  );
}

function Group({
  id,
  title,
  rows,
  none,
  hrefFor,
  onOpen,
  children,
}: {
  id: string;
  title: string;
  rows: ClarificationListRow[];
  none: string;
  hrefFor: (displayId: string) => string;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void;
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="border-t border-line first:border-t-0">
      <div className="px-5 pt-4 pb-2 max-xl:px-4">
        <h2 id={id} className="text-lg leading-7 font-bold tracking-[-0.015em] text-ink">
          {title} <span className="num-tabular font-normal text-ink-muted">({rows.length})</span>
        </h2>
        {children}
      </div>
      {rows.length ? (
        <ul className="pb-1">
          {rows.map((r) => (
            <DeskRow key={r.id} r={r} href={hrefFor(r.displayId)} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 px-5 pb-4 text-base text-ink-muted max-xl:px-4">
          <Check className="size-4 shrink-0" aria-hidden />
          {none}
        </p>
      )}
    </section>
  );
}

export function DeskLanding({
  desk,
  queueHasRows,
  hrefFor,
  onOpen,
}: {
  desk: DeskAttention;
  queueHasRows: boolean;
  hrefFor: (displayId: string) => string;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, displayId: string) => void;
}) {
  return (
    <div className="min-h-0 overflow-y-auto p-4 max-lg:hidden max-xl:p-3">
      <div className="max-w-[64rem] rounded-lg border border-line bg-surface">
        <Group id="clr-desk-problems" title="Overdue or not delivered" rows={desk.problems} none="Nothing on the desk is overdue or undelivered." hrefFor={hrefFor} onOpen={onOpen}>
          <p className="mt-0.5 text-sm text-ink-secondary">
            No question is open. Across every filter, most urgent first; open one here or from the queue
            {queueHasRows ? " (J opens the first in the queue)" : ""}.
          </p>
        </Group>
        <Group id="clr-desk-review" title="Answers waiting for a lead" rows={desk.toReview} none="No office answer is waiting for review." hrefFor={hrefFor} onOpen={onOpen} />
        <Group id="clr-desk-release" title="Holds to release" rows={desk.toRelease} none="No closed question still holds material." hrefFor={hrefFor} onOpen={onOpen} />
        <ul className="space-y-1.5 border-t border-line px-5 py-3.5 text-sm text-ink-muted max-xl:px-4">
          <li>Questions go to the submitting office through a simulated connector. No real office is contacted.</li>
          <li>An answer never resolves a question by itself: a lead or supervisor reviews it, then resolves it.</li>
          <li>A hold stays on the affected material only, and a lead releases it separately, with a reason.</li>
        </ul>
      </div>
    </div>
  );
}
