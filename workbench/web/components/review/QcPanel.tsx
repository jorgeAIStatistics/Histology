"use client";

import { useState } from "react";
import { FlaskConical, Layers, ScanSearch } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { pollJob } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { ELIGIBILITY_LABEL, QC_ACTION_LABEL, QC_CATEGORY_LABEL, QC_STATUS_LABEL, formatDateTime, humanize, userName } from "@/lib/format";
import type { Annotation, Job, QcIssue, QcView, Slide } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { SelectField, TextArea, TextField } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { Disclosure, PanelSection } from "./shared";

const STEPS = ["open", "reviewed", "action_suggested", "resolved"] as const;

function Stepper({ issue }: { issue: QcIssue }) {
  const idx = STEPS.indexOf(issue.status);
  return (
    <ol className="mt-2 flex items-center gap-1" aria-label={`Lifecycle: ${QC_STATUS_LABEL[issue.status]}`}>
      {STEPS.map((s, i) => (
        <li key={s} className="flex flex-1 items-center gap-1">
          <span
            className={cn(
              // min-w: in the 380–420 px panel the nowrap "Action suggested" label otherwise squeezes its bar to zero.
              "h-1.5 min-w-3 flex-1 rounded-full",
              i < idx || issue.status === "resolved" ? "bg-approved" : i === idx ? "bg-amber" : "bg-line",
            )}
            aria-hidden
          />
          <span className={cn("whitespace-nowrap text-[11px] font-semibold", i === idx ? "text-ink" : "text-graphite")}>{QC_STATUS_LABEL[s]}</span>
        </li>
      ))}
    </ol>
  );
}

type Form =
  | { kind: "review"; issue: QcIssue; confirmed: "yes" | "no"; reason: string }
  | { kind: "suggest"; issue: QcIssue; action: string; reason: string }
  | { kind: "resolve"; issue: QcIssue; resolution: string; effect: string; reason: string }
  | { kind: "override"; issue: QcIssue; reason: string }
  | { kind: "reopen"; issue: QcIssue; reason: string };

