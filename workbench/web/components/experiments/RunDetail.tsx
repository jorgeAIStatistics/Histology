"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Lock, ShieldCheck } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { api, errorText } from "@/lib/api";
import { LABEL_SHORT, formatBytes, formatDateTime, humanize, isSpecOnlySlide, shortHash, userName } from "@/lib/format";
import type { ErrorItem, Evaluation, LabelValue, MetricValue, Run, Slide, ViewerToken } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ErrorBox, Loading, Notice } from "@/components/ui/Notice";
import { PipelineTestBanner } from "@/components/ui/Badges";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { TextField } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { CalibrationChart, CoverageChart } from "./Charts";
import { HEAD_LABEL, MlUnavailable, RunStatus } from "./ExperimentsView";

const METRIC_LABEL: Record<string, string> = {
  sensitivity: "Sensitivity (recall)",
  specificity: "Specificity",
  ppv: "Precision / PPV",
  npv: "NPV",
  auroc: "AUROC",
  auprc: "AUPRC (average precision)",
};

function fmt(v: number | null | undefined, d = 3) {
  return v === null || v === undefined ? "n/a" : v.toFixed(d);
}

function MetricRow({ name, m }: { name: string; m: MetricValue & { ci_reason?: string | null; prevalence_baseline?: number } }) {
  const isRatio = m.denominator !== undefined;
  return (
    <tr className="border-b border-line align-top" data-testid={`metric-${name}`}>
      <th scope="row" className="py-2 pr-3 text-left font-semibold text-ink">
        {METRIC_LABEL[name] ?? name}
      </th>
      <td className="tabular py-2 pr-3 font-bold">
        {m.value === null ? <span className="font-semibold text-amber-ink">{m.undefined_reason ?? "undefined"}</span> : m.value.toFixed(3)}
      </td>
      <td className="tabular py-2 pr-3 text-ink">{isRatio ? `${m.numerator} / ${m.denominator}` : m.prevalence_baseline !== undefined ? `baseline ${m.prevalence_baseline.toFixed(3)}` : "rank metric"}</td>
      <td className="tabular py-2 text-graphite">{m.ci ? `${m.ci[0].toFixed(3)} – ${m.ci[1].toFixed(3)}` : <span className="text-micro">{m.ci_reason ?? "no interval"}</span>}</td>
    </tr>
  );
}

function Confusion({ ev }: { ev: Evaluation }) {
  const c = ev.confusion;
  const pos = LABEL_SHORT[(ev as unknown as { positive_class: LabelValue }).positive_class] ?? "positive";
  const neg = LABEL_SHORT[(ev as unknown as { negative_class: LabelValue }).negative_class] ?? "negative";
  const cell = (n: number, label: string, tone: string) => (
    <td className={cn("h-20 w-36 border border-line-strong text-center", tone)}>
      <span className="tabular block text-title font-bold text-ink">{n}</span>
      <span className="block text-micro text-graphite">{label}</span>
    </td>
  );
  return (
    <table className="text-small" data-testid="confusion-matrix">
      <caption className="mb-2 text-left font-bold text-ink">Confusion matrix ({ev.n_items} items, {ev.n_patients} patients)</caption>
      <thead>
        <tr>
          <td />
          <th scope="col" className="px-2 pb-1 text-micro font-semibold text-graphite">
            Predicted {pos}
          </th>
          <th scope="col" className="px-2 pb-1 text-micro font-semibold text-graphite">
            Predicted {neg}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row" className="pr-2 text-right text-micro font-semibold text-graphite">
            Truth: {pos}
          </th>
          {cell(c.tp, "true positive", "bg-approved-tint/60")}
          {cell(c.fn, "false negative", "bg-berry-tint/70")}
        </tr>
        <tr>
          <th scope="row" className="pr-2 text-right text-micro font-semibold text-graphite">
            Truth: {neg}
          </th>
          {cell(c.fp, "false positive", "bg-amber-tint/70")}
          {cell(c.tn, "true negative", "bg-approved-tint/60")}
        </tr>
      </tbody>
    </table>
  );
}

