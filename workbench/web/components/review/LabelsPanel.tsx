"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, EyeOff, Gavel } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { LABEL_SHORT, LABEL_STATUS_TEXT, REVIEW_STATE_LABEL, ROLE_LABEL, formatDateTime, userName } from "@/lib/format";
import type { Annotation, LabelScope, LabelValue, LabelsView, LabelVersion, ReviewState, Slide } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { TextArea, TextField, SelectField } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { ReviewStateBadge } from "@/components/ui/Badges";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { Disclosure, LABEL_DISPLAY_FULL, LabelChoice, PanelSection, REASON_REQUIRED } from "./shared";

type Props = {
  slide: Slide;
  labels: LabelsView | null;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  openedAt: number;
  onChanged: () => Promise<void> | void;
  independentEffective: boolean;
  onIndependentChanged: () => Promise<void> | void;
};

function latestPerAuthor(rows: LabelVersion[], scope: LabelScope, target: string): Map<string, LabelVersion> {
  const out = new Map<string, LabelVersion>();
  for (const r of rows) {
    if (r.scope !== scope || r.target_id !== target || r.source !== "expert" || r.is_adjudication || !r.value || !r.author_id) continue;
    const prev = out.get(r.author_id);
    if (!prev || prev.created_at <= r.created_at) out.set(r.author_id, r);
  }
  return out;
}