export function QcPanel({
  slide,
  qc,
  onChanged,
  selectedAnnotation,
  maskOn,
  onToggleMask,
  onShowRegion,
}: {
  slide: Slide;
  qc: QcView | null;
  onChanged: () => Promise<void> | void;
  selectedAnnotation: Annotation | null;
  maskOn: boolean;
  onToggleMask: () => void;
  onShowRegion: (issueId: string | null) => void;
}) {
  const { can, meta, demoUsers } = useSession();
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newIssue, setNewIssue] = useState<{ category: string; note: string; useRegion: boolean } | null>(null);
  const [override, setOverride] = useState<{ metric: string; verdict: string; reason: string } | null>(null);
  const [screenJob, setScreenJob] = useState<Job | null>(null);

  const canWrite = can("qc.write");
  const writeReason = canWrite ? null : "Recording QC needs the histology assistant or pathologist demo role (permission qc.write).";

  if (!qc) return <p className="p-4 text-small text-graphite">Loading quality review…</p>;

  const latest = qc.reviews.find((r) => r.kind === "automated_screen") ?? null;
  const overrides = qc.reviews.filter((r) => r.kind === "manual");
  const m = (latest?.metrics ?? {}) as {
    tissue?: { tissue_fraction?: number; method?: string };
    focus?: { median_variance?: number; method?: string; suspected_blur?: boolean; tiles_measured?: number };
    calibration?: { status?: string; note?: string; mpp_x?: number };
    thresholds?: { low_tissue_fraction?: number; blur_variance?: number; calibrated?: boolean };
  };

  const act = async (key: string, fn: () => Promise<unknown>, title: string, body?: string) => {
    setBusy(key);
    try {
      await fn();
      toast.show({ tone: "success", title, body });
      await onChanged();
      return true;
    } catch (err) {
      toast.show({ tone: "error", title: "Not saved", body: errorText(err) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const patch = (issue: QcIssue, body: Record<string, unknown>) => api(`/qc/issues/${issue.id}`, { method: "PATCH", body });

  const runScreen = async () => {
    setBusy("screen");
    try {
      const r = await api<{ job_id: string; status: string }>(`/slides/${slide.id}/qc/screen`, { method: "POST" });
      toast.show({ tone: "info", title: "Screening queued", body: "The worker runs it in the background; results appear here." });
      const job = await pollJob<Job>(r.job_id, setScreenJob, { timeoutMs: 120000 });
      if (job.status === "succeeded") await onChanged();
      else toast.show({ tone: "warning", title: `Screening ${job.status}`, body: job.error ?? (job.status === "queued" ? "Is the worker running?" : undefined) });
    } catch (err) {
      toast.show({ tone: "error", title: "Could not queue the screen", body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const calibration = slide.mpp_x
    ? { tone: "success" as const, text: `${slide.mpp_x} µm per pixel recorded in the file. Scale bar shown.` }
    : slide.image_kind === "synthetic_tiles"
      ? { tone: "neutral" as const, text: "Synthetic tiles have no physical calibration by construction. No scale bar, no measurements." }
      : { tone: "warning" as const, text: "Missing calibration: microns per pixel is unknown. No scale bar and no physical measurements are shown." };

  return (
    <div data-testid="qc-panel">
      <PanelSection title="Policy">
        <p className="text-small text-ink">{qc.policy}</p>
        <Notice tone={calibration.tone === "success" ? "success" : calibration.tone === "warning" ? "warning" : "neutral"} className="mt-2" title="Calibration">
          {calibration.text}
        </Notice>
      </PanelSection>

      <PanelSection
        title={
          <span className="flex items-center gap-2">
            Automated screen
            <span className="rounded-[3px] border border-amber/70 bg-amber-tint px-1.5 text-[11px] font-bold text-amber-ink">EXPERIMENTAL</span>
          </span>
        }
        aside={
          <Button size="sm" variant="quiet" icon={<ScanSearch size={14} aria-hidden />} busy={busy === "screen"} unavailable={can("qc.screen") ? (slide.ingest_status !== "succeeded" ? "Only ingested slides can be screened." : null) : "Running the screen needs the histology assistant or pathologist demo role."} onClick={runScreen}>
            Run again
          </Button>
        }
        testId="qc-screen"
      >
        <p className="mb-2 text-micro text-graphite">{qc.experimental_notice}</p>
        {screenJob && screenJob.status !== "succeeded" ? (
          <p className="mb-2 text-small text-amber-ink" role="status">
            Screening job {screenJob.status}
            {screenJob.status === "queued" ? ": waiting for the worker" : ""}…
          </p>
        ) : null}
        {latest ? (
          <>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-small">
              <dt className="text-graphite">Tissue fraction ({m.tissue?.method ?? "Otsu"})</dt>
              <dd className="tabular text-right font-semibold" data-testid="tissue-fraction">
                {m.tissue?.tissue_fraction !== undefined ? `${(m.tissue.tissue_fraction * 100).toFixed(1)}%` : "n/a"}
                <span className="block text-micro font-normal text-graphite">flag below {((m.thresholds?.low_tissue_fraction ?? 0.05) * 100).toFixed(0)}%</span>
              </dd>
              <dt className="text-graphite">Focus: median variance of Laplacian</dt>
              <dd className="tabular text-right font-semibold">
                {m.focus?.median_variance ?? "n/a"}
                <span className="block text-micro font-normal text-graphite">
                  {m.focus?.suspected_blur ? "below" : "above"} the uncalibrated threshold {m.thresholds?.blur_variance ?? "?"}
                </span>
              </dd>
              <dt className="text-graphite">Calibration</dt>
              <dd className="text-right font-semibold">{humanize(m.calibration?.status ?? "unknown")}</dd>
            </dl>
            <p className="mt-2 text-micro text-graphite">
              {latest.method_version} · {formatDateTime(latest.created_at)} · thresholds {m.thresholds?.calibrated ? "calibrated" : "not calibrated"}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Button size="sm" icon={<Layers size={14} aria-hidden />} aria-pressed={maskOn} unavailable={latest.has_mask ? null : "This screen stored no tissue mask."} onClick={onToggleMask} data-testid="toggle-mask">
                {maskOn ? "Hide tissue mask" : "Show tissue mask"}
              </Button>
              <Button size="sm" unavailable={writeReason} onClick={() => setOverride({ metric: "focus", verdict: "adequate", reason: "" })}>
                Override a metric
              </Button>
            </div>
            {override ? (
              <div className="mt-3 space-y-2 rounded-[var(--radius-control)] border border-line bg-surface p-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <SelectField
                    label="Metric"
                    value={override.metric}
                    onChange={(e) => setOverride({ ...override, metric: e.target.value })}
                    options={[
                      { value: "tissue_fraction", label: "Tissue fraction" },
                      { value: "focus", label: "Focus" },
                      { value: "calibration", label: "Calibration" },
                    ]}
                  />
                  <SelectField
                    label="Human verdict"
                    value={override.verdict}
                    onChange={(e) => setOverride({ ...override, verdict: e.target.value })}
                    options={[
                      { value: "adequate", label: "Adequate" },
                      { value: "inadequate", label: "Inadequate" },
                      { value: "not_assessable", label: "Not assessable" },
                    ]}
                  />
                </div>
                <TextField label="Reason" required value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="quiet" onClick={() => setOverride(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    busy={busy === "override"}
                    unavailable={override.reason.trim() ? null : "An override needs a reason."}
                    onClick={async () => {
                      const ok = await act("override", () => api(`/slides/${slide.id}/qc/override`, { method: "POST", body: { review_id: latest.id, ...override } }), "Override recorded", "Kept alongside the automated value; neither is deleted.");
                      if (ok) setOverride(null);
                    }}
                  >
                    Save override
                  </Button>
                </div>
              </div>
            ) : null}
            {overrides.length ? (
              <ul className="mt-3 space-y-1 text-micro">
                {overrides.map((o) => {
                  const ov = (o.metrics as { override?: { metric: string; verdict: string } }).override;
                  return (
                    <li key={o.id} className="rounded border border-line bg-sheet px-2 py-1">
                      <strong>Human override</strong>: {humanize(ov?.metric)} judged {humanize(ov?.verdict).toLowerCase()} by {userName(o.created_by, demoUsers)} · {formatDateTime(o.created_at)} · “{o.reason}”
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-small text-graphite">No automated screen has run on this slide. Run it to measure tissue fraction and the focus heuristic.</p>
        )}
      </PanelSection>

      <PanelSection
        title={`Quality issues (${qc.issues.filter((i) => i.status !== "resolved").length} open)`}
        aside={
          <Button size="sm" variant="primary" unavailable={writeReason} onClick={() => setNewIssue({ category: "fold", note: "", useRegion: Boolean(selectedAnnotation) })} data-testid="new-issue">
            Record issue
          </Button>
        }
        testId="qc-issues"
      >
        {newIssue ? (
          <div className="mb-3 space-y-2 rounded-[var(--radius-control)] border border-teal/40 bg-teal-tint/40 p-2.5" data-testid="new-issue-form">
            <SelectField
              label="Category"
              value={newIssue.category}
              onChange={(e) => setNewIssue({ ...newIssue, category: e.target.value })}
              options={(meta?.qc.manual_categories ?? ["fold", "chatter", "stain_variation", "contamination_concern", "incomplete_tissue", "scan_focus", "unreadable_region", "missing_calibration"]).map((c) => ({ value: c, label: QC_CATEGORY_LABEL[c] ?? humanize(c) }))}
              hint="Recorded by a person. The prototype has no detector for these categories."
            />
            <TextArea label="What did you see?" value={newIssue.note} onChange={(e) => setNewIssue({ ...newIssue, note: e.target.value })} />
            <label className="flex items-start gap-2 text-small">
              <input
                type="checkbox"
                checked={newIssue.useRegion && Boolean(selectedAnnotation)}
                disabled={!selectedAnnotation}
                onChange={(e) => setNewIssue({ ...newIssue, useRegion: e.target.checked })}
                className="mt-1 accent-[var(--color-teal)]"
              />
              <span>
                Attach the selected outline as the issue region
                <span className="block text-micro text-graphite">{selectedAnnotation ? "Stored in level-0 pixels; allows a region-only exclusion later." : "Select an outline on the slide to attach a region."}</span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="quiet" onClick={() => setNewIssue(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                busy={busy === "new"}
                data-testid="save-issue"
                onClick={async () => {
                  const region =
                    newIssue.useRegion && selectedAnnotation
                      ? { type: "polygon", points: selectedAnnotation.geometry.coordinates[0].slice(0, -1) }
                      : null;
                  const ok = await act(
                    "new",
                    () => api(`/slides/${slide.id}/qc/issues`, { method: "POST", body: { category: newIssue.category, note: newIssue.note || null, region } }),
                    "Issue recorded",
                    "Status: open. Next: a review, a suggested action and a resolution.",
                  );
                  if (ok) setNewIssue(null);
                }}
              >
                Save issue
              </Button>
            </div>
          </div>
        ) : null}
        {qc.issues.length === 0 ? <p className="text-small text-graphite">No quality issue recorded for this slide.</p> : null}
        <ul className="space-y-3">
          {qc.issues.map((issue) => (
            <li key={issue.id} className={cn("rounded-[var(--radius-control)] border p-3", issue.status === "resolved" ? "border-line bg-surface" : "border-amber/60 bg-amber-tint/30")} data-testid="qc-issue" data-status={issue.status} data-category={issue.category}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold text-ink">{QC_CATEGORY_LABEL[issue.category] ?? humanize(issue.category)}</p>
                {issue.source === "heuristic" ? (
                  <span className="inline-flex items-center gap-1 rounded-[3px] border border-amber/70 bg-amber-tint px-1.5 text-[11px] font-bold text-amber-ink">
                    <FlaskConical size={11} aria-hidden /> heuristic suggestion
                  </span>
                ) : (
                  <span className="rounded-[3px] border border-line-strong bg-sheet px-1.5 text-[11px] font-bold text-graphite">recorded by a person</span>
                )}
                {issue.overridden ? <span className="rounded-[3px] bg-excluded-tint px-1.5 text-[11px] font-bold text-graphite">overridden by a person</span> : null}
                {issue.region ? (
                  <button type="button" className="ml-auto text-micro font-semibold text-teal-deep underline" onClick={() => onShowRegion(issue.id)}>
                    Show region
                  </button>
                ) : null}
              </div>
              <Stepper issue={issue} />
              <dl className="mt-2 space-y-0.5 text-micro">
                {issue.note ? (
                  <div>
                    <dt className="inline text-graphite">Note: </dt>
                    <dd className="inline text-ink">{issue.note}</dd>
                  </div>
                ) : null}
                {issue.human_confirmed !== null ? (
                  <div>
                    <dt className="inline text-graphite">Review: </dt>
                    <dd className="inline text-ink">{issue.human_confirmed ? "confirmed" : "not confirmed"}</dd>
                  </div>
                ) : null}
                {issue.suggested_action ? (
                  <div>
                    <dt className="inline text-graphite">Suggested action (for a human decision): </dt>
                    <dd className="inline text-ink">{QC_ACTION_LABEL[issue.suggested_action] ?? issue.suggested_action}</dd>
                  </div>
                ) : null}
                {issue.resolution ? (
                  <div>
                    <dt className="inline text-graphite">Resolution: </dt>
                    <dd className="inline text-ink">{issue.resolution}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="inline text-graphite">Dataset eligibility: </dt>
                  <dd className={cn("inline font-semibold", issue.dataset_eligibility_effect && issue.dataset_eligibility_effect !== "none" && issue.status === "resolved" ? "text-rust" : "text-ink")} data-testid="eligibility-effect">
                    {issue.status === "resolved" ? ELIGIBILITY_LABEL[issue.dataset_eligibility_effect ?? "none"] : "decided at resolution"}
                  </dd>
                </div>
              </dl>
              {canWrite ? (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {issue.status === "open" ? (
                    <Button size="sm" variant="review" onClick={() => setForm({ kind: "review", issue, confirmed: "yes", reason: "" })} data-testid="issue-review">
                      Review
                    </Button>
                  ) : null}
                  {issue.status === "reviewed" || issue.status === "action_suggested" ? (
                    <Button size="sm" variant="review" onClick={() => setForm({ kind: "suggest", issue, action: issue.suggested_action ?? "review_region", reason: "" })} data-testid="issue-suggest">
                      {issue.status === "action_suggested" ? "Change suggestion" : "Suggest action"}
                    </Button>
                  ) : null}
                  {issue.status === "reviewed" || issue.status === "action_suggested" ? (
                    <Button size="sm" variant="primary" onClick={() => setForm({ kind: "resolve", issue, resolution: "", effect: "none", reason: "" })} data-testid="issue-resolve">
                      Resolve
                    </Button>
                  ) : null}
                  {issue.source === "heuristic" && issue.status !== "resolved" ? (
                    <Button size="sm" onClick={() => setForm({ kind: "override", issue, reason: "" })}>
                      Override
                    </Button>
                  ) : null}
                  {issue.status === "resolved" ? (
                    <Button size="sm" variant="quiet" onClick={() => setForm({ kind: "reopen", issue, reason: "" })}>
                      Reopen
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {form && form.issue.id === issue.id ? (
                <div className="mt-3 space-y-2 rounded-[var(--radius-control)] border border-line bg-surface p-2.5" data-testid="issue-form">
                  {form.kind === "review" ? (
                    <fieldset className="flex gap-4 text-small">
                      <legend className="mb-1 font-semibold">Is the finding real?</legend>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" checked={form.confirmed === "yes"} onChange={() => setForm({ ...form, confirmed: "yes" })} className="accent-[var(--color-teal)]" /> Confirmed
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" checked={form.confirmed === "no"} onChange={() => setForm({ ...form, confirmed: "no" })} className="accent-[var(--color-teal)]" /> Not confirmed
                      </label>
                    </fieldset>
                  ) : null}
                  {form.kind === "suggest" ? (
                    <SelectField
                      label="Suggested corrective action"
                      hint="A proposal for a person to decide. Nothing is ordered, recut or rescanned."
                      value={form.action}
                      data-testid="suggest-select"
                      onChange={(e) => setForm({ ...form, action: e.target.value })}
                      options={(meta?.qc.suggested_actions ?? Object.keys(QC_ACTION_LABEL)).map((a) => ({ value: a, label: QC_ACTION_LABEL[a] ?? humanize(a) }))}
                    />
                  ) : null}
                  {form.kind === "resolve" ? (
                    <>
                      <TextField label="Resolution: what was decided or done" required value={form.resolution} data-testid="resolution-text" onChange={(e) => setForm({ ...form, resolution: e.target.value })} />
                      <SelectField
                        label="Effect on dataset eligibility"
                        value={form.effect}
                        data-testid="effect-select"
                        onChange={(e) => setForm({ ...form, effect: e.target.value })}
                        options={(meta?.qc.eligibility_effects ?? ["none", "exclude_slide", "exclude_region"]).map((x) => ({
                          value: x,
                          label: ELIGIBILITY_LABEL[x] ?? x,
                          disabled: x === "exclude_region" && !issue.region,
                        }))}
                        hint={issue.region ? undefined : "Excluding a region needs an issue recorded with a region."}
                      />
                    </>
                  ) : null}
                  <TextField
                    label={form.kind === "override" || form.kind === "reopen" || (form.kind === "resolve" && form.effect !== "none") ? "Reason" : "Reason (optional)"}
                    required={form.kind === "override" || form.kind === "reopen" || (form.kind === "resolve" && form.effect !== "none")}
                    value={form.reason}
                    data-testid="issue-reason"
                    onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="quiet" onClick={() => setForm(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      busy={busy === `f-${issue.id}`}
                      data-testid="issue-submit"
                      onClick={async () => {
                        const f = form;
                        const body: Record<string, unknown> =
                          f.kind === "review"
                            ? { action: "review", confirmed: f.confirmed === "yes", reason: f.reason || null }
                            : f.kind === "suggest"
                              ? { action: "suggest_action", suggested_action: f.action, reason: f.reason || null }
                              : f.kind === "resolve"
                                ? { action: "resolve", resolution: f.resolution, dataset_eligibility_effect: f.effect, reason: f.reason || null }
                                : f.kind === "override"
                                  ? { action: "override", reason: f.reason }
                                  : { action: "reopen", reason: f.reason };
                        const ok = await act(`f-${issue.id}`, () => patch(issue, body), `Issue ${f.kind === "suggest" ? "action suggested" : f.kind === "review" ? "reviewed" : f.kind === "resolve" ? "resolved" : f.kind === "override" ? "overridden" : "reopened"}`);
                        if (ok) setForm(null);
                      }}
                    >
                      {form.kind === "review" ? "Save review" : form.kind === "suggest" ? "Save suggestion" : form.kind === "resolve" ? "Resolve issue" : form.kind === "override" ? "Override finding" : "Reopen issue"}
                    </Button>
                  </div>
                </div>
              ) : null}
              {issue.history?.length ? (
                <div className="mt-2">
                  <Disclosure summary={`History (${issue.history.length})`}>
                    <ol className="space-y-1 text-micro">
                      {issue.history.map((h, i) => (
                        <li key={i} className="text-ink">
                          {formatDateTime(h.at)} · {userName(h.actor_id, demoUsers)} · {humanize(h.action)} → {QC_STATUS_LABEL[h.to_status] ?? h.to_status}
                          {h.reason ? <span className="text-graphite"> · “{h.reason}”</span> : null}
                        </li>
                      ))}
                    </ol>
                  </Disclosure>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </PanelSection>
    </div>
  );
}
