"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Ban, FlaskConical, Play, RotateCcw } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { api, ApiError, errorText } from "@/lib/api";
import { formatDateTime, shortHash, userName } from "@/lib/format";
import type { DatasetVersion, Encoder, ModelVersion, Run } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ErrorBox, Loading, Notice } from "@/components/ui/Notice";
import { SelectField, TextField } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { ReadinessLadder } from "./ReadinessLadder";

export const HEAD_LABEL: Record<string, string> = {
  meanpool_logreg: "Baseline: mean-pooled embeddings + logistic regression",
  abmil: "Attention-based multiple-instance learning (ABMIL)",
};

const KIND_LABEL: Record<Encoder["kind"], string> = {
  synthetic: "Synthetic pipeline-test fixture",
  handcrafted: "Handcrafted technical baseline (not a pathology foundation model)",
  pathology_foundation: "Pathology foundation model",
  generic_imagenet: "Generic ImageNet model",
};

const ENCODER_STATUS_STYLE: Record<Encoder["status"], string> = {
  available: "border-approved/40 bg-approved-tint text-approved",
  missing_weights: "border-amber/70 bg-amber-tint text-amber-ink",
  missing_dependency: "border-amber/70 bg-amber-tint text-amber-ink",
  weights_mismatch: "border-rust/50 bg-rust-tint text-rust",
};

const STATUS_STYLE: Record<string, string> = {
  queued: "border-line-strong bg-sheet text-graphite",
  running: "border-teal/50 bg-teal-tint text-teal-deep",
  succeeded: "border-approved/40 bg-approved-tint text-approved",
  failed: "border-rust/50 bg-rust-tint text-rust",
  canceled: "border-line-strong bg-excluded-tint text-graphite",
};

export function RunStatus({ run }: { run: Run }) {
  return (
    <span className={cn("inline-flex h-6 items-center rounded-[var(--radius-chip)] border px-1.5 text-micro font-semibold", STATUS_STYLE[run.status] ?? STATUS_STYLE.queued)} data-testid="run-status">
      {run.status}
    </span>
  );
}

/** True when the API mounts the ML router; false with the reason otherwise. */
export function MlUnavailable({ error }: { error: unknown }) {
  const notMounted = error instanceof ApiError && (error.status === 404 || error.status === 405);
  return (
    <Notice tone="warning" title="ML service not available" className="mt-6">
      {notMounted ? (
        <p>
          This API does not mount the ML routes: <code className="font-mono">dermpath/ml/router.py</code> is not installed in the running backend
          (<code className="font-mono">GET /api/v1/encoders</code> returned HTTP {(error as ApiError).status}). Experiments, encoders and evaluations need that
          module and its worker job handlers (<code className="font-mono">dermpath.ml.jobs</code>). No results are shown rather than invented ones.
        </p>
      ) : (
        <p>{errorText(error)}</p>
      )}
    </Notice>
  );
}

