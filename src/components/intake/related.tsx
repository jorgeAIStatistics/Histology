"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { Check, CircleHelp, CirclePause, EqualNot, TriangleAlert } from "lucide-react";
import type { BenchPermissions, ItemDetail, RelatedView, SiblingView } from "@/server/queries/intake";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { AccessionChip, IdChip, ProvisionalChip } from "@/components/domain/chips";
import { LabelRef } from "@/components/domain/specimen-label";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand, type CommandFailure } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { RELATED_STATUS } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { fmtDate } from "@/lib/time";
import type { ClarificationDraft } from "./clarification-dialog";
import { CtrlEnterBadge } from "@/components/ui/ctrl-enter-badge";
import { Segs, stackFrame, useBackToScan, type StepFrame } from "./bits";
import { partsOf, segs } from "./plan";

type Decision = "single_accession_approved" | "keep_separate" | "not_related" | "escalated_to_office";

/** `name`: the option in a few words, said under a "2 more options below" cue when the list is cut. */
const DECISIONS: { value: Decision; label: string; name: string; hint: string }[] = [
  { value: "single_accession_approved", label: "Link as related: one accession, parts kept with their original orders", name: "Link as related", hint: "Nothing is merged." },
  { value: "keep_separate", label: "Keep separate (separate cases)", name: "Keep separate", hint: "Each is requested on its own." },
  { value: "not_related", label: "Not related", name: "Not related", hint: "The match was coincidental." },
  { value: "escalated_to_office", label: "Ask the office first", name: "Ask the office first", hint: "Accession waits for the answer." },
];

const TONE: Record<string, "warning" | "success" | "info" | "neutral"> = {
  pending_review: "neutral",
  single_accession_approved: "neutral",
  keep_separate: "neutral",
  not_related: "neutral",
  escalated_to_office: "neutral",
};

/** The safeguard said with every related-order decision, wherever its choices sit. */
export const REVIEW_NOT_MERGE = "Review, not merge. Both orders and both provisional ids are kept.";

/** What recording each choice would do, said before anything is recorded. */
function effectOf(decision: Decision, members: string[], orders: string[]): string {
  const items = members.join(" and ");
  const ords = orders.join(" and ");
  switch (decision) {
    case "single_accession_approved":
      return `If recorded: ${items} are requested together as one accession. Parts keep their original orders (${ords}) and both provisional ids stay on record. Nothing is merged.`;
    case "keep_separate":
      return `If recorded: ${items} become separate cases, cross-referenced; each is requested on its own. Nothing is merged.`;
    case "not_related":
      return `If recorded: the match is marked coincidental and each item continues on its own. Nothing is merged.`;
    case "escalated_to_office":
      return `If recorded: accession for ${items} waits until the office answers and a decision is recorded. Nothing is merged.`;
  }
}

type DecisionCand = Pick<RelatedView, "id" | "displayId" | "version" | "duplicateRecordKind" | "orders" | "otherItems">;

/**
 * One related-order decision in progress (lead or supervisor): the choice, the
 * reason and the command. Held once and shared by the choices, wherever they
 * sit (the wide band in the centre, or the decision column), and by "Record
 * decision", which stays pinned in the decision column.
 */
export interface RelatedDecisionState {
  cand: DecisionCand;
  decision: Decision | "";
  choose: (d: Decision) => void;
  reason: string;
  setReason: (r: string) => void;
  /** Why "Record decision" cannot run yet; null when it can. */
  why: string | null;
  /** "If recorded: ..." for the current choice; null before a choice. */
  effect: string | null;
  /** Shown after "Record decision" was pressed with something missing (next to the choices and the reason). */
  choiceError: string | null;
  reasonError: string | null;
  /** Where the missing input is focused when "Record decision" is pressed too early. */
  choiceRef: RefObject<HTMLInputElement | null>;
  reasonRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  error: CommandFailure | null;
  /** Records the decision, or (choice or reason missing) shows what is missing and moves focus there; records nothing. */
  record: () => void;
}

