import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { IdText } from "@/components/domain/id-text";
import type { MessageView } from "./data";
import { RawMessage, TimePair } from "./parts";

const linkClass = "inline-flex min-h-[var(--hlo-target-min)] items-center font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand";

/**
 * Recent messages, one line per message id however often it was delivered (a duplicate shows once, with its
 * delivery count). Failed and late (older-version) messages are listed in their own groups above, not here.
 */
export function RecentMessages({
  messages,
  total,
  now,
  showAllHref,
}: {
  messages: MessageView[];
  total: number;
  now: string;
  /** Link to every message (null when every one is shown). */
  showAllHref: string | null;
}) {
  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-3">
        <h3 id="recent-messages-title" className="text-base font-semibold text-ink">
          Recent messages
        </h3>
        <p className="text-sm text-ink-muted">
          {messages.length === total ? `All ${total}` : `Latest ${messages.length} of ${total}`}, newest first; one line per message.
        </p>
      </div>
      {messages.length ? (
        <ul aria-labelledby="recent-messages-title" className="mt-1 flex flex-col">
          {messages.map((m) => (
            <li key={m.eventId} className="flex min-w-0 flex-col gap-1 border-t border-line px-4 py-2.5 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <p className="min-w-0 text-sm text-ink">
                  <span className="font-semibold">{m.what}</span> <IdText text={m.subject} />
                  <span className="text-ink-muted"> · {m.sourceName} (simulated)</span>
                </p>
                <StatusPill tone={m.outcome === "applied" ? "success" : "neutral"} icon={CircleCheck} size="sm">
                  {m.outcomeWords}
                </StatusPill>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-0.5">
                <p className="text-sm text-ink-muted">
                  Message <span className="id-mono text-ink-secondary">{m.messageId}</span>
                  {m.seeded ? " (before this demo session: synthetic seed)" : ""}
                </p>
                <TimePair sourceTime={m.sourceEventTime} receivedTime={m.firstReceivedAt} now={now} deliveries={m.deliveries} lastReceivedTime={m.lastReceivedAt} />
              </div>
              {m.detail ? (
                <p className="text-sm text-ink-secondary">
                  <IdText text={m.detail} />
                </p>
              ) : null}
              {m.raw ? <RawMessage raw={m.raw} messageId={m.messageId} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-sm text-ink-secondary">No message has been received yet.</p>
      )}
      <p className="flex flex-wrap gap-x-4 border-t border-line px-4 py-1 text-sm">
        {showAllHref ? (
          <Link href={showAllHref} className={linkClass}>
            Show all {total} messages
          </Link>
        ) : null}
        <Link href="/settings?tab=integration" className={linkClass}>
          Every delivery, with totals: Settings, integration
        </Link>
      </p>
    </div>
  );
}
