"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, CircleCheck, CirclePause, FilePen, FolderOpen, Hourglass, Info, Send, TriangleAlert, UserCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { CtrlEnterBadge } from "@/components/ui/ctrl-enter-badge";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import type { FinalizeBlocker, GrossFields } from "@/lib/gross";
import { emptyGrossFields } from "@/lib/gross";
import { PROCEDURE, type GrossState, type SourceUpdateState } from "@/lib/domain";
import { fmtSmart } from "@/lib/time";
import { useCommand, type CommandFailure, type CommandOutcome } from "@/lib/client/command";
import { useConflict } from "@/lib/client/conflict";
import { useScanTarget } from "@/lib/client/scan";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { useActor, useCan, isReadOnlyRole } from "@/lib/client/shell-context";
import { useToast } from "@/components/ui/toast";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button, ButtonLink, DisabledReason } from "@/components/ui/button";
import { FactList } from "@/components/ui/card";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { StatePill } from "@/components/ui/status-pill";
import { Timeline, sourceFromOrigin } from "@/components/ui/timeline";
import { Tooltip } from "@/components/ui/tooltip";
import { IdentityBar } from "@/components/domain/identity-bar";
import { IdText } from "@/components/domain/id-text";
import { HoldBanner } from "@/components/domain/hold";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { PartWorkspace } from "@/server/queries/grossing";
import { FieldRow, fromModel, sameModel, toModel, type EditorModel } from "./field-editors";
import { composeNarrative, FIELD_LABEL, FIELD_ORDER, fmtFieldValue, onRefreshedVersion, scanToGrossingHref, type FieldKey, type StepKey, type StoredField } from "./model";
import { PartsStrip } from "./parts-strip";
import { StatusRail } from "./status-stepper";
import { TranscriptPane } from "./transcript-pane";

type Summary = { id: string; version: number; recordVersion: number; state: GrossState; sourceUpdateState: string; blockers: FinalizeBlocker[] };
type ApproveResult = {
  record: Summary;
  blocksCreated: string[];
  blocks: { id: string; label: string; identifier: string; eligibleForProcessing: boolean; heldBy: string[] }[];
  tasks: { id: string; kind: string; title: string; owner: string | null }[];
  otherParts: { designation: string; status: string }[];
  worklistSummary: string;
};

/** Below 1024px wide or 560px tall (200% zoom of a bench screen) the fixed frame becomes one page-scrolling stack. */
const STACKED_QUERY = "(max-width: 63.99875rem), (max-height: 35rem)";

const TASK_KIND_LABEL: Record<string, string> = {
  source_entry: "Source-system entry",
  processing_eligible: "Processing eligibility",
  gross_review: "Review",
};

function versionOf(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { version?: unknown; record?: { version?: unknown } };
  if (typeof r.version === "number") return r.version;
  if (r.record && typeof r.record.version === "number") return r.record.version;
  return null;
}

/** Conflict rows for a gross record: compare the fields I tried to change with the newer saved version. */
function grossConflictRows(
  details: unknown,
  input: Record<string, unknown> | null,
  procedure: string | null,
  base: { fields: GrossFields; narrative: string; state: string } | null,
) {
  const current = (details as { current?: Record<string, unknown> } | undefined)?.current;
  if (!current || !input) return undefined;
  let theirsFields: GrossFields;
  try {
    theirsFields = { ...emptyGrossFields(procedure), ...(JSON.parse(String(current.fields ?? "{}")) as Partial<GrossFields>) };
  } catch {
    return undefined;
  }
  const rows: { field: string; label: string; theirs: unknown; yours: unknown }[] = [];
  const describe = (k: FieldKey, v: StoredField | undefined) => (v ? `${fmtFieldValue(k, v.value)} (${v.status.replace("_", " ")})` : "Not entered");
  if (typeof input.field === "string") {
    const k = input.field as FieldKey;
    rows.push({ field: k, label: FIELD_LABEL[k], theirs: describe(k, theirsFields[k] as StoredField), yours: `${fmtFieldValue(k, input.value)} (confirm)` });
  }
  const patch = input.patch as Record<string, { value: unknown }> | undefined;
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      const key = k as FieldKey;
      rows.push({ field: key, label: FIELD_LABEL[key], theirs: describe(key, theirsFields[key] as StoredField), yours: fmtFieldValue(key, v?.value) });
    }
  }
  if (typeof input.narrative === "string") rows.push({ field: "narrative", label: "Narrative", theirs: String(current.narrative ?? ""), yours: input.narrative });
  // What the other person changed since the version these edits were based on (fields I did not touch).
  if (base) {
    const mine = new Set(rows.map((r) => r.field));
    for (const k of FIELD_ORDER) {
      if (mine.has(k)) continue;
      const theirs = theirsFields[k] as StoredField | undefined;
      const was = base.fields[k] as StoredField | undefined;
      if (JSON.stringify(theirs?.value ?? null) === JSON.stringify(was?.value ?? null) && theirs?.status === was?.status) continue;
      rows.push({ field: k, label: FIELD_LABEL[k], theirs: describe(k, theirs), yours: `${describe(k, was)}, not changed by you` });
    }
    if (typeof input.narrative !== "string" && String(current.narrative ?? "") !== base.narrative) {
      rows.push({ field: "narrative", label: "Narrative", theirs: String(current.narrative ?? ""), yours: "Not changed by you" });
    }
    if (String(current.state ?? "") !== base.state) {
      rows.push({ field: "state", label: "Record state", theirs: String(current.state ?? "").replace(/_/g, " "), yours: `${base.state.replace(/_/g, " ")}, not changed by you` });
    }
  }
  return rows;
}

const BLOCKER_GROUPS: { key: string; test: RegExp; title: string }[] = [
  { key: "proposed", test: /was proposed from the transcript and has not been confirmed$/, title: "Proposed, not yet confirmed" },
  { key: "missing", test: / is missing$/, title: "Missing" },
];

/** "6 values to confirm, 1 missing, 1 needs review, narrative is empty" (counts by kind, never a score; each numeral is bound to its noun with a no-break space). */
function blockerSummary(blockers: FinalizeBlocker[]): string {
  const fieldItems = blockers.filter((b) => b.field !== "narrative");
  const toConfirm = fieldItems.filter((b) => BLOCKER_GROUPS[0].test.test(b.message)).length;
  const missing = fieldItems.filter((b) => BLOCKER_GROUPS[1].test.test(b.message)).length;
  const review = fieldItems.filter((b) => /needs review/.test(b.message)).length;
  const other = fieldItems.length - toConfirm - missing - review;
  const parts: string[] = [];
  if (toConfirm) parts.push(`${toConfirm}\u00A0value${toConfirm === 1 ? "" : "s"} to confirm`);
  if (missing) parts.push(`${missing}\u00A0missing`);
  if (review) parts.push(`${review}\u00A0need${review === 1 ? "s" : ""} review`);
  if (other) {
    const names = [
      ...new Set(
        fieldItems
          .filter((b) => !BLOCKER_GROUPS.some((g) => g.test.test(b.message)) && !/needs review/.test(b.message))
          .map((b) => FIELD_LABEL[b.field as FieldKey]?.toLowerCase() ?? b.field),
      ),
    ];
    parts.push(`${names.join(" and ")} to check`);
  }
  const narr = blockers.filter((b) => b.field === "narrative");
  if (narr.some((b) => /empty/.test(b.message))) parts.push("narrative is empty");
  else if (narr.length) parts.push("narrative needs a check");
  return parts.join(", ");
}

