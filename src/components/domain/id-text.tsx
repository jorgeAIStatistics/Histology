import { Fragment } from "react";
import { cn } from "@/lib/cn";

/**
 * Identifier pattern used across the demo: INT-1014-032, D26-04817, ORD-77121,
 * CLR-0457, H-0090, REL-0112, TRY-M-03, RR-0192, PJ-8841, WO-2147, CR-1014-11.
 */
// A storage path (CAB-2/DR-4/BX-11/S-14) is one identifier; source-system names (EMA-SIM) are words, not ids.
const ID_RE = /\b([A-Z]{1,4}-[A-Z0-9]+(?:\/[A-Z]{1,4}-[A-Z0-9]+)+|[A-Z][A-Z0-9]{0,4}(?:-[A-Z0-9]+)+)\b/g;
const isSystemName = (s: string) => /-SIM$/.test(s);

/**
 * Running text with its identifiers set in the identifier mono and never
 * split across lines (a break after "TRY-M-" or "D26-" misleads at the bench).
 */
export function IdText({ text, idClassName }: { text: string; idClassName?: string }) {
  const parts = text.split(ID_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          isSystemName(part) ? (
            <span key={i} className="whitespace-nowrap">
              {part}
            </span>
          ) : (
            <span key={i} className={cn("id-mono", idClassName)}>
              {part}
            </span>
          )
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
