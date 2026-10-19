"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowRight, ChevronDown, Eye, Hourglass, UserRoundCheck } from "lucide-react";
import type { IntakeBench, ItemDetail } from "@/server/queries/intake";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Field, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { SimulatedLabel } from "@/components/domain/honesty";
import { LabelRef } from "@/components/domain/specimen-label";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useScan } from "@/lib/client/scan";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { cn } from "@/lib/cn";
import type { ClarificationDraft } from "./clarification-dialog";
import { CtrlEnterBadge } from "@/components/ui/ctrl-enter-badge";
import { Segs, useBackToScan, type StepFrame } from "./bits";
import { CutScroll } from "./cut-scroll";
import { draftForCount, draftForRow } from "./evidence-sheet";
import { REVIEW_NOT_MERGE, RecordDecision, type RelatedDecisionState } from "./related";
import { RoutingDialog } from "./routing-card";
import { SendClarification } from "./send-clarification";
import { SourceConflictDialog } from "./source-conflict-dialog";
import { identityFacts, partsOf, segs, segText, type IntakePlan, type NextAction, type WorkItem } from "./plan";

/** The related-order decision when it is this person's next step (held by the workspace, shared with the centre). */
export interface RelatedDecisionCtx {
  state: RelatedDecisionState;
  /** "Record decision" is pinned in this column (bench layouts); stacked, it follows the reason in the centre. */
  recordHere: boolean;
}

interface VerifyResult {
  state: "verified" | "discrepancy";
  discrepancies: { field: string; label: string }[];
  stillOpen: { field: string; label: string }[];
}

function verifyToast(seq: number, r: VerifyResult): string {
  if (r.state === "verified") return `Container ${seq}: your check is recorded; every compared field agrees`;
  const parts: string[] = [];
  if (r.discrepancies.length) parts.push(`discrepancy recorded (${r.discrepancies.map((d) => d.label.toLowerCase()).join(", ")}); both values kept`);
  if (r.stillOpen.length) parts.push(`recorded mismatch still open (${r.stillOpen.map((d) => d.label.toLowerCase()).join(", ")})`);
  return `Container ${seq}: your check is recorded; ${parts.join("; ")}`;
}

type VerifyAction = Extract<NextAction, { kind: "verify" }>;
type ConflictAction = Extract<NextAction, { kind: "review_source_conflict" }>;

/** "Also yours now": the button right under its title, details after it, so the list stays scannable in a short column. */
const actionFirst: StepFrame = ({ body, action }) => (
  <div className="space-y-1.5">
    {action}
    {body}
  </div>
);

/** Secondary actions in "Also yours now": small, and the label may wrap in the narrow column. */
const SECONDARY_WRAP = "h-auto whitespace-normal py-1.5 text-left leading-5";