export function useRelatedDecision(item: ItemDetail, cand: DecisionCand | null, siblings: SiblingView[], onDone?: () => void): RelatedDecisionState | null {
  const [decision, setDecision] = useState<Decision | "">("");
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const choiceRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const backToScan = useBackToScan();
  useUnsavedChanges(!!cand && reason.trim().length > 0, `decision on ${cand?.displayId ?? "the related orders"}`);
  const review = useCommand<{ status: string }, { candidateId: string; expectedVersion: number; decision: Decision; reason: string }>("related.review", {
    successToast: (r) => `${cand?.displayId ?? "Related orders"}: ${RELATED_STATUS[r.status as keyof typeof RELATED_STATUS] ?? r.status}`,
    errorToast: false,
    onSuccess: () => {
      setDecision("");
      setReason("");
      setAttempted(false);
      onDone?.();
      backToScan();
    },
  });
  if (!cand) return null;
  const members = [item.displayId, ...cand.otherItems.map((o) => o.displayId)].sort();
  const orders = [...new Set([...item.orders.map((o) => o.sourceOrderId), ...siblings.map((s) => s.orderRef).filter((x): x is string => !!x), ...cand.orders.map((o) => o.sourceOrderId)])].sort();
  return {
    cand,
    decision,
    choose: setDecision,
    reason,
    setReason,
    why: !decision ? "Choose a decision and give a reason." : !reason.trim() ? "Give a reason; it is recorded with your name." : null,
    effect: decision ? effectOf(decision, members, orders) : null,
    choiceError: attempted && !decision ? "Choose one of the four decisions." : null,
    reasonError: attempted && !reason.trim() ? "A reason is required: say why. It is recorded with your name." : null,
    choiceRef,
    reasonRef,
    pending: review.pending,
    error: review.error,
    record: () => {
      if (decision && reason.trim()) {
        void review.run({ candidateId: cand.id, expectedVersion: cand.version, decision, reason: reason.trim() });
        return;
      }
      // Nothing is recorded: say what is missing where it is entered, and take focus there (the band in the
      // centre keeps the two submissions above the choices in view as it scrolls to them).
      setAttempted(true);
      const el = !decision ? choiceRef.current : reasonRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      (el.closest<HTMLElement>("[data-rel-choices]") ?? el).scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
    },
  };
}

/**
 * The four choices, the effect of the chosen one and the required reason.
 * `stack`: one column (the decision column, "Change decision"); the effect
 * follows the choices. `band`: the wide band in the centre; the choices on the
 * left and, next to them, the effect of the chosen one above the reason.
 */