/** The finding sentence for the open values: what is missing or may be wrong first, then what only waits on the grosser. */
function openValuesSentence(blockers: FinalizeBlocker[]): { lead: string; amber: boolean } {
  const fieldItems = blockers.filter((b) => b.field !== "narrative");
  const name = (b: FinalizeBlocker) => FIELD_LABEL[b.field as FieldKey]?.toLowerCase() ?? b.field;
  const missing = [...new Set(fieldItems.filter((b) => BLOCKER_GROUPS[1].test.test(b.message)).map(name))];
  const review = [...new Set(fieldItems.filter((b) => /needs review/.test(b.message)).map(name))];
  const proposed = fieldItems.filter((b) => BLOCKER_GROUPS[0].test.test(b.message)).length;
  const other = [
    ...new Set(fieldItems.filter((b) => !BLOCKER_GROUPS.some((g) => g.test.test(b.message)) && !/needs review/.test(b.message)).map(name)),
  ];
  const list = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  // "Dimensions" is plural: "dimensions need review", "piece count needs review".
  const one = (xs: string[]) => xs.length === 1 && xs[0] !== "dimensions";
  // Name the fields while the list stays short; past that, count them (the blocker list names each one).
  const named = missing.length + review.length + other.length <= 2;
  const count = (n: number) => `${n}\u00A0value${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (missing.length) parts.push(named ? `${list(missing)} ${one(missing) ? "is" : "are"} missing` : `${count(missing.length)} ${missing.length === 1 ? "is" : "are"} missing`);
  if (review.length) parts.push(named ? `${list(review)} need${one(review) ? "s" : ""} review` : `${review.length}\u00A0need${review.length === 1 ? "s" : ""} review`);
  if (other.length) parts.push(named ? `${list(other)} need${one(other) ? "s" : ""} a check` : `${other.length}\u00A0need${other.length === 1 ? "s" : ""} a check`);
  if (proposed) parts.push(`${proposed}\u00A0proposed value${proposed === 1 ? " waits" : "s wait"} for your confirmation`);
  const narr = blockers.filter((b) => b.field === "narrative");
  if (narr.some((b) => /empty/.test(b.message))) parts.push("the narrative is empty");
  else if (narr.length) parts.push("the narrative needs a check against the confirmed values");
  const s = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return { lead: `${s.charAt(0).toUpperCase()}${s.slice(1)}.`, amber: missing.length + review.length + other.length > 0 };
}

function withoutLabel(message: string, label: string): string {
  return label && message.startsWith(label) ? message.slice(label.length).trim() : message;
}

/** Blockers grouped by kind; each field name moves focus to that field. */
function BlockerList({ blockers, onGo }: { blockers: FinalizeBlocker[]; onGo: (k: FieldKey) => void }) {
  const goTo = (field: string, text?: string) =>
    field === "narrative" ? (
      <span>{text ?? "Narrative"}</span>
    ) : (
      <button
        type="button"
        onClick={() => onGo(field as FieldKey)}
        className="rounded-sm font-semibold text-brand underline decoration-brand-100 underline-offset-2 hover:text-brand-hover hover:decoration-current"
      >
        {text ?? FIELD_LABEL[field as FieldKey] ?? field}
      </button>
    );
  const grouped = BLOCKER_GROUPS.map((g) => ({ ...g, items: blockers.filter((b) => g.test.test(b.message)) })).filter((g) => g.items.length);
  const rest = blockers.filter((b) => !BLOCKER_GROUPS.some((g) => g.test.test(b.message)));
  return (
    <ul className="mt-1.5 flex flex-col gap-1.5 text-sm">
      {grouped.map((g) => (
        <li key={g.key} className="leading-6">
          <span className="text-ink">{g.title}: </span>
          {g.items.map((b, i) => (
            <span key={b.field}>
              {i ? ", " : ""}
              {goTo(b.field)}
            </span>
          ))}
        </li>
      ))}
      {rest.map((b, i) => (
        <li key={`r${i}`} className="leading-6">
          {b.field === "narrative" ? (
            <span className="text-ink">
              {b.message}. {/empty/.test(b.message) ? "Compose it from the confirmed values or type it, then save." : "Use the choices under Narrative."}
            </span>
          ) : (
            <>
              {goTo(b.field)}
              <span className="text-ink">
                : {withoutLabel(b.message, FIELD_LABEL[b.field as FieldKey] ?? "")}
                {/^Cassette piece total/.test(b.message)
                  ? ". Cassette pieces count specimen pieces; for a bisected or trisected specimen, describe the cut pieces in Contents instead."
                  : ""}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Running text whose identifiers (H-0089, CLR-0455, D26-04817) are set whole in the identifier mono by the shared
 * IdText, while source-system names ("EMA-SIM Sunrise Coast") stay in the word face: they are names, not identifiers.
 */
function ProseWithIds({ text, names }: { text: string; names: string[] }) {
  const keep = names.filter(Boolean);
  if (!keep.length) return <IdText text={text} />;
  const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(" + keep.map(escape).join("|") + ")", "g");
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 === 1 ? <span key={i}>{part}</span> : <IdText key={i} text={part} />))}
    </>
  );
}

type FindingTone = "warning" | "neutral" | "done";
const FINDING_ICON: Record<FindingTone, ReactNode> = {
  warning: <TriangleAlert className="mt-1 size-5 shrink-0 text-warning-solid" aria-hidden />,
  neutral: <Info className="mt-1 size-5 shrink-0 text-ink-muted" aria-hidden />,
  done: <CircleCheck className="mt-1 size-5 shrink-0 text-ink-muted" aria-hidden />,
};

/** Source-system update state in words and icon (waiting is neutral, failed is amber, acknowledged is quiet). */
function SourceUpdateStatus({ state, unreachable }: { state: SourceUpdateState; unreachable: boolean }) {
  const c = "size-4 shrink-0";
  const view =
    state === "source_acknowledged"
      ? { icon: <Check className={cn(c, "text-ink-muted")} aria-hidden />, text: "Source acknowledged (simulated)", cls: "text-ink-muted" }
      : state === "entered_attested"
        ? { icon: <UserCheck className={cn(c, "text-ink-secondary")} aria-hidden />, text: "Entered (staff attested)", cls: "text-ink" }
        : state === "failed"
          ? { icon: <TriangleAlert className={cn(c, "text-warning-solid")} aria-hidden />, text: "Source update failed", cls: "font-semibold text-warning-fg" }
          : { icon: <Hourglass className={cn(c, "text-ink-muted")} aria-hidden />, text: "Source update pending", cls: "text-ink" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-base", view.cls)}>
      {view.icon}
      {view.text}
      {unreachable && (state === "pending_entry" || state === "failed") ? <span className="font-normal text-warning-fg">, source unreachable</span> : null}
    </span>
  );
}

/** What approval opened, shown once right after approving: tasks with their owners, blocks recorded, what the case still waits on. */
function ApprovalOutcome({ result, partLabel, anchorRef }: { result: ApproveResult; partLabel: string; anchorRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={anchorRef} tabIndex={-1} className="scroll-mt-4 rounded-lg focus:outline-none focus-visible:outline-2 focus-visible:outline-focus">
      <section role="status" className="animate-swap-in rounded-lg border border-line bg-surface px-4 py-3">
        <h2 className="flex items-start gap-2 text-md font-semibold tracking-[-0.01em] text-ink">
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-ink-muted" aria-hidden />
          {partLabel} approved for downstream use
        </h2>
        <p className="mt-1 pl-7 text-base text-ink-secondary">
          <IdText text={`${result.worklistSummary}.`} />
        </p>
        {result.tasks.length || result.blocksCreated.length ? (
          <ul className="mt-2 ml-7 divide-y divide-line border-y border-line text-sm" aria-label="Opened by this approval">
            {result.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
                <span className="text-ink">
                  <IdText text={t.title} />
                </span>
                <span className="text-ink-secondary">Owner: {t.owner ?? "Unassigned"}</span>
              </li>
            ))}
            {result.blocksCreated.length ? (
              <li className="py-1.5 text-ink">
                Blocks recorded: <span className="id-mono">{result.blocksCreated.join(", ")}</span> (location unknown until confirmed)
              </li>
            ) : null}
          </ul>
        ) : null}
        <p className="mt-2 pl-7 text-sm text-ink">The case is not complete. Source-system entry is pending; nothing was written to the source system.</p>
      </section>
    </div>
  );
}

/** Downstream work for an approved part: tasks with owners, blocks and their eligibility, what the case still waits on. */
function DownstreamSheet({ ws, showOpenTasks }: { ws: PartWorkspace; showOpenTasks: boolean }) {
  const id = ws.identity;
  const openTasks = ws.tasks.filter((t) => t.status === "open" || t.status === "in_progress");
  const doneTasks = ws.tasks.filter((t) => !(t.status === "open" || t.status === "in_progress"));
  return (
    <section aria-labelledby="gross-downstream-title" className="rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-4 py-3 max-xl:px-3">
        <h2 id="gross-downstream-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
          Downstream work
        </h2>
        <p className="text-sm text-ink-muted">Created from approved documentation. Eligibility is derived from the approval and active holds.</p>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3 max-xl:px-3">
        {showOpenTasks ? (
          openTasks.length ? (
            <ul className="divide-y divide-line text-sm" aria-label="Open downstream tasks">
              {openTasks.map((t) => (
                <li key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-1.5 first:pt-0">
                  <span className="min-w-0 text-ink">
                    <span className="block text-sm text-ink-muted">{TASK_KIND_LABEL[t.kind] ?? t.kind}</span>
                    <IdText text={t.title} />
                  </span>
                  <span className="self-end text-right text-ink-secondary">
                    Owner: {t.owner ?? (t.ownerRole ? `${ROLE_LABEL[t.ownerRole as Role] ?? t.ownerRole.replace(/_/g, " ")} on duty` : "Unassigned")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-secondary">No open downstream tasks for this part.</p>
          )
        ) : null}
        {ws.blocks.length ? (
          <FactList
            className={showOpenTasks ? "border-t border-line pt-3" : undefined}
            items={ws.blocks.map((b) => ({
              label: `Block ${b.label}`,
              value: (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="id-mono text-ink" title={`Label code ${b.identifier}`}>
                    {id.accessionNumber} {b.label}
                  </span>
                  <span>{b.state === "cassette_loaded" ? "Cassette loaded (grossed)" : b.state.replace(/_/g, " ")}</span>
                  {b.eligibleForProcessing ? (
                    <span className="inline-flex items-center gap-1 text-ink-secondary">
                      <Check className="size-3.5 text-ink-muted" aria-hidden /> Eligible for processing
                    </span>
                  ) : null}
                  {b.heldBy.length ? (
                    <span className="hatch inline-flex items-center gap-1 rounded-sm border border-hold-border px-1.5 text-hold-fg">
                      <CirclePause className="size-3.5 text-hold-solid" aria-hidden /> Held from processing ({b.heldBy.join(", ")})
                    </span>
                  ) : null}
                  {b.eligibleForProcessing && !b.hasEligibilityTask ? <span className="text-ink-muted">No processing task open yet</span> : null}
                  <span className="text-ink-muted">Pieces: {b.piecesSubmitted ?? "Unknown (not stated)"}</span>
                </span>
              ),
            }))}
          />
        ) : null}
        {ws.readiness ? (
          <div className="border-t border-line pt-3 text-sm">
            <p className="text-ink">
              Case: {ws.readiness.caseSummary}. {ws.readiness.caseComplete ? "All parts sent on trays; receipt not recorded." : "The case is not complete."}
            </p>
            {ws.readiness.blockedBy.length ? <p className="text-ink-secondary">Not ready: {ws.readiness.blockedBy.join("; ")}</p> : null}
          </div>
        ) : null}
        {doneTasks.length ? (
          <details className="text-sm">
            <summary className="flex min-h-[var(--hlo-target-min)] cursor-pointer items-center text-ink-secondary">Closed tasks ({doneTasks.length})</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {doneTasks.map((t) => (
                <li key={t.id} className="text-ink-secondary">
                  {t.title}: {t.status === "done" ? "done" : "canceled"}
                  {t.completedAt ? (
                    <>
                      {" "}
                      at <Timestamp iso={t.completedAt} now={ws.now} />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

/** Versions, source facts and the audit history for this part, in one sheet. */
function HistorySheet({ ws }: { ws: PartWorkspace }) {
  const id = ws.identity;
  const rec = ws.record;
  return (
    <section aria-labelledby="gross-history-title" className="rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-4 py-3 max-xl:px-3">
        <h2 id="gross-history-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
          Record history
        </h2>
      </header>
      <div className="grid grid-cols-1 min-[80rem]:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]">
        <div className="flex flex-col gap-3 px-4 py-3 max-xl:px-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Versions</h3>
            {ws.versions.length ? (
              <ol className="mt-1 flex flex-col gap-1.5">
                {ws.versions.map((v) => (
                  <li key={v.id} className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm", rec?.id === v.id && "font-medium")}>
                    <span className="text-ink">Version {v.recordVersion}</span>
                    <StatePill domain="gross" state={v.state} size="sm" />
                    <span className="text-ink-secondary">
                      Started <Timestamp iso={v.createdAt} now={ws.now} />
                      {v.approvedAt ? (
                        <>
                          , approved <Timestamp iso={v.approvedAt} now={ws.now} /> by {v.approvedBy ?? "Unknown"}
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-sm text-ink-secondary">No versions yet. Starting the record creates version 1.</p>
            )}
          </div>
          <FactList
            className="border-t border-line pt-3"
            items={[
              { label: "Ordering clinician", value: id.orderingClinician ?? <UnknownValue reason="not in the source order" /> },
              { label: "Source order", value: id.sourceOrderRef ? <span className="id-mono">{id.sourceOrderRef}</span> : "Unknown" },
              { label: "Original designation", value: id.originalDesignation },
              { label: "Extractor", value: rec?.extractor ? `${rec.extractor} (deterministic demo output, not live AI)` : "None (manual entry)" },
            ]}
          />
        </div>
        <Timeline
          className="border-t border-line px-4 py-3 min-[80rem]:border-t-0 min-[80rem]:border-l max-xl:px-3"
          title="History for this part"
          now={ws.now}
          events={ws.history.map((h) => ({
            id: String(h.seq),
            at: h.at,
            actorName: h.actor,
            summary: h.summary,
            source: sourceFromOrigin(h.origin),
          }))}
          emptyText={
            rec && (rec.reviewedAt || rec.approvedAt || rec.sourceEntryAt) ? (
              <>
                <span className="block">No audit events: this record was created by the synthetic seed, which wrote no event history. Recorded on the record itself:</span>
                <span className="mt-1 block text-ink">
                  <span className="block">
                    Started <Timestamp iso={rec.createdAt} now={ws.now} /> by {rec.grosser ?? "Unknown"}.
                  </span>
                  {rec.reviewedAt ? (
                    <span className="block">
                      Marked operator reviewed <Timestamp iso={rec.reviewedAt} now={ws.now} /> by {rec.reviewedBy ?? "Unknown"}.
                    </span>
                  ) : null}
                  {rec.approvedAt ? (
                    <span className="block">
                      Approved for downstream use <Timestamp iso={rec.approvedAt} now={ws.now} /> by {rec.approvedBy ?? "Unknown"}.
                    </span>
                  ) : null}
                  {rec.sourceEntryAt ? (
                    <span className="block">
                      Entered in source system (staff attested) <Timestamp iso={rec.sourceEntryAt} now={ws.now} /> by {rec.sourceEntryBy ?? "Unknown"}.
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-xs">Individual field confirmations were not recorded for seeded records.</span>
              </>
            ) : rec && ws.history.length === 0 ? (
              "No audit events: this draft was created by the synthetic seed, which wrote no event history. Your confirmations from here on are recorded."
            ) : (
              "No grossing events yet."
            )
          }
        />
      </div>
    </section>
  );
}

export function GrossingWorkspace({ ws }: { ws: PartWorkspace }) {
  const router = useRouter();
  const toast = useToast();
  const conflict = useConflict();
  const actor = useActor();
  const readOnly = isReadOnlyRole(actor.role);
  const canEdit = useCan("gross.edit");
  const canReview = useCan("gross.review");
  const canApprove = useCan("gross.approve");
  const canCassettes = useCan("gross.confirmCassettes");
  const canSource = useCan("gross.recordSourceEntry");

  const id = ws.identity;
  const rec = ws.record;
  const partLabel = `${id.accessionNumber} Part ${id.designation}`;
  const partActive = id.partStatus === "active" && id.caseStatus !== "canceled";
  const frozen = !rec || rec.state === "approved_for_downstream" || rec.state === "superseded" || !partActive;
  const fields: GrossFields = rec?.fields ?? emptyGrossFields(id.procedure);
  const approvalHolds = ws.holds.filter((h) => h.blocksApproval);
  const narrativeStale = rec?.narrativeStale ?? [];

  // ---------------------------------------------------------------- local edit state (never carried to another part)
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, EditorModel>>>({});
  const [narrativeDraft, setNarrativeDraft] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<FieldKey | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [pendingField, setPendingField] = useState<FieldKey | null>(null);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [lastApproval, setLastApproval] = useState<ApproveResult | null>(null);
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  /** A newer version saved by someone else arrived while this screen had unsaved edits. */
  const [foreignVersion, setForeignVersion] = useState<number | null>(null);
  const [actionError, setActionError] = useState<CommandFailure | null>(null);
  const [reveal, setReveal] = useState<{ key: FieldKey; n: number } | null>(null);
  const stayRef = useRef<HTMLButtonElement | null>(null);
  const approvalRef = useRef<HTMLDivElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);

  // The version every command is checked against (optimistic concurrency). It advances with my own command results
  // (so quick successive confirms do not self-conflict) and with refreshed props ONLY while I have no unsaved edits.
  // While I have unsaved edits, a newer version from someone else is not adopted: my next save or confirm is checked
  // against the version my edits were based on, so it returns CONFLICT (with the conflict dialog) instead of silently
  // overwriting a colleague's change.
  const versionRef = useRef<number>(rec?.version ?? 0);
  /** The saved content my unsaved edits are based on (the version in versionRef), to show what someone else changed. */
  const baseRef = useRef<{ fields: GrossFields; narrative: string; state: string } | null>(rec ? { fields: rec.fields, narrative: rec.narrative ?? "", state: rec.state } : null);

  const modelFor = useCallback((k: FieldKey): EditorModel => drafts[k] ?? toModel(k, fields[k].value), [drafts, fields]);
  const dirtyKeys = useMemo(
    () => FIELD_ORDER.filter((k) => drafts[k] !== undefined && !sameModel(drafts[k]!, toModel(k, fields[k].value))),
    [drafts, fields],
  );
  const narrative = narrativeDraft ?? rec?.narrative ?? "";
  const narrativeDirty = narrativeDraft !== null && narrativeDraft !== (rec?.narrative ?? "");
  const isDirty = dirtyKeys.length > 0 || narrativeDirty;
  useUnsavedChanges(isDirty, `${partLabel} gross record`);

  useEffect(() => {
    if (!rec) return;
    const d = onRefreshedVersion(versionRef.current, rec.version, isDirty);
    if (d.adopt) {
      versionRef.current = rec.version;
      setForeignVersion(null);
    } else if (d.changedUnderEdits) {
      setForeignVersion(rec.version);
    }
    if (rec.version === versionRef.current) baseRef.current = { fields: rec.fields, narrative: rec.narrative ?? "", state: rec.state };
  }, [rec, isDirty]);

  // The dictation stays beside the form while the form scrolls: its height follows the scrolling pane's height.
  useEffect(() => {
    const el = mainRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => el.style.setProperty("--gross-pane-h", `${el.clientHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clearLocal = useCallback(() => {
    setDrafts({});
    setNarrativeDraft(null);
    setFieldErrors({});
  }, []);

  // ---------------------------------------------------------------- commands
  const onConflict = useCallback(
    (err: CommandFailure, input: unknown) => {
      if (err.code !== "CONFLICT") return;
      const cur = (err.details as { currentVersion?: number } | undefined)?.currentVersion;
      conflict.open({
        message: err.message,
        details: err.details,
        subject: `${partLabel} gross record`,
        fields: grossConflictRows(err.details, input as Record<string, unknown>, id.procedure, baseRef.current),
        // "Load latest and re-apply my changes": my edits are kept and the next save is checked against the latest version.
        onLoadLatest: () => {
          if (typeof cur === "number") versionRef.current = cur;
          setForeignVersion(null);
        },
        onDiscard: () => {
          if (typeof cur === "number") versionRef.current = cur;
          setForeignVersion(null);
          clearLocal();
        },
      });
    },
    [conflict, partLabel, id.procedure, clearLocal],
  );
  const opts = { conflict: false as const, errorToast: false, onError: onConflict };
  const confirmCmd = useCommand<Summary, Record<string, unknown>>("gross.confirmField", opts);
  const saveCmd = useCommand<Summary, Record<string, unknown>>("gross.updateFields", opts);
  const checkCmd = useCommand<Summary, Record<string, unknown>>("gross.updateFields", opts);
  const reviewCmd = useCommand<Summary, Record<string, unknown>>("gross.markReviewed", opts);
  const approveCmd = useCommand<ApproveResult, Record<string, unknown>>("gross.approve", opts);
  const flagCmd = useCommand<Summary, Record<string, unknown>>("gross.flagNeedsClarification", opts);
  const resolveCmd = useCommand<Summary, Record<string, unknown>>("gross.resolveClarification", opts);
  const amendCmd = useCommand<{ record: Summary }, Record<string, unknown>>("gross.amend", opts);
  const startCmd = useCommand<{ record: Summary }, Record<string, unknown>>("gross.startDraft", { errorToast: false });
  const loadCmd = useCommand<{ record: Summary; counts: { proposed: number; needsReview: number; missing: number }; ignoredInstructions: string[] }, Record<string, unknown>>(
    "gross.loadTranscript",
    opts,
  );
  const entryCmd = useCommand<Summary, Record<string, unknown>>("gross.recordSourceEntry", opts);

  const track = <R,>(out: CommandOutcome<R>): CommandOutcome<R> => {
    if (out.ok) {
      const v = versionOf(out.result);
      if (v !== null) versionRef.current = v;
      setActionError(null);
    } else if (out.error.code !== "CONFLICT") setActionError(out.error);
    return out;
  };

  const focusField = useCallback((k: FieldKey) => {
    setActiveField(k);
    const el = document.getElementById(`gf-${k}`) as HTMLElement | null;
    if (el) {
      el.focus();
      el.closest("[data-field]")?.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const nextUnconfirmed = useCallback(
    (after: FieldKey | null): FieldKey | null => {
      const start = after ? FIELD_ORDER.indexOf(after) + 1 : 0;
      for (let i = 0; i < FIELD_ORDER.length; i++) {
        const k = FIELD_ORDER[(start + i) % FIELD_ORDER.length];
        if (fields[k].status !== "confirmed" && k !== after) return k;
      }
      return null;
    },
    [fields],
  );

  const confirmField = async (k: FieldKey, how: { acknowledgeReview?: boolean } = {}) => {
    if (!rec || frozen) return;
    const stored = fields[k] as StoredField;
    if (stored.status === "needs_review" && !how.acknowledgeReview && !dirtyKeys.includes(k)) {
      // Enter / Confirm never accepts an uncertain value as shown: it needs an edit or the explicit "checked" step.
      setFieldErrors((e) => ({ ...e, [k]: "Needs review: enter the value you observed, or check the specimen and use “Checked: keep as dictated”." }));
      return;
    }
    const conv = fromModel(k, modelFor(k));
    if (!conv.ok) {
      setFieldErrors((e) => ({ ...e, [k]: conv.error }));
      return;
    }
    if (conv.value === null) {
      setFieldErrors((e) => ({ ...e, [k]: "Enter the value you observed before confirming." }));
      return;
    }
    setFieldErrors((e) => ({ ...e, [k]: undefined }));
    setPendingField(k);
    // An unedited proposal is confirmed exactly as proposed (no value sent), so nothing reads as "changed by the operator".
    const asProposed = !dirtyKeys.includes(k) && (stored.status === "proposed" || (stored.status === "needs_review" && how.acknowledgeReview));
    const out = track(
      await confirmCmd.run({
        grossRecordId: rec.id,
        expectedVersion: versionRef.current,
        field: k,
        ...(asProposed ? {} : { value: conv.value }),
        ...(how.acknowledgeReview ? { acknowledgeReview: true } : {}),
      }),
    );
    setPendingField(null);
    if (out.ok) {
      setDrafts((d) => {
        const n = { ...d };
        delete n[k];
        return n;
      });
      const next = nextUnconfirmed(k);
      if (next) window.setTimeout(() => focusField(next), 50);
    } else if (out.error.code !== "CONFLICT") {
      setFieldErrors((e) => ({ ...e, [k]: out.error.message }));
      setActionError(null);
    }
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!rec || frozen) return false;
    const patch: Record<string, { value: unknown }> = {};
    const errs: Partial<Record<FieldKey, string>> = {};
    for (const k of dirtyKeys) {
      const conv = fromModel(k, drafts[k]!);
      if (!conv.ok) errs[k] = conv.error;
      else patch[k] = { value: conv.value };
    }
    if (Object.keys(errs).length) {
      setFieldErrors((e) => ({ ...e, ...errs }));
      return false;
    }
    const out = track(await saveCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, patch, ...(narrativeDirty ? { narrative: narrativeDraft } : {}) }));
    if (out.ok) {
      clearLocal();
      toast.show({ tone: "success", title: Object.keys(patch).length ? "Draft saved. Typed values still need confirmation." : "Narrative saved." });
      return true;
    }
    return false;
  };

  const compose = () => setNarrativeDraft(composeNarrative(fields, { designation: id.designation, site: id.site }));
  const markNarrativeChecked = async () => {
    if (!rec || frozen) return;
    const out = track(await checkCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, patch: {}, narrativeChecked: true }));
    if (out.ok) toast.show({ tone: "success", title: "Narrative checked against the confirmed values" });
  };

  const resolveClarification = async () => {
    if (!rec) return;
    const out = track(await resolveCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, resolution: resolution.trim() }));
    if (out.ok) {
      setResolveOpen(false);
      setResolution("");
    }
  };

  const markReviewed = async () => {
    if (!rec) return;
    track(await reviewCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current }));
  };

  const approve = async () => {
    if (!rec) return;
    const out = track(await approveCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current }));
    if (out.ok) {
      // The inline outcome (scrolled into view and focused) is the confirmation; no toast over the downstream sheet.
      setLastApproval(out.result);
      setActiveField(null);
    }
  };

  const attach = async (key: string) => {
    // null = no gross record when this screen was opened; a record someone else started meanwhile is a conflict.
    const out = track(await loadCmd.run({ specimenPartId: id.partId, transcriptKey: key, expectedVersion: rec ? versionRef.current : null }));
    if (out.ok) {
      clearLocal();
      const c = out.result.counts;
      toast.show({
        tone: "info",
        title: `Proposed values ready: ${c.proposed} proposed, ${c.needsReview} need review, ${c.missing} missing`,
        body: "Nothing is confirmed until you confirm it.",
      });
    }
  };

  // After approval, show the record from its top (heading, finding, parts, the full state rail) with the outcome right
  // under the band, and give the outcome focus without scrolling the band away. In the stacked layout (200% zoom) the
  // page scrolls instead, so focusing the outcome brings it into view below the pinned top bar.
  useEffect(() => {
    if (!lastApproval || !approvalRef.current) return;
    if (window.matchMedia(STACKED_QUERY).matches) {
      approvalRef.current.focus();
      return;
    }
    mainRef.current?.scrollTo({ top: 0 });
    approvalRef.current.focus({ preventScroll: true });
  }, [lastApproval]);

  // ---------------------------------------------------------------- navigation guard (no cross-case carryover)
  const guardLink = (href: string) => (e: MouseEvent) => {
    if (!isDirty || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    setPendingNav(href);
  };

  // Any in-app link (top bar, other screens' links) asks first while there are unsaved edits.
  useEffect(() => {
    if (!isDirty) return;
    const onClick = (e: globalThis.MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target instanceof Element ? e.target.closest("a[href]") : null) as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingNav(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [isDirty]);

  useScanTarget(
    "Open part",
    (value) => {
      const r = scanToGrossingHref(value);
      if ("error" in r) return { tone: "danger", message: r.error, alert: true };
      if (r.href === `/grossing?part=${encodeURIComponent(id.ref)}`) return { tone: "info", message: `Already working on ${partLabel}.` };
      if (isDirty) {
        setPendingNav(r.href);
        return { tone: "warning", message: `Unsaved changes for ${partLabel}. Save the draft, discard the changes, or stay.` };
      }
      router.push(r.href);
      return { tone: "success", message: r.message };
    },
    { placeholder: "Scan a cassette label or type D26-04817 A" },
  );

  // ---------------------------------------------------------------- derived UI state
  const blockers = ws.blockers;
  const fieldBlockers = blockers.filter((b) => b.field !== "narrative");
  const stateCanReview = rec && rec.state === "draft";
  const reviewReason: string | null = !rec
    ? "Start the gross record first."
    : readOnly
      ? "Read only role."
      : !canReview.allowed
        ? canReview.reason
        : rec.state === "operator_reviewed"
          ? "Already marked operator reviewed."
          : rec.state === "needs_clarification"
            ? "Flagged as needing clarification. Record how it was resolved first (returns the record to draft)."
            : !stateCanReview
              ? "This version is frozen."
              : isDirty
                ? "Save or confirm your edits first."
                : blockers.length
                  ? `Cannot mark reviewed yet: ${blockers.length}\u00A0item${blockers.length === 1 ? "" : "s"} need${blockers.length === 1 ? "s" : ""} attention (listed below).`
                  : null;
  const approveReason: string | null = !rec
    ? "Start the gross record first."
    : rec.state === "approved_for_downstream"
      ? "Already approved for downstream use."
      : rec.state === "superseded"
        ? "Superseded by a newer version."
        : !canApprove.allowed
          ? `${canApprove.reason} Approval needs a grosser, supervisor or dermatopathologist.`
          : isDirty
            ? "Save or confirm your edits first."
            : blockers.length
              ? `Cannot approve yet: ${blockers.length}\u00A0item${blockers.length === 1 ? "" : "s"} need${blockers.length === 1 ? "s" : ""} attention (listed below).`
              : approvalHolds.length
                ? `Cannot approve: ${approvalHolds.map((h) => `${h.displayId} (${h.reasonText})`).join("; ")} blocks approval for this part.`
                : rec.state === "needs_clarification"
                  ? "Flagged as needing clarification. Record how it was resolved, then mark it reviewed."
                  : rec.state !== "operator_reviewed"
                    ? "Mark the record operator reviewed first."
                    : null;
  // One sentence under the step buttons; it is also the visible reason for their disabled state.
  const barTone: "warning" | "ready" | "info" =
    !rec || frozen ? "info" : isDirty && foreignVersion !== null ? "warning" : readOnly || isDirty ? "info" : !reviewReason || !approveReason ? "ready" : "warning";
  const barText: string = !rec
    ? ""
    : readOnly
      ? "Read only role: you can view this record but not change it."
      : !canReview.allowed && !canApprove.allowed
        ? `${canReview.reason} Review and approval need a grosser or supervisor.`
        : isDirty && foreignVersion !== null
          ? `Someone else saved version\u00A0${foreignVersion} while you were editing. Confirming or saving shows what changed; nothing is overwritten.`
          : isDirty
            ? `Unsaved edits${dirtyKeys.length ? ` (${dirtyKeys.map((k) => FIELD_LABEL[k].toLowerCase()).join(", ")})` : ""}${narrativeDirty ? `${dirtyKeys.length ? " and" : ""} narrative` : ""}. Confirm each value or save the draft first.`
            : rec.state === "needs_clarification"
              ? "Flagged as needing clarification. Record how it was resolved to return it to draft."
              : blockers.length
                ? `Not ready for review: ${blockerSummary(blockers)}.`
                : rec.state === "draft"
                  ? reviewReason
                    ? reviewReason
                    : `Ready to mark operator reviewed. Approval comes after review${approvalHolds.length ? `, and stays blocked by ${approvalHolds.map((h) => h.displayId).join(", ")} until a lead releases it` : ""}.`
                  : (approveReason ?? "Operator reviewed. Ready to approve for downstream use.");

  // A draft with open items: each disabled step gets its own short reason, and the list under it names the items once.
  const splitReasons = Boolean(rec && !readOnly && !isDirty && rec.state === "draft" && blockers.length > 0 && canReview.allowed);
  const reviewLine = `Waits for the ${blockers.length === 1 ? "item" : "items"} listed below.`;
  const approveLine = !canApprove.allowed
    ? `${canApprove.reason} Approval needs a grosser, supervisor or dermatopathologist.`
    : `Comes after operator review.${approvalHolds.length ? ` Also blocked by ${approvalHolds.map((h) => h.displayId).join(", ")} until a lead releases it.` : ""}`;

  const nextAction: (() => void) | null =
    !rec || reviewCmd.pending || approveCmd.pending ? null : !reviewReason && stateCanReview ? markReviewed : !approveReason ? approve : null;
  const firstOpenField = FIELD_ORDER.find((k) => fieldBlockers.some((b) => b.field === k)) ?? null;

  const onWorkspaceKeyDown = (e: ReactKeyboardEvent) => {
    if (e.altKey && e.key === "ArrowDown") {
      const cur = (document.activeElement?.closest("[data-field]") as HTMLElement | null)?.dataset.field as FieldKey | undefined;
      const next = nextUnconfirmed(cur ?? null);
      if (next) {
        e.preventDefault();
        focusField(next);
      }
    }
  };

  // Ctrl/Cmd+Enter runs the marked step from anywhere on the page (also after a button that had focus went away),
  // never while a dialog is open. The step itself is checked again by the server.
  const nextActionRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    nextActionRef.current = nextAction;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter" || e.altKey || e.shiftKey || e.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      const run = nextActionRef.current;
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sourceOffline = Boolean(ws.sourceSystem && ws.sourceSystem.status !== "connected");
  /** "EMA-SIM Sunrise Coast" (the "(simulated source adapter)" suffix is said once by the Simulated label). */
  const sourceName = ws.sourceSystem ? ws.sourceSystem.name.replace(/\s*\(simulated[^)]*\)\s*$/i, "") : "source system";
  const entryTask = ws.tasks.find((t) => t.kind === "source_entry" && (t.status === "open" || t.status === "in_progress"));
  const entryOwner = entryTask ? (entryTask.owner ?? (entryTask.ownerRole ? `${ROLE_LABEL[entryTask.ownerRole as Role] ?? entryTask.ownerRole} on duty` : null)) : null;
  const otherPartsText = ws.parts
    .filter((p) => p.partId !== id.partId)
    .map((p) => `Part ${p.designation}: ${p.state === "awaiting" ? "awaiting grossing" : p.state === "on_hold" ? `on hold (${p.holdIds.join(", ")})` : p.state.replace(/_/g, " ")}`)
    .join("; ");

  const holdScope = (h: { scopeType: string; scopeLabel: string }) =>
    h.scopeType === "accession"
      ? `Case ${id.accessionNumber}`
      : /\bpart\s+([A-Z])\b/i.test(h.scopeLabel)
        ? `Part ${/\bpart\s+([A-Z])\b/i.exec(h.scopeLabel)![1].toUpperCase()}`
        : h.scopeLabel;
  const holdScopes = ws.holds.map(holdScope);
  const labelField = fields.container_label_matches as StoredField;
  const partWarning =
    labelField.status === "needs_review" && /Laterality differs/.test(labelField.note ?? "")
      ? "Dictated container label laterality differs from the part site. Check the container; nothing is corrected automatically."
      : undefined;
  const confirmedCount = rec ? FIELD_ORDER.filter((k) => fields[k].status === "confirmed").length : 0;
  const seededConfirmations = rec ? FIELD_ORDER.some((k) => fields[k].status === "confirmed" && !(fields[k] as StoredField).confirmedByName) : false;
  const heldNote = approvalHolds.length ? ` Approval stays blocked by ${approvalHolds.map((h) => h.displayId).join(", ")} until a lead releases it.` : "";
  /** Instruction-like sentences in the attached dictation (quoted as data, ignored): named in the finding, not only in the dictation sheet. */
  const ignoredCount = rec && !frozen && ws.transcript ? ws.transcript.ignored.length : 0;
  const ignoredNote = ignoredCount
    ? `${ignoredCount}\u00A0instruction-like sentence${ignoredCount === 1 ? " in the dictation was" : "s in the dictation were"} ignored and changed nothing. `
    : "";

  // ---------------------------------------------------------------- the finding: one sentence on where this part stands
  const baseFinding: { tone: FindingTone; lead: string; then: string } = !partActive
    ? { tone: "neutral", lead: id.partStatus !== "active" ? `Part ${id.designation} is ${id.partStatus}.` : `Case ${id.accessionNumber} is canceled.`, then: "Gross documentation cannot change." }
    : !rec
      ? {
          tone: "neutral",
          lead: `Nothing is recorded for Part ${id.designation} yet.`,
          then: `Start the record or attach a synthetic dictation; template defaults are never filled in as observations.${heldNote}`,
        }
      : rec.state === "needs_clarification"
        ? { tone: "warning", lead: "This draft is flagged as needing clarification.", then: "Record how the question was resolved to return it to draft." }
        : rec.state === "approved_for_downstream"
          ? rec.sourceUpdateState === "source_acknowledged"
            ? { tone: "done", lead: "Approved and acknowledged by the simulated source.", then: "Nothing is left on this gross record." }
            : rec.sourceUpdateState === "entered_attested"
              ? {
                  tone: "neutral",
                  lead: `Entered in ${sourceName}, attested by ${rec.sourceEntryBy ?? "Unknown"}.`,
                  then: "Not acknowledged by the source yet. Downstream work does not wait for it.",
                }
              : rec.sourceUpdateState === "failed"
                ? { tone: "warning", lead: "The source update failed.", then: `Enter the description in ${sourceName} by hand again, then attest it.` }
                : {
                    tone: "neutral",
                    lead: `Approved for downstream use by ${rec.approvedBy ?? "Unknown"}.`,
                    then: `Source update pending: ${entryOwner ?? "the histology assistant"} enters it in ${sourceName} by hand.`,
                  }
          : blockers.length
            ? (() => {
                const s = openValuesSentence(blockers);
                // With ignored instruction-like text, that safeguard takes the second clause (the column already says review waits).
                const then = ignoredNote ? `${ignoredNote.trim()}${heldNote}` : `Review and approval wait until every value is confirmed.${heldNote}`;
                return { tone: s.amber ? "warning" : "neutral", lead: s.lead, then } as const;
              })()
            : rec.state === "operator_reviewed"
              ? {
                  tone: "neutral",
                  lead: `Operator reviewed by ${rec.reviewedBy ?? "Unknown"}.`,
                  then: approvalHolds.length ? heldNote.trim() : "Approval for downstream use is next.",
                }
              : { tone: "neutral", lead: "Every value is confirmed and the narrative matches.", then: `Mark it operator reviewed; approval comes after review.${heldNote}` };
  const finding = ignoredNote && !baseFinding.then.startsWith(ignoredNote.trim()) ? { ...baseFinding, then: `${ignoredNote}${baseFinding.then}` } : baseFinding;

  const at = (iso: string | null | undefined, who: string | null | undefined) =>
    iso ? (
      <>
        {who ?? "Unknown"}, <Timestamp iso={iso} now={ws.now} />
      </>
    ) : null;
  /** "Blocked by H-0089": the hold id never breaks across lines. */
  const blockedByHolds = (
    <>
      Blocked by{" "}
      {approvalHolds.map((h, i) => (
        <span key={h.id}>
          {i ? ", " : ""}
          <span className="id-mono whitespace-nowrap">{h.displayId}</span>
        </span>
      ))}
    </>
  );
  const railDetails: Partial<Record<StepKey, ReactNode>> = rec
    ? {
        draft: rec.state === "draft" || rec.state === "needs_clarification" ? `Waiting on ${rec.grosser ?? "the grosser"}` : at(rec.createdAt, rec.grosser),
        operator_reviewed: rec.reviewedAt ? at(rec.reviewedAt, rec.reviewedBy) : null,
        approved_for_downstream: rec.approvedAt ? at(rec.approvedAt, rec.approvedBy) : approvalHolds.length ? blockedByHolds : null,
        pending_entry: rec.state === "approved_for_downstream" && (rec.sourceUpdateState === "pending_entry" || rec.sourceUpdateState === "failed") ? `Waiting on ${entryOwner ?? "the histology assistant"}` : null,
        entered_attested: rec.sourceEntryAt ? at(rec.sourceEntryAt, rec.sourceEntryBy) : null,
        source_acknowledged: rec.sourceAckAt ? (
          <>
            Simulated source, <Timestamp iso={rec.sourceAckAt} now={ws.now} />
          </>
        ) : rec.sourceUpdateState === "entered_attested" ? (
          "Waiting on the source"
        ) : null,
      }
    : {
        draft: "Not started",
        approved_for_downstream: approvalHolds.length ? blockedByHolds : null,
      };

  // ---------------------------------------------------------------- the docked next step
  const stepTitle: string = !partActive
    ? "Nothing to do on this part"
    : readOnly
      ? "Read only"
      : !rec
        ? "Start the gross record"
        : rec.state === "approved_for_downstream"
          ? rec.sourceUpdateState === "source_acknowledged"
            ? "Nothing left on this record"
            : rec.sourceUpdateState === "entered_attested"
              ? "Waiting for the source to acknowledge"
              : canSource.allowed
                ? `Enter it in ${sourceName}`
                : "Nothing left for you on this record"
          : rec.state === "needs_clarification"
            ? "Record how the question was resolved"
            : isDirty
              ? "Confirm or save your edits"
              : fieldBlockers.length
                ? `Confirm the open value${fieldBlockers.length === 1 ? "" : "s"}`
                : blockers.length
                  ? "Write or check the narrative"
                  : rec.state === "operator_reviewed"
                    ? approvalHolds.length
                      ? "Approval waits for the hold"
                      : "Approve for downstream use"
                    : "Mark operator reviewed";

  const waitingOn: { key: string; icon: ReactNode; who: string; what: ReactNode }[] = [];
  for (const h of approvalHolds) {
    waitingOn.push({
      key: h.id,
      icon: (
        <span aria-hidden className="hatch mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-hold-border">
          <CirclePause className="size-3 text-hold-solid" />
        </span>
      ),
      who: h.owner ?? "Owner unknown",
      what: (
        <>
          to settle {h.clarificationDisplayId ? <span className="id-mono">{h.clarificationDisplayId}</span> : "the question"} ({h.reasonText}). Approval stays blocked until a lead
          releases <span className="id-mono">{h.displayId}</span>.
        </>
      ),
    });
  }
  if (rec && !frozen && (readOnly || actor.name !== rec.grosser)) {
    waitingOn.push({
      key: "grosser",
      icon: <Hourglass className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />,
      who: rec.grosser ?? "The grosser",
      what:
        rec.state === "needs_clarification"
          ? "to record how the question was resolved."
          : blockers.length
            ? `to settle ${blockers.length}\u00A0open item${blockers.length === 1 ? "" : "s"} before review.`
            : rec.state === "operator_reviewed"
              ? "to approve it for downstream use."
              : "to mark it operator reviewed.",
    });
  }
  if (rec?.state === "approved_for_downstream" && (rec.sourceUpdateState === "pending_entry" || rec.sourceUpdateState === "failed")) {
    waitingOn.push({ key: "entry", icon: <Hourglass className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />, who: entryOwner ?? "Histology assistant", what: `to enter it in ${sourceName} by hand.` });
  }
  if (rec?.state === "approved_for_downstream" && rec.sourceUpdateState === "entered_attested") {
    waitingOn.push({
      key: "ack",
      icon: <Hourglass className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />,
      who: `${sourceName} (simulated)`,
      what: sourceOffline ? "to acknowledge the entry once it is reachable again." : "to acknowledge the entry.",
    });
  }

  const entryPending = rec?.state === "approved_for_downstream" && (rec.sourceUpdateState === "pending_entry" || rec.sourceUpdateState === "failed");
  /** Attesting the manual entry is this person's step; anyone else sees who does it, without controls they can never use. */
  const canAttestHere = !readOnly && canSource.allowed;
  const sourceStep =
    rec && rec.state === "approved_for_downstream" ? (
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <SourceUpdateStatus state={rec.sourceUpdateState} unreachable={sourceOffline} />
          <SimulatedLabel connector={sourceName} size="xs" />
        </div>
        {entryPending && !canAttestHere ? (
          <p className="text-sm text-ink-secondary">
            {entryOwner ?? "The histology assistant"} types it into {sourceName} by hand and attests the entry; only the simulated source can acknowledge it.
          </p>
        ) : (
          <p className="text-sm text-ink-secondary">
            Entry is made by hand in the source system. Marking it entered is a staff attestation, not an acknowledgment. Only the simulated source can acknowledge in this demo.
          </p>
        )}
        {rec.sourceEntryAt ? (
          <p className="text-sm text-ink">
            Entered (staff attested) by {rec.sourceEntryBy ?? "Unknown"} at <Timestamp iso={rec.sourceEntryAt} now={ws.now} />.
            {rec.sourceAckAt ? (
              <>
                {" "}
                Acknowledged by the simulated source at <Timestamp iso={rec.sourceAckAt} now={ws.now} />.
              </>
            ) : (
              " Not acknowledged by the source."
            )}
          </p>
        ) : null}
        {sourceOffline ? (
          <AlertBanner tone="warning" title={`${sourceName} unreachable (simulated outage)`}>
            {rec.sourceUpdateState === "pending_entry" || rec.sourceUpdateState === "failed"
              ? "Attest only an entry you actually typed into the source system. Its acknowledgment waits until the source is back. Approval and downstream work are not affected."
              : "The source cannot acknowledge the entry until it is back. Approval and downstream work are not affected."}
          </AlertBanner>
        ) : null}
        {entryPending && canAttestHere ? (
          <>
            <Button
              variant="primary"
              size="block"
              icon={<Send />}
              loading={entryCmd.pending}
              loadingLabel="Recording..."
              onClick={async () => void track(await entryCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current }))}
            >
              Mark entered in source system (staff attestation)
            </Button>
          </>
        ) : null}
      </div>
    ) : null;

  const reviewPrimary = Boolean(rec && !reviewReason && stateCanReview);
  const approvePrimary = Boolean(rec && rec.state === "operator_reviewed" && !approveReason);

  return (
    // A fixed frame at bench sizes (the record scrolls beside the docked next step). Below 1024px wide or 560px tall (200%
    // browser zoom of a bench screen) it becomes one page-scrolling stack: identity, record band, next step, then the sheets.
    <div onKeyDown={onWorkspaceKeyDown} className="flex h-[calc(100dvh-var(--hlo-chrome-h))] min-h-[34rem] flex-col [@media(max-width:63.99875rem),(max-height:35rem)]:h-auto [@media(max-width:63.99875rem),(max-height:35rem)]:min-h-0">
      <IdentityBar
        identity={{ kind: "accession", accession: id.accessionNumber, namespace: id.namespace }}
        part={{
          letter: id.designation,
          description: `${id.site.toLowerCase()}, ${id.procedure ? (PROCEDURE[id.procedure as keyof typeof PROCEDURE]?.toLowerCase() ?? id.procedure) : "procedure unknown"}`,
          warning: partWarning,
        }}
        patient={id.patientName ? { name: id.patientName, mrn: id.mrn, tenant: id.tenantName } : null}
        office={id.officeName}
        doctor={id.pathologist ? { name: id.pathologist.name, color: id.pathologist.color } : null}
        holds={holdScopes.length ? [...new Set(holdScopes)] : undefined}
        contextKey={`${id.accessionNumber}:${id.designation}`}
        actions={
          // Icon only below 1280px, so the bar keeps one row on a bench tablet with a hold; the name and tooltip say it in words.
          <Tooltip content={<IdText text={`Open case ${id.accessionNumber}`} />} side="bottom" className="min-[80rem]:hidden">
            <ButtonLink
              href={`/cases/${encodeURIComponent(id.accessionNumber)}`}
              size="sm"
              variant="ghost"
              icon={<FolderOpen />}
              className="max-[79.9375rem]:w-[max(2rem,var(--hlo-target-min))] max-[79.9375rem]:px-0"
              onClick={guardLink(`/cases/${encodeURIComponent(id.accessionNumber)}`)}
            >
              <span className="max-[79.9375rem]:sr-only">Open case</span>
              <span className="sr-only"> {id.accessionNumber}</span>
            </ButtonLink>
          </Tooltip>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_19rem] min-[80rem]:grid-cols-[minmax(0,1fr)_21rem] min-[87.5rem]:grid-cols-[minmax(0,1fr)_22.5rem] [@media(max-width:63.99875rem),(max-height:35rem)]:flex [@media(max-width:63.99875rem),(max-height:35rem)]:flex-col">
        {/* ------------------------------------------------ the record: finding, states, evidence beside structure */}
        {/* Stacked: this scroller dissolves (display: contents) so the next step can sit between the record band and the sheets. */}
        {/* "relative" keeps visually hidden text (sr-only, absolutely positioned) inside this scroller instead of
            stretching the page below the frame. */}
        <div ref={mainRef} className="relative min-h-0 overflow-y-auto overscroll-contain [@media(max-width:63.99875rem),(max-height:35rem)]:contents">
          <section aria-label="Gross record summary" className="border-b border-line bg-surface px-5 pt-3 pb-2 max-xl:px-4 [@media(max-width:63.99875rem),(max-height:35rem)]:order-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 max-[79.9375rem]:gap-x-3">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 max-[79.9375rem]:gap-x-2">
                <Link
                  href="/grossing"
                  onClick={guardLink("/grossing")}
                  className="inline-flex min-h-[var(--hlo-target-min)] items-center gap-1 self-center rounded-sm text-sm font-medium whitespace-nowrap text-brand hover:underline"
                >
                  <ArrowLeft className="size-4" aria-hidden /> Grossing queue
                </Link>
                <h1 className="text-lg font-bold tracking-[-0.01em] text-ink">
                  Gross record <span className="sr-only">for {partLabel}</span>
                </h1>
                <span className="text-sm text-ink-muted">{rec ? `Version ${rec.recordVersion}` : "Not started"}</span>
              </div>
              <PartsStrip parts={ws.parts} currentPartId={id.partId} onNavigate={guardLink} />
            </div>
            <p className="mt-2.5 flex items-start gap-2.5 text-md tracking-[-0.005em] min-[80rem]:text-lg">
              {FINDING_ICON[finding.tone]}
              <span>
                <span className="font-semibold text-ink">
                  <ProseWithIds text={finding.lead} names={[sourceName]} />
                </span>{" "}
                <span className="text-ink-muted">
                  <ProseWithIds text={finding.then} names={[sourceName]} />
                </span>
              </span>
            </p>
            <div className="mt-3">
              <StatusRail state={rec?.state ?? null} sourceUpdateState={rec?.sourceUpdateState ?? null} details={railDetails} />
            </div>
          </section>

          <div className="flex flex-col gap-4 px-5 py-4 max-xl:px-4 [@media(max-width:63.99875rem),(max-height:35rem)]:order-3">
            {!partActive ? (
              <AlertBanner tone="warning" title={id.partStatus !== "active" ? `${partLabel} is ${id.partStatus}` : `Case ${id.accessionNumber} is canceled`}>
                Gross documentation cannot change for a canceled part or case. The server refuses drafting, confirming, approving and amending.
              </AlertBanner>
            ) : null}
            {foreignVersion !== null && isDirty && rec && !frozen ? (
              <AlertBanner tone="warning" title="Changed by someone else while you were editing" headingLevel={2}>
                <p>
                  {partLabel} was saved by someone else (now version {foreignVersion}). Your unsaved edits are kept and are based on the version you opened. Saving or confirming will
                  show what changed so you can choose; nothing is overwritten silently.
                </p>
                <div className="mt-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      versionRef.current = foreignVersion;
                      setForeignVersion(null);
                      clearLocal();
                    }}
                  >
                    Discard my edits and show the latest
                  </Button>
                </div>
              </AlertBanner>
            ) : null}

            {ws.holds.map((h) => (
              <HoldBanner
                key={h.id}
                scope={holdScope(h)}
                reason={h.reasonText}
                otherScopeNote={otherPartsText && h.scopeType !== "accession" ? "Other parts of this case are not affected by this hold." : undefined}
                clarification={
                  h.clarificationDisplayId
                    ? { displayId: h.clarificationDisplayId, href: `/clarifications?selected=${h.clarificationDisplayId}`, state: h.clarificationState?.replace(/_/g, " ") }
                    : undefined
                }
                owner={h.owner}
                nextFollowUpAt={h.nextFollowUpAt}
                now={ws.now}
              >
                <p className="mt-1 text-sm text-ink">
                  {h.displayId} placed {fmtSmart(h.placedAt, ws.now)} ET by {h.placedBy ?? "Unknown"}. Blocks: {h.blocks.map((b) => b.replace(/_/g, " ")).join(", ")}.{" "}
                  {h.blocksApproval ? "Drafting and confirming can continue; approval for downstream use stays blocked until the hold is released by a lead." : ""}
                </p>
              </HoldBanner>
            ))}

            {lastApproval ? <ApprovalOutcome result={lastApproval} partLabel={partLabel} anchorRef={approvalRef} /> : null}
            {rec && rec.state === "approved_for_downstream" ? <DownstreamSheet ws={ws} showOpenTasks={!lastApproval} /> : null}

            <div className="grid grid-cols-1 items-start gap-4 min-[80rem]:grid-cols-[minmax(18rem,5fr)_minmax(0,8fr)]">
              <TranscriptPane
                className="order-2 min-[80rem]:order-none min-[80rem]:[@media(min-height:35.00125rem)]:sticky min-[80rem]:[@media(min-height:35.00125rem)]:top-4 min-[80rem]:[@media(min-height:35.00125rem)]:max-h-[calc(var(--gross-pane-h,70vh)-2rem)] min-[80rem]:[@media(min-height:35.00125rem)]:overflow-y-auto"
                transcript={ws.transcript}
                fields={rec ? fields : null}
                activeField={frozen ? null : activeField}
                reveal={reveal}
                onSelectField={focusField}
                assistantMode={ws.assistantMode}
                options={ws.transcriptOptions}
                frozen={frozen && Boolean(rec)}
                attachDisabledReason={
                  readOnly
                    ? "Read only role: attaching a dictation needs a grosser, histology assistant or supervisor."
                    : !canEdit.allowed
                      ? `${canEdit.reason} Attaching a dictation needs a grosser, histology assistant or supervisor.`
                      : !partActive
                        ? "Part or case is canceled, so no dictation can be attached."
                        : null
                }
                onAttach={attach}
                attaching={loadCmd.pending}
                attachError={loadCmd.error && loadCmd.error.code !== "CONFLICT" ? loadCmd.error : null}
                now={ws.now}
                extractedWithoutText={Boolean(rec?.extractor) && !ws.transcript}
              />

              {/* One form sheet: structured fields, then the narrative, separated by hairlines. */}
              <section aria-labelledby="gross-fields-title" className="order-1 min-w-0 rounded-lg border border-line bg-surface min-[80rem]:order-none">
                <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3 max-xl:px-3">
                  <div className="min-w-0">
                    <h2 id="gross-fields-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
                      Structured fields
                    </h2>
                    <p className="max-w-[60ch] text-sm text-ink-muted">
                      {!rec
                        ? "Template defaults are never filled in as observations."
                        : frozen
                          ? `Template ${fields.template_id} (synthetic). Frozen with version ${rec.recordVersion}; a correction creates a new version.`
                          : `Template ${fields.template_id} (synthetic). Nothing is pre-filled; each number, unit and count needs your confirmation.`}
                    </p>
                  </div>
                  {rec ? (
                    <p className="pt-0.5 text-sm text-ink-secondary">
                      <span className="font-semibold text-ink">{confirmedCount}</span> of {FIELD_ORDER.length} confirmed
                    </p>
                  ) : null}
                  {seededConfirmations ? (
                    <p className="basis-full text-sm text-ink-muted">Values marked “Confirmed (seeded)” come from the synthetic seed, which recorded no name or time for them.</p>
                  ) : null}
                </header>

                {!rec ? (
                  <div className="flex flex-col gap-1 px-4 py-6 max-xl:px-3">
                    <p className="text-base text-ink">No gross record for {partLabel} yet.</p>
                    <p className="max-w-[62ch] text-sm text-ink-secondary">
                      Start the record from Your next step to type the values you observe, or attach a synthetic dictation to get proposed values. Every value then waits for your
                      confirmation, one field at a time.
                    </p>
                  </div>
                ) : (
                  <>
                    {!frozen && (readOnly || !canReview.allowed) ? (
                      <p id="gross-role-reason" className="border-b border-line bg-surface-subtle px-4 py-2 text-sm text-ink-secondary max-xl:px-3">
                        {readOnly ? "Read only role." : canReview.reason} Confirming values needs a grosser, histology assistant or supervisor. The server checks this on every action.
                      </p>
                    ) : null}
                    <div>
                      {FIELD_ORDER.map((k) => {
                        const stored = fields[k] as StoredField;
                        const confirmBlocked = readOnly
                          ? "Read only role."
                          : !canReview.allowed
                            ? canReview.reason
                            : k === "cassettes" && !canCassettes.allowed
                              ? `${canCassettes.reason} Cassette allocation is confirmed by the grosser or a supervisor.`
                              : null;
                        return (
                          <FieldRow
                            key={k}
                            fieldKey={k}
                            stored={stored}
                            model={modelFor(k)}
                            dirty={dirtyKeys.includes(k)}
                            onModel={(m) => setDrafts((d) => ({ ...d, [k]: m }))}
                            onConfirm={() => void confirmField(k)}
                            onKeepAsDictated={() => void confirmField(k, { acknowledgeReview: true })}
                            onRevert={() =>
                              setDrafts((d) => {
                                const n = { ...d };
                                delete n[k];
                                return n;
                              })
                            }
                            onShowEvidence={() => {
                              setActiveField(k);
                              setReveal((r) => ({ key: k, n: (r?.n ?? 0) + 1 }));
                            }}
                            onFocusField={() => setActiveField(k)}
                            active={activeField === k}
                            frozen={frozen}
                            confirmBlockedReason={confirmBlocked}
                            sharedReasonId={readOnly || !canReview.allowed ? "gross-role-reason" : undefined}
                            editBlockedReason={readOnly ? "Read only role." : !canEdit.allowed ? canEdit.reason : null}
                            pending={pendingField === k && confirmCmd.pending}
                            error={fieldErrors[k] ?? null}
                            partDesignation={id.designation}
                            now={ws.now}
                          />
                        );
                      })}
                    </div>

                    <section aria-labelledby="gross-narrative-title" className="border-t border-line px-4 py-3 max-xl:px-3">
                      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                        <div className="min-w-0">
                          <h2 id="gross-narrative-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
                            Narrative
                          </h2>
                          <p className="text-sm text-ink-muted">Free text for the gross description. It is entered in the source system by hand after approval.</p>
                        </div>
                        {!frozen ? (
                          <Button variant="secondary" size="sm" disabled={readOnly || !canEdit.allowed} onClick={compose}>
                            Compose from confirmed values
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-2 flex flex-col gap-2">
                        {narrativeStale.length && !frozen && !narrativeDirty ? (
                          <AlertBanner tone="warning" title="Check the narrative against the confirmed values">
                            <p>
                              It was written before {narrativeStale.map((k) => FIELD_LABEL[k].toLowerCase()).join(" and ")} {narrativeStale.length === 1 ? "was" : "were"} confirmed,
                              so it may still say what was dictated. Compose it again, edit it, or confirm it already matches.
                            </p>
                            {!readOnly && canEdit.allowed ? (
                              <div className="mt-1.5 flex flex-wrap gap-2">
                                <Button variant="secondary" size="sm" onClick={compose}>
                                  Compose again
                                </Button>
                                <Button variant="secondary" size="sm" loading={checkCmd.pending} loadingLabel="Recording..." onClick={() => void markNarrativeChecked()}>
                                  Checked: it matches
                                </Button>
                              </div>
                            ) : null}
                          </AlertBanner>
                        ) : null}
                        {frozen ? (
                          <div>
                            <p className="text-sm text-ink-muted">
                              Narrative for {partLabel}, frozen with version {rec.recordVersion}
                            </p>
                            <p className="mt-1 max-w-[75ch] whitespace-pre-wrap text-base leading-7 text-ink">{narrative || <UnknownValue reason="no narrative was saved" />}</p>
                          </div>
                        ) : (
                          <Field
                            label={`Narrative for ${partLabel}`}
                            required
                            hint="Composing uses confirmed values only; anything unconfirmed is marked, never filled in. Edit before saving."
                          >
                            <Textarea rows={5} value={narrative} readOnly={readOnly || !canEdit.allowed} onChange={(e) => setNarrativeDraft(e.target.value)} />
                          </Field>
                        )}
                      </div>
                    </section>

                    {rec.state !== "needs_clarification" && rec.unresolved.some((u) => u.field === "clarification" && u.resolvedAt) ? (
                      <section aria-label="Resolved grossing questions" className="border-t border-line px-4 py-3 max-xl:px-3">
                        <h3 className="text-sm font-semibold text-ink">Resolved questions</h3>
                        <ul className="mt-1 flex flex-col gap-0.5 text-sm text-ink-secondary">
                          {rec.unresolved
                            .filter((u) => u.field === "clarification" && u.resolvedAt)
                            .map((u, i) => (
                              <li key={i}>
                                Question &quot;{u.message}&quot; resolved by {u.resolvedBy ?? "Unknown"}: {u.resolution}
                              </li>
                            ))}
                        </ul>
                      </section>
                    ) : null}
                  </>
                )}
              </section>
            </div>

            {rec && rec.state !== "approved_for_downstream" && (ws.tasks.length > 0 || ws.blocks.length > 0) ? <DownstreamSheet ws={ws} showOpenTasks /> : null}
            <HistorySheet ws={ws} />
          </div>
        </div>

        {/* ------------------------------------------------ docked: the next step, why anything is disabled, who else is waited on */}
        <section
          aria-label={`Next step for ${partLabel}`}
          className="flex min-h-0 flex-col border-l border-line bg-canvas [@media(max-width:63.99875rem),(max-height:35rem)]:order-2 [@media(max-width:63.99875rem),(max-height:35rem)]:border-b [@media(max-width:63.99875rem),(max-height:35rem)]:border-l-0"
        >
          <div
            className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 max-xl:p-3 [@media(max-width:63.99875rem),(max-height:35rem)]:overflow-visible [@media(max-width:63.99875rem),(max-height:35rem)]:sm:grid [@media(max-width:63.99875rem),(max-height:35rem)]:sm:grid-cols-2 [@media(max-width:63.99875rem),(max-height:35rem)]:sm:items-start"
          >
            <div className="rounded-lg border border-line bg-surface p-4 max-xl:p-3 [@media(max-width:63.99875rem),(max-height:35rem)]:sm:row-span-3">
              <h2 className="text-lg font-bold tracking-[-0.01em] text-ink">Your next step</h2>
              <p className="mt-1 text-md font-semibold leading-6 text-ink">{stepTitle}</p>

              {readOnly ? (
                <p className="mt-1.5 text-sm text-ink-secondary">
                  {actor.name} can view but not change records in this demo. The server checks permissions on every action.
                </p>
              ) : null}

              {!partActive ? (
                <p className="mt-1.5 text-sm text-ink-secondary">The server refuses drafting, confirming, approving and amending for a canceled part or case.</p>
              ) : !rec ? (
                <div className="mt-3 flex flex-col gap-2">
                  <Button
                    variant="primary"
                    size="block"
                    icon={<FilePen />}
                    loading={startCmd.pending}
                    loadingLabel="Starting..."
                    disabled={readOnly || !canEdit.allowed}
                    reasonId={readOnly || !canEdit.allowed ? "start-reason" : undefined}
                    onClick={() => void startCmd.run({ specimenPartId: id.partId })}
                  >
                    Start gross record
                  </Button>
                  {readOnly || !canEdit.allowed ? (
                    <DisabledReason id="start-reason">{canEdit.reason ?? "Read only role."}</DisabledReason>
                  ) : (
                    <p className="text-sm text-ink-secondary">Or attach a synthetic dictation in the Dictation sheet to get proposed values.</p>
                  )}
                  <CommandError error={startCmd.error} />
                </div>
              ) : rec.state === "approved_for_downstream" ? (
                <div className="mt-3">{sourceStep}</div>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  {rec.state === "needs_clarification" ? (
                    <div className="flex flex-col gap-2">
                      {rec.unresolved
                        .filter((u) => u.field === "clarification" && !u.resolvedAt)
                        .map((u, i) => (
                          <p key={i} className="text-sm text-ink">
                            <TriangleAlert className="mr-1 inline size-4 align-[-3px] text-warning-solid" aria-hidden />
                            {u.message}
                            {u.by ? ` (${u.by})` : ""}
                          </p>
                        ))}
                      <p className="text-sm text-ink-secondary">
                        To ask the office, raise a clarification from the{" "}
                        <Link className="font-medium text-brand underline underline-offset-2" href={`/cases/${encodeURIComponent(id.accessionNumber)}`}>
                          case
                        </Link>
                        . When it is answered, record how it was resolved; the record returns to draft and can then be reviewed.
                      </p>
                      <Button variant="primary" size="block" disabled={readOnly || !canEdit.allowed} onClick={() => setResolveOpen(true)}>
                        Record resolution (return to draft)
                      </Button>
                    </div>
                  ) : null}
                  {!readOnly && !isDirty && firstOpenField && rec.state !== "needs_clarification" ? (
                    <Button variant="primary" size="block" icon={<ArrowRight />} className="justify-start" onClick={() => focusField(firstOpenField)}>
                      Go to {FIELD_LABEL[firstOpenField].toLowerCase()}
                    </Button>
                  ) : null}
                  {!readOnly ? (
                    <>
                      {isDirty ? (
                        <Button variant="primary" size="block" loading={saveCmd.pending} loadingLabel="Saving..." onClick={() => void saveDraft()}>
                          Save draft
                        </Button>
                      ) : null}
                      {rec.state !== "operator_reviewed" ? (
                        <>
                          <Button
                            variant={reviewPrimary ? "primary" : "secondary"}
                            size="block"
                            loading={reviewCmd.pending}
                            loadingLabel="Marking..."
                            disabled={Boolean(reviewReason)}
                            reasonId={reviewReason ? (splitReasons ? "gross-review-reason" : "gross-bar-reason") : undefined}
                            aria-keyshortcuts={reviewPrimary ? "Control+Enter Meta+Enter" : undefined}
                            onClick={() => void markReviewed()}
                          >
                            Mark operator reviewed
                            {reviewPrimary ? <CtrlEnterBadge onDark /> : null}
                          </Button>
                          {splitReasons ? (
                            <DisabledReason id="gross-review-reason" className="-mt-1">
                              {reviewLine}
                            </DisabledReason>
                          ) : null}
                        </>
                      ) : null}
                      <Button
                        variant={approvePrimary ? "primary" : "secondary"}
                        size="block"
                        loading={approveCmd.pending}
                        loadingLabel="Approving..."
                        disabled={Boolean(approveReason)}
                        reasonId={approveReason ? (splitReasons ? "gross-approve-reason" : "gross-bar-reason") : undefined}
                        aria-keyshortcuts={approvePrimary ? "Control+Enter Meta+Enter" : undefined}
                        onClick={() => void approve()}
                      >
                        Approve for downstream use
                        {approvePrimary ? <CtrlEnterBadge onDark /> : null}
                      </Button>
                      {splitReasons ? (
                        <DisabledReason id="gross-approve-reason" className="-mt-1">
                          {approveLine}
                        </DisabledReason>
                      ) : null}
                    </>
                  ) : null}
                  {!splitReasons ? (
                    <p id="gross-bar-reason" className={cn("flex items-start gap-1.5 text-sm text-ink", readOnly && "sr-only")}>
                      {barTone === "warning" ? (
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
                      ) : barTone === "ready" ? (
                        <ArrowRight className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
                      ) : (
                        <Info className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
                      )}
                      <span>
                        <ProseWithIds text={barText} names={[sourceName]} />
                      </span>
                    </p>
                  ) : null}
                </div>
              )}

              {rec && blockers.length && !frozen ? (
                <div role="status" className="mt-3 border-t border-line pt-3">
                  <p className="flex items-start gap-1.5 text-sm font-semibold text-warning-fg">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
                    {`Cannot approve yet: ${blockers.length}\u00A0item${blockers.length === 1 ? "" : "s"} need${blockers.length === 1 ? "s" : ""} attention`}
                  </p>
                  <BlockerList blockers={blockers} onGo={focusField} />
                </div>
              ) : null}
              {actionError ? <CommandError error={actionError} className="mt-3" /> : null}
            </div>

            {waitingOn.length ? (
              <section aria-labelledby="gross-waiting-title">
                <h3 id="gross-waiting-title" className="text-sm font-semibold text-ink">
                  Waiting on
                </h3>
                <ul className="mt-1.5 flex flex-col gap-2">
                  {waitingOn.map((w) => (
                    <li key={w.key} className="flex items-start gap-2 text-sm text-ink-secondary">
                      {w.icon}
                      <span>
                        <span className="font-semibold text-ink">{w.who}</span> {w.what}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {rec && partActive && !readOnly && (!frozen || rec.state === "approved_for_downstream") ? (
              <section aria-labelledby="gross-other-title" className="flex flex-col gap-1.5">
                <h3 id="gross-other-title" className="text-sm font-semibold text-ink">
                  If something is wrong
                </h3>
                {!frozen && rec.state !== "needs_clarification" ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      disabled={!canEdit.allowed}
                      reasonId={!canEdit.allowed ? "gross-role-reason" : undefined}
                      onClick={() => setFlagOpen(true)}
                    >
                      Flag needs clarification
                    </Button>
                    <p className="text-sm text-ink-secondary">Parks the draft with your note while a question is open.</p>
                  </>
                ) : null}
                {rec.state === "approved_for_downstream" ? (
                  canApprove.allowed ? (
                    <>
                      <Button variant="secondary" size="sm" className="self-start" onClick={() => setAmendOpen(true)}>
                        Amend (creates version {rec.recordVersion + 1})
                      </Button>
                      <p className="text-sm text-ink-secondary">Version {rec.recordVersion} stays as it is and is marked superseded.</p>
                    </>
                  ) : (
                    // No control this role can never use: say who corrects an approved record.
                    <p className="text-sm text-ink-secondary">
                      A grosser, supervisor or dermatopathologist amends an approved record; that creates version {rec.recordVersion + 1} and keeps version {rec.recordVersion}.
                    </p>
                  )
                ) : null}
              </section>
            ) : null}

            {/* Keyboard legend: at the end of the column's own flow, so it never covers the step, the blockers or the actions. */}
            {rec && !frozen && !readOnly ? (
              <p className="mt-auto border-t border-line pt-3 text-sm leading-6 text-ink-muted">
                <Kbd>Enter</Kbd> confirms the field. <Kbd>Alt</Kbd>+<Kbd>↓</Kbd> next open value. <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> runs the marked step.
              </p>
            ) : null}
          </div>
        </section>
      </div>

      <Dialog
        open={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        title={`Unsaved changes for ${partLabel}`}
        initialFocusRef={stayRef}
        description="Values never carry over to another part. Choose what to do with your edits."
        role="alertdialog"
        footer={
          <>
            <Button ref={stayRef} variant="secondary" onClick={() => setPendingNav(null)}>
              Stay on Part {id.designation}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const href = pendingNav;
                clearLocal();
                setPendingNav(null);
                if (href) window.setTimeout(() => router.push(href), 0);
              }}
            >
              Discard changes
            </Button>
            <Button
              variant="primary"
              loading={saveCmd.pending}
              loadingLabel="Saving..."
              disabled={frozen}
              onClick={async () => {
                const href = pendingNav;
                const ok = await saveDraft();
                setPendingNav(null);
                if (ok && href) router.push(href);
              }}
            >
              Save draft
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          {dirtyKeys.length ? `Edited fields: ${dirtyKeys.map((k) => FIELD_LABEL[k]).join(", ")}. ` : ""}
          {narrativeDirty ? "The narrative was edited. " : ""}
          Saved typed values still need confirmation.
        </p>
      </Dialog>

      <Dialog
        open={flagOpen}
        onClose={() => setFlagOpen(false)}
        title={`Flag ${partLabel} as needing clarification`}
        description="Parks the draft with your note. A question to the office is raised separately as a clarification."
        footer={
          <>
            <Button variant="secondary" onClick={() => setFlagOpen(false)}>
              Keep as is
            </Button>
            <Button
              variant="primary"
              loading={flagCmd.pending}
              loadingLabel="Flagging..."
              disabled={flagNote.trim().length < 3 || !rec}
              onClick={async () => {
                if (!rec) return;
                const out = track(await flagCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, note: flagNote.trim() }));
                if (out.ok) {
                  setFlagOpen(false);
                  setFlagNote("");
                }
              }}
            >
              Flag needs clarification
            </Button>
          </>
        }
      >
        <Field label="What needs clarification" required hint="For example: suture orientation not stated on the requisition.">
          <Textarea rows={3} value={flagNote} onChange={(e) => setFlagNote(e.target.value)} />
        </Field>
        <CommandError error={flagCmd.error} className="mt-2" />
      </Dialog>

      <Dialog
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title={`Record how the question for ${partLabel} was resolved`}
        description="The record returns to draft with your note. It can then be marked operator reviewed."
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolveOpen(false)}>
              Keep flagged
            </Button>
            <Button variant="primary" loading={resolveCmd.pending} loadingLabel="Saving..." disabled={resolution.trim().length < 3 || !rec} onClick={() => void resolveClarification()}>
              Return to draft
            </Button>
          </>
        }
      >
        <Field label="How it was resolved" required hint="For example: office confirmed the suture marks 12 o'clock (clarification C-0412).">
          <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </Field>
        <CommandError error={resolveCmd.error} className="mt-2" />
      </Dialog>

      <Dialog
        open={amendOpen}
        onClose={() => setAmendOpen(false)}
        title={`Amend the approved gross record for ${partLabel}?`}
        initialFocusRef={keepRef}
        description={`Version ${rec?.recordVersion ?? ""} stays unchanged and is marked superseded. A new draft version is created for your correction; downstream eligibility is withdrawn until it is approved.`}
        footer={
          <>
            <Button ref={keepRef} variant="secondary" onClick={() => setAmendOpen(false)}>
              Keep version {rec?.recordVersion ?? ""}
            </Button>
            <Button
              variant="primary"
              loading={amendCmd.pending}
              loadingLabel="Creating..."
              disabled={amendReason.trim().length < 3 || !rec}
              onClick={async () => {
                if (!rec) return;
                const out = track(await amendCmd.run({ grossRecordId: rec.id, reason: amendReason.trim() }));
                if (out.ok) {
                  setAmendOpen(false);
                  setAmendReason("");
                }
              }}
            >
              Create version {(rec?.recordVersion ?? 0) + 1}
            </Button>
          </>
        }
      >
        <Field label="Reason for the amendment" required>
          <Textarea rows={3} value={amendReason} onChange={(e) => setAmendReason(e.target.value)} />
        </Field>
        <CommandError error={amendCmd.error} className="mt-2" />
      </Dialog>
    </div>
  );
}