/** The container check: always a deliberate click or Enter on this button; Ctrl+Enter and scans never record it. */
function VerifyControl({ action, item, primary, frame, onFailure }: { action: VerifyAction; item: ItemDetail; primary: boolean; frame: StepFrame; onFailure?: () => void }) {
  const backToScan = useBackToScan();
  const parts = item.orders.flatMap((o) => o.parts.map((p) => ({ id: p.id, label: `${o.sourceOrderId} part ${p.designation} (${p.siteText})` })));
  const [partId, setPartId] = useState(action.orderPartId ?? "");
  const [choosing, setChoosing] = useState(action.needsPart);
  const whereId = useId();
  const hintId = useId();
  const verify = useCommand<VerifyResult, { containerId: string; expectedVersion: number; orderPartId: string }>("intake.verifyContainer", {
    successToast: (r) => verifyToast(action.seq, r),
    errorToast: false,
    onSuccess: () => backToScan(),
    onError: () => onFailure?.(),
  });
  const order = item.orders.find((o) => o.parts.some((p) => p.id === partId));
  const body = (
    <div className="space-y-2">
      {parts.length > 1 && choosing ? (
        <Field label="Order part this bottle belongs to" hint={action.needsPart ? "Not matched automatically. Choose the part, then record the check." : "Change it only if the link is wrong."}>
          <Select size="sm" value={partId} onChange={(e) => setPartId(e.target.value)}>
            {action.needsPart ? <option value="">Choose a part</option> : null}
            {parts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <p id={whereId} className="text-sm text-ink-secondary">
        Container {action.seq} of {action.total}
        {order ? (
          <>
            {" "}
            against <span className="id-mono">{order.sourceOrderId}</span> part {order.parts.find((p) => p.id === partId)?.designation ?? "?"} v{order.sourceVersion}
          </>
        ) : null}
        .
        {parts.length > 1 && !choosing ? (
          <>
            {" "}
            <button type="button" onClick={() => setChoosing(true)} className="font-medium text-brand underline-offset-2 hover:underline">
              Change the part
            </button>
          </>
        ) : null}
      </p>
      <p id={hintId} className="text-sm text-ink-muted">
        Records your name and the time. Ctrl+Enter never records it.
      </p>
    </div>
  );
  const control = (
    <div className="space-y-1.5">
      <Button
        variant={primary ? "primary" : "secondary"}
        size={primary ? "block" : "md"}
        icon={<UserRoundCheck />}
        loading={verify.pending}
        loadingLabel="Recording..."
        disabled={!partId}
        data-intake-verify=""
        aria-describedby={`${whereId} ${hintId}`}
        className={primary ? undefined : SECONDARY_WRAP}
        onClick={() => void verify.run({ containerId: action.containerId, expectedVersion: action.version, orderPartId: partId })}
      >
        Record: I checked this bottle against the order
      </Button>
      <CommandError error={verify.error} />
    </div>
  );
  return frame({ body, action: control });
}

/**
 * The control for one work item, handed to `frame` as a body and an action.
 * `primary` marks the current step: it carries the Ctrl+Enter badge, and its
 * button keeps only the verb because the step heading already says what.
 */
function ActionControl({
  w,
  item,
  bench,
  primary,
  frame,
  onRaise,
  onAssign,
  onReviewConflict,
  onFailure,
  related = null,
}: {
  w: WorkItem;
  item: ItemDetail;
  bench: IntakeBench;
  primary: boolean;
  frame: StepFrame;
  onRaise: (d: ClarificationDraft) => void;
  onAssign: () => void;
  onReviewConflict: (a: ConflictAction) => void;
  /** A command from this control failed (its error shows inline): "Also yours now" stays open so the error is not folded away. */
  onFailure?: () => void;
  /** The related-order decision held by the workspace (its evidence and choices lead the centre); `recordHere`: "Record decision" sits in this column. */
  related?: RelatedDecisionCtx | null;
}) {
  const backToScan = useBackToScan();
  const a = w.action;
  if (!a) return frame({});
  const variant = primary ? "primary" : "secondary";
  // A step that is also yours (not the current one) is still a record or decision button: 40px, not the compact 32px.
  const size = primary ? "block" : "md";
  const wide = primary ? undefined : SECONDARY_WRAP;
  const keys = primary ? "Control+Enter Meta+Enter" : undefined;
  const mark = primary ? "" : undefined;
  const badge = primary ? <CtrlEnterBadge onDark /> : null;
  switch (a.kind) {
    case "verify":
      return <VerifyControl action={a} item={item} primary={primary} frame={frame} onFailure={onFailure} />;
    case "raise": {
      const c = item.containers.find((x) => x.id === a.containerId);
      const row = c?.comparison.find((r) => r.field === a.field);
      if (!c || !row) return frame({});
      return frame({
        action: (
          <Button variant={variant} size={size} className={wide} aria-keyshortcuts={keys} data-intake-primary={mark} onClick={() => onRaise(draftForRow(item, c, row))}>
            Raise clarification
            {badge}
          </Button>
        ),
      });
    }
    case "raise_missing": {
      const m = item.missingParts.find((x) => x.orderPartId === a.orderPartId);
      if (!m) return frame({});
      return frame({
        action: (
          <Button variant={variant} size={size} className={wide} aria-keyshortcuts={keys} data-intake-primary={mark} onClick={() => onRaise(draftForCount(item, m))}>
            Raise clarification
            {badge}
          </Button>
        ),
      });
    }
    case "send":
      return <SendClarification action={a} primary={primary} assistantMode={bench.assistantMode} frame={frame} />;
    case "open_clarification":
      return frame({
        action: (
          <ButtonLink href={`/clarifications?selected=${encodeURIComponent(a.displayId)}`} variant={variant} size={size} className={wide} aria-keyshortcuts={keys} data-intake-primary={mark} icon={<ArrowRight />}>
            {a.label}
            {badge}
          </ButtonLink>
        ),
      });
    case "review_related": {
      const cand = item.related.find((r) => r.id === a.candidateId);
      if (!cand) return frame({});
      // The choices never sit here: they follow the two submissions side by side in the centre, so nobody
      // picks a relationship without the conflicting information on screen. This column keeps the step,
      // the review-not-merge rule and (at bench widths) "Record decision".
      if (primary && related && related.state.cand.id === cand.id) {
        return frame({
          body: (
            <p className="text-sm text-ink-secondary">
              {cand.duplicateRecordKind ? "Possible duplicate patient record: different patient references are never joined. " : null}
              {REVIEW_NOT_MERGE}
              {related.recordHere ? null : " Compare the two submissions below, then choose and record the decision there."}
            </p>
          ),
          action: related.recordHere ? <RecordDecision s={related.state} primary /> : undefined,
        });
      }
      return frame({
        action: (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const el = document.getElementById("related-orders");
              el?.scrollIntoView({ block: "start" });
              el?.focus({ preventScroll: true });
            }}
          >
            Review <span className="id-mono">{cand.displayId}</span>
          </Button>
        ),
      });
    }
    case "review_source_conflict":
      return frame({
        action: (
          <Button variant={variant} size={size} className={wide} aria-keyshortcuts={keys} aria-haspopup="dialog" data-intake-primary={mark} onClick={() => onReviewConflict(a)}>
            Review source conflict
            {badge}
          </Button>
        ),
      });
    case "resolve_routing":
      return frame({
        action: (
          <Button variant={variant} size={size} className={wide} aria-keyshortcuts={keys} data-intake-primary={mark} onClick={onAssign}>
            Choose the dermatopathologist
            {badge}
          </Button>
        ),
      });
    case "accept_routing":
      return frame({
        action: (
          <span data-intake-primary={mark} className="contents">
            <CommandButton
              command="routing.confirm"
              input={{ intakeItemId: item.id }}
              variant={variant}
              size={size}
              className={wide}
              wrapperClassName={primary ? "w-full" : undefined}
              pendingLabel="Accepting..."
              successToast={`Routing accepted: ${a.doctorName}`}
              onSuccess={() => backToScan()}
              onError={() => onFailure?.()}
            >
              {primary ? "Accept routing" : `Accept routing to ${a.doctorName}`}
              {badge}
            </CommandButton>
          </span>
        ),
      });
    case "request":
      return frame({});
  }
}

function AccessionDock({ item, plan, bench, primary }: { item: ItemDetail; plan: IntakePlan; bench: IntakeBench; primary: boolean }) {
  const toast = useToast();
  const scan = useScan();
  const backToScan = useBackToScan();
  const reasonId = useId();
  const [explainKey, setExplainKey] = useState(0);
  const acc = plan.accession;
  const req = useCommand<{ outcome: string; accessionNumber: string | null; message: string }, { intakeItemIds: string[]; relatedCandidateId?: string | null }>("accession.request", {
    errorToast: false,
    onSuccess: (r, meta) => {
      backToScan();
      if (meta.replayed) return;
      if (r.outcome === "issued") toast.show({ tone: "success", title: `Accession ${r.accessionNumber} issued by EMA-SIM (simulated)`, body: r.message });
      else if (r.outcome === "source_offline") toast.show({ tone: "warning", title: "Source system unreachable (simulated outage)", body: r.message });
      else toast.show({ tone: "info", title: r.message });
    },
  });

  if (acc.state === "issued" && item.accession) {
    return (
      <div className="space-y-2 border-t border-line bg-surface px-4 py-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-secondary">
          <SimulatedLabel connector="EMA-SIM" size="xs">
            Issued by EMA-SIM (simulated)
          </SimulatedLabel>
          <span>
            <Timestamp iso={item.accession.issuedAt} now={bench.now} />; provisional <span className="id-mono">{item.displayId}</span> stays on record
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink href={`/cases/${encodeURIComponent(item.accession.number)}`} variant="primary" size="sm" icon={<ArrowRight />}>
            Open case {item.accession.number}
          </ButtonLink>
          {bench.permissions.print && !bench.readOnly ? (
            <CommandButton
              command="print.request"
              input={{ targetType: "accession", targetId: item.accession.id, kind: "requisition_label", purpose: "initial" }}
              size="sm"
              pendingLabel="Queuing..."
              successToast={(r: { displayId: string; stateLabel: string; message: string; printerUnavailable?: boolean; outcome: string }) =>
                r.printerUnavailable || r.outcome === "duplicate_prevented" ? null : `${r.displayId}: ${r.stateLabel} (simulated printer). ${r.message}`
              }
              onSuccess={(r: { displayId: string; stateLabel: string; message: string; printerUnavailable?: boolean; outcome: string }) => {
                if (r.printerUnavailable) toast.show({ tone: "warning", title: `Printer unavailable: ${r.displayId} queued, not printed`, body: `${r.message} Track it in Materials > Print jobs.` });
                else if (r.outcome === "duplicate_prevented") toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
                backToScan();
              }}
            >
              Print sticker (simulated)
            </CommandButton>
          ) : null}
        </div>
      </div>
    );
  }

  const ready = acc.state === "ready";
  const live = primary && ready;
  return (
    <div className="space-y-1.5 border-t border-line bg-surface px-4 py-3">
      <button
        id="accession-request"
        type="button"
        aria-disabled={!ready || req.pending || undefined}
        aria-describedby={reasonId}
        aria-keyshortcuts={live ? "Control+Enter Meta+Enter" : undefined}
        data-intake-primary={live ? "" : undefined}
        onClick={() => {
          if (req.pending) return;
          if (!ready) {
            setExplainKey((k) => k + 1);
            scan.setResult({ tone: "info", message: segText(acc.reason) });
            return;
          }
          void req.run({ intakeItemIds: acc.ids, relatedCandidateId: acc.candidateId });
        }}
        // aria-disabled (not disabled) so a click or Ctrl+Enter can still say why; it reads like the shared disabled button.
        className={buttonClasses({
          variant: ready ? "primary" : "secondary",
          size: "block",
          className: "aria-disabled:cursor-not-allowed aria-disabled:border-line aria-disabled:bg-surface-subtle aria-disabled:text-ink-muted aria-disabled:hover:bg-surface-subtle",
        })}
      >
        {req.pending ? (
          "Requesting..."
        ) : (
          <span>
            <Segs value={segs(acc.label)} />
          </span>
        )}
        {live ? <CtrlEnterBadge onDark /> : null}
      </button>
      <p key={explainKey} id={reasonId} className={cn("text-sm", ready ? "text-ink" : "text-ink-secondary", explainKey > 0 && "animate-rise-in")}>
        <Segs value={acc.reason} />
        {acc.holdNote ? (
          <>
            {" "}
            <Segs value={acc.holdNote} />
          </>
        ) : null}
      </p>
      {acc.blockers.length > 1 ? (
        <details className="text-sm text-ink-secondary">
          <summary className="cursor-pointer font-medium text-brand">Show all {acc.blockers.length} reasons</summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5">
            {acc.blockers.map((b, i) => (
              <li key={i}>
                <Segs value={b} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {acc.groupNote ? (
        <p className="text-sm text-ink-secondary">
          <Segs value={acc.groupNote} />
        </p>
      ) : null}
      {acc.pendingNote ? (
        <p className="text-sm text-warning-fg">
          <Segs value={acc.pendingNote} />
        </p>
      ) : null}
      <CommandError error={req.error} />
    </div>
  );
}

/**
 * The next-step sheet: the step heading (the action itself, e.g. "Send
 * CLR-0457 to Harbor Point Dermatology") and the primary action stay pinned.
 * In a short column only the body between them scrolls, and it is cut at
 * whole lines, options and fields with an explicit cue ("More below", or
 * "2 more options below" for a choice). The body ends right at its cue: the
 * room a cut gives back goes to the column, not to an empty strip.
 */
function NextStepSheet({
  title,
  detail,
  body,
  action,
  folded = false,
  onUnfold,
}: {
  title: ReactNode;
  detail: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  /** A short column with "Also yours now" opened: the step keeps its heading and action, its details fold to one line. */
  folded?: boolean;
  onUnfold?: () => void;
}) {
  const hasBody = !!detail || !!body;
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const foldRef = useRef<HTMLDivElement>(null);
  // The sheet may give up body lines to a short column, never its heading, the cue or its action:
  // its card is floored at heading + 3rem + action (the card itself is otherwise free to shrink).
  useEffect(() => {
    const card = rootRef.current?.parentElement;
    if (!card) return;
    const floor = () => {
      const h = (titleRef.current?.offsetHeight ?? 0) + (actionRef.current?.offsetHeight ?? 0) + (hasBody && !folded ? 48 : 0) + (folded ? (foldRef.current?.offsetHeight ?? 0) : 0) + 2;
      card.style.minHeight = `${h}px`;
    };
    floor();
    const ro = new ResizeObserver(floor);
    if (titleRef.current) ro.observe(titleRef.current);
    if (actionRef.current) ro.observe(actionRef.current);
    return () => {
      ro.disconnect();
      card.style.minHeight = "";
    };
  }, [hasBody, folded]);
  return (
    <div ref={rootRef} data-folded={folded && hasBody ? "" : undefined} className="flex min-h-0 flex-1 flex-col">
      <h3 ref={titleRef} className="shrink-0 px-4 pt-3.5 pb-2 text-md leading-6 font-bold tracking-[-0.01em] text-balance text-ink max-xl:px-3">
        {title}
      </h3>
      {hasBody && folded ? (
        <div ref={foldRef} className="shrink-0 px-4 pb-2 max-xl:px-3">
          <button
            type="button"
            data-unfold=""
            onClick={onUnfold}
            className="-ml-1.5 inline-flex min-h-[max(2rem,var(--hlo-target-min))] items-center gap-1 rounded-sm px-1.5 text-sm font-medium text-brand hover:bg-brand-50"
          >
            <ChevronDown className="size-4" aria-hidden />
            Show the step details
          </button>
        </div>
      ) : hasBody ? (
        <CutScroll
          label="your next step"
          snap
          countSelector="[data-cut-option]"
          countNoun="option"
          className="flex-[0_1_auto]"
          scrollerClassName="px-4 pb-3 max-xl:px-3"
          contentClassName="space-y-2.5"
        >
          {detail}
          {body}
        </CutScroll>
      ) : null}
      {action ? (
        <div ref={actionRef} className={cn("shrink-0 px-4 pb-3.5 max-xl:px-3", hasBody && "border-t border-line pt-3")}>
          {action}
        </div>
      ) : null}
    </div>
  );
}

/** Stacked, page-scrolling layout: below 1024px wide or 560px tall (200% zoom of a bench screen). */
const STACKED_QUERY = "(max-width: 63.99875rem), (max-height: 35rem)";

type AlsoMode = "list" | "collapsed" | "open";

/**
 * Whether "Also yours now" can show at least its first task whole beside the
 * next step at its full height. If not, the list folds to its heading and a
 * count (a disclosure), so the next step never gives up lines to it.
 */
function useAlsoMode(asideRef: RefObject<HTMLElement | null>, count: number, open: boolean, stepKey: string): AlsoMode {
  const [fits, setFits] = useState(true);
  const firstItem = useRef(72);
  const unfolded = useRef(0);
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside || !count) return;
    const stacked = window.matchMedia(STACKED_QUERY);
    let frame = 0;
    const compute = () => {
      if (stacked.matches) return setFits(true);
      const part = (sel: string) => aside.querySelector<HTMLElement>(`:scope > [data-part='${sel}']`);
      const card = part("next");
      const waiting = part("waiting");
      const alsoHead = aside.querySelector<HTMLElement>("[data-part='also-head']");
      const dock = part("dock");
      if (!card || !waiting || !alsoHead || !dock) return;
      // While the step is folded (list opened on request) its full height is the one measured before folding.
      const body = card.querySelector<HTMLElement>("[data-cut-scroller]");
      if (!card.querySelector("[data-folded]")) {
        unfolded.current = card.offsetHeight + (body ? Math.max(0, body.scrollHeight - body.clientHeight) : 0) + parseFloat(getComputedStyle(card).marginTop || "0");
      }
      const cardNatural = unfolded.current;
      const li = aside.querySelector<HTMLElement>("[data-part='also-list'] li");
      if (li && li.offsetHeight) firstItem.current = li.offsetHeight;
      // The list's "N more below" sits in its heading row, so one whole task is enough.
      const free = aside.clientHeight - cardNatural - waiting.offsetHeight - alsoHead.offsetHeight - dock.offsetHeight - 12;
      setFits(free >= firstItem.current);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(compute);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(aside);
    for (const el of aside.querySelectorAll<HTMLElement>(":scope > [data-part], [data-cut-scroller] > div")) ro.observe(el);
    stacked.addEventListener("change", schedule);
    compute();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      stacked.removeEventListener("change", schedule);
    };
  }, [asideRef, count, stepKey]);
  return fits ? "list" : open ? "open" : "collapsed";
}

/**
 * Decision column (fixed beside the evidence): this actor's next step with its
 * one primary action and the Ctrl+Enter badge, who else is being waited on,
 * the other things they can do now, and the accession request at the foot
 * with its precise reason. The step heading, the primary action, "Waiting on"
 * and the request never scroll away. Nothing is ever cut mid-line: a short
 * step body ends at a whole unit with a "More below" cue, and when "Also yours
 * now" cannot show a whole task it folds to a count you can open.
 * Stacked (narrow or 200% zoom): a band between the finding and the evidence,
 * the next step beside waiting-on, other tasks and the request.
 */
export function DecisionColumn({
  bench,
  item,
  plan,
  onRaise,
  onOpenItem,
  related = null,
  className,
}: {
  bench: IntakeBench;
  item: ItemDetail;
  plan: IntakePlan;
  onRaise: (d: ClarificationDraft) => void;
  onOpenItem: (displayId: string) => void;
  /** The related-order decision when it is this person's next step (held by the workspace, shared with the centre). */
  related?: RelatedDecisionCtx | null;
  className?: string;
}) {
  const [assigning, setAssigning] = useState(false);
  const [reviewing, setReviewing] = useState<ConflictAction | null>(null);
  const [alsoOpen, setAlsoOpen] = useState(false);
  // A failed action in "Also yours now" grows the list by its error; if the list then stopped fitting it would fold to
  // titles and unmount the error with its button. Opening it keeps the failed task, its error and its retry on screen.
  const keepAlsoOpen = useCallback(() => setAlsoOpen(true), []);
  const asideRef = useRef<HTMLElement>(null);
  const alsoListId = useId();
  const next = plan.next;
  const requestIsNext = next?.action?.kind === "request";
  const onAssign = () => setAssigning(true);
  const alsoCount = plan.also.length;
  const alsoMode = useAlsoMode(asideRef, alsoCount, alsoOpen, next?.key ?? "idle");
  // "N more below" for the task list sits in its heading row (CutScroll reports the count and scrolls on request).
  const [alsoMore, setAlsoMore] = useState(0);
  const alsoControl = useRef<{ showMore: () => void } | null>(null);
  const alsoExternal = useMemo(() => ({ onMore: setAlsoMore, control: alsoControl }), []);
  const parts = partsOf(item);
  const patient = identityFacts(item).name.value;

  const nextFrame: StepFrame = ({ body, action }) =>
    next ? (
      <NextStepSheet
        title={<Segs value={next.title} />}
        detail={
          next.detail.length && next.action?.kind !== "send" ? (
            <p className="text-sm text-ink-secondary">
              <Segs value={next.detail} />
            </p>
          ) : null
        }
        body={body}
        action={action}
        folded={alsoMode === "open"}
        onUnfold={() => setAlsoOpen(false)}
      />
    ) : null;

  return (
    <aside
      ref={asideRef}
      aria-label="Decision"
      className={cn(
        // When even the floors of its parts do not fit (large text, a long reason, a validation message), the
        // column scrolls as a whole instead of clipping its foot (the accession request).
        "relative flex min-h-0 flex-col overflow-y-auto overscroll-contain border-l border-line bg-surface-subtle",
        "stacked:grid stacked:grid-cols-1 stacked:items-start stacked:overflow-visible stacked:border-b stacked:border-l-0 stacked:sm:grid-cols-2",
        className,
      )}
    >
      <section
        aria-label="Your next step"
        key={next?.key ?? "idle"}
        data-part="next"
        className={cn(
          "animate-swap-in mx-3 mt-3 flex min-h-0 flex-col rounded-lg border border-line bg-surface shadow-1 max-xl:mx-2 max-xl:mt-2 stacked:mb-2 stacked:sm:row-span-3",
          // Opened on request, "Also yours now" keeps its room: the step body gives way first (down to its floor).
          alsoMode === "open" ? "flex-[0_100_auto]" : "flex-[0_1_auto]",
        )}
      >
        {/* Stacked, the identity band has scrolled away: the step names the item it acts on. */}
        <p className="hidden flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2 text-sm text-ink-secondary max-xl:px-3 stacked:flex">
          <LabelRef id={item.accession?.number ?? item.displayId} provisional={!item.accession} />
          <span>
            {parts.length ? `${parts.length > 1 ? "Parts" : "Part"} ${parts.join(" and ")}` : "Item"}, {patient ?? "patient unknown"}
          </span>
        </p>
        {next ? (
          <ActionControl w={next} item={item} bench={bench} primary frame={nextFrame} onRaise={onRaise} onAssign={onAssign} onReviewConflict={setReviewing} related={related} />
        ) : plan.idle ? (
          <NextStepSheet
            title={
              bench.readOnly ? (
                <span className="inline-flex items-center gap-2">
                  <Eye className="size-4 text-ink-muted" aria-hidden />
                  <Segs value={plan.idle.title} />
                </span>
              ) : (
                <Segs value={plan.idle.title} />
              )
            }
            detail={
              bench.readOnly ? (
                <p className="text-sm text-ink-secondary">
                  {ROLE_LABEL[bench.actor.role as Role] ?? bench.actor.role} can view but not change records. The people below can act on it.
                </p>
              ) : (
                <p className="text-sm text-ink-secondary">
                  <Segs value={plan.idle.detail} />
                </p>
              )
            }
            action={
              plan.nextItem ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button variant="secondary" aria-keyshortcuts="Control+Enter Meta+Enter J" data-intake-primary="" onClick={() => onOpenItem(plan.nextItem!.displayId)}>
                    Open <span className="id-mono">{plan.nextItem.displayId}</span>
                    <CtrlEnterBadge />
                  </Button>
                  <span className="text-sm text-ink-muted">or press J</span>
                </div>
              ) : null
            }
          />
        ) : null}
      </section>

      <section aria-labelledby="waiting-title" data-part="waiting" className="shrink-0 px-4 py-3 max-xl:px-3">
        {plan.waitingOn.length ? (
          <>
            <h3 id="waiting-title" className="text-sm font-semibold text-ink">
              Waiting on
            </h3>
            <ul className="mt-1 space-y-1.5">
              {plan.waitingOn.map((w) => (
                <li key={w.key} className="flex items-start gap-2 text-sm">
                  <Hourglass className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
                  <span>
                    <span className="font-semibold text-ink">{w.who}</span>{" "}
                    <span className="text-ink-secondary">
                      to <Segs value={w.what} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            <span id="waiting-title" className="font-semibold text-ink">
              Waiting on
            </span>{" "}
            nobody else on this item.
          </p>
        )}
      </section>
      {alsoCount ? (
        <section
          aria-labelledby="also-title"
          data-part="also"
          className={cn(
            "flex min-h-0 flex-col border-t border-line",
            // Folded, it takes the room left above the request: its heading and count, then as many task titles as fit whole.
            alsoMode === "list" ? "flex-1" : alsoMode === "collapsed" ? "flex-[1_0_auto]" : "max-h-[55%] min-h-[5.5rem] flex-[0_1_auto]",
          )}
        >
          <div data-part="also-head" className="flex shrink-0 flex-wrap items-center gap-x-2 px-4 pt-2 max-xl:px-3">
            <h3 id="also-title" className="mr-auto py-1 text-sm font-semibold text-ink">
              Also yours now <span className="num-tabular font-normal text-ink-muted">{alsoCount}</span>
            </h3>
            {alsoMore && alsoMode !== "collapsed" ? (
              <button
                type="button"
                aria-label={`${alsoMore} more ${alsoMore === 1 ? "task" : "tasks"} below in also yours now`}
                onClick={() => alsoControl.current?.showMore()}
                className="inline-flex min-h-[max(2rem,var(--hlo-target-min))] items-center gap-1 rounded-sm px-1.5 text-sm font-medium text-brand hover:bg-brand-50"
              >
                <ChevronDown className="size-4" aria-hidden />
                {alsoMore} more below
              </button>
            ) : null}
            {alsoMode === "list" ? null : (
              <button
                type="button"
                aria-expanded={alsoMode === "open"}
                aria-controls={alsoListId}
                onClick={() => setAlsoOpen((o) => !o)}
                className="-mr-1.5 inline-flex min-h-[max(2rem,var(--hlo-target-min))] items-center gap-1 rounded-sm px-1.5 text-sm font-medium text-brand hover:bg-brand-50"
              >
                {alsoMode === "open" ? "Hide" : alsoCount === 1 ? "Show it" : `Show all ${alsoCount}`}
                <ChevronDown className={cn("size-4 transition-transform duration-[var(--hlo-duration-fast)]", alsoMode === "open" && "rotate-180")} aria-hidden />
              </button>
            )}
          </div>
          {alsoMode === "collapsed" ? (
            // Titles only, one whole line each; a title that does not fit wraps into a second column out of view.
            // "Show all" opens the tasks with their actions.
            // At least one whole title tall: with less room the column scrolls rather than showing half a line.
            <div className="relative min-h-7 flex-1">
              <ul aria-label="Also yours now, titles only" className="absolute inset-x-4 top-0 bottom-2 flex flex-col flex-wrap content-start gap-x-8 overflow-hidden max-xl:inset-x-3">
                {plan.also.map((w) => (
                  <li key={w.key} className="flex w-full shrink-0 items-center gap-1.5 text-sm leading-5 text-ink-secondary">
                    <ArrowRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
                    <span className="min-w-0 truncate">
                      <Segs value={w.title} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <CutScroll label="also yours now" tone="subtle" countSelector="li" external={alsoExternal} className="flex-1" scrollerClassName="px-4 pt-1 pb-3 max-xl:px-3">
              <ul id={alsoListId} data-part="also-list" className="space-y-2">
                {plan.also.map((w) => (
                  <li key={w.key} data-cut-keep="" className="space-y-1">
                    {w.action?.kind === "accept_routing" ? null : (
                      <p className="text-sm text-ink">
                        <Segs value={w.title} />
                      </p>
                    )}
                    {w.action?.kind === "send" ? null : (
                      <ActionControl w={w} item={item} bench={bench} primary={false} frame={actionFirst} onRaise={onRaise} onAssign={onAssign} onReviewConflict={setReviewing} onFailure={keepAlsoOpen} />
                    )}
                  </li>
                ))}
              </ul>
            </CutScroll>
          )}
        </section>
      ) : null}
      <div data-part="dock" className={cn("shrink-0", alsoCount && alsoMode === "collapsed" ? null : "mt-auto")}>
        <AccessionDock item={item} plan={plan} bench={bench} primary={requestIsNext} />
      </div>
      {assigning ? <RoutingDialog mode="resolve" item={item} current={null} pathologists={bench.pathologists} onClose={() => setAssigning(false)} /> : null}
      {reviewing ? <SourceConflictDialog action={reviewing} item={item} onClose={() => setReviewing(null)} /> : null}
    </aside>
  );
}
