"use client";

import { ListChecks } from "lucide-react";
import type { ItemDetail } from "@/server/queries/intake";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { IdChip } from "@/components/domain/chips";
import { HoldPill } from "@/components/domain/hold";
import { Timestamp } from "@/components/domain/timestamp";
import { CLARIFICATION_CATEGORY } from "@/lib/domain";
import { HOLD_BLOCK_WORDS } from "./plan";
import { RecordSection } from "./bits";

/** Holds (hatched ink, scope named), every clarification on the item and the open tasks with their owners. */
export function HoldsSection({ item, now }: { item: ItemDetail; now: string }) {
  const openClar = item.clarifications.filter((c) => c.state !== "resolved" && c.state !== "canceled");
  const closedClar = item.clarifications.filter((c) => c.state === "resolved" || c.state === "canceled");
  if (!item.holds.length && !item.clarifications.length && !item.tasks.length) return null;
  return (
    <RecordSection
      id="holds"
      title={
        <span className="inline-flex items-center gap-2">
          <ListChecks className="size-4 text-ink-muted" aria-hidden />
          Holds, questions and tasks
        </span>
      }
    >
      <div className="space-y-3">
        {item.holds.length ? (
          <ul className="space-y-2">
            {item.holds.map((h) => (
              <li key={h.id} className="hatch rounded-md border border-hold-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <IdChip kind="HOLD" id={h.displayId} />
                  <HoldPill scope={h.scopeLabel} />
                  {h.clarificationDisplayId ? <IdChip kind="CLR" id={h.clarificationDisplayId} href={`/clarifications?selected=${encodeURIComponent(h.clarificationDisplayId)}`} /> : null}
                </div>
                <p className="mt-1 text-ink">{h.reasonText}</p>
                <p className="text-ink-secondary">
                  Blocks {h.blocks.map((b) => HOLD_BLOCK_WORDS[b] ?? b).join(", ")} for {h.scopeLabel} only. {h.blocksAccession ? "Accession is blocked until it is released." : "Accession is not blocked."} Placed by{" "}
                  {h.placedByName ?? "Unknown"} at <Timestamp iso={h.placedAt} now={now} />. Released only by a lead or supervisor, with a reason.
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {openClar.length ? (
          <div>
            <h4 className="mb-1 text-sm font-semibold text-ink">Open clarifications</h4>
            <ul className="space-y-1.5 text-sm">
              {openClar.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <IdChip kind="CLR" id={c.displayId} href={`/clarifications?selected=${encodeURIComponent(c.displayId)}`} />
                  <StatePill domain="clarification" state={c.state} suffix={c.state === "drafted" ? ", not sent" : undefined} className="text-sm" />
                  <span className="text-ink-secondary">{CLARIFICATION_CATEGORY[c.category as keyof typeof CLARIFICATION_CATEGORY] ?? c.category}</span>
                  <span className="min-w-0 flex-1 text-ink">{c.question}</span>
                  <span className="text-ink-muted">Owner: {c.ownerName ?? "Unknown"}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {closedClar.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-secondary">Closed clarifications ({closedClar.length})</summary>
            <ul className="mt-1 space-y-1">
              {closedClar.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <IdChip kind="CLR" id={c.displayId} href={`/clarifications?selected=${encodeURIComponent(c.displayId)}`} />
                  <StatePill domain="clarification" state={c.state} className="text-sm" />
                  <span className="text-ink-secondary">{c.question}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {item.tasks.length ? (
          <div>
            <h4 className="mb-1 text-sm font-semibold text-ink">Open tasks and their owners</h4>
            <ul className="space-y-1 text-sm">
              {item.tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <StatusPill tone="neutral" size="sm" className="text-sm">
                    {t.priority === "routine" ? "Routine" : t.priority === "high" ? "High" : "Urgent"}
                  </StatusPill>
                  <span className="min-w-0 flex-1 text-ink">{t.title}</span>
                  <span className="text-ink-muted">Owner: {t.ownerName ?? (t.ownerRole ? `${t.ownerRole.replace(/_/g, " ")} (unassigned)` : "Unassigned")}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </RecordSection>
  );
}
