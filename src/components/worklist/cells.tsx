import { Fragment } from "react";
import { Plug, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { HoldPill, PasTag, UnknownValue } from "@/components/domain";
import { groupParts } from "./format";
import type { ChangeTag as ChangeTagKind, HoldEntry, StainEntry, WorklistRow } from "@/server/queries/worklist";

/**
 * Small render helpers shared by the worklist table, side panel, printed
 * snapshot and the case page. Text always carries the meaning; color only
 * reinforces it.
 */

const CHANGE_LABEL: Record<ChangeTagKind, string> = { new: "New", changed: "Changed", canceled: "Canceled" };

/** Every change tag on a row ("New" and "Canceled" can both apply). */
export function ChangeTags({ tags, className }: { tags: ChangeTagKind[]; className?: string }) {
  if (!tags.length) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {tags.map((t) => (
        <ChangeTag key={t} change={t} />
      ))}
    </span>
  );
}

/** "New" / "Changed" / "Canceled" as a bordered text tag (works in grayscale). */
export function ChangeTag({ change, className }: { change: ChangeTagKind | null; className?: string }) {
  if (!change) return null;
  return (
    <span
      className={cn(
        "hlo-chip inline-flex h-5 shrink-0 items-center rounded-sm border px-1 text-xs font-semibold",
        change === "new" && "border-info-border bg-info-bg text-info-fg",
        change === "changed" && "border-line-strong bg-surface text-ink",
        change === "canceled" && "border-warning-border bg-warning-bg text-warning-fg",
        className,
      )}
    >
      {CHANGE_LABEL[change]}
      <span className="sr-only"> since your last acknowledgment</span>
    </span>
  );
}

/**
 * Work-order stains: PAS as the yellow tag with work order, material and where the request came from
 * ("Source: Source order"); others as plain text chips. Canceled work stays visible, struck through; work
 * canceled or amended at source whose material may already exist carries a visible "Review" flag.
 */
export function StainList({
  stains,
  max = 2,
  detailed = true,
  compact = false,
  className,
}: {
  stains: StainEntry[];
  max?: number;
  detailed?: boolean;
  /** Table cells: work order and material only; where the request came from stays in the tooltip, panel and print. */
  compact?: boolean;
  className?: string;
}) {
  if (!stains.length) return <span className="text-ink-muted">None</span>;
  const shown = stains.slice(0, max);
  const more = stains.length - shown.length;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {shown.map((s, i) =>
        s.isPas && compact ? (
          // Table cells: PAS and its work order are one tag, always ("PAS (WO-2141)"); the material and "Canceled"
          // follow as text that may wrap under the tag, never between PAS and its work order.
          <span key={`${s.workOrder ?? "req"}-${i}`} className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" title={s.text}>
            <span className={cn(s.canceled && "[&_.hlo-pas-tag]:line-through [&_.hlo-pas-tag]:decoration-2")}>
              <PasTag workOrder={detailed ? s.workOrder ?? undefined : undefined} />
            </span>
            {detailed && s.workOrder ? <StainTarget target={s.target} /> : null}
            {!s.workOrder ? <span className="text-xs text-ink-muted">on order</span> : null}
            {s.canceled ? <span className="text-xs font-semibold text-ink-secondary">Canceled</span> : null}
            {s.needsReview ? <ReviewFlag /> : null}
          </span>
        ) : s.isPas ? (
          <span key={`${s.workOrder ?? "req"}-${i}`} className="inline-flex flex-wrap items-center gap-1" title={s.text}>
            <PasTag
              workOrder={detailed ? s.workOrder ?? undefined : undefined}
              target={detailed ? s.target.replace(" (block not yet assigned)", "") : undefined}
              source={detailed ? `Source: ${s.authorization}` : undefined}
              canceled={s.canceled}
            />
            {s.needsReview ? <ReviewFlag /> : null}
            {!s.workOrder ? <span className="text-xs text-ink-muted">on order, no work order yet</span> : null}
          </span>
        ) : (
          <span
            key={`${s.workOrder ?? "req"}-${i}`}
            title={s.text}
            className={cn(
              "hlo-chip inline-flex min-h-6 items-center gap-1 rounded-sm border border-line bg-surface-subtle px-1.5 text-xs text-ink",
              compact ? "flex-wrap py-0.5" : "h-6",
              s.canceled && "line-through",
            )}
          >
            {s.kind === "levels" ? `Levels ${s.stain}` : s.kind === "recut" ? `Recut ${s.stain}` : s.stain}
            {detailed && s.workOrder ? <span className="id-mono text-ink-secondary">({s.workOrder})</span> : null}
            {s.canceled ? <span className="font-semibold no-underline">Canceled</span> : null}
            {s.needsReview ? <ReviewFlag /> : null}
          </span>
        ),
      )}
      {more > 0 ? <span className="text-xs text-ink-muted">+{more} more</span> : null}
    </span>
  );
}

/** The material a work order is for: a block or slide id in the identifier mono ("A1-5"), a part in words ("Part A"). */
function StainTarget({ target }: { target: string }) {
  const text = target.replace(" (block not yet assigned)", "");
  return <span className={cn("whitespace-nowrap text-xs text-ink-secondary", /^Part\b/.test(text) ? "" : "id-mono")}>{text}</span>;
}

