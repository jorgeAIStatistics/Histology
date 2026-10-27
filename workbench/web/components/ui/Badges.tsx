import type { ReactNode } from "react";
import { cn } from "./cn";
import { LABEL_SHORT, LABEL_STATUS_TEXT, PROVENANCE_LONG, PROVENANCE_SHORT, REVIEW_STATE_LABEL } from "@/lib/format";
import type { LabelValue, Provenance, ReviewState } from "@/lib/types";

export function Chip({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-[var(--radius-chip)] border px-1.5 text-micro font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}

const provenanceStyle: Record<Provenance, string> = {
  demo_synthetic: "border-hema/40 bg-hema-tint text-hema",
  public_cc0: "border-slate/40 bg-slate-tint text-slate",
  public_licensed: "border-teal/40 bg-teal-tint text-teal",
  real_authorized: "border-rust/50 bg-rust-tint text-rust",
};

export function ProvenanceChip({ provenance, long = false }: { provenance: Provenance; long?: boolean }) {
  return (
    <Chip className={provenanceStyle[provenance]} title={PROVENANCE_LONG[provenance]}>
      {long ? PROVENANCE_LONG[provenance] : PROVENANCE_SHORT[provenance]}
    </Chip>
  );
}

const stateStyle: Record<ReviewState, string> = {
  imported: "border-line-strong bg-sheet text-graphite",
  pending_review: "border-amber/70 bg-amber-tint text-amber-ink",
  approved: "border-approved/40 bg-approved-tint text-approved",
  disputed: "border-berry/40 bg-berry-tint text-berry",
  excluded: "border-line-strong bg-excluded-tint text-graphite line-through decoration-graphite/60",
};

export function ReviewStateBadge({ state }: { state: ReviewState }) {
  return (
    <Chip className={stateStyle[state]} title={`Review state: ${REVIEW_STATE_LABEL[state]}`}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", state === "pending_review" ? "bg-amber" : state === "approved" ? "bg-approved" : state === "disputed" ? "bg-berry" : "bg-graphite/60")} />
      <span className={state === "excluded" ? "line-through" : undefined}>{REVIEW_STATE_LABEL[state]}</span>
    </Chip>
  );
}

export function LabelValueText({ value, className }: { value: LabelValue | null; className?: string }) {
  if (!value) return <span className={cn("text-graphite", className)}>none</span>;
  return (
    <span className={cn("font-semibold", value === "bcc_present" ? "text-ink" : "text-ink", className)} title={value === "bcc_absent_not_benign" ? "BCC absent may include other malignancy, inflammation or mimics. It is NOT the same as benign." : undefined}>
      {LABEL_SHORT[value]}
    </span>
  );
}

export function LabelStatus({ status }: { status: string }) {
  const tone =
    status === "disputed"
      ? "text-berry"
      : status === "unlabeled"
        ? "text-amber-ink"
        : status === "adjudicated" || status === "agreed"
          ? "text-approved"
          : "text-graphite";
  return <span className={cn("text-small font-semibold", tone)}>{LABEL_STATUS_TEXT[status] ?? status}</span>;
}

export function SyntheticBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-[var(--radius-chip)] border border-hema/50 bg-hema-tint px-2 py-0.5 text-small font-bold text-hema", className)}>
      SYNTHETIC — NO HISTOLOGY
    </span>
  );
}

export function PipelineTestBanner({ text, className }: { text?: string | null; className?: string }) {
  return (
    <div role="note" className={cn("flex items-center gap-3 rounded-[var(--radius-panel)] border-2 border-hema bg-hema-tint px-4 py-3 text-hema", className)} data-testid="pipeline-test-banner">
      <span aria-hidden className="hatch-synthetic h-8 w-8 shrink-0 rounded border border-hema/50" />
      <div>
        <p className="text-lead font-bold tracking-tight">PIPELINE TEST — NOT PATHOLOGY VALIDATION</p>
        <p className="text-small">{text && text !== "PIPELINE TEST — NOT PATHOLOGY VALIDATION" ? text : "Synthetic embeddings carry no pathology information. These numbers verify the machinery, nothing about tissue."}</p>
      </div>
    </div>
  );
}
