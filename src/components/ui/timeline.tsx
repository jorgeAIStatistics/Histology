"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDownUp, Bot, ChevronRight, Clock, MessageSquareReply, Plug, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/roles";
import { fmtFull, fmtSmart } from "@/lib/time";

/**
 * Timeline / audit list (spec §7): <ol> of events with <time datetime> (UTC),
 * actor and role, summary, object chip, source tag and expandable details
 * (original and new values). Newest first by default, with a toggle.
 */
export type TimelineSource = "local" | "source" | "demo" | "office" | "assistant" | "system";

export const TIMELINE_SOURCE_LABEL: Record<TimelineSource, string> = {
  local: "Local",
  source: "Source (simulated)",
  demo: "Demo",
  office: "Simulated office reply",
  assistant: "Assistant",
  system: "Local (system)",
};

/** Map an audit_event.origin to a timeline source tag. */
export function sourceFromOrigin(origin: string | null | undefined): TimelineSource {
  switch (origin) {
    case "simulator":
    case "import":
      return "source";
    case "demo":
      return "demo";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    default:
      return "local";
  }
}

export interface TimelineDetail {
  label: string;
  before?: ReactNode;
  after?: ReactNode;
}

export interface TimelineEvent {
  id: string;
  /** UTC ISO (demo-clock time). */
  at: string;
  actorName?: string | null;
  /** A demo Role key (translated with ROLE_LABEL) or free text. */
  actorRole?: Role | string | null;
  summary: ReactNode;
  source: TimelineSource;
  /** Object chip (IdChip, AccessionChip...). */
  object?: ReactNode;
  /** Expandable details: field rows with before/after, or any node. */
  details?: TimelineDetail[] | ReactNode;
  reason?: string | null;
}

export interface TimelineProps {
  events: TimelineEvent[];
  /** Demo now (ISO): today's events show time only. */
  now: string;
  /** Initial order (the user can toggle). */
  order?: "newest" | "oldest";
  /** Show the honesty note in the header (default true). */
  showNote?: boolean;
  title?: ReactNode;
  /** Heading level for `title` (default 3). */
  headingLevel?: 2 | 3 | 4;
  emptyText?: ReactNode;
  className?: string;
}

const SOURCE_ICON: Record<TimelineSource, typeof Plug> = {
  local: UserRound,
  system: Clock,
  source: Plug,
  demo: Clock,
  office: MessageSquareReply,
  assistant: Bot,
};

function roleText(role: string | null | undefined): string | null {
  if (!role) return null;
  return (ROLES as readonly string[]).includes(role) ? ROLE_LABEL[role as Role] : role;
}

function isDetailRows(d: TimelineEvent["details"]): d is TimelineDetail[] {
  return Array.isArray(d) && d.every((x) => x && typeof x === "object" && "label" in (x as object));
}

export function SourceTag({ source, className }: { source: TimelineSource; className?: string }) {
  const Icon = SOURCE_ICON[source];
  const simulated = source === "source" || source === "office";
  return (
    <span
      className={cn(
        "hlo-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-xs font-medium leading-5",
        simulated ? "border-sim-border bg-sim-bg text-sim-fg" : "border-line bg-surface-subtle text-ink-secondary",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {TIMELINE_SOURCE_LABEL[source]}
    </span>
  );
}

export function Timeline({ events, now, order: initialOrder = "newest", showNote = true, title, headingLevel = 3, emptyText, className }: TimelineProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const [order, setOrder] = useState(initialOrder);
  const sorted = useMemo(() => {
    const list = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return order === "newest" ? list.reverse() : list;
  }, [events, order]);

  return (
    <section className={cn("relative flex flex-col gap-2", className)} aria-label={typeof title === "string" ? title : "History"}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {title ? <Heading className="text-md font-semibold text-ink">{title}</Heading> : null}
          {showNote ? <p className="text-xs text-ink-muted">Local append-only audit log for this demo. Not proof of tamper resistance.</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setOrder((o) => (o === "newest" ? "oldest" : "newest"))}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-ink-secondary hover:bg-surface-subtle hover:text-ink"
        >
          <ArrowDownUp className="size-4" aria-hidden />
          {order === "newest" ? "Newest first" : "Oldest first"}
          <span className="sr-only">. Activate to show {order === "newest" ? "oldest" : "newest"} first.</span>
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="rounded-md border border-line px-3 py-4 text-sm text-ink-secondary">{emptyText ?? "No events recorded yet."}</p>
      ) : (
        <ol className="flex flex-col">
          {sorted.map((e) => {
            const role = roleText(e.actorRole);
            const hasDetails = e.details !== undefined && e.details !== null && !(Array.isArray(e.details) && e.details.length === 0);
            return (
              <li key={e.id} className="grid grid-cols-[5.5rem_1fr] gap-x-3 border-b border-line py-2 last:border-b-0">
                <time dateTime={e.at} title={fmtFull(e.at)} className="num-tabular pt-px text-xs text-ink-muted">
                  {fmtSmart(e.at, now)} ET
                </time>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm text-ink">{e.summary}</span>
                    {e.object}
                    <SourceTag source={e.source} />
                  </div>
                  {e.actorName || role ? (
                    <p className="mt-0.5 text-xs text-ink-secondary">
                      {e.actorName ?? "Unknown actor"}
                      {role ? <span className="text-ink-muted">, {role}</span> : null}
                    </p>
                  ) : null}
                  {e.reason ? <p className="mt-0.5 text-xs text-ink-secondary">Reason: {e.reason}</p> : null}
                  {hasDetails ? (
                    <details className="group/details mt-1">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs font-medium text-brand hover:underline [&::-webkit-details-marker]:hidden">
                        <ChevronRight className="size-3.5 transition-transform duration-[var(--hlo-duration-fast)] group-open/details:rotate-90" aria-hidden />
                        Details
                      </summary>
                      <div className="mt-1 rounded-sm border border-line bg-surface-subtle p-2 text-xs">
                        {isDetailRows(e.details) ? (
                          <table className="w-full border-collapse">
                            <caption className="sr-only">Original and new values</caption>
                            <thead>
                              <tr className="text-left text-ink-muted">
                                <th scope="col" className="pb-1 pr-2 font-medium">Field</th>
                                <th scope="col" className="pb-1 pr-2 font-medium">Original</th>
                                <th scope="col" className="pb-1 font-medium">New</th>
                              </tr>
                            </thead>
                            <tbody>
                              {e.details.map((d, i) => (
                                <tr key={i} className="align-top">
                                  <th scope="row" className="py-0.5 pr-2 text-left font-medium text-ink-secondary">{d.label}</th>
                                  <td className="py-0.5 pr-2 text-ink">{d.before ?? <span className="text-ink-muted">None</span>}</td>
                                  <td className="py-0.5 text-ink">{d.after ?? <span className="text-ink-muted">None</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          e.details
                        )}
                        <p className="mt-1 text-ink-muted">UTC: {e.at}</p>
                      </div>
                    </details>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