export function LabelsPanel({ slide, labels, annotations, selectedAnnotationId, openedAt, onChanged, independentEffective, onIndependentChanged }: Props) {
  const { me, can, demoUsers, meta, projectId } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [scope, setScope] = useState<LabelScope>("slide");
  const [value, setValue] = useState<LabelValue | null>(null);
  const [reason, setReason] = useState("");
  const [assess, setAssess] = useState<{ value: LabelValue | null; confidence: string; comment: string; record: boolean }>({ value: null, confidence: "medium", comment: "", record: true });
  const [suggestionAction, setSuggestionAction] = useState<{ id: string; action: "correct" | "reject" | "hide"; value: LabelValue | null; reason: string } | null>(null);
  const [adjudicate, setAdjudicate] = useState<{ id: string; value: LabelValue | null; reason: string } | null>(null);
  const [stateChange, setStateChange] = useState<{ to: ReviewState; reason: string } | null>(null);
  const [showHidden, setShowHidden] = useState<Record<string, boolean>>({});

  const isPathologist = can("label.expert_write");
  const labelReason = isPathologist ? null : "Expert labels come only from the pathologist demo role (permission label.expert_write).";
  const caseId = slide.lineage.case_id;
  const myId = me?.user.id ?? "";

  const rows = useMemo(() => labels?.expert_labels ?? [], [labels]);
  const target = scope === "slide" ? slide.id : scope === "case" ? caseId ?? "" : selectedAnnotationId ?? "";
  const mine = useMemo(() => latestPerAuthor(rows, scope, target).get(myId) ?? null, [rows, scope, target, myId]);
  const slideReaders = useMemo(() => latestPerAuthor(rows, "slide", slide.id), [rows, slide.id]);

  useEffect(() => {
    setValue(mine?.value ?? null);
    setReason("");
  }, [mine?.id, scope]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: { title: string; body?: string }) => {
    setBusy(key);
    try {
      await fn();
      toast.show({ tone: "success", ...ok });
      await onChanged();
      return true;
    } catch (err) {
      toast.show({ tone: "error", title: "Not saved", body: errorText(err) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!labels) return <p className="p-4 text-small text-graphite">Loading labels…</p>;

  const hidden = labels.suggestions_hidden;
  const ref = labels.reference;
  const openDisagreements = labels.disagreements.filter((d) => d.status === "open");
  const transitions = (meta?.review_transitions ?? []).filter((t) => t.from === slide.review_state);
  const role = me?.user.role;

  const saveLabel = async () => {
    if (!value) return;
    if (scope === "region" && !selectedAnnotationId) {
      toast.show({ tone: "warning", title: "Select an outline first", body: "A region label needs an annotation: select one on the slide or in the Annotations tab." });
      return;
    }
    await run(
      "label",
      () => api(`/slides/${slide.id}/labels`, { method: "POST", body: { scope, target_id: scope === "slide" ? null : target, value, reason: reason || null } }),
      { title: mine ? "Label changed (new version)" : "Label recorded", body: `${LABEL_SHORT[value]} at ${scope} scope. Stored as your expert judgement with author and time.` },
    );
  };

  return (
    <div data-testid="labels-panel">
      <PanelSection title="Reference label">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-small">
          <dt className="text-graphite">Slide</dt>
          <dd data-testid="reference-slide">
            <span className="font-semibold text-ink">{ref.slide.label?.value ? LABEL_DISPLAY_FULL[ref.slide.label.value] : "none"}</span>{" "}
            <span className={cn("font-semibold", ref.slide.status === "disputed" ? "text-berry" : ref.slide.status === "unlabeled" ? "text-amber-ink" : "text-graphite")}>
              ({LABEL_STATUS_TEXT[ref.slide.status] ?? ref.slide.status})
            </span>
          </dd>
          <dt className="text-graphite">Case</dt>
          <dd>
            <span className="font-semibold text-ink">{ref.case.label?.value ? LABEL_SHORT[ref.case.label.value] : "none"}</span>{" "}
            <span className="text-graphite">({LABEL_STATUS_TEXT[ref.case.status] ?? ref.case.status}). Valid for the case only, never copied to its slides.</span>
          </dd>
        </dl>
        <p className="mt-2 text-micro text-graphite">The reference is the adjudicated label, or the readers&rsquo; label when they agree. A suggestion never becomes the reference.</p>
      </PanelSection>

      {role === "pathologist" ? (
        <PanelSection
          title="Independent initial review"
          aside={
            <label className="flex items-center gap-2 text-small font-semibold">
              <input
                type="checkbox"
                role="switch"
                checked={independentEffective}
                data-testid="independent-toggle"
                onChange={async (e) => {
                  const on = e.target.checked;
                  try {
                    await api(`/projects/${projectId}/members/me`, { method: "PATCH", body: { independent_review: on } });
                    toast.show({ tone: "info", title: on ? "Independent review on" : "Independent review off", body: on ? "Suggestions stay hidden until you record your own assessment." : "Suggestions are shown alongside your review." });
                    await onIndependentChanged();
                  } catch (err) {
                    toast.show({ tone: "error", title: "Setting not saved", body: errorText(err) });
                  }
                }}
                className="h-4 w-8 accent-[var(--color-teal)]"
              />
              {independentEffective ? "On" : "Off"}
            </label>
          }
        >
          {labels.my_assessment ? (
            <p className="text-small text-ink" data-testid="my-assessment">
              <CheckCircle2 size={14} aria-hidden className="mr-1 inline text-approved" />
              Your assessment: <strong>{LABEL_SHORT[labels.my_assessment.value]}</strong>
              {labels.my_assessment.confidence ? `, ${labels.my_assessment.confidence} confidence` : ""}, recorded {formatDateTime(labels.my_assessment.created_at)}.{" "}
              <span className="text-graphite">Suggestions were {labels.my_assessment.suggestions_were_hidden ? "hidden" : "visible"} at the time.</span>
            </p>
          ) : hidden ? (
            <div className="space-y-3" data-testid="assessment-form">
              <p className="text-small text-graphite">Record your own view first. Suggestions for this slide appear only after you do; the record shows they were hidden.</p>
              <LabelChoice name="assess" value={assess.value} onChange={(v) => setAssess({ ...assess, value: v })} compact />
              <div className="grid grid-cols-2 gap-2">
                <SelectField
                  label="Confidence"
                  value={assess.confidence}
                  onChange={(e) => setAssess({ ...assess, confidence: e.target.value })}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                  ]}
                />
                <label className="mt-6 flex items-start gap-2 text-small">
                  <input type="checkbox" checked={assess.record} onChange={(e) => setAssess({ ...assess, record: e.target.checked })} className="mt-1 accent-[var(--color-teal)]" />
                  Also record it as my slide label
                </label>
              </div>
              <TextArea label="Comment (optional)" value={assess.comment} onChange={(e) => setAssess({ ...assess, comment: e.target.value })} />
              <Button
                variant="primary"
                size="sm"
                busy={busy === "assess"}
                unavailable={!assess.value ? "Choose a value first." : null}
                data-testid="record-assessment"
                onClick={() =>
                  run(
                    "assess",
                    () =>
                      api(`/slides/${slide.id}/assessment`, {
                        method: "POST",
                        body: {
                          value: assess.value,
                          confidence: assess.confidence,
                          comment: assess.comment || null,
                          time_spent_seconds: Math.round((Date.now() - openedAt) / 1000),
                          record_as_label: assess.record,
                        },
                      }),
                    { title: "Assessment recorded", body: "Suggestions for this slide are now visible to you." },
                  )
                }
              >
                Record my assessment
              </Button>
            </div>
          ) : (
            <p className="text-small text-graphite">
              {independentEffective ? "No assessment recorded and no suggestion to hide on this slide." : "Off: suggestions are visible immediately. Turn it on to look first."}
            </p>
          )}
        </PanelSection>
      ) : null}

      <PanelSection title="Suggestions (not expert truth)" testId="suggestions">
        {hidden ? (
          <div className="hatch-synthetic rounded-[var(--radius-control)] border border-dashed border-hema/60 px-3 py-4 text-small text-hema" data-testid="suggestions-hidden">
            <EyeOff size={15} aria-hidden className="mr-1 inline" />
            <span className="rounded bg-surface/90 px-1 font-semibold">Hidden until you record your assessment.</span>
          </div>
        ) : labels.model_suggestions.length === 0 ? (
          <p className="text-small text-graphite">No suggestion for this slide.</p>
        ) : (
          <ul className="space-y-3">
            {labels.model_suggestions.map((s) => {
              const reviews = rows.filter((r) => r.review_of_suggestion_id === s.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
              const myLatest = [...reviews].reverse().find((r) => r.author_id === myId);
              const iHid = myLatest?.review_action === "hidden";
              const collapsed = iHid && !showHidden[s.id];
              return (
                <li key={s.id} className="rounded-[var(--radius-control)] border-2 border-dashed border-hema/60 bg-hema-tint/40 p-3" data-testid="suggestion-card">
                  <div className="flex items-start gap-2">
                    <CircleDashed size={16} aria-hidden className="mt-0.5 shrink-0 text-hema" />
                    <div className="min-w-0 flex-1">
                      <p className="text-micro font-bold text-hema">{s.suggestion_notice ?? "Suggestion: not expert truth"}</p>
                      {collapsed ? (
                        <p className="mt-1 text-small text-graphite">
                          You hid this suggestion.{" "}
                          <button type="button" className="font-semibold text-teal-deep underline" onClick={() => setShowHidden({ ...showHidden, [s.id]: true })}>
                            Show it
                          </button>
                        </p>
                      ) : (
                        <>
                          <p className="mt-1 font-semibold text-ink">{s.value ? LABEL_DISPLAY_FULL[s.value] : "no value"}</p>
                          <p className="text-micro text-graphite">
                            {s.scope} scope · score {s.score ?? "n/a"} (a raw score, not a probability) · {s.model_ref}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                  {reviews.length ? (
                    <ol className="mt-2 space-y-1 border-l-2 border-line-strong pl-3 text-micro" aria-label="Expert reviews of this suggestion">
                      {reviews.map((r) => (
                        <li key={r.id} className="text-ink">
                          <strong>{userName(r.author_id, demoUsers)}</strong> {r.review_action}
                          {r.review_action === "corrected" && r.value ? ` to ${LABEL_SHORT[r.value]}` : ""} · {formatDateTime(r.created_at)}
                          {r.reason ? <span className="text-graphite"> · “{r.reason}”</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {isPathologist ? (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        busy={busy === `acc-${s.id}`}
                        onClick={() =>
                          run(`acc-${s.id}`, () => api(`/labels/${s.id}/review`, { method: "POST", body: { action: "accept", reason: myLatest ? "changed my review" : null } }), {
                            title: "Suggestion accepted",
                            body: "Your acceptance is a separate expert record; the suggestion itself is unchanged.",
                          })
                        }
                      >
                        Accept
                      </Button>
                      <Button size="sm" onClick={() => setSuggestionAction({ id: s.id, action: "correct", value: null, reason: "" })}>
                        Correct
                      </Button>
                      <Button size="sm" onClick={() => setSuggestionAction({ id: s.id, action: "reject", value: null, reason: "" })}>
                        Reject
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setSuggestionAction({ id: s.id, action: "hide", value: null, reason: "" })}>
                        Hide
                      </Button>
                    </div>
                  ) : null}
                  {suggestionAction?.id === s.id ? (
                    <div className="mt-3 space-y-2 rounded-[var(--radius-control)] border border-line bg-surface p-2.5">
                      {suggestionAction.action === "correct" ? (
                        <LabelChoice name={`correct-${s.id}`} value={suggestionAction.value} onChange={(v) => setSuggestionAction({ ...suggestionAction, value: v })} compact />
                      ) : null}
                      <TextField
                        label={suggestionAction.action === "hide" ? "Reason (optional)" : "Reason"}
                        required={suggestionAction.action !== "hide"}
                        value={suggestionAction.reason}
                        onChange={(e) => setSuggestionAction({ ...suggestionAction, reason: e.target.value })}
                      />
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="quiet" onClick={() => setSuggestionAction(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          busy={busy === `sa-${s.id}`}
                          unavailable={
                            suggestionAction.action === "correct" && (!suggestionAction.value || suggestionAction.value === s.value)
                              ? "Choose a value different from the suggestion (use Accept to agree)."
                              : suggestionAction.action !== "hide" && !suggestionAction.reason.trim()
                                ? "A reason is required."
                                : null
                          }
                          onClick={async () => {
                            const ok = await run(
                              `sa-${s.id}`,
                              () =>
                                api(`/labels/${s.id}/review`, {
                                  method: "POST",
                                  body: { action: suggestionAction.action, value: suggestionAction.action === "correct" ? suggestionAction.value : null, reason: suggestionAction.reason || null },
                                }),
                              { title: `Suggestion ${suggestionAction.action === "correct" ? "corrected" : suggestionAction.action === "reject" ? "rejected" : "hidden"}`, body: "The original suggestion stays in the history." },
                            );
                            if (ok) setSuggestionAction(null);
                          }}
                        >
                          {suggestionAction.action === "correct" ? "Save correction" : suggestionAction.action === "reject" ? "Reject suggestion" : "Hide suggestion"}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>

      <PanelSection title="Your expert label" testId="expert-label">
        <div role="radiogroup" aria-label="Label scope" className="mb-3 flex gap-1">
          {(["slide", "case", "region"] as LabelScope[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              onClick={() => setScope(s)}
              data-testid={`scope-${s}`}
              className={cn("h-8 flex-1 rounded-[var(--radius-control)] border text-small font-semibold", scope === s ? "border-teal bg-teal-tint text-teal-deep" : "border-line-strong bg-sheet text-ink")}
            >
              {s === "slide" ? "This slide" : s === "case" ? "Whole case" : "Selected region"}
            </button>
          ))}
        </div>
        <p className="mb-2 text-micro text-graphite">
          {scope === "slide"
            ? "Valid for this slide only."
            : scope === "case"
              ? "Valid for the case only. Never copied down to its slides or patches; slide training needs slide labels."
              : selectedAnnotationId
                ? `Valid for the selected outline (${annotations.find((a) => a.annotation_id === selectedAnnotationId)?.label?.replace(/_/g, " ") ?? "region"}).`
                : "Select an outline on the slide first."}
        </p>
        <LabelChoice name="expert" value={value} onChange={setValue} />
        {mine ? (
          <TextField className="mt-3" label="Reason for changing your label" required hint={`Your current label is ${LABEL_SHORT[mine.value!]} (v${mine.version}). A change creates a new version.`} value={reason} onChange={(e) => setReason(e.target.value)} />
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-micro text-graphite">{mine ? `Last saved ${formatDateTime(mine.created_at)}` : "Not labelled by you at this scope yet."}</p>
          <Button
            variant="primary"
            size="sm"
            busy={busy === "label"}
            data-testid="save-label"
            unavailable={labelReason ?? (!value ? "Choose a value first." : mine && mine.value === value ? "This is already your current label." : mine && !reason.trim() ? "Give a reason for the change." : null)}
            onClick={saveLabel}
          >
            {mine ? "Save new version" : "Save label"}
          </Button>
        </div>
      </PanelSection>

      <PanelSection title="Readers and disagreements" testId="disagreements">
        {slideReaders.size === 0 ? (
          <p className="text-small text-graphite">No expert has labelled this slide yet.</p>
        ) : (
          <ul className="space-y-1 text-small">
            {[...slideReaders.values()].map((r) => (
              <li key={r.id} className="flex justify-between gap-2">
                <span>{userName(r.author_id, demoUsers)}</span>
                <span className="font-semibold">{r.value ? LABEL_SHORT[r.value] : "none"}</span>
              </li>
            ))}
          </ul>
        )}
        {labels.disagreements.map((d) => (
          <div key={d.id} className={cn("mt-3 rounded-[var(--radius-control)] border p-2.5 text-small", d.status === "open" ? "border-berry/50 bg-berry-tint/60" : "border-line bg-surface")}>
            <p className="font-semibold text-ink">
              <Gavel size={14} aria-hidden className="mr-1 inline" />
              {d.status === "open" ? "Readers disagree" : d.status === "adjudicated" ? "Adjudicated" : "Resolved by agreement"} at {d.scope} scope:{" "}
              {d.values.map((v) => LABEL_SHORT[v]).join(" vs ")}
            </p>
            {d.status !== "open" && d.reason ? (
              <p className="text-micro text-graphite">
                {userName(d.adjudicated_by, demoUsers)} · {formatDateTime(d.adjudicated_at)} · “{d.reason}”
              </p>
            ) : null}
            {d.status === "open" ? (
              adjudicate?.id === d.id ? (
                <div className="mt-2 space-y-2">
                  <LabelChoice name={`adj-${d.id}`} value={adjudicate.value} onChange={(v) => setAdjudicate({ ...adjudicate, value: v })} compact />
                  <TextField label="Reason" required value={adjudicate.reason} onChange={(e) => setAdjudicate({ ...adjudicate, reason: e.target.value })} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="quiet" onClick={() => setAdjudicate(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      busy={busy === `adj-${d.id}`}
                      unavailable={!adjudicate.value ? "Choose the adjudicated value." : !adjudicate.reason.trim() ? "Adjudication requires a reason." : null}
                      onClick={async () => {
                        const ok = await run(`adj-${d.id}`, () => api(`/disagreements/${d.id}/adjudicate`, { method: "POST", body: { value: adjudicate.value, reason: adjudicate.reason } }), {
                          title: "Disagreement adjudicated",
                          body: "Recorded as a separate adjudication label; the readers' labels are kept.",
                        });
                        if (ok) setAdjudicate(null);
                      }}
                    >
                      Record adjudication
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  className="mt-2"
                  unavailable={can("disagreement.adjudicate") ? null : "Adjudication needs the pathologist demo role."}
                  onClick={() => setAdjudicate({ id: d.id, value: null, reason: "" })}
                >
                  Adjudicate
                </Button>
              )
            ) : null}
          </div>
        ))}
      </PanelSection>

      <PanelSection title="Review decision" aside={<ReviewStateBadge state={slide.review_state} />} testId="review-decision">
        {slide.review_state_reason ? (
          <p className="mb-2 text-micro text-graphite">
            Last change by {userName(slide.review_state_by, demoUsers)}: “{slide.review_state_reason}”
          </p>
        ) : null}
        {openDisagreements.length && transitions.some((t) => t.to === "approved") ? (
          <Notice tone="warning" className="mb-2">
            Approval is blocked until the open disagreement is adjudicated.
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {transitions.length === 0 ? <p className="text-small text-graphite">No transition is defined from {REVIEW_STATE_LABEL[slide.review_state]}.</p> : null}
          {transitions.map((t) => {
            const allowed = role ? t.roles.includes(role) : false;
            const label = t.to === "approved" ? "Approve" : t.to === "disputed" ? "Mark disputed" : t.to === "excluded" ? "Exclude" : slide.review_state === "imported" ? "Route to review" : "Return to pending";
            return (
              <Button
                key={t.to}
                size="sm"
                variant={t.to === "approved" ? "primary" : t.to === "excluded" ? "danger" : "review"}
                data-testid={`state-${t.to}`}
                unavailable={
                  !allowed
                    ? `${label} needs the ${t.roles.map((r) => ROLE_LABEL[r]).join(" or ")} demo role.`
                    : t.to === "approved" && openDisagreements.length
                      ? "Approval is blocked until the open disagreement is adjudicated."
                      : null
                }
                onClick={() => setStateChange({ to: t.to, reason: "" })}
              >
                {label}
              </Button>
            );
          })}
        </div>
        {stateChange ? (
          <div className="mt-3 space-y-2 rounded-[var(--radius-control)] border border-line bg-surface p-2.5">
            <p className="text-small">
              Move from <strong>{REVIEW_STATE_LABEL[slide.review_state]}</strong> to <strong>{REVIEW_STATE_LABEL[stateChange.to]}</strong>.
              {stateChange.to === "approved" ? " The slide becomes eligible for datasets that include approved slides." : ""}
              {stateChange.to === "excluded" ? " The slide leaves every new dataset version; frozen versions do not change." : ""}
            </p>
            <TextField
              label={REASON_REQUIRED.has(`${slide.review_state}>${stateChange.to}`) ? "Reason" : "Reason (optional)"}
              required={REASON_REQUIRED.has(`${slide.review_state}>${stateChange.to}`)}
              value={stateChange.reason}
              data-testid="state-reason"
              onChange={(e) => setStateChange({ ...stateChange, reason: e.target.value })}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="quiet" onClick={() => setStateChange(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                busy={busy === "state"}
                data-testid="confirm-state"
                unavailable={REASON_REQUIRED.has(`${slide.review_state}>${stateChange.to}`) && !stateChange.reason.trim() ? "This change requires a reason." : null}
                onClick={async () => {
                  const ok = await run("state", () => api(`/slides/${slide.id}/review-state`, { method: "POST", body: { state: stateChange.to, reason: stateChange.reason || null } }), {
                    title: `Slide ${REVIEW_STATE_LABEL[stateChange.to].toLowerCase()}`,
                    body: "Recorded with author, time and reason.",
                  });
                  if (ok) setStateChange(null);
                }}
              >
                Confirm: {REVIEW_STATE_LABEL[stateChange.to]}
              </Button>
            </div>
          </div>
        ) : null}
      </PanelSection>

      <PanelSection title="Label history">
        <Disclosure summary={`All label versions (${rows.length + labels.model_suggestions.length})`} testId="label-history-toggle">
          <ol className="space-y-1.5 text-micro" data-testid="label-history">
            {[...rows, ...labels.model_suggestions]
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .map((r) => (
                <li key={r.id} className={cn("rounded border px-2 py-1.5", r.source === "model_suggestion" ? "border-dashed border-hema/60 bg-hema-tint/30" : "border-line bg-sheet")}>
                  <span className="font-semibold text-ink">{r.source === "model_suggestion" ? "Suggestion" : r.is_adjudication ? "Adjudication" : r.review_action ? `Review: ${r.review_action}` : "Expert label"}</span>{" "}
                  · {r.value ? LABEL_SHORT[r.value] : "no value"} · {r.scope} · v{r.version} · {r.source === "model_suggestion" ? "not a person" : userName(r.author_id, demoUsers)} · {formatDateTime(r.created_at)}
                  {r.reason ? <span className="block text-graphite">“{r.reason}”</span> : null}
                </li>
              ))}
          </ol>
        </Disclosure>
      </PanelSection>
    </div>
  );
}
