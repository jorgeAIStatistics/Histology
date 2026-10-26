"use client";

import Link from "next/link";
import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { EXCLUSION_REASON_LABEL, LABEL_SHORT, humanize } from "@/lib/format";
import type { DatasetSummary, DatasetVersion, LabelValue } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { LABEL_DISPLAY_FULL } from "@/components/review/shared";

function Block({ title, children, className, testId }: { title: string; children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn("rounded-[var(--radius-panel)] border border-line bg-surface p-4", className)} data-testid={testId}>
      <h3 className="mb-3 font-bold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function Bars({ rows, total, unit, tone = "teal" }: { rows: { key: string; label: string; n: number; sub?: string }[]; total: number; unit: string; tone?: "teal" | "neutral" }) {
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-small">
            <span className="text-ink">{r.label}</span>
            <span className="tabular whitespace-nowrap font-semibold">
              {r.n} {unit}
              {r.sub ? <span className="font-normal text-graphite"> · {r.sub}</span> : null}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-paraffin" aria-hidden>
            <div className={cn("h-2 rounded-full", tone === "teal" ? "bg-teal" : "bg-graphite/55")} style={{ width: `${total ? (r.n / total) * 100 : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CrossTab({ title, data }: { title: string; data: Record<string, Record<string, number>> }) {
  const labels = [...new Set(Object.values(data).flatMap((r) => Object.keys(r)))];
  return (
    <table className="w-full text-left text-small">
      <caption className="sr-only">{title}</caption>
      <thead>
        <tr className="border-b border-line-strong text-micro text-graphite">
          <th scope="col" className="py-1 pr-2 font-semibold">{title}</th>
          {labels.map((l) => (
            <th key={l} scope="col" className="px-2 py-1 text-right font-semibold">
              {LABEL_SHORT[l as LabelValue] ?? l}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Object.entries(data).map(([k, row]) => (
          <tr key={k} className="border-b border-line">
            <th scope="row" className="py-1 pr-2 font-normal text-ink">
              {k}
            </th>
            {labels.map((l) => (
              <td key={l} className="tabular px-2 py-1 text-right">
                {row[l] ?? 0}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SummaryPanel({ dv, s, onChanged }: { dv: DatasetVersion; s: DatasetSummary; onChanged: () => Promise<void> | void }) {
  const { can, projectId, demoUsers } = useSession();
  const toast = useToast();
  const [nd, setNd] = useState<{ key: string; decision: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const balanceTotal = Object.values(s.label_balance).reduce((a, b) => a + b.slides, 0);
  const reasonsTotal = Math.max(1, ...Object.values(s.exclusions.by_reason));
  const ra = s.reviewer_agreement;

  return (
    <div className="grid gap-4 xl:grid-cols-2" data-testid="dataset-summary">
      <Block title="What is in it" className="xl:col-span-2" testId="dataset-counts">
        <ol className="flex flex-wrap items-stretch gap-2" aria-label="Unique counts at each level of the hierarchy">
          {[
            ["patients", "coded patients", s.counts.patients],
            ["cases", "cases", s.counts.cases],
            ["blocks", "blocks", s.counts.blocks],
            ["slides", "slides", s.counts.slides],
          ].map(([k, label, n], i) => (
            <li key={k as string} className="flex items-center gap-2">
              {i > 0 ? (
                <span aria-hidden className="text-line-strong">
                  →
                </span>
              ) : null}
              <span className={cn("rounded-[var(--radius-control)] border px-3 py-2", k === "patients" ? "border-teal/50 bg-teal-tint" : "border-line bg-sheet")}>
                <span className="tabular block text-title font-bold text-ink" data-testid={`count-${k}`}>
                  {n as number}
                </span>
                <span className="block text-micro text-graphite">unique {label as string}</span>
              </span>
            </li>
          ))}
          <li className="flex items-center gap-2">
            <span aria-hidden className="text-line-strong">
              →
            </span>
            <span className="rounded-[var(--radius-control)] border border-dashed border-line-strong px-3 py-2">
              <span className="block text-title font-bold text-graphite">none</span>
              <span className="block text-micro text-graphite">patches (made by the processing pipeline)</span>
            </span>
          </li>
        </ol>
        <p className="mt-3 text-small text-graphite">
          Patients are the unit that matters for leakage: {s.counts.slides} slides come from only {s.counts.patients} coded patients. Label scope: {s.label_scope}.
        </p>
      </Block>

      <Block title="Label balance" testId="label-balance">
        <Bars
          total={balanceTotal}
          unit="slides"
          rows={Object.entries(s.label_balance).map(([k, v]) => ({ key: k, label: LABEL_DISPLAY_FULL[k as LabelValue] ?? v.display, n: v.slides, sub: `${v.patients} patients` }))}
        />
        <p className="mt-3 text-micro text-graphite">BCC absent is not benign: it may include other malignancy, inflammation or mimics.</p>
      </Block>

      <Block title="Exclusions, with reasons" testId="exclusions">
        <p className="mb-2 text-small text-graphite">{s.exclusions.count} slides in the project did not enter. A slide can have several reasons.</p>
        <Bars
          total={reasonsTotal}
          unit=""
          tone="neutral"
          rows={Object.entries(s.exclusions.by_reason)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => ({ key: k, label: EXCLUSION_REASON_LABEL[k] ?? humanize(k), n }))}
        />
        <details className="mt-3">
          <summary className="cursor-pointer text-small font-semibold text-teal-deep">Every excluded slide</summary>
          <ul className="mt-2 space-y-1.5 text-micro">
            {s.exclusions.slides.map((x) => (
              <li key={x.slide_id} className="rounded border border-line bg-sheet px-2 py-1.5">
                <Link href={`/review/${x.slide_id}`} className="font-semibold text-teal-deep underline">
                  {x.accession_code ?? "unassigned"} ({x.patient_code ?? "?"})
                </Link>
                : {x.reasons.map((r) => EXCLUSION_REASON_LABEL[r.code] ?? humanize(r.code)).join("; ")}
              </li>
            ))}
          </ul>
        </details>
      </Block>

      <Block title="Site, scanner and stain batches" testId="batches">
        <div className="space-y-4">
          <CrossTab title="Site" data={s.batches.label_by_site} />
          <CrossTab title="Scanner" data={s.batches.label_by_scanner} />
          <CrossTab title="Stain" data={s.batches.label_by_stain} />
        </div>
        <p className="mt-2 text-micro text-graphite">A label concentrated in one site or scanner is a shortcut a model can learn. Check this before training.</p>
      </Block>

      <Block title="Reviewer agreement and missing metadata" testId="agreement">
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-small">
          <dt className="text-graphite">Targets read by two or more experts</dt>
          <dd className="tabular text-right font-semibold">
            {ra.targets_with_2plus_readers} of {ra.targets_considered}
          </dd>
          <dt className="text-graphite">Agreeing reader pairs</dt>
          <dd className="tabular text-right font-semibold">
            {ra.agreeing_pairs} / {ra.reader_pairs}
          </dd>
          <dt className="text-graphite">Observed agreement</dt>
          <dd className="tabular text-right font-semibold">{typeof ra.observed_agreement === "number" ? `${(ra.observed_agreement * 100).toFixed(0)}%` : ra.observed_agreement}</dd>
          <dt className="text-graphite">Cohen&rsquo;s kappa</dt>
          <dd className="text-right font-semibold" data-testid="kappa">
            {String(ra.cohen_kappa)}
          </dd>
        </dl>
        {ra.kappa_reader_pair ? <p className="mt-1 text-micro text-graphite">Reader pair: {ra.kappa_reader_pair.map((u) => demoUsers.find((d) => d.id === u)?.display_name ?? u).join(" and ")}</p> : null}
        <h4 className="mt-4 text-small font-bold">Missing metadata among included slides</h4>
        <ul className="mt-1 space-y-1 text-small">
          {Object.entries(s.missing_metadata).map(([k, v]) => (
            <li key={k} className="flex justify-between">
              <span className="text-ink">{k === "mpp" ? "Calibration (microns per pixel)" : humanize(k)}</span>
              <span className={cn("tabular font-semibold", v.count ? "text-amber-ink" : "text-graphite")}>{v.count ? `${v.count} missing` : "complete"}</span>
            </li>
          ))}
        </ul>
        {s.qc_warnings.length ? (
          <p className="mt-3 text-small text-amber-ink">
            {s.qc_warnings.length} included slide{s.qc_warnings.length === 1 ? " has" : "s have"} open QC issues ({s.qc_warnings.flatMap((w) => w.open_issues.map((i) => humanize(i.category))).join(", ")}). Resolve
            them before freezing.
          </p>
        ) : null}
      </Block>

      <Block title="Duplicates" className="xl:col-span-2" testId="duplicates">
        <p className="text-small text-ink">
          Exact duplicates: {s.duplicates.exact_within_dataset.length} within this dataset; {s.duplicates.exact_rejected_at_upload} rejected at upload. {s.duplicates.exact_note}
        </p>
        <p className="mt-1 text-small text-graphite">
          Near-duplicate candidates ({s.duplicates.near_duplicate_method}). {s.duplicates.near_duplicate_note}
        </p>
        {s.duplicates.near_duplicate_candidates.length === 0 ? <p className="mt-2 text-small text-graphite">No candidate pairs.</p> : null}
        <ul className="mt-3 space-y-2">
          {s.duplicates.near_duplicate_candidates.map((c) => {
            const key = `${c.slide_a}:${c.slide_b}`;
            return (
              <li key={key} className="rounded-[var(--radius-control)] border border-amber/60 bg-amber-tint/30 p-3" data-testid="near-duplicate">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small">
                  <Link href={`/review/${c.slide_a}`} className="font-mono font-semibold text-teal-deep underline">
                    {c.slide_a.slice(0, 8)}
                  </Link>
                  <span aria-hidden>↔</span>
                  <Link href={`/review/${c.slide_b}`} className="font-mono font-semibold text-teal-deep underline">
                    {c.slide_b.slice(0, 8)}
                  </Link>
                  <span>Hamming distance {c.dhash_distance}</span>
                  <span>{c.same_patient ? "same patient" : "different patients"}</span>
                  {c.cross_split ? <span className="font-semibold text-rust">in different splits: possible leakage</span> : null}
                  <span className="ml-auto font-semibold">{c.human_decision ? `Human decision: ${c.human_decision.decision}${c.human_decision.reason ? ` (“${c.human_decision.reason}”)` : ""}` : "Awaiting human review"}</span>
                </div>
                {nd?.key === key ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div role="radiogroup" aria-label="Decision" className="flex gap-1">
                      {["distinct", "duplicate", "unsure"].map((d) => (
                        <button key={d} type="button" role="radio" aria-checked={nd.decision === d} onClick={() => setNd({ ...nd, decision: d })} className={cn("h-9 rounded border px-3 text-small font-semibold", nd.decision === d ? "border-teal bg-teal-tint" : "border-line-strong bg-sheet")}>
                          {humanize(d)}
                        </button>
                      ))}
                    </div>
                    <TextField className="min-w-[240px] flex-1" label="Reason" value={nd.reason} onChange={(e) => setNd({ ...nd, reason: e.target.value })} />
                    <Button size="sm" variant="quiet" onClick={() => setNd(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      busy={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api(`/projects/${projectId}/near-duplicates/review`, { method: "POST", body: { slide_a_id: c.slide_a, slide_b_id: c.slide_b, decision: nd.decision, reason: nd.reason || null } });
                          toast.show({ tone: "success", title: "Decision recorded", body: "Nothing was removed or excluded automatically. Exclude a slide through its review state if needed." });
                          setNd(null);
                          await onChanged();
                        } catch (err) {
                          toast.show({ tone: "error", title: "Not recorded", body: errorText(err) });
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Record decision
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" className="mt-2" unavailable={can("near_duplicate.review") ? null : "Reviewing near-duplicates needs the pathologist or research lead demo role."} onClick={() => setNd({ key, decision: "distinct", reason: "" })}>
                    Review this pair
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Block>
      <p className="text-micro text-graphite xl:col-span-2">
        {s.workflow_metadata_note} Version {dv.version}, {dv.status}.
      </p>
    </div>
  );
}
