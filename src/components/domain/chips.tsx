import Link from "next/link";
import type { ReactNode } from "react";
import { CircleDashed, Hash, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Identifier chips (spec §2 shape language, §7). Identifiers are square-
 * cornered boxes in monospace and are never truncated or wrapped. Each chip
 * includes its type in the accessible name ("Accession D26-04817 ...").
 */

function MaybeLink({ href, className, children, label }: { href?: string | false; className: string; children: ReactNode; label?: string }) {
  if (href) {
    return (
      <Link href={href} className={cn(className, "hover:underline hover:underline-offset-2")} title={label}>
        {children}
      </Link>
    );
  }
  return <span className={className}>{children}</span>;
}

export interface AccessionChipProps {
  /** Official accession number, e.g. "D26-04817". */
  accession: string;
  /** Numbering namespace, e.g. "EMA-SIM DERM". */
  namespace?: string;
  /** Compact rows: caption hidden (still read by screen readers). */
  compact?: boolean;
  /** Link target; default /cases/<accession>. Pass false for no link. */
  href?: string | false;
  className?: string;
}

/** Official accession: solid brand border, brand-50 fill, # icon, mono 600, namespace caption. */
export function AccessionChip({ accession, namespace = "EMA-SIM DERM", compact, href, className }: AccessionChipProps) {
  const target = href === undefined ? `/cases/${encodeURIComponent(accession)}` : href;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", className)}>
      <MaybeLink
        href={target}
        label={`Accession ${accession}, namespace ${namespace}`}
        className="hlo-chip inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-brand bg-brand-50 px-1.5 text-brand-ink"
      >
        <Hash className="size-3.5 shrink-0" aria-hidden />
        <span className="sr-only">Accession </span>
        <span className="id-mono text-sm font-semibold">{accession}</span>
        {compact ? <span className="sr-only">, namespace {namespace}</span> : null}
      </MaybeLink>
      {compact ? null : (
        <span className="whitespace-nowrap text-xs text-ink-muted">
          <span aria-hidden>Accession, </span>
          <span className="sr-only">namespace </span>
          {namespace}
        </span>
      )}
    </span>
  );
}

export interface ProvisionalChipProps {
  /** Provisional intake id, e.g. "INT-1014-031". */
  id: string;
  compact?: boolean;
  /** Link target; default /intake?item=<id>. Pass false for no link. */
  href?: string | false;
  className?: string;
}

/**
 * Provisional intake item: DASHED muted border, white fill, dashed-circle
 * icon, mono 500, and the word "Provisional" always visible (also in compact
 * rows). Never uses the brand fill.
 */
export function ProvisionalChip({ id, compact, href, className }: ProvisionalChipProps) {
  const target = href === undefined ? `/intake?item=${encodeURIComponent(id)}` : href;
  return (
    <MaybeLink
      href={target}
      label={`Provisional intake item ${id}, not an accession number`}
      className={cn(
        "hlo-chip inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border-[1.5px] border-dashed border-ink-muted bg-surface px-1.5 text-ink-secondary",
        className,
      )}
    >
      <CircleDashed className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">Provisional intake item </span>
      <span className="id-mono text-sm font-medium">{id}</span>
      <span className="font-sans text-xs font-medium text-ink-muted" data-compact={compact || undefined}>
        <span className="sr-only">, </span>Provisional<span className="sr-only">, not an accession number</span>
      </span>
    </MaybeLink>
  );
}

export type IdKind = "CLR" | "WO" | "PJ" | "TRY" | "RR" | "ORD" | "MRN" | "INT" | "HOLD" | "PART" | "BLOCK" | "SLIDE" | "TASK" | "OTHER";

export const ID_KIND_LABEL: Record<IdKind, string> = {
  CLR: "Clarification",
  WO: "Work order",
  PJ: "Print job",
  TRY: "Tray",
  RR: "Retrieval request",
  ORD: "Order",
  MRN: "MRN",
  INT: "Intake item",
  HOLD: "Hold",
  PART: "Part",
  BLOCK: "Block",
  SLIDE: "Slide",
  TASK: "Task",
  OTHER: "ID",
};

export interface IdChipProps {
  /** The identifier exactly as issued, e.g. "CLR-0457", "HPD-448210", "D26-04817 A1-2 PAS". */
  id: string;
  kind: IdKind;
  /** Source tenant (MRN and ORD chips always carry it), e.g. "EMA-SIM Sunrise Coast". */
  tenant?: string;
  href?: string;
  /** Show the type word before the id (always on for MRN). */
  showKind?: boolean;
  className?: string;
}

/** Other identifiers: subtle fill, no border, mono. MRN/ORD carry the tenant; chips link to the record. */
export function IdChip({ id, kind, tenant, href, showKind, className }: IdChipProps) {
  const kindLabel = ID_KIND_LABEL[kind];
  const visibleKind = showKind || kind === "MRN";
  return (
    <MaybeLink
      href={href}
      label={`${kindLabel} ${id}${tenant ? `, ${tenant}` : ""}`}
      className={cn("hlo-chip inline-flex h-6 shrink-0 items-center gap-1 rounded-sm bg-surface-subtle px-1.5 text-ink", href && "text-brand-ink", className)}
    >
      {visibleKind ? <span className="text-xs font-medium text-ink-muted">{kindLabel}</span> : <span className="sr-only">{kindLabel} </span>}
      <span className="id-mono text-sm font-medium">{id}</span>
      {tenant ? (
        <span className="whitespace-nowrap text-xs text-ink-muted">
          <span aria-hidden>· </span>
          <span className="sr-only">, </span>
          {tenant}
        </span>
      ) : null}
    </MaybeLink>
  );
}

export interface PartChipProps {
  /** Part letter, e.g. "B". */
  part: string;
  /** "dorsal forearm, punch". */
  description?: string;
  /** Visible warning, e.g. "Order says Right, bottle says Left." (no auto-correction). */
  warning?: string;
  className?: string;
}

/** Part chip used in the identity bar: "Part B: dorsal forearm, punch", with an optional laterality warning. */
export function PartChip({ part, description, warning, className }: PartChipProps) {
  return (
    <span
      className={cn(
        "hlo-chip inline-flex min-h-6 max-w-full items-center gap-1 rounded-sm border px-1.5 text-sm",
        warning ? "border-warning-border bg-warning-bg text-ink" : "border-line-strong bg-surface text-ink",
        className,
      )}
    >
      {warning ? <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden /> : null}
      <span className="min-w-0">
        <span className="whitespace-nowrap font-semibold">Part {part}</span>
        {description ? <span className="text-ink-secondary">: {description}</span> : null}
        {warning ? <span className="text-warning-fg">. {warning}</span> : null}
      </span>
    </span>
  );
}