export function ExperimentsView() {
  const { projectId, can, demoUsers } = useSession();
  const toast = useToast();
  const encoders = useApi<{ items: Encoder[]; note: string }>("/encoders");
  const runs = useApi<{ items: Run[] }>(projectId && !encoders.error ? `/projects/${projectId}/experiments` : null);
  const models = useApi<{ items: ModelVersion[]; note: string }>(projectId && !encoders.error ? `/projects/${projectId}/models` : null);
  const datasets = useApi<{ items: DatasetVersion[] }>(projectId ? `/projects/${projectId}/datasets` : null);
  const frozen = useMemo(() => (datasets.data?.items ?? []).filter((d) => d.status === "frozen"), [datasets.data]);
  const [form, setForm] = useState({ dataset: "", encoder: "synthetic-deterministic-v1", head: "meanpool_logreg", seed: "7", name: "", rule: "youden" });
  const [busy, setBusy] = useState<string | null>(null);
  const canWrite = can("experiment.write");

  useEffect(() => {
    if (!form.dataset && frozen.length) setForm((f) => ({ ...f, dataset: frozen[frozen.length - 1].id }));
  }, [frozen, form.dataset]);

  const active = (runs.data?.items ?? []).some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void runs.reload(), 2000);
    return () => window.clearInterval(t);
  }, [active, runs]);

  if (encoders.loading && !encoders.data) return <Loading className="mx-auto max-w-[1600px] px-6" label="Checking the ML service" />;

  const chosenEncoder = encoders.data?.items.find((e) => e.id === form.encoder);

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-16 pt-6 md:px-6 xl:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display font-bold tracking-tight">Experiments</h1>
          <p className="mt-1 max-w-[76ch] text-graphite">
            Reproducible training runs on frozen dataset versions. A simple baseline sits next to attention-based MIL; the complex head has to earn its
            place. Thresholds are chosen on validation; the test split stays locked until then.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <ReadinessLadder />
      </div>

      {encoders.error ? (
        <MlUnavailable error={encoders.error} />
      ) : (
        <>
          <section aria-labelledby="enc" className="mt-6">
            <h2 id="enc" className="text-title font-bold">
              Encoders
            </h2>
            <p className="mt-1 text-small text-graphite">{encoders.data?.note}</p>
            <div className="mt-3 overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-sheet">
              <table className="w-full min-w-[900px] text-left text-small" data-testid="encoder-table">
                <thead className="border-b border-line-strong bg-surface text-micro text-graphite">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-semibold">Encoder</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Licence</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Status and exactly what is missing</th>
                  </tr>
                </thead>
                <tbody>
                  {encoders.data?.items.map((e) => (
                    <tr key={e.id} className="border-b border-line align-top" data-testid={`encoder-${e.id}`}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-ink">{e.name}</p>
                        <p className="text-micro text-graphite" data-testid="encoder-kind">
                          {KIND_LABEL[e.kind] ?? e.kind}
                          {e.reads_pixels === false ? " · reads no pixels" : ""}
                        </p>
                        <p className="font-mono text-micro text-graphite">
                          {e.id} · {e.embedding_dim ?? "?"}-d · {e.preprocessing_version}
                        </p>
                        {e.spec_sha256 ? (
                          <p className="font-mono text-micro text-graphite" data-testid="encoder-spec">
                            adapter v{e.adapter_version ?? "?"}
                            {e.input_size ? ` · input ${e.input_size}px` : ""}
                            {e.pooling ? ` · ${e.pooling}` : ""}
                            {e.weights_format ? ` · ${e.weights_format}` : ""} · spec {shortHash(e.spec_sha256, 12)}
                          </p>
                        ) : null}
                        {e.synthetic ? <p className="mt-1 text-micro font-bold text-hema">Synthetic: carries no pathology information</p> : null}
                        {e.notice ? <p className="mt-1 max-w-[48ch] text-micro text-graphite">{e.notice}</p> : null}
                      </td>
                      <td className="px-3 py-3">
                        <p className="text-ink">{e.license.name}</p>
                        <p className={cn("text-micro font-semibold", e.license.commercial_use === "no" ? "text-rust" : "text-graphite")}>Commercial use: {e.license.commercial_use}</p>
                        {e.license.notes ? <p className="mt-1 max-w-[40ch] text-micro text-graphite">{e.license.notes}</p> : null}
                        {e.license.url ? (
                          <a href={e.license.url} target="_blank" rel="noreferrer noopener" className="text-micro font-semibold text-teal-deep underline">
                            Licence source
                          </a>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={cn(
                            "inline-flex h-6 items-center rounded-[var(--radius-chip)] border px-1.5 text-micro font-bold",
                            ENCODER_STATUS_STYLE[e.status] ?? ENCODER_STATUS_STYLE.missing_weights,
                          )}
                          data-testid="encoder-status"
                        >
                          {e.status.replace(/_/g, " ")}
                        </span>
                        {e.status_detail ? (
                          <p className="mt-1.5 max-w-[60ch] text-small text-ink" data-testid="encoder-status-detail">
                            {e.status_detail}
                          </p>
                        ) : (
                          <p className="mt-1.5 text-micro text-graphite">weights: {e.weights_sha256 ? shortHash(e.weights_sha256, 16) : "none (no weights exist for this encoder)"}</p>
                        )}
                        {e.status === "weights_mismatch" ? (
                          <p className="mt-1 max-w-[60ch] text-micro font-semibold text-rust">
                            The local files do not match this encoder&rsquo;s pinned identity; it is refused rather than run with unknown weights.
                          </p>
                        ) : null}
                        {e.weights_env || e.license_env || e.expected_weights_sha256_env ? (
                          <p className="mt-1 max-w-[60ch] font-mono text-micro text-graphite" data-testid="encoder-env">
                            {[e.weights_env, e.license_env, e.expected_weights_sha256_env ? `${e.expected_weights_sha256_env} (optional pin)` : null].filter(Boolean).join(" · ")}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="new-exp" className="mt-8 rounded-[var(--radius-panel)] border border-line bg-surface p-4">
            <h2 id="new-exp" className="text-title font-bold">
              New experiment
            </h2>
            {frozen.length === 0 ? (
              <p className="mt-2 text-small text-amber-ink">
                No frozen dataset version in this project. Freeze one on the{" "}
                <Link href="/dataset" className="font-semibold underline">
                  Dataset
                </Link>{" "}
                screen first.
              </p>
            ) : null}
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              <SelectField
                className="xl:col-span-2"
                label="Frozen dataset version"
                value={form.dataset}
                onChange={(e) => setForm({ ...form, dataset: e.target.value })}
                options={frozen.length ? frozen.map((d) => ({ value: d.id, label: `${d.name} v${d.version} (${d.item_count} slides)` })) : [{ value: "", label: "none frozen" }]}
              />
              <SelectField
                label="Encoder"
                value={form.encoder}
                onChange={(e) => setForm({ ...form, encoder: e.target.value })}
                options={(encoders.data?.items ?? []).map((e) => ({ value: e.id, label: `${e.name}${e.status === "available" ? "" : ` (${e.status.replace(/_/g, " ")})`}` }))}
              />
              <SelectField
                label="Head"
                value={form.head}
                onChange={(e) => setForm({ ...form, head: e.target.value })}
                options={[
                  { value: "meanpool_logreg", label: "Baseline: mean pool + logistic regression" },
                  { value: "abmil", label: "Attention MIL" },
                ]}
              />
              <TextField label="Seed" type="number" min={0} value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} />
              <SelectField
                label="Threshold rule (on validation)"
                value={form.rule}
                onChange={(e) => setForm({ ...form, rule: e.target.value })}
                options={[
                  { value: "youden", label: "Youden J" },
                  { value: "target_sensitivity", label: "Target sensitivity 0.9" },
                ]}
              />
            </div>
            {chosenEncoder && chosenEncoder.status !== "available" ? (
              <Notice tone="warning" className="mt-3" title={`${chosenEncoder.name} cannot run here`}>
                {chosenEncoder.status_detail} It is never silently replaced by another encoder under the same name.
              </Notice>
            ) : null}
            {chosenEncoder?.synthetic ? (
              <p className="mt-3 text-small font-semibold text-hema">Results from this encoder are labelled PIPELINE TEST — NOT PATHOLOGY VALIDATION.</p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <TextField className="min-w-[280px] flex-1" label="Name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Button
                variant="primary"
                icon={<Play size={15} aria-hidden />}
                busy={busy === "create"}
                className="self-end"
                data-testid="start-experiment"
                unavailable={
                  !canWrite
                    ? "Starting experiments needs the research lead demo role (permission experiment.write)."
                    : !form.dataset
                      ? "Freeze a dataset version first."
                      : chosenEncoder && chosenEncoder.status !== "available"
                        ? `Encoder unavailable: ${chosenEncoder.status_detail ?? chosenEncoder.status}`
                        : null
                }
                onClick={async () => {
                  setBusy("create");
                  try {
                    const r = await api<{ experiment: Run; job_id: string }>(`/projects/${projectId}/experiments`, {
                      method: "POST",
                      body: { dataset_version_id: form.dataset, encoder_id: form.encoder, head: form.head, seed: Number(form.seed) || 0, name: form.name || null, params: { threshold_rule: form.rule } },
                    });
                    toast.show({ tone: "success", title: "Experiment queued", body: `Job ${r.job_id.slice(0, 8)}… runs on the worker; this page does not wait for it.` });
                    await runs.reload();
                  } catch (err) {
                    toast.show({ tone: "error", title: "Experiment not started", body: errorText(err) });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Queue experiment
              </Button>
            </div>
          </section>

          <section aria-labelledby="runs" className="mt-8">
            <h2 id="runs" className="text-title font-bold">
              Runs
            </h2>
            <ErrorBox error={runs.error} what="load runs" className="mt-2" />
            <div className="mt-3 overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-sheet">
              <table className="w-full min-w-[960px] text-left text-small" data-testid="run-table">
                <thead className="border-b border-line-strong bg-surface text-micro text-graphite">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-semibold">Run</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Dataset</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Head · encoder · seed</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Job</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(runs.data?.items ?? []).length === 0 && runs.data ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-graphite">
                        No run yet in this project.
                      </td>
                    </tr>
                  ) : null}
                  {(runs.data?.items ?? []).map((r) => (
                    <tr key={r.id} className="border-b border-line align-top" data-testid="run-row">
                      <td className="px-4 py-3">
                        <Link href={`/experiments/${r.id}`} className="font-semibold text-ink hover:text-teal-deep hover:underline">
                          {r.name ?? r.id}
                        </Link>
                        {r.synthetic ? <p className="mt-0.5 text-micro font-bold text-hema">PIPELINE TEST — NOT PATHOLOGY VALIDATION</p> : null}
                        <p className="text-micro text-graphite">
                          {userName(r.created_by, demoUsers)} · {formatDateTime(r.created_at)}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-ink">
                        {r.dataset_name}
                        <p className="font-mono text-micro text-graphite">manifest {shortHash(r.dataset_manifest_sha256, 10)}</p>
                      </td>
                      <td className="px-3 py-3">
                        <p className="text-ink">{r.head === "abmil" ? "Attention MIL" : "Baseline"}</p>
                        <p className="font-mono text-micro text-graphite">
                          {r.encoder_id} · seed {r.seed}
                        </p>
                      </td>
                      <td className="min-w-[200px] px-3 py-3">
                        <RunStatus run={r} />
                        {r.status === "queued" || r.status === "running" ? (
                          <div className="mt-1.5">
                            <div className="h-1.5 rounded-full bg-paraffin" role="progressbar" aria-label="Job progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((r.progress ?? 0) * 100)}>
                              <div className="h-1.5 rounded-full bg-teal" style={{ width: `${(r.progress ?? 0) * 100}%` }} />
                            </div>
                            <p className="mt-1 text-micro text-graphite">{r.progress_message ?? (r.status === "queued" ? "waiting for the worker" : "")}</p>
                          </div>
                        ) : null}
                        {r.error ? <p className="mt-1 max-w-[40ch] text-micro text-rust">{r.error}</p> : null}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-1.5">
                          {r.status === "queued" || r.status === "running" ? (
                            <Button
                              size="sm"
                              variant="danger"
                              icon={<Ban size={14} aria-hidden />}
                              busy={busy === `c-${r.id}`}
                              unavailable={canWrite ? null : "Cancelling needs the research lead demo role."}
                              onClick={async () => {
                                setBusy(`c-${r.id}`);
                                try {
                                  await api(`/experiments/${r.id}/cancel`, { method: "POST" });
                                  toast.show({ tone: "info", title: "Cancel requested", body: "A running job stops at its next checkpoint." });
                                  await runs.reload();
                                } catch (err) {
                                  toast.show({ tone: "error", title: "Not cancelled", body: errorText(err) });
                                } finally {
                                  setBusy(null);
                                }
                              }}
                            >
                              Cancel
                            </Button>
                          ) : null}
                          {(r.status === "failed" || r.status === "canceled") && r.job_id ? (
                            <Button
                              size="sm"
                              icon={<RotateCcw size={14} aria-hidden />}
                              busy={busy === `r-${r.id}`}
                              unavailable={can("jobs.manage") ? null : "Retrying needs a role with jobs.manage."}
                              onClick={async () => {
                                setBusy(`r-${r.id}`);
                                try {
                                  await api(`/jobs/${r.job_id}/retry`, { method: "POST" });
                                  toast.show({ tone: "info", title: "Retry queued" });
                                  await runs.reload();
                                } catch (err) {
                                  toast.show({ tone: "error", title: "Not retried", body: errorText(err) });
                                } finally {
                                  setBusy(null);
                                }
                              }}
                            >
                              Retry
                            </Button>
                          ) : null}
                          <Link href={`/experiments/${r.id}`} className="inline-flex h-8 items-center rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2.5 text-small font-semibold hover:border-teal">
                            Open
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="registry" className="mt-8">
            <h2 id="registry" className="text-title font-bold">
              Model registry
            </h2>
            <p className="mt-1 text-small text-graphite">{models.data?.note ?? "Research candidates only."}</p>
            <ul className="mt-3 grid gap-2 md:grid-cols-2" data-testid="model-registry">
              {(models.data?.items ?? []).length === 0 ? <li className="text-small text-graphite">No research candidate registered yet. Register one from a finished run.</li> : null}
              {(models.data?.items ?? []).map((m) => (
                <li key={m.id} className="rounded-[var(--radius-control)] border border-line bg-sheet p-3 text-small">
                  <p className="font-semibold">
                    <FlaskConical size={14} aria-hidden className="mr-1 inline text-teal-deep" />
                    {m.status.replace(/_/g, " ")} · <Link href={`/experiments/${m.run_id}`} className="text-teal-deep underline">run {m.run_id.slice(0, 8)}</Link>
                  </p>
                  <p className="text-micro text-graphite">
                    {userName(m.created_by, demoUsers)} · {formatDateTime(m.created_at)} · never deployed
                  </p>
                  {m.bundle_id ? <p className="font-mono text-micro text-graphite">inference bundle {shortHash(m.bundle_id, 10)} · research use only</p> : null}
                  {m.synthetic ? <p className="mt-1 text-micro font-bold text-hema">{m.banner}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
