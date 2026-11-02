import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtFull, fmtSmart } from "@/lib/time";
import { UnknownValue } from "@/components/domain/honesty";
import { IdText } from "@/components/domain/id-text";
import type { WorkLink } from "./data";

/**
 * Small shared pieces of the /integration screen. Server components (no state).
 */

const DATE_RE = /(\b\d{4}-\d{2}-\d{2}\b)/g;

/** Running text with identifiers in the identifier mono (IdText) and dates (1956-03-09) never split across lines. */
export function RowText({ text }: { text: string }) {
  const parts = text.split(DATE_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          <IdText key={i} text={part} />
        ),
      )}
    </>
  );
}

/** "Source says sent 10:31 AM ET" and "Received here 11:00 AM ET": two times, always labelled apart. */
export function TimePair({
  sourceTime,
  receivedTime,
  now,
  receivedLabel = "Received here",
  deliveries,
  lastReceivedTime,
}: {
  sourceTime: string | null;
  receivedTime: string | null;
  now: string;
  receivedLabel?: string;
  /** More than one delivery of the same message: say how many, and when the last one came. */
  deliveries?: number;
  lastReceivedTime?: string | null;
}) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-0.5 text-sm">
      <div className="flex items-baseline gap-1.5">
        <dt className="text-ink-muted">Source says sent</dt>
        <dd className="text-ink">{sourceTime ? <LabTime iso={sourceTime} now={now} /> : <UnknownValue reason="the source gave no event time for this" />}</dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="text-ink-muted">{receivedLabel}</dt>
        <dd className="text-ink">{receivedTime ? <LabTime iso={receivedTime} now={now} /> : <UnknownValue reason="not recorded" />}</dd>
      </div>
      {deliveries && deliveries > 1 ? (
        <div className="flex items-baseline gap-1.5">
          <dt className="text-ink-muted">Delivered</dt>
          <dd className="text-ink">
            {deliveries} times, applied once
            {lastReceivedTime && lastReceivedTime !== receivedTime ? (
              <>
                {" "}
                (last <LabTime iso={lastReceivedTime} now={now} />)
              </>
            ) : null}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** A lab-clock time ("10:31 AM ET"), the full date and UTC in the tooltip, machine-readable in <time>. */
export function LabTime({ iso, now }: { iso: string; now: string }) {
  return (
    <time dateTime={iso} title={`${fmtFull(iso)} · UTC ${iso}`} className="num-tabular whitespace-nowrap">
      {fmtSmart(iso, now)} ET
    </time>
  );
}

/** Links to the work a row touches: Intake, Case or Clarify (holds and pre-accession order parts as plain text). */
export function WorkLinks({ links, className }: { links: WorkLink[]; className?: string }) {
  // A pre-accession order part with no screen of its own adds nothing when the intake item that holds it is listed.
  const shown = links.some((l) => l.href) ? links.filter((l) => l.href || l.screen === "Hold") : links;
  if (!shown.length) return <span className={cn("text-sm text-ink-secondary", className)}>None recorded</span>;
  return (
    <ul className={cn("flex flex-wrap gap-x-3 gap-y-1", className)}>
      {shown.map((l) => (
        <li key={`${l.screen}:${l.label}`} className="text-sm">
          {l.href ? (
            <Link
              href={l.href}
              className="inline-flex min-h-[var(--hlo-target-min)] items-center gap-1 font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
            >
              <span>{l.screen}</span>{" "}
              <span>
                <IdText text={l.label} />
              </span>
              <ArrowRight className="size-3.5 shrink-0" aria-hidden />
            </Link>
          ) : (
            <span className="inline-flex min-h-[var(--hlo-target-min)] items-center gap-1 text-ink">
              <span className="text-ink-muted">{l.screen}</span>{" "}
              <span>
                <IdText text={l.label} />
              </span>
            </span>
          )}
          {l.status ? <span className="text-ink-muted"> ({l.status})</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The stored message, verbatim, behind a disclosure. It is DATA: rendered as text (React escapes it), never
 * interpreted or linked. The block scrolls inside itself so a long line never widens the page.
 */
export function RawMessage({ raw, messageId }: { raw: string; messageId: string }) {
  return (
    <details className="group mt-1">
      <summary className="inline-flex min-h-[var(--hlo-target-min)] cursor-pointer items-center gap-1 rounded-sm text-sm font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand">
        Message as received (raw data)
      </summary>
      <p className="mt-1 text-xs text-ink-muted">
        Stored exactly as the simulated source sent it; shown as data only. Message <span className="id-mono">{messageId}</span>.
      </p>
      <pre
        tabIndex={0}
        aria-label={`Raw message ${messageId}`}
        className="mt-1 max-h-72 max-w-full overflow-auto rounded-sm border border-line bg-surface-subtle p-2 font-mono text-xs leading-5 whitespace-pre text-ink"
      >
        {raw}
      </pre>
    </details>
  );
}
