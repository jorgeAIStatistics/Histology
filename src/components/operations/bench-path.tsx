import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtSmart } from "@/lib/time";
import { plural } from "@/components/worklist/format";
import { UnknownValue } from "@/components/domain/honesty";
import type { PathStage } from "@/server/queries/operations";
import { IdText } from "@/components/domain/id-text";
import { HoldPill } from "@/components/domain/hold";

/**
 * The bench path, intake to sent on tray, as one sheet: how many orders or parts
 * sit at each stage, the longest wait there and the record that shows it, and
 * the holds hatched where they sit. Each count opens its records. Zeros
 * recede; delivered is quiet. Same rail vocabulary as the Intake step path
 * (2px top rule per step, one weight: the hatched chip carries the hold).
 * Each stage is a four-row subgrid (label, count, longest wait, hold), so the
 * rows line up across the path whatever wraps in one stage. Labels sit on
 * their rule; where a long name must wrap (200% zoom), the counts still share one line.
 */
export function BenchPath({ stages, definition, now }: { stages: PathStage[]; definition: string; now: string }) {
  return (
    <section aria-labelledby="path-title" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-3 max-xl:px-4">
        <h2 id="path-title" className="text-md font-bold tracking-[-0.01em] text-ink">
          Bench path
        </h2>
        <p className="text-sm text-ink-muted">
          At {fmtSmart(now, now)} ET. {definition}
        </p>
      </div>
      {/* Eleven stages in one line from 1280px; below that the path wraps into two lines (six, then five) so no identifier is squeezed or split.
          Tracks size to their content first (a long stage name keeps its line instead of pushing every other label down), then share the rest equally. */}
      <ol className="grid grid-cols-[repeat(6,auto)] gap-x-1 px-4 pt-2.5 pb-2 max-xl:px-3 max-xl:pb-0.5 xl:grid-cols-[repeat(11,auto)]">
        {stages.map((s) => (
          <PathCell key={s.key} stage={s} />
        ))}
      </ol>
    </section>
  );
}

function stageSummary(s: PathStage): string {
  const unit = s.unit === "order" ? "order" : "part";
  if (s.count === 0) return `${s.label}: none`;
  const parts = [`${s.label}: ${plural(s.count, unit)}`];
  if (s.held) parts.push(`${s.held} on hold (${s.holdIds.join(", ")})`);
  if (s.unknownAge) parts.push(`${s.unknownAge} with Unknown age`);
  return parts.join("; ");
}

function PathCell({ stage: s }: { stage: PathStage }) {
  const empty = s.count === 0;
  const done = s.key === "delivered";
  const unit = s.unit === "order" ? (s.count === 1 ? "order" : "orders") : s.count === 1 ? "part" : "parts";
  return (
    <li className={cn("row-span-4 grid min-w-0 grid-rows-subgrid gap-y-0 border-t-2 pb-1.5 max-xl:pb-3", empty || done ? "border-line" : "border-line-strong")}>
      {empty ? (
        <div className="row-span-2 grid grid-rows-subgrid px-1 pt-1.5">
          <span className="self-start hyphens-auto text-sm leading-5 text-ink-muted [overflow-wrap:anywhere]">{s.label}</span>
          <span className="text-sm leading-6 text-ink-muted">None</span>
        </div>
      ) : (
        <Link
          href={s.href}
          aria-label={`${stageSummary(s)}. Open these ${s.unit === "order" ? "orders on the intake bench" : "parts on the worklist"}.`}
          className="group row-span-2 grid min-h-[var(--hlo-target-min)] grid-rows-subgrid rounded-sm px-1 pt-1.5 transition-colors duration-[var(--hlo-duration-fast)] hover:bg-surface-subtle"
        >
          <span className={cn("self-start hyphens-auto text-sm leading-5 [overflow-wrap:anywhere]", done ? "text-ink-muted" : "font-medium text-ink-secondary")}>{s.label}</span>
          <span className="flex items-baseline gap-1 pb-0.5">
            {done ? <Check className="size-3.5 shrink-0 self-center text-ink-muted" aria-hidden /> : null}
            <span className={cn("num-tabular font-semibold group-hover:underline underline-offset-2", done ? "text-base leading-6 text-ink-secondary" : "text-lg leading-6 text-brand-ink")}>{s.count}</span>
            <span className="text-xs text-ink-muted">{unit}</span>
          </span>
        </Link>
      )}
      {done ? <span className="row-start-3 px-1 text-xs leading-4 text-ink-muted">Today&apos;s worklist</span> : !empty ? <OldestWait stage={s} /> : null}
      {s.held ? (
        <Link
          href="/operations?category=holds#blocked"
          aria-label={`${plural(s.held, s.unit)} on hold at ${s.label}: ${s.holdIds.join(", ")}. Show the holds.`}
          className="group/hold row-start-4 mx-1 mt-1 self-start justify-self-start rounded-sm"
        >
          <HoldPill scope={plural(s.held, s.unit)} className="group-hover/hold:border-hold-solid" />
        </Link>
      ) : null}
    </li>
  );
}

/** The longest wait at a stage and the record that shows it (a link to that record), so equal ages can be checked. */
function OldestWait({ stage: s }: { stage: PathStage }) {
  if (!s.oldestAge)
    return s.unknownAge ? (
      <span className="row-start-3 px-1 text-xs leading-4 text-ink-muted">
        Longest wait <UnknownValue reason="no event recorded" />
      </span>
    ) : null;
  const text = (
    <>
      <span className="text-ink-muted">Longest wait</span>
      <span className="num-tabular whitespace-nowrap text-ink-secondary">{s.oldestAge}</span>
    </>
  );
  if (!s.oldestRef || !s.oldestHref) return <span className="row-start-3 flex flex-col px-1 text-xs leading-4">{text}</span>;
  return (
    <Link
      href={s.oldestHref}
      className="group/old row-start-3 flex min-h-[var(--hlo-target-min)] flex-col justify-start self-start rounded-sm px-1 py-1 text-xs leading-4 transition-colors duration-[var(--hlo-duration-fast)] hover:bg-surface-subtle"
    >
      {text}
      <span className="text-brand underline-offset-2 group-hover/old:underline">
        <RefText text={s.oldestRef} />
      </span>
      <span className="sr-only">, the longest wait at {s.label}</span>
    </Link>
  );
}

/** "D26-04798 part B": the id never splits and "part B" stays together; the line may break only between them. */
function RefText({ text }: { text: string }) {
  const m = /^(\S+) (part [A-Z])$/.exec(text);
  if (!m) return <IdText text={text} />;
  return (
    <>
      <IdText text={m[1]} /> <span className="whitespace-nowrap">{m[2]}</span>
    </>
  );
}