/**
 * Parts and their state, grouped so equal states read once. Holds stay in the hold color with the
 * word, never color alone. The letters never split; the state words may wrap in a narrow column.
 */
export function PartsCell({ row }: { row: Pick<WorklistRow, "parts" | "partsSummary"> }) {
  if (!row.parts.length) return <span>{row.partsSummary}</span>;
  const groups = groupParts(row.parts);
  return (
    <span title={row.partsSummary}>
      {groups.map((g, i) => (
        <Fragment key={i}>
          {i ? <span className="text-ink-muted"> · </span> : null}
          <span className={cn(g.hold && "font-medium text-hold-fg")}>
            <span className="whitespace-nowrap">{g.letters.join(", ")}</span> {g.word}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Visible flag for work canceled or amended at source whose material may already be printed or prepared. */
export function ReviewFlag() {
  return (
    <span className="inline-flex h-5 items-center rounded-sm border border-warning-border bg-warning-bg px-1 text-xs font-semibold text-warning-fg no-underline">
      Review<span className="sr-only"> needed: material may already be printed or prepared</span>
    </span>
  );
}

/** Explicit PAS sentence for panels and print: "PAS (WO-2213) · A1-2 · Source: Source order — ORD-77120 v1 · part A". */
export function StainText({ stain, className }: { stain: StainEntry; className?: string }) {
  return (
    <span className={cn("text-sm", stain.canceled && "text-ink-muted", className)}>
      <span className={cn(stain.canceled && "line-through")}>{stain.text}</span>
      {stain.canceled ? <span className="ml-1 font-semibold text-ink-secondary">Canceled</span> : null}
      {stain.needsReview ? <span className="ml-1 font-semibold text-warning-fg">Needs review: material may already be printed or prepared</span> : null}
    </span>
  );
}

/** A hold as the shared hatched chip with its scope ("Hold: Part B"); its id and reason in the tooltip. */
export function HoldChip({ hold }: { hold: Pick<HoldEntry, "displayId" | "scopeLabel" | "reasonText"> }) {
  return (
    <span title={`${hold.displayId}: ${hold.reasonText}`} className="inline-flex">
      <HoldPill scope={shortScope(hold.scopeLabel)} />
    </span>
  );
}

export function HoldList({ holds, max = 2, stacked = false }: { holds: HoldEntry[]; max?: number; /** Table cell: one chip per line. */ stacked?: boolean }) {
  if (!holds.length) return <span className="text-ink-muted">None</span>;
  const shown = holds.slice(0, max);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", stacked && "flex-col items-start")}>
      {shown.map((h) => (
        <HoldChip key={h.id} hold={h} />
      ))}
      {holds.length > max ? <span className="text-xs text-ink-muted">+{holds.length - max} more</span> : null}
    </span>
  );
}

/** "D26-04817 part B" → "Part B"; keeps other labels short for the table. */
export function shortScope(label: string): string {
  const m = label.match(/\bpart ([A-Z])\b/i);
  if (m) return `Part ${m[1].toUpperCase()}`;
  return label.length > 28 ? `${label.slice(0, 26)}…` : label;
}

/** Origin of the last confirmed update: Local (staff action here) or Source (simulated). */
export function UpdateOrigin({ origin }: { origin: WorklistRow["lastUpdate"]["origin"] }) {
  if (!origin) return <UnknownValue />;
  const simulated = origin !== "Local";
  const Icon = simulated ? Plug : UserRound;
  return (
    <span
      className={cn(
        "hlo-chip inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1 text-xs font-medium",
        // Honesty tags take a solid hairline; a dashed outline means "not yet real".
        simulated ? "border-sim-border bg-sim-bg text-sim-fg" : "border-line bg-surface-subtle text-ink-secondary",
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {origin}
    </span>
  );
}

/**
 * Blocks prepared / expected, with Unknown never shown as 0. `brief` (the dense grid): the word Unknown on screen,
 * its reason in the tooltip and for screen readers (the side panel, print and CSV say it in full).
 */
export function BlocksCell({ blocks, brief = false }: { blocks: WorklistRow["blocks"]; brief?: boolean }) {
  if (blocks.expected === null && blocks.expectedLowerBound === null && blocks.prepared === 0) {
    const reason = /^Unknown \((.+)\)$/.exec(blocks.text)?.[1] ?? "no gross record yet";
    return brief ? (
      <span title={`Unknown: ${reason}`} className="text-ink-muted">
        Unknown<span className="sr-only"> ({reason})</span>
      </span>
    ) : (
      <UnknownValue reason={reason} />
    );
  }
  if (brief && blocks.expected === null) {
    // "2 of at least 3 (some Unknown)" and "2 prepared, expected Unknown": the total is not known yet.
    return (
      <span title={blocks.text} className="num-tabular">
        <span aria-hidden>
          {blocks.prepared} of <span className="text-ink-muted">Unknown</span>
        </span>
        <span className="sr-only">{blocks.text}</span>
      </span>
    );
  }
  return <span className="num-tabular">{blocks.text}</span>;
}
