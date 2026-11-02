import type { ReactNode } from "react";
import { CircleCheck, Clock, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatusPill } from "@/components/ui/status-pill";
import type { Tone } from "@/components/ui/tone";
import { IdText } from "@/components/domain/id-text";
import { IdentityMark } from "@/components/domain/identity-mark";
import { RetryEventButton } from "@/components/settings/retry-button";
import { GROUP_TITLE, type ActionGroup, type ScreenRow } from "./data";
import { LabTime, RawMessage, RowText, TimePair, WorkLinks } from "./parts";

/** One pill per row, on the severity ladder: red only for patient identity, amber when sources disagree or a message failed. */
function rowPill(r: ScreenRow): { tone: Tone; text: string; icon?: LucideIcon } {
  if (r.kind === "source_status") return { tone: "warning", text: r.what === "Slow link" ? "Slow link" : "Unavailable", icon: Clock };
  switch (r.status) {
    case "review_open":
      return r.identity ? { tone: "danger", text: "Patient identity: review open" } : { tone: "warning", text: "Review open" };
    case "attention":
      return r.identity ? { tone: "danger", text: "Patient identity: needs a person" } : { tone: "warning", text: "Needs a person" };
    case "waiting":
      return { tone: "neutral", text: "Waiting on the source", icon: Clock };
    case "failed":
      return { tone: "warning", text: r.failure?.kind === "invalid_data" ? "Rejected" : "Failed, retryable" };
    case "ignored":
      return { tone: "neutral", text: "Ignored, not applied" };
    case "review_closed":
      return { tone: "success", text: "Reviewed", icon: CircleCheck };
    default:
      return { tone: "success", text: "In agreement", icon: CircleCheck };
  }
}

const GROUP_ANCHOR: Record<ActionGroup, string> = { review: "needs-review", waiting: "waiting-on-source", failed: "failed", info: "informational" };
export const groupAnchor = (g: ActionGroup) => GROUP_ANCHOR[g];

const GROUP_HELP: Record<ActionGroup, string> = {
  review: "A person decides. What is on file stays in effect until then; a message never changes it.",
  waiting: "Nothing to do here but wait for the source. Nothing was applied from these.",
  failed: "Received but not applied. Each keeps its message and reason until it is retried, or the source re-sends it corrected.",
  info: "No action needed. Kept so you can see what arrived and what was ignored.",
};

const GROUP_EMPTY: Record<ActionGroup, string> = {
  review: "Nothing needs review: every difference the sources sent has been decided, or there is none.",
  waiting: "Nothing is waiting on a source.",
  failed: "No message is waiting in the failure queue.",
  info: "Nothing to note.",
};

/** One comparison: the source's assertion, what is recorded here, and the difference side by side. */
export function ReconRowView({ row, now, canRetry }: { row: ScreenRow; now: string; canRetry: boolean }) {
  const pill = rowPill(row);
  const headingId = `row-${row.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const isSource = row.kind === "source_status";
  return (
    <article aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 id={headingId} className="flex flex-wrap items-center gap-x-1.5 text-base font-semibold text-ink">
            {row.identity ? <IdentityMark className="size-4" /> : null}
            <span>{row.what}:</span>
            <span className="min-w-0">
              <IdText text={row.subject} />
            </span>
          </h3>
          <p className="text-sm text-ink-muted">
            {row.sourceName ? `${row.sourceName} (simulated source)` : "Recorded here"}
            {row.messageId ? (
              <>
                {" · message "}
                <span className="id-mono text-ink-secondary">{row.messageId}</span>
              </>
            ) : null}
          </p>
        </div>
        <StatusPill tone={pill.tone} icon={pill.icon}>
          {pill.text}
        </StatusPill>
      </div>

      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 lg:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-sm font-medium text-ink-secondary">{isSource ? "Source" : "The source says"}</dt>
          <dd className="text-sm text-ink">
            <RowText text={row.externalAssertion} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-sm font-medium text-ink-secondary">Recorded here</dt>
          <dd className="text-sm text-ink">
            <RowText text={row.localState} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-sm font-medium text-ink-secondary">Difference</dt>
          <dd className={cn("text-sm", row.difference ? (row.identity ? "text-danger-fg" : row.status === "ignored" || row.status === "review_closed" ? "text-ink" : "text-warning-fg") : "text-ink-secondary")}>
            {row.difference ? <RowText text={row.difference} /> : "None: they agree."}
          </dd>
        </div>
      </dl>

      {isSource ? (
        <dl className="flex flex-wrap gap-x-5 text-sm">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-muted">Last successful sync</dt>
            <dd className="text-ink">{row.localReceivedTime ? <LabTime iso={row.localReceivedTime} now={now} /> : "Unknown"}</dd>
          </div>
        </dl>
      ) : (
        <TimePair sourceTime={row.sourceEventTime} receivedTime={row.localReceivedTime} now={now} />
      )}

      <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-secondary">Work it touches</p>
          <WorkLinks links={row.work} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-secondary">{row.review.required ? "A person must review" : "Review"}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
            <dt className="text-ink-muted">Who</dt>
            <dd className="text-ink">{row.review.owner}</dd>
            {row.review.record ? (
              <>
                <dt className="text-ink-muted">Record</dt>
                <dd className="text-ink">
                  <RowText text={row.review.record} />
                </dd>
              </>
            ) : null}
            {row.review.action ? (
              <>
                <dt className="text-ink-muted">Next</dt>
                <dd className="text-ink-secondary">{row.review.action}</dd>
              </>
            ) : null}
          </dl>
          {row.retryEventId && row.messageId ? (
            <div className="mt-1.5">
              <RetryEventButton eventId={row.retryEventId} messageId={row.messageId} canRetry={canRetry} />
            </div>
          ) : null}
        </div>
      </div>

      {row.raw && row.messageId ? <RawMessage raw={row.raw} messageId={row.messageId} /> : null}
    </article>
  );
}

/** A group of rows that share what the operator must do. */
export function GroupSection({ group, rows, now, canRetry, children }: { group: ActionGroup; rows: ScreenRow[]; now: string; canRetry: boolean; children?: ReactNode }) {
  const id = groupAnchor(group);
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 min-w-0 rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-4 py-2.5">
        <h2 id={`${id}-title`} className="text-md font-bold tracking-[-0.01em] text-ink">
          {GROUP_TITLE[group]} <span className="num-tabular font-semibold text-ink-secondary">({rows.length})</span>
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">{GROUP_HELP[group]}</p>
      </header>
      {rows.length ? (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.key} className="border-b border-line last:border-b-0">
              <ReconRowView row={r} now={now} canRetry={canRetry} />
            </li>
          ))}
        </ul>
      ) : group !== "info" ? (
        <p className="px-4 py-3 text-sm text-ink-secondary">{GROUP_EMPTY[group]}</p>
      ) : null}
      {children}
    </section>
  );
}
