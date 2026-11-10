import { PenLine } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Synthetic bottle label card. It renders the TYPED OBSERVATION of a bottle
 * label in a label-like layout so staff can compare it at a glance. It is not
 * a photograph and not evidence of what tissue is inside the container.
 */
export function BottleLabel({
  observed,
  handwritten,
  seq,
  className,
}: {
  observed: Record<string, string | null>;
  handwritten?: boolean;
  seq: number;
  className?: string;
}) {
  const line = (label: string, value: string | null, mono = false) => (
    <div className="flex items-baseline gap-1.5">
      <span className="w-11 shrink-0 text-xs text-ink-muted">{label}</span>
      {value ? (
        <span className={cn("min-w-0 break-words text-ink", mono && "id-mono", handwritten && "italic")}>{value}</span>
      ) : (
        <span className="text-xs text-ink-muted">Not on label</span>
      )}
    </div>
  );
  const alt = [
    `Synthetic label card for container ${seq}`,
    observed.patient_name ? `name ${observed.patient_name}` : "no name",
    observed.birth_date ? `birth date ${observed.birth_date}` : null,
    observed.part_designation ? `part ${observed.part_designation}` : null,
    observed.site_text ? `site ${observed.site_text}` : null,
    observed.procedure ? `procedure ${observed.procedure}` : null,
    handwritten ? "handwritten" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <figure className={cn("w-full max-w-[220px]", className)}>
      <div role="img" aria-label={alt} className="overflow-hidden rounded-lg border border-line-strong bg-surface shadow-1">
        {/* Cap band: purely decorative */}
        <div aria-hidden className="flex h-5 items-center justify-between bg-surface-sunken px-2 text-xs font-medium text-ink-muted">
          <span>Formalin</span>
          <span>Synthetic card</span>
        </div>
        <div className="space-y-0.5 border-t border-line-strong px-2 py-2 text-sm">
          {line("Name", observed.patient_name)}
          {line("DOB", observed.birth_date, true)}
          {observed.mrn ? line("MRN", observed.mrn, true) : null}
          <div className="flex items-baseline gap-1.5">
            <span className="w-11 shrink-0 text-xs text-ink-muted">Part</span>
            {observed.part_designation ? (
              <span className={cn("rounded-sm border border-line-strong px-1 font-semibold text-ink", handwritten && "italic")}>{observed.part_designation}</span>
            ) : (
              <span className="text-xs text-ink-muted">Not on label</span>
            )}
          </div>
          {line("Site", observed.site_text)}
          {observed.laterality ? line("Side", observed.laterality) : null}
          {line("Method", observed.procedure)}
          {observed.collection_date ? line("Collected", observed.collection_date, true) : null}
        </div>
      </div>
      <figcaption className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
        {handwritten ? (
          <span className="inline-flex items-center gap-1 text-ink-secondary">
            <PenLine className="size-3.5" aria-hidden />
            Handwritten label
          </span>
        ) : null}
        <span>Synthetic label card from the typed observation. Not a photo.</span>
      </figcaption>
    </figure>
  );
}