export function RelatedChoices({ s, layout = "stack", legend = "visible" }: { s: RelatedDecisionState; layout?: "stack" | "band"; legend?: "visible" | "hidden" }) {
  const reasonId = useId();
  const choiceErrId = useId();
  const { cand, decision } = s;
  // The effect of a choice is said before anything is recorded: bring it into view in a short column.
  const effectRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!decision || layout === "band") return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    effectRef.current?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [decision, layout]);
  const band = layout === "band";
  const options = (
    <div className={band ? "space-y-0.5" : "space-y-1"}>
      {DECISIONS.map((d, i) => {
        const disabled = cand.duplicateRecordKind && d.value === "single_accession_approved";
        const first = i === DECISIONS.findIndex((x) => !(cand.duplicateRecordKind && x.value === "single_accession_approved"));
        return (
          <label
            key={d.value}
            data-cut-option=""
            data-cut-name={d.name}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-md px-2 text-base transition-colors duration-[var(--hlo-duration-fast)] max-xl:min-h-11",
              band ? "py-1" : "py-1.5",
              decision === d.value ? "bg-brand-50" : disabled ? null : "hover:bg-surface-subtle",
              disabled && "cursor-not-allowed",
            )}
          >
            <input
              ref={first ? s.choiceRef : undefined}
              type="radio"
              name={`rel-${cand.id}-${layout}`}
              value={d.value}
              checked={decision === d.value}
              disabled={disabled}
              aria-invalid={s.choiceError ? true : undefined}
              aria-describedby={s.choiceError ? choiceErrId : undefined}
              onChange={() => s.choose(d.value)}
              className="mt-1 size-4 shrink-0 accent-[var(--hlo-brand)]"
            />
            {/* Unavailable stays legible (muted ink, no fade) and says why. In the band the chosen option's effect sits beside the list instead of a hint. */}
            <span className="text-sm leading-5">
              <span className={cn("font-medium", disabled ? "text-ink-muted" : "text-ink")}>{d.label}.</span>
              {disabled || !band ? (
                <>
                  {" "}
                  <span className="text-ink-muted">{disabled ? "Not available: these are different patient records, which are never joined." : d.hint}</span>
                </>
              ) : null}
            </span>
          </label>
        );
      })}
      {s.choiceError ? (
        <p id={choiceErrId} className="flex items-start gap-1 px-2 pt-0.5 text-xs font-medium text-warning-fg">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-solid" aria-hidden />
          <span>{s.choiceError}</span>
        </p>
      ) : null}
    </div>
  );
  const reasonField = (
    <div data-cut-keep="">
      <Field label="Reason, recorded with your name" required id={reasonId} error={s.reasonError}>
        <Textarea ref={s.reasonRef} rows={2} value={s.reason} onChange={(e) => s.setReason(e.target.value)} />
      </Field>
    </div>
  );
  if (band) {
    return (
      <fieldset data-rel-choices="" className="min-w-0 scroll-mb-3">
        <legend className="sr-only">
          Decision on <span className="id-mono">{cand.displayId}</span>
        </legend>
        {/* Side by side while the band is wide; one column (choices, effect, reason) when it is narrow or the text is large. */}
        <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-x-4 gap-y-2 @max-[34rem]:grid-cols-1">
          {options}
          <div className="flex min-w-0 flex-col gap-1.5">
            {/* Dashed: what would happen is not real until it is recorded. */}
            <p
              key={decision || "none"}
              role="status"
              className={cn("rounded-md border border-dashed border-line-strong px-3 py-1 text-sm", s.effect ? "animate-swap-in text-ink" : "text-ink-muted")}
            >
              {s.effect ? <Segs value={segs(s.effect)} /> : "Choose a decision to see what recording it would do. Nothing is recorded until you press Record decision."}
            </p>
            {reasonField}
          </div>
        </div>
      </fieldset>
    );
  }
  return (
    <fieldset data-rel-choices="" className="space-y-2">
      <legend className={legend === "hidden" ? "sr-only" : "text-base font-semibold text-ink"}>
        Decision on <span className="id-mono">{cand.displayId}</span>
      </legend>
      {options}
      {s.effect ? (
        <p key={decision} ref={effectRef} role="status" className="animate-rise-in border-t border-line pt-2 text-sm text-ink">
          <Segs value={segs(s.effect)} />
        </p>
      ) : null}
      {reasonField}
    </fieldset>
  );
}

/** Reads like the shared disabled button, but stays pressable so a press can say what is missing (aria-disabled). */
const NOT_YET = "aria-disabled:cursor-not-allowed aria-disabled:border aria-disabled:border-line aria-disabled:bg-surface-subtle aria-disabled:text-ink-muted aria-disabled:hover:bg-surface-subtle";

/**
 * "Record decision" with the reason it cannot run yet. As the current step it
 * carries the Ctrl+Enter badge. Until a choice and a reason are given it is
 * aria-disabled, not disabled: pressing it records nothing, shows what is
 * missing beside the choices or the reason, and moves focus there.
 */
export function RecordDecision({ s, primary = false }: { s: RelatedDecisionState; primary?: boolean }) {
  const whyId = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex flex-col items-start gap-1">
        <Button
          variant={primary ? "primary" : "secondary"}
          size={primary ? "block" : "md"}
          loading={s.pending}
          loadingLabel="Recording..."
          aria-disabled={s.why ? true : undefined}
          className={NOT_YET}
          reasonId={s.why ? whyId : undefined}
          aria-keyshortcuts={primary ? "Control+Enter Meta+Enter" : undefined}
          data-intake-primary={primary ? "" : undefined}
          onClick={s.record}
        >
          Record decision
          {primary ? <CtrlEnterBadge onDark={!s.why} /> : null}
        </Button>
        {s.why ? (
          <p id={whyId} className="text-sm text-ink-secondary">
            {s.why}
          </p>
        ) : null}
      </div>
      <CommandError error={s.error && s.error.code !== "CONFLICT" ? s.error : null} />
    </div>
  );
}