function EvaluationBody({ ev }: { ev: Evaluation & { warnings?: string[]; unscored?: unknown[] } }) {
  return (
    <div className="space-y-5" data-testid={`evaluation-${ev.split}`}>
      {ev.warnings?.length ? (
        <Notice tone="warning" title="Read these numbers with care">
          <ul className="list-disc pl-4">
            {ev.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[auto_minmax(0,1fr)]">
        <Confusion ev={ev} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-small" data-testid="metrics-table">
            <caption className="mb-2 text-left font-bold text-ink">Metrics with numerators, denominators and patient-cluster bootstrap 95% intervals</caption>
            <thead>
              <tr className="border-b border-line-strong text-left text-micro text-graphite">
                <th scope="col" className="pb-1 font-semibold">Metric</th>
                <th scope="col" className="pb-1 font-semibold">Value</th>
                <th scope="col" className="pb-1 font-semibold">Numerator / denominator</th>
                <th scope="col" className="pb-1 font-semibold">95% interval</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ev.metrics).map(([k, m]) => (
                <MetricRow key={k} name={k} m={m} />
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-micro text-graphite">
            {ev.positives} positive and {ev.negatives} negative items. Bootstrap: {ev.bootstrap ? `${ev.bootstrap.method.replace("_", "-")}, ${ev.bootstrap.n_boot} replicates, seed ${ev.bootstrap.seed}` : "none"}
            {(ev.bootstrap as { status?: string } | null)?.status && (ev.bootstrap as { status?: string }).status !== "ok" ? ` (${(ev.bootstrap as { status?: string }).status})` : ""}.
          </p>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-[var(--radius-panel)] border border-line bg-sheet p-4">
          <h4 className="font-bold">Calibration</h4>
          <p className="mb-2 text-micro text-graphite">
            Brier {fmt(ev.calibration.brier)} · ECE {fmt(ev.calibration.ece)} · {ev.calibration.note}
          </p>
          {ev.n_items ? <CalibrationChart cal={ev.calibration} /> : <p className="text-small text-graphite">No scored items.</p>}
        </section>
        <section className="rounded-[var(--radius-panel)] border border-line bg-sheet p-4">
          <h4 className="font-bold">Coverage and error (abstention)</h4>
          <p className="mb-2 text-micro text-graphite">How the error rate changes if the least certain items go to a person instead.</p>
          {ev.coverage_curve.length ? <CoverageChart curve={ev.coverage_curve} /> : <p className="text-small text-graphite">No scored items.</p>}
        </section>
      </div>
      <section>
        <h4 className="font-bold">Subgroups (scanner, site, stain)</h4>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-small" data-testid="subgroups">
            <thead>
              <tr className="border-b border-line-strong text-micro text-graphite">
                <th scope="col" className="py-1 font-semibold">Group</th>
                <th scope="col" className="py-1 text-right font-semibold">n</th>
                <th scope="col" className="py-1 pl-4 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {ev.subgroups.map((g) => (
                <tr key={`${g.key}:${g.value}`} className="border-b border-line">
                  <th scope="row" className="py-1.5 font-normal">
                    {humanize(g.key.replace("_id", ""))}: <span className="font-semibold">{g.value}</span>
                  </th>
                  <td className="tabular py-1.5 text-right">{g.n}</td>
                  <td className="py-1.5 pl-4">
                    {g.status === "ok" && g.metrics ? (
                      <span className="text-ink">
                        sensitivity {fmt(g.metrics.sensitivity?.value, 2)} ({g.metrics.sensitivity?.numerator}/{g.metrics.sensitivity?.denominator}) · specificity {fmt(g.metrics.specificity?.value, 2)} ({g.metrics.specificity?.numerator}/
                        {g.metrics.specificity?.denominator}) <span className="text-micro text-graphite">point estimates, exploratory</span>
                      </span>
                    ) : (
                      <span className="font-semibold text-amber-ink">{(g as { reason?: string }).reason ?? "insufficient evidence"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ErrorCard({ item, runId, attention }: { item: ErrorItem & { threshold?: number; attributes?: Record<string, unknown> }; runId: string; attention: boolean }) {
  const [thumb, setThumb] = useState<string | null | "none">(null);
  useEffect(() => {
    let live = true;
    (async () => {
      // Pipeline-test cohort records have no image: never request a viewer for them.
      const s = await api<Slide>(`/slides/${item.slide_id}`);
      if (!s.has_thumbnail || isSpecOnlySlide(s)) {
        if (live) setThumb("none");
        return;
      }
      const t = await api<ViewerToken>(`/slides/${item.slide_id}/viewer-token`);
      if (live) setThumb(t.thumbnail_url);
    })().catch(() => live && setThumb("none"));
    return () => {
      live = false;
    };
  }, [item.slide_id]);
  const fn = item.error_type === "false_negative";
  return (
    <li className={cn("flex gap-3 rounded-[var(--radius-control)] border bg-sheet p-3", fn ? "border-berry/50" : "border-amber/60")} data-testid="error-card" data-error-type={item.error_type}>
      <div className="flex h-20 w-24 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-paraffin">
        {thumb && thumb !== "none" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={`Thumbnail of slide ${item.slide_id.slice(0, 8)} (synthetic tiles)`} className="h-full w-full object-cover" />
        ) : (
          <span className="px-1 text-center text-[11px] text-graphite">{thumb === "none" ? "no image: generator-spec record" : "…"}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 text-small">
        <p className={cn("font-bold", fn ? "text-berry" : "text-amber-ink")}>{fn ? "False negative" : "False positive"}</p>
        <p className="text-ink">
          {item.patient_code} · truth {LABEL_SHORT[item.label as LabelValue] ?? item.label} · predicted {LABEL_SHORT[item.predicted as LabelValue] ?? item.predicted}
        </p>
        <p className="tabular text-micro text-graphite">
          score {item.score.toFixed(3)} vs threshold {item.threshold?.toFixed(3) ?? "?"}
          {item.attributes ? ` · ${[item.attributes.scanner_id, item.attributes.site_id, item.attributes.stain].filter(Boolean).join(", ")}` : ""}
        </p>
        <p className="mt-1 text-micro text-ink">{item.failure_reason ?? "No recorded QC issue or calibration gap: no candidate reason. (A reason here would be a possible factor, never a cause.)"}</p>
        <div className="mt-1.5 flex flex-wrap gap-3">
          {thumb && thumb !== "none" ? (
            <Link href={`/review/${item.slide_id}${attention ? `?run=${runId}` : ""}`} className="text-micro font-semibold text-teal-deep underline" data-testid="error-open-slide">
              Open in Slide Review{attention ? " with attention" : ""}
            </Link>
          ) : (
            <span className="text-micro text-graphite" data-testid="error-no-image">Generator-spec record from the pipeline-test cohort: there is no image to open.</span>
          )}
        </div>
      </div>
    </li>
  );
}

export function RunDetail({ runId }: { runId: string }) {
  const { can, demoUsers, projectId, setProjectId, me } = useSession();
  const router = useRouter();
  const toast = useToast();
  const ml = useApi<{ items: unknown[] }>("/encoders");
  const run = useApi<Run & Record<string, unknown>>(`/experiments/${runId}`);
  const ready = run.data?.status === "succeeded";
  const val = useApi<Evaluation & { warnings?: string[] }>(ready ? `/experiments/${runId}/evaluation?split=val` : null);
  const errs = useApi<{ items: (ErrorItem & { threshold?: number })[]; counts: Record<string, number>; order: string; failure_reason_note: string }>(ready ? `/experiments/${runId}/errors?split=val` : null);
  const [tab, setTab] = useState("val");
  const [test, setTest] = useState<Evaluation | null>(null);
  const [testErr, setTestErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [al, setAl] = useState<{ k: string; rf: string }>({ k: "8", rf: "0.25" });
  const [alOut, setAlOut] = useState<{ items: { slide_id: string; reason: string; score: number | null }[]; pool: string; notice: string } | null>(null);

  // Align the header's project with the run's project once per run. Re-aligning on every change silently undid a
  // project chosen in the top bar while this page was open; that choice now opens the chosen project's experiments.
  const projectSynced = useRef<string | null>(null);
  const runProject = run.data?.id === runId ? (run.data.project_id ?? null) : null;
  useEffect(() => {
    if (!runProject || !projectId) return;
    if (projectSynced.current !== runId) {
      projectSynced.current = runId;
      if (runProject !== projectId && me?.memberships.some((m) => m.project_id === runProject)) setProjectId(runProject);
      return;
    }
    if (runProject !== projectId) router.push("/experiments");
  }, [runProject, projectId, me, setProjectId, runId, router]);

  const active = run.data && (run.data.status === "queued" || run.data.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void run.reload(), 1500);
    return () => window.clearInterval(t);
  }, [active, run]);

  if (ml.error) {
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-6">
        <MlUnavailable error={ml.error} />
      </div>
    );
  }
  if (run.error) {
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-6">
        <ErrorBox error={run.error} what="open this run" />
      </div>
    );
  }
  if (!run.data) return <Loading className="mx-auto max-w-[1100px] px-6" label="Loading the run" />;
  const r = run.data;
  const thr = r.threshold as (Run["threshold"] & { selection_status?: string; reason?: string | null; val_sensitivity_at_threshold?: number; val_specificity_at_threshold?: number; comparison?: string }) | null;
  const splitCounts = (r.split_counts ?? {}) as Record<string, { patients?: number; items?: number }>;
  const training = r.training_summary as { epochs_run?: number; best_epoch?: number; early_stopping?: string } | null;
  const reasons = (r.synthetic_reasons as string[] | undefined) ?? [];

  const openTest = async () => {
    setBusy("test");
    setTestErr(null);
    try {
      setTest(await api<Evaluation>(`/experiments/${runId}/evaluation?split=test`));
      toast.show({ tone: "info", title: "Test evaluation opened (audited)", body: "Computed once with the threshold frozen on validation." });
    } catch (err) {
      setTestErr(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-16 pt-5 md:px-6 xl:px-8">
      <Link href="/experiments" className="inline-flex items-center gap-1 text-small font-semibold text-teal-deep">
        <ArrowLeft size={15} aria-hidden /> All experiments
      </Link>
      {r.synthetic ? (
        <div className="mt-3">
          <PipelineTestBanner text={reasons.length ? `Why: ${reasons.join("; ")}.` : null} />
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-bold md:text-display" data-testid="run-title">
            {r.name}
          </h1>
          <p className="mt-1 text-small text-graphite">
            {HEAD_LABEL[r.head] ?? r.head} · {r.encoder_id} · seed {r.seed} · {r.dataset_name} · started by {userName(r.created_by, demoUsers)} {formatDateTime(r.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RunStatus run={r} />
          {r.registered_model_id ? (
            <span className="inline-flex items-center gap-1 text-small font-semibold text-teal-deep" data-testid="registered">
              <ShieldCheck size={15} aria-hidden /> Research candidate (never deployed)
            </span>
          ) : (
            <Button
              size="sm"
              variant="primary"
              busy={busy === "register"}
              data-testid="register-model"
              unavailable={!can("model.register") ? "Registering needs the research lead demo role (permission model.register)." : r.status !== "succeeded" ? "Only a finished run with a checkpoint can be registered." : null}
              onClick={async () => {
                setBusy("register");
                try {
                  await api(`/experiments/${runId}/register`, { method: "POST", body: {} });
                  toast.show({ tone: "success", title: "Registered as a research candidate", body: "Nothing is deployed. New uploads or labels never change it." });
                  await run.reload();
                } catch (err) {
                  toast.show({ tone: "error", title: "Not registered", body: errorText(err) });
                } finally {
                  setBusy(null);
                }
              }}
            >
              Register as research candidate
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-small text-graphite">{r.notice as string}</p>

      {r.status !== "succeeded" ? (
        <Notice tone={r.status === "failed" ? "error" : "info"} className="mt-4" title={`Run ${r.status}`}>
          {r.progress_message ?? ""} {r.error ?? (r.status === "queued" ? "Waiting for the worker (python -m dermpath.worker)." : "")}
        </Notice>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="rounded-[var(--radius-panel)] border border-line bg-surface p-4" data-testid="provenance">
          <h2 className="font-bold">Provenance: what makes it reproducible</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
            <dt className="text-graphite">Seed</dt>
            <dd className="font-mono">{r.seed}</dd>
            <dt className="text-graphite">Code revision</dt>
            <dd className="break-all font-mono text-micro">{r.code_revision ?? "not recorded"}</dd>
            <dt className="text-graphite">Dataset manifest</dt>
            <dd className="break-all font-mono text-micro">{r.dataset_manifest_sha256}</dd>
            <dt className="text-graphite">Weights</dt>
            <dd className="break-all font-mono text-micro">{r.weights_sha256 ?? "none"}</dd>
            <dt className="text-graphite">Checkpoint</dt>
            <dd className="break-all font-mono text-micro">{r.checkpoint ? `${r.checkpoint.sha256} · ${formatBytes(r.checkpoint.bytes)} · ${r.checkpoint.object_key}` : "none yet"}</dd>
            <dt className="text-graphite">Splits</dt>
            <dd>
              {Object.entries(splitCounts)
                .map(([k, v]) => `${k} ${v.patients ?? "?"} patients / ${v.items ?? "?"} items`)
                .join(" · ") || "n/a"}
            </dd>
            {training ? (
              <>
                <dt className="text-graphite">Training</dt>
                <dd>
                  {training.epochs_run ? `${training.epochs_run} epochs, best ${training.best_epoch}; ${training.early_stopping}` : "closed-form fit (logistic regression)"}
                </dd>
              </>
            ) : null}
          </dl>
          <details className="mt-3">
            <summary className="cursor-pointer text-small font-semibold text-teal-deep">Dependencies ({Object.keys(r.deps ?? {}).length})</summary>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 font-mono text-micro">
              {Object.entries(r.deps ?? {}).map(([k, v]) => (
                <li key={k}>
                  {k} {v}
                </li>
              ))}
            </ul>
          </details>
          <details className="mt-2">
            <summary className="cursor-pointer text-small font-semibold text-teal-deep">Parameters</summary>
            <pre className="mt-2 max-h-64 overflow-auto font-mono text-micro">{JSON.stringify(r.params, null, 2)}</pre>
          </details>
        </section>
        <section className="rounded-[var(--radius-panel)] border border-line bg-surface p-4" data-testid="threshold">
          <h2 className="font-bold">Operating threshold</h2>
          {thr ? (
            <>
              <p className="mt-2 text-small">
                <span className="tabular text-title font-bold">{thr.value.toFixed(3)}</span> <span className="text-graphite">({thr.comparison ?? "positive if score ≥ value"})</span>
              </p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
                <dt className="text-graphite">Chosen on</dt>
                <dd className="font-semibold">the validation split</dd>
                <dt className="text-graphite">Rule</dt>
                <dd>{humanize(thr.rule)}</dd>
                <dt className="text-graphite">Frozen</dt>
                <dd>{formatDateTime(thr.frozen_at)}, before any test evaluation</dd>
                {thr.val_sensitivity_at_threshold !== undefined && thr.val_sensitivity_at_threshold !== null ? (
                  <>
                    <dt className="text-graphite">On validation</dt>
                    <dd>
                      sensitivity {fmt(thr.val_sensitivity_at_threshold, 2)}, specificity {fmt(thr.val_specificity_at_threshold, 2)}
                    </dd>
                  </>
                ) : null}
              </dl>
              {thr.selection_status === "fallback" ? (
                <Notice tone="warning" className="mt-3" title="Fallback threshold">
                  {thr.reason}
                </Notice>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-small text-graphite">Not frozen yet: the run has not finished.</p>
          )}
          <div className="mt-4 rounded-[var(--radius-control)] border border-hema/40 bg-hema-tint/50 p-3 text-small">
            <p className="flex items-center gap-1.5 font-bold text-hema">
              <Lock size={14} aria-hidden /> Test split
            </p>
            <p className="mt-1 text-ink">Locked until the threshold is frozen on validation; then readable by the research lead only, and every access is audited.</p>
          </div>
        </section>
      </div>

      {ready ? (
        <section className="mt-6" aria-labelledby="eval">
          <h2 id="eval" className="text-title font-bold">
            Evaluation
          </h2>
          <Tabs
            idBase="ev"
            active={tab}
            onChange={setTab}
            className="mt-2"
            tabs={[
              { id: "val", label: "Validation" },
              { id: "test", label: "Test (locked)" },
              { id: "errors", label: `Errors (${errs.data?.counts.errors ?? "…"})` },
              { id: "al", label: "Active learning" },
            ]}
          />
          <TabPanel idBase="ev" id="val" active={tab} className="pt-4">
            <ErrorBox error={val.error} what="load the validation evaluation" />
            {val.data ? <EvaluationBody ev={val.data} /> : val.loading ? <Loading /> : null}
          </TabPanel>
          <TabPanel idBase="ev" id="test" active={tab} className="pt-4">
            {test ? (
              <>
                <Notice tone="info" className="mb-4" title="Test evaluation (audited access)">
                  Computed once with the checkpoint and the threshold frozen on validation. Looking at it again does not change it; tuning on it would invalidate it.
                </Notice>
                <EvaluationBody ev={test} />
              </>
            ) : (
              <div className="space-y-3">
                <p className="max-w-[72ch] text-small text-ink">
                  The test split stays untouched during development. Open it only when the run is final. The access is recorded in the audit trail with your name.
                </p>
                <Button
                  variant="primary"
                  icon={<Lock size={15} aria-hidden />}
                  busy={busy === "test"}
                  data-testid="open-test"
                  unavailable={can("dataset.test_access") ? (thr ? null : "The threshold has not been frozen on validation yet.") : "Only the research lead may open the test split (permission dataset.test_access)."}
                  onClick={openTest}
                >
                  Open the test evaluation (audited)
                </Button>
                {testErr ? <ErrorBox error={testErr} what="open the test evaluation" /> : null}
              </div>
            )}
          </TabPanel>
          <TabPanel idBase="ev" id="errors" active={tab} className="pt-4">
            <ErrorBox error={errs.error} what="load the error gallery" />
            {errs.data ? (
              <div data-testid="error-gallery">
                <p className="text-small text-ink">
                  Validation errors, {errs.data.order}. {errs.data.counts.false_negative} false negatives, {errs.data.counts.false_positive} false positives out of {errs.data.counts.n_items} items.
                </p>
                <p className="mt-1 text-micro text-graphite">
                  A failure reason appears only when a recorded QC issue or missing calibration offers a possible contributing factor. It is never a causal explanation.
                </p>
                {r.head === "abmil" ? (
                  <p className="mt-1 text-micro font-semibold text-amber-ink">
                    For slides with an image, Slide Review can show this run&rsquo;s attention weights, labelled as attention: not tumour segmentation and not an explanation.
                  </p>
                ) : null}
                {errs.data.items.length === 0 ? <p className="mt-3 text-small text-graphite">No validation error.</p> : null}
                <ul className="mt-3 grid gap-2 lg:grid-cols-2">
                  {errs.data.items.map((it) => (
                    <ErrorCard key={`${it.error_type}:${it.slide_id}`} item={it} runId={runId} attention={it.attention_available && r.head === "abmil"} />
                  ))}
                </ul>
              </div>
            ) : errs.loading ? (
              <Loading />
            ) : null}
          </TabPanel>
          <TabPanel idBase="ev" id="al" active={tab} className="pt-4">
            <div className="max-w-[900px] space-y-3">
              <p className="text-small text-ink">
                Proposes training-pool slides for expert labelling: the most uncertain, a diverse set and a random share so the selection does not tunnel. It never
                touches the test split and never creates a label: a pathologist labels whatever is proposed.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <TextField label="How many" type="number" min={1} max={500} value={al.k} onChange={(e) => setAl({ ...al, k: e.target.value })} />
                <TextField label="Random share (0–1)" type="number" step="0.05" min={0} max={1} value={al.rf} onChange={(e) => setAl({ ...al, rf: e.target.value })} />
                <Button
                  variant="primary"
                  busy={busy === "al"}
                  unavailable={can("experiment.write") ? null : "Active learning proposals need the research lead demo role."}
                  onClick={async () => {
                    setBusy("al");
                    try {
                      setAlOut(await api(`/projects/${r.project_id ?? projectId}/active-learning`, { method: "POST", body: { dataset_version_id: r.dataset_version_id, run_id: runId, k: Number(al.k) || 8, random_fraction: Number(al.rf) } }));
                    } catch (err) {
                      toast.show({ tone: "error", title: "No proposal", body: errorText(err) });
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Propose slides
                </Button>
              </div>
              {alOut ? (
                <div data-testid="active-learning">
                  <p className="text-small font-semibold">
                    Pool: {alOut.pool.replace("_", " ")}. {alOut.notice}
                  </p>
                  <ul className="mt-2 grid gap-1.5 md:grid-cols-2">
                    {alOut.items.map((it) => (
                      <li key={it.slide_id} className="rounded border border-line bg-sheet px-3 py-2 text-small">
                        <span className="font-mono">{it.slide_id.slice(0, 12)}</span> · {it.reason}
                        {it.score !== null ? <span className="text-graphite"> · score {it.score.toFixed(3)}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </TabPanel>
        </section>
      ) : null}
      <p className="mt-8 text-micro text-graphite">Run {r.id} · job {shortHash(r.job_id, 12)} · finished {formatDateTime(r.finished_at)}</p>
    </div>
  );
}
