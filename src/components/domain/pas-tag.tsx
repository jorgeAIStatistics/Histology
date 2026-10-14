import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * PAS tag (spec §7): highlighter-yellow fill, dark border, flask icon and the
 * word "PAS". The detailed variant shows the originating work order and the
 * affected block or slide ("PAS (WO-2213) · A1-2") plus where the request came
 * from. PAS is never inferred from diagnosis text. A canceled PAS stays
 * visible, struck through, with the word "Canceled".
 */
export interface PasTagProps {
  /** Originating work order, e.g. "WO-2213". Shows the detailed variant. */
  workOrder?: string;
  /** Affected block or slide, e.g. "A1-2". */
  target?: string;
  /** Authorization source text, e.g. "Source order" or "Pathologist request". */
  source?: string;
  canceled?: boolean;
  className?: string;
}

export function PasTag({ workOrder, target, source, canceled, className }: PasTagProps) {
  const detailed = Boolean(workOrder || target);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap", className)}>
      <span
        className={cn(
          "hlo-pas-tag inline-flex h-6 items-center gap-1 rounded-sm border border-pas-border bg-pas-bg px-1.5 text-xs font-semibold text-pas-fg",
          canceled && "line-through decoration-2",
        )}
      >
        <FlaskConical className="size-3.5 shrink-0" aria-hidden />
        <span>PAS</span>
        {detailed ? (
          <span className="id-mono font-medium">
            {workOrder ? ` (${workOrder})` : ""}
            {target ? (
              <>
                <span aria-hidden> · </span>
                <span className="sr-only">, </span>
                {target}
              </>
            ) : null}
          </span>
        ) : null}
      </span>
      {canceled ? <span className="text-xs font-semibold text-ink-secondary">Canceled</span> : null}
      {source ? <span className="text-xs text-ink-muted">{source}</span> : null}
    </span>
  );
}
