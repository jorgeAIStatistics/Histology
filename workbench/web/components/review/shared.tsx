"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { LabelValue } from "@/lib/types";

export const LABEL_ORDER: LabelValue[] = ["bcc_present", "bcc_absent_not_benign", "indeterminate", "inadequate", "out_of_scope"];

export const LABEL_HELP: Record<LabelValue, string> = {
  bcc_present: "Basal cell carcinoma is present in the material at this scope.",
  bcc_absent_not_benign: "No BCC. This is NOT benign: other malignancy, inflammation or mimics may be present.",
  indeterminate: "Cannot decide with the material available.",
  inadequate: "Material is not adequate for assessment.",
  out_of_scope: "Outside the defined research task.",
};

export const LABEL_DISPLAY_FULL: Record<LabelValue, string> = {
  bcc_present: "BCC present",
  bcc_absent_not_benign: "BCC absent (may include other malignancy, inflammation or mimics)",
  indeterminate: "Indeterminate",
  inadequate: "Inadequate for assessment",
  out_of_scope: "Out of scope for this research task",
};

export function PanelSection({ title, aside, children, className, testId }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn("border-b border-line px-4 py-4 last:border-b-0", className)} data-testid={testId}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-small font-bold text-ink">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Disclosure({ summary, children, defaultOpen = false, testId }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-small font-semibold text-teal-deep hover:underline" data-testid={testId}>
        <ChevronDown size={14} aria-hidden className={cn("transition-transform", open ? "rotate-0" : "-rotate-90")} />
        {summary}
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

/** Radio group of label values, each with its plain-language display text. */
export function LabelChoice({ name, value, onChange, compact = false }: { name: string; value: LabelValue | null; onChange: (v: LabelValue) => void; compact?: boolean }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="sr-only">Label value</legend>
      {LABEL_ORDER.map((v) => (
        <label
          key={v}
          className={cn(
            "flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border px-2.5 py-2",
            value === v ? "border-teal bg-teal-tint/60" : "border-line bg-sheet hover:border-line-strong",
          )}
        >
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="mt-1 accent-[var(--color-teal)]" data-testid={`${name}-${v}`} />
          <span>
            <span className="block text-small font-semibold text-ink">{LABEL_DISPLAY_FULL[v]}</span>
            {!compact || v === "bcc_absent_not_benign" ? <span className="block text-micro text-graphite">{LABEL_HELP[v]}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export const REASON_REQUIRED = new Set([
  "pending_review>disputed",
  "approved>disputed",
  "imported>excluded",
  "pending_review>excluded",
  "disputed>excluded",
  "approved>excluded",
  "approved>pending_review",
  "excluded>pending_review",
  "disputed>pending_review",
]);