/**
 * The related-order decision (lead or supervisor), with an effect preview
 * before recording, as one self-contained form: used to change a recorded
 * decision from the related-orders section.
 */
export function RelatedDecisionForm({
  item,
  cand,
  siblings,
  primary = false,
  onDone,
  frame = stackFrame,
}: {
  item: ItemDetail;
  cand: DecisionCand;
  siblings: SiblingView[];
  /** The current step: carries the Ctrl+Enter target. */
  primary?: boolean;
  onDone?: () => void;
  /** Where the choices (body) and "Record decision" (action) go. */
  frame?: StepFrame;
}) {
  const s = useRelatedDecision(item, cand, siblings, onDone)!;
  return frame({ body: <RelatedChoices s={s} legend={primary ? "hidden" : "visible"} />, action: <RecordDecision s={s} primary={primary} /> });
}

// ------------------------------------------------------------------ the lead's decision, in the centre

/** A value one submission's own record states, identifiers in mono ("MRN 448210", "ENC-55031", "CR-1014-11"). */
function SideValue({ value }: { value: string | null }) {
  if (!value) return <span className="text-ink-muted">Not stated</span>;
  const mrn = /^MRN (\S+)$/.exec(value);
  if (mrn) {
    return (
      <>
        MRN <span className="id-mono">{mrn[1]}</span>
      </>
    );
  }
  return <Segs value={segs(value)} />;
}

/**
 * The lead's "one case or two" when it is their next step, leading the centre
 * at every size (the choices never sit anywhere without the evidence above
 * them). Both submissions side by side in aligned columns, differences first:
 * what keeps them apart, read from each record, then what they share; then
 * the four choices, the effect of the chosen one and the required reason. A
 * review, never a merge.
 *
 * The column header and what keeps the two apart stay pinned at the top of
 * the scrolling region while the rest of the workspace scrolls under them, so
 * a choice is never made with the conflict off screen. On short windows
 * (200% zoom) the pinned chrome would pass a third of the view: there the
 * conflict alone is restated in one pinned line right above the choices.
 * At bench sizes "Record decision" stays pinned in the decision column; stacked
 * (`withRecord`) it follows the reason here.
 */
export function RelatedDecisionWorkspace({ item, cand, s, withRecord = false }: { item: ItemDetail; cand: RelatedView; s: RelatedDecisionState; withRecord?: boolean }) {
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const recapRef = useRef<HTMLDivElement>(null);
  const sides = [...cand.sides].sort((a, b) => (a.parts[0] ?? "").localeCompare(b.parts[0] ?? ""));
  const apart = cand.conflicts.map((r) => ({ ...r, kind: r.code === "separate_orders" ? ("apart" as const) : ("caution" as const) }));
  const shared = cand.reasons.map((r) => ({ ...r, kind: "shared" as const }));
  // Focus and "scroll into view" inside the workspace land below whatever is pinned (WCAG 2.4.11).
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const measure = () => {
      const pinned = [pinnedRef.current, recapRef.current].find((el) => el && getComputedStyle(el).position === "sticky");
      section.style.setProperty("--rel-pinned-h", `${pinned ? pinned.offsetHeight : 0}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [pinnedRef.current, recapRef.current, section]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = (
    <colgroup>
      <col className="w-[42%] @max-[34rem]:w-[36%]" />
      <col />
      <col />
    </colgroup>
  );
  const rowsOf = (list: (typeof apart)[number][] | (typeof shared)[number][]) =>
    list.map((r, i) => (
      <tr key={r.code} className={cn("align-top", i < list.length - 1 && "border-b border-line")}>
        <th scope="row" className="py-0.5 pr-2 pl-4 text-left leading-[1.125rem] font-normal">
          <span className={cn("flex items-start gap-1.5", r.kind === "caution" ? "font-medium text-warning-fg" : r.kind === "apart" ? "font-medium text-ink" : "text-ink-secondary")}>
            {r.kind === "shared" ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
            ) : r.kind === "apart" ? (
              <EqualNot className="mt-0.5 size-3.5 shrink-0 text-ink-secondary" aria-hidden />
            ) : (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-solid" aria-hidden />
            )}
            {r.label}
          </span>
        </th>
        {sides.map((sd) => (
          <td key={sd.orderId} className="py-0.5 pr-3 leading-[1.125rem] text-ink">
            <SideValue value={sd.values[r.code] ?? (r.detail || null)} />
          </td>
        ))}
      </tr>
    ));
  return (
    <section
      ref={sectionRef}
      id="related-orders"
      tabIndex={-1}
      aria-labelledby={titleId}
      data-intake-decision=""
      className={cn(
        "@container scroll-mt-3 rounded-lg border border-line bg-surface focus:outline-none",
        "[&_:is(input,textarea,a,fieldset)]:scroll-mt-[calc(var(--rel-pinned-h,0px)+0.75rem)]",
      )}
    >
      {/* Never folded and always before the choices. Columns and headers wrap rather than overflow with larger
          text or a narrow centre. Pinned while the workspace scrolls (not on short windows). */}
      <div
        ref={pinnedRef}
        data-rel-pinned=""
        // Bench: pinned to the top edge of the centre pane (it pads its top by 0.5rem while this workspace leads it).
        className="-top-2 z-[2] rounded-t-lg border-b border-line-strong bg-surface stacked:top-[var(--hlo-chrome-h)] [@media(min-height:35.00125rem)]:sticky"
      >
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">
            {cand.displayId}: the two submissions side by side, as each submission&apos;s own record states it. First what keeps them apart, then what they share.
          </caption>
          {cols}
          <thead>
            <tr className={cn("text-left", apart.length && "border-b border-line-strong")}>
              <th scope="col" className="py-1 pr-2 pl-4 align-middle font-normal">
                <span id={titleId} className="text-md font-semibold text-ink">
                  <span className="id-mono">{cand.displayId}</span> <span className="font-normal text-ink-secondary">side by side</span>
                </span>
              </th>
              {sides.map((sd) => {
                const isThis = sd.intakeDisplayId === item.displayId;
                return (
                  <th key={sd.orderId} scope="col" className="py-1 pr-3 align-middle font-normal">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-base font-semibold whitespace-nowrap text-ink">Part {sd.parts.join(" ") || "?"}</span>
                      {sd.intakeDisplayId ? (
                        <LabelRef id={sd.intakeDisplayId} provisional href={isThis ? undefined : `/intake?item=${encodeURIComponent(sd.intakeDisplayId)}`} />
                      ) : (
                        <span className="text-ink-muted">Not received</span>
                      )}
                      {isThis ? <span className="sr-only">(this item)</span> : null}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          {apart.length ? <tbody>{rowsOf(apart)}</tbody> : null}
        </table>
      </div>
      <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">What both submissions share ({shared.length})</caption>
        {cols}
        <thead className="sr-only">
          <tr>
            <th scope="col">Reason</th>
            {sides.map((sd) => (
              <th key={sd.orderId} scope="col">
                Part {sd.parts.join(" ") || "?"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rowsOf(shared)}</tbody>
      </table>
      {apart.length ? (
        // Short windows only: what keeps them apart, again, pinned right above the choices (one line under the top bar).
        <div
          ref={recapRef}
          aria-hidden
          data-rel-recap=""
          className="top-[var(--hlo-chrome-h)] z-[2] hidden border-y border-line-strong bg-surface px-4 py-1 text-sm [@media(max-height:35rem)]:sticky [@media(max-height:35rem)]:block"
        >
          {apart.map((r) => (
            <p key={r.code} className={cn("flex flex-wrap items-baseline gap-x-2", r.kind === "caution" ? "text-warning-fg" : "text-ink")}>
              <span className="inline-flex items-baseline gap-1.5 font-medium">
                {r.kind === "caution" ? (
                  <TriangleAlert className="size-3.5 shrink-0 self-center text-warning-solid" aria-hidden />
                ) : (
                  <EqualNot className="size-3.5 shrink-0 self-center text-ink-secondary" aria-hidden />
                )}
                {r.label}:
              </span>
              {sides.map((sd) => (
                <span key={sd.orderId} className="whitespace-nowrap">
                  <span className="text-ink-secondary">Part {sd.parts.join(" ") || "?"}</span> <SideValue value={sd.values[r.code] ?? (r.detail || null)} />
                </span>
              ))}
            </p>
          ))}
        </div>
      ) : null}
      <div className={cn("border-t border-line-strong px-4 pt-2 pb-2.5", apart.length && "[@media(max-height:35rem)]:border-t-0")}>
        <RelatedChoices s={s} layout="band" />
      </div>
      {withRecord ? (
        // Stacked (one page-scrolling column): the action follows the reason, after the evidence and the choices.
        <div className="border-t border-line px-4 pt-3 pb-3.5">
          <RecordDecision s={s} primary />
        </div>
      ) : null}
    </section>
  );
}

function Plate({ display, part, orderRef, site, procedure, verification, differing, holdId, accession, isThis }: {
  display: string;
  part: string | null;
  orderRef: string | null;
  site: string | null;
  procedure: string | null;
  verification: string;
  differing: string[];
  holdId: string | null;
  accession: string | null;
  isThis: boolean;
  id: string;
}) {
  return (
    <article aria-label={`Part ${part ?? "unknown"}, ${display}${isThis ? " (this item)" : ""}`} className={cn("min-w-0 border-t-2 pt-2", isThis ? "border-ink" : "border-line-strong")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xl leading-none font-bold text-ink">{part ?? "?"}</span>
        {isThis ? (
          <span className="text-sm text-ink-muted">This item</span>
        ) : (
          <Link href={`/intake?item=${encodeURIComponent(display)}`} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
            Open Part {part ?? ""}
          </Link>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {accession ? <AccessionChip accession={accession} compact href={false} /> : <ProvisionalChip id={display} compact href={isThis ? false : undefined} />}
      </div>
      <p className="mt-1.5 text-sm text-ink-secondary">
        Order <span className="id-mono text-ink">{orderRef ?? "Unknown"}</span>
      </p>
      <p className="text-sm text-ink">
        {site ?? "Site not stated"}
        {procedure ? `, ${procedure.toLowerCase()}` : ""}
      </p>
      <ul className="mt-1.5 space-y-0.5 text-sm">
        <li className={cn("flex items-center gap-1", differing.length ? "font-medium text-warning-fg" : "text-ink-secondary")}>
          {differing.length ? <TriangleAlert className="size-3.5 text-warning-solid" aria-hidden /> : verification === "unverified" ? <CircleHelp className="size-3.5 text-ink-muted" aria-hidden /> : <Check className="size-3.5 text-ink-muted" aria-hidden />}
          {differing.length ? `${differing.join(", ")} differs` : verification === "unverified" ? "Not checked yet" : "Checked, sources agree"}
        </li>
        <li className={cn("flex items-center gap-1", holdId ? "text-hold-fg" : "text-ink-muted")}>
          {holdId ? (
            <>
              <CirclePause className="size-3.5 text-hold-solid" aria-hidden /> Hold <span className="id-mono">{holdId}</span>
            </>
          ) : (
            "No hold"
          )}
        </li>
      </ul>
    </article>
  );
}

function CandidateBlock({
  item,
  cand,
  siblings,
  permissions,
  readOnly,
  now,
  onRaise,
}: {
  item: ItemDetail;
  cand: RelatedView;
  siblings: SiblingView[];
  permissions: BenchPermissions;
  readOnly: boolean;
  now: string;
  onRaise: (draft: ClarificationDraft) => void;
}) {
  const accessioned = item.status === "accessioned" || cand.otherItems.some((o) => o.status === "accessioned");
  const decided = !!cand.reviewedAt && cand.status !== "pending_review";
  const canDecide = permissions.reviewRelated && !readOnly && !accessioned;
  const thisPart = partsOf(item).join(" ") || null;
  const c0 = item.containers[0];
  const thisOrderPart = c0?.orderPartId ? item.orders.flatMap((o) => o.parts).find((p) => p.id === c0.orderPartId) : item.orders[0]?.parts[0];
  const plates = [
    {
      id: item.id,
      display: item.displayId,
      part: thisPart,
      orderRef: item.orders[0]?.sourceOrderId ?? null,
      site: thisOrderPart?.siteText ?? null,
      procedure: thisOrderPart?.procedure ?? null,
      verification: item.containers.some((c) => c.verificationState === "unverified") ? "unverified" : "verified",
      differing: [...new Set(item.containers.flatMap((c) => c.comparison.filter((r) => r.status === "differs").map((r) => r.label)))],
      holdId: item.holds[0]?.displayId ?? null,
      accession: item.accession?.number ?? null,
      isThis: true,
    },
    ...siblings
      .filter((s) => cand.otherItems.some((o) => o.id === s.id))
      .map((s) => ({
        id: s.id,
        display: s.displayId,
        part: s.part,
        orderRef: s.orderRef,
        site: s.site,
        procedure: s.procedure,
        verification: s.verification,
        differing: s.differing,
        holdId: s.holds[0]?.displayId ?? null,
        accession: s.accession,
        isThis: false,
      })),
  ].sort((a, b) => (a.part ?? "").localeCompare(b.part ?? ""));
  const owner = item.tasks.find((t) => t.kind === "related_order_review")?.ownerName ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="id-mono text-md font-semibold text-ink">{cand.displayId}</span>
        <StatusPill tone={TONE[cand.status] ?? "neutral"} className="text-sm">{cand.status === "pending_review" ? "Needs review" : RELATED_STATUS[cand.status as keyof typeof RELATED_STATUS] ?? cand.status}</StatusPill>
        {cand.status === "pending_review" && owner ? <span className="text-sm text-ink-secondary">Owner {owner}</span> : null}
        <span className="flex flex-wrap gap-1.5">
          {cand.orders.map((o) => (
            <IdChip key={o.id} kind="ORD" id={o.sourceOrderId} tenant={o.tenantName} />
          ))}
        </span>
      </div>
      <p className="text-sm text-ink">
        {cand.duplicateRecordKind
          ? "Possible duplicate patient record (different patient references with the same name, birth date and office). This app never joins different patient records."
          : "A review, not a merge. Whatever is decided, both source orders and both provisional ids stay on record."}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)] items-start gap-3 max-xl:grid-cols-2">
        {plates[0] ? <Plate {...plates[0]} /> : null}
        <div className="min-w-0 border-t border-line pt-2 max-xl:order-last max-xl:col-span-2">
          <p className="text-sm font-semibold text-ink">Shared by both ({cand.reasons.length})</p>
          <ul className="mt-1 divide-y divide-line text-sm">
            {cand.reasons.map((r) => (
              <li key={r.code} className="py-1 text-ink">
                {r.label}
                {r.detail ? <span className="text-ink-secondary">: {r.detail}</span> : null}
              </li>
            ))}
          </ul>
          {cand.conflicts.length ? (
            <>
              <p className="mt-2 text-sm font-semibold text-ink">Kept apart ({cand.conflicts.length})</p>
              <ul className="mt-1 divide-y divide-line text-sm">
                {cand.conflicts.map((r) => (
                  <li key={r.code} className="py-1 text-ink">
                    {r.label}
                    {r.detail ? <span className="text-ink-secondary">: {r.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        {plates[1] ? <Plate {...plates[1]} /> : <p className="text-sm text-ink-muted">Other item not available.</p>}
      </div>
      <p className="text-sm text-ink-muted">
        Detected <Timestamp iso={cand.detectedAt} now={now} /> by rule: {cand.detectionRule.replace(/^[a-z0-9_]+:\s*/, "")}. Similar names or demographics alone never propose a link.
      </p>

      {cand.reviewedAt ? (
        <p className="text-sm text-ink">
          Decision by {cand.reviewedByName ?? "Unknown"} at <Timestamp iso={cand.reviewedAt} now={now} />: {RELATED_STATUS[cand.status as keyof typeof RELATED_STATUS] ?? cand.status}.
          {cand.decisionReason ? <span className="text-ink-secondary"> Reason: {cand.decisionReason}</span> : null}
        </p>
      ) : null}

      {cand.status === "escalated_to_office" && permissions.raiseClarification && !readOnly && !accessioned ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            onRaise({
              category: "related_orders",
              refs: { intakeItemId: item.id, sourceOrderId: item.orders[0]?.id ?? null },
              intakeDisplayId: item.displayId,
              orderRef: cand.orders.map((o) => o.sourceOrderId).join(" + "),
              partLabel: null,
              subjectLabel: `${cand.displayId} · ${cand.orders.map((o) => o.sourceOrderId).join(" + ")}`,
              question: `Orders ${cand.orders.map((o) => o.sourceOrderId).join(" and ")} appear to come from the same visit. Should they be one case with separate parts, or separate cases?`,
              evidence: cand.reasons.map((r) => ({ field: r.label, order_value: r.detail || null, observed_value: null, requisition_value: null, source: "related-order detection" })),
              priority: "high",
              hold: { scope: { type: "intake_item", id: item.id }, scopeLabel: `${item.displayId} (related orders question)`, blocks: ["accession_request"] },
            })
          }
        >
          Raise a related-orders clarification
        </Button>
      ) : null}

      {accessioned ? (
        <p className="text-sm text-ink-secondary">Already accessioned. Changes now go through a correction review on the case.</p>
      ) : canDecide ? (
        decided ? (
          <details className="group/chg rounded-md border border-line">
            <summary className="flex min-h-10 cursor-pointer list-none items-center px-3 text-sm font-medium text-brand hover:bg-surface-subtle [&::-webkit-details-marker]:hidden">
              Change decision on {cand.displayId}
            </summary>
            <div className="border-t border-line p-3">
              <RelatedDecisionForm item={item} cand={cand} siblings={siblings} />
            </div>
          </details>
        ) : (
          <p className="text-sm text-ink-secondary">Your decision form is in the decision column, with what each choice would do.</p>
        )
      ) : decided && cand.status !== "escalated_to_office" ? null : (
        <p className="text-sm text-ink-secondary">
          Who may decide: the accessioning lead (Kim Nguyen) or the operations supervisor (Tanya Brooks). Your demo role can view the candidate but not decide; the server checks this on every request.
        </p>
      )}
    </div>
  );
}

/** Related orders: the parts side by side with what they share and what stays apart. A review, never a merge. */
export function RelatedSection({
  item,
  siblings,
  permissions,
  readOnly,
  now,
  onRaise,
  exclude = null,
}: {
  item: ItemDetail;
  siblings: SiblingView[];
  permissions: BenchPermissions;
  readOnly: boolean;
  now: string;
  onRaise: (draft: ClarificationDraft) => void;
  /** A candidate already shown as the lead's decision in the centre (not repeated here). */
  exclude?: string | null;
}) {
  const related = item.related.filter((c) => c.id !== exclude);
  if (!related.length && !item.separateEncounters.length) return null;
  return (
    <section
      id={exclude ? "related-orders-other" : "related-orders"}
      aria-labelledby="related-orders-title"
      tabIndex={-1}
      className="rounded-lg border border-line bg-surface px-5 py-4 focus:outline-none max-xl:px-4"
    >
      <h3 id="related-orders-title" className="mb-2 text-md font-semibold text-ink">
        {exclude ? "Other orders for this patient" : "Related orders"}
      </h3>
      <div className="space-y-5">
        {related.map((c) => (
          <CandidateBlock key={c.id} item={item} cand={c} siblings={siblings} permissions={permissions} readOnly={readOnly} now={now} onRaise={onRaise} />
        ))}
        {item.separateEncounters.length ? (
          <div className={related.length ? "border-t border-line pt-3" : undefined}>
            <h4 className="text-sm font-semibold text-ink">Other orders for this patient, separate encounter</h4>
            <p className="mb-2 text-sm text-ink-muted">Not proposed as related: a different encounter is a separate visit and stays a separate case.</p>
            <ul className="space-y-1.5 text-sm">
              {item.separateEncounters.map((s) => (
                <li key={s.orderId} className="flex flex-wrap items-center gap-2">
                  <IdChip kind="ORD" id={s.sourceOrderId} />
                  <span className="text-ink-secondary">
                    Encounter <span className="id-mono">{s.encounter ?? "Unknown"}</span>
                    {s.encounterAt ? `, ${fmtDate(s.encounterAt)}` : ""} · {s.officeName}
                  </span>
                  {s.accessionNumber ? <AccessionChip accession={s.accessionNumber} compact /> : s.intakeDisplay ? <ProvisionalChip id={s.intakeDisplay} compact /> : <span className="text-ink-muted">Not received yet</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
