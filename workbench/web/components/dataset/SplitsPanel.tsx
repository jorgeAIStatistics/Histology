"use client";

import { useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { LABEL_SHORT } from "@/lib/format";
import type { DatasetSummary, DatasetVersion, LabelValue, Manifest } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { SelectField, TextField } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";

const SPLIT_STYLE: Record<string, string> = {
  train: "bg-teal-tint text-teal-deep border-teal/40",
  val: "bg-slate-tint text-slate border-slate/40",
  test: "bg-hema-tint text-hema border-hema/40",
};

export function SplitsPanel({ dv, s, onChanged }: { dv: DatasetVersion; s: DatasetSummary; onChanged: () => Promise<void> | void }) {
  const { can } = useSession();
  const toast = useToast();
  const [partition, setPartition] = useState(dv.config.split?.partition ?? "random");
  const [seed, setSeed] = useState(String(dv.config.split?.seed ?? 7));
  const [ratios, setRatios] = useState({ train: "0.6", val: "0.2", test: "0.2" });
  const [testCutoff, setTestCutoff] = useState("2026-06-01");
  const [valCutoff, setValCutoff] = useState("2026-04-01");
  const [testSites, setTestSites] = useState("site-south");
  const [busy, setBusy] = useState(false);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const [testItems, setTestItems] = useState<{ count: number } | null>(null);
  const manifest = useApi<Manifest>(dv.status === "frozen" ? `/datasets/${dv.id}/manifest` : null);
  const canWrite = can("dataset.write");

  const patients = useMemo(() => {
    const m = manifest.data?.manifest;
    if (!m) return [];
    const bySplit = new Map<string, { code: string; split: string; slides: number; cases: Set<string> }>();
    for (const it of m.items) {
      const p = bySplit.get(it.coded_patient_id) ?? { code: it.patient_code, split: it.split ?? "unassigned", slides: 0, cases: new Set<string>() };
      p.slides += 1;
      p.cases.add(it.accession_code);
      bySplit.set(it.coded_patient_id, p);
    }
    return [...bySplit.values()].sort((a, b) => a.split.localeCompare(b.split) || a.code.localeCompare(b.code));
  }, [manifest.data]);

  const per = s.splits.per_split;
  return (
    <div className="space-y-4" data-testid="splits-panel">
      <section className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
        <h3 className="font-bold">Current split {s.splits.partition ? `(${s.splits.partition})` : ""}</h3>
        {s.splits.assigned ? (
          <table className="mt-3 w-full text-left text-small">
            <thead>
              <tr className="border-b border-line-strong text-micro text-graphite">
                <th scope="col" className="py-1 font-semibold">Split</th>
                <th scope="col" className="py-1 text-right font-semibold">Coded patients</th>
                <th scope="col" className="py-1 text-right font-semibold">Slides</th>
                <th scope="col" className="py-1 pl-4 font-semibold">Labels</th>
              </tr>
            </thead>
            <tbody>
              {["train", "val", "test"].map((k) => (
                <tr key={k} className="border-b border-line" data-testid={`split-row-${k}`}>
                  <th scope="row" className="py-1.5">
                    <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 text-micro font-bold", SPLIT_STYLE[k])}>
                      {k === "test" ? <Lock size={11} aria-hidden /> : null}
                      {k === "val" ? "validation" : k}
                    </span>
                  </th>
                  <td className="tabular py-1.5 text-right font-semibold">{per[k]?.patients ?? 0}</td>
                  <td className="tabular py-1.5 text-right">{per[k]?.slides ?? 0}</td>
                  <td className="py-1.5 pl-4 text-graphite">
                    {Object.entries(per[k]?.label_balance ?? {})
                      .map(([l, n]) => `${LABEL_SHORT[l as LabelValue] ?? l} ${n}`)
                      .join(" · ") || "none"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-small text-amber-ink">No split assigned yet. Freezing needs one.</p>
        )}
        <p className="mt-3 text-small text-ink">Guarantee: every slide, level and stain of one coded patient is in exactly one split, including repeat specimens from later cases.</p>
      </section>

      <section className="rounded-[var(--radius-panel)] border-2 border-hema/40 bg-hema-tint/40 p-4" data-testid="test-lock">
        <h3 className="flex items-center gap-2 font-bold text-hema">
          <Lock size={16} aria-hidden /> Test set lock
        </h3>
        <p className="mt-1 text-small text-ink">
          The test split ({per.test?.patients ?? 0} patient{(per.test?.patients ?? 0) === 1 ? "" : "s"}, {per.test?.slides ?? 0} slide{(per.test?.slides ?? 0) === 1 ? "" : "s"}) is locked away
          from training, active learning and threshold selection.
          Thresholds are chosen on validation and frozen before any test evaluation. Opening the test items is for the research lead only and is audited.
        </p>
        {dv.status === "frozen" ? (
          <div className="mt-2 flex items-center gap-3">
            <Button
              size="sm"
              unavailable={can("dataset.test_access") ? null : "Test items are visible to the research lead only (permission dataset.test_access)."}
              onClick={async () => {
                try {
                  const r = await api<{ count: number }>(`/datasets/${dv.id}/items?purpose=test_evaluation`);
                  setTestItems(r);
                  toast.show({ tone: "info", title: "Test items opened (audited)", body: `${r.count} items. The access is recorded in the audit trail.` });
                } catch (err) {
                  toast.show({ tone: "error", title: "Refused", body: errorText(err) });
                }
              }}
            >
              Open test items (audited)
            </Button>
            {testItems ? <span className="text-small text-graphite">{testItems.count} test items listed; the access was audited.</span> : null}
          </div>
        ) : (
          <p className="mt-2 text-micro text-graphite">The lock is enforced on frozen versions.</p>
        )}
      </section>

      {dv.status === "draft" ? (
        <section className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
          <h3 className="font-bold">Assign patient-grouped splits</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <SelectField
              label="Partition"
              value={partition}
              onChange={(e) => setPartition(e.target.value)}
              data-testid="partition-select"
              options={[
                { value: "random", label: "Random (by patient)" },
                { value: "temporal", label: "Temporal (by latest case date)" },
                { value: "external_site", label: "External site (held-out site is test)" },
              ]}
            />
            {/* Temporal splits are fully determined by the cutoffs: the API rejects an unused seed or ratios. */}
            {partition !== "temporal" ? <TextField label="Seed" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} /> : null}
            {partition === "random" ? (
              <div className="grid grid-cols-3 gap-2">
                {(["train", "val", "test"] as const).map((k) => (
                  <TextField key={k} label={k === "val" ? "Val" : k[0].toUpperCase() + k.slice(1)} type="number" step="0.05" min="0" max="1" value={ratios[k]} onChange={(e) => setRatios({ ...ratios, [k]: e.target.value })} />
                ))}
              </div>
            ) : null}
            {partition === "temporal" ? (
              <>
                <TextField label="Validation from" type="date" value={valCutoff} onChange={(e) => setValCutoff(e.target.value)} hint="Cases collected on or after this date" />
                <TextField label="Test from" type="date" value={testCutoff} onChange={(e) => setTestCutoff(e.target.value)} hint="Later material never trains" />
              </>
            ) : null}
            {partition === "external_site" ? <TextField label="Test sites (comma separated)" value={testSites} onChange={(e) => setTestSites(e.target.value)} hint="A patient with any case at a test site is entirely test" /> : null}
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              busy={busy}
              data-testid="assign-splits"
              unavailable={canWrite ? null : "Assigning splits needs the research lead demo role."}
              onClick={async () => {
                setBusy(true);
                try {
                  const body: Record<string, unknown> = { partition };
                  if (partition !== "temporal") body.seed = Number(seed) || 0;
                  if (partition === "random") body.ratios = { train: Number(ratios.train), val: Number(ratios.val), test: Number(ratios.test) };
                  if (partition === "temporal") Object.assign(body, { test_cutoff: testCutoff, val_cutoff: valCutoff });
                  if (partition === "external_site") body.test_sites = testSites.split(",").map((x) => x.trim()).filter(Boolean);
                  const r = await api<{ diagnostics: Record<string, unknown> }>(`/datasets/${dv.id}/splits`, { method: "POST", body });
                  setDiag(r.diagnostics);
                  toast.show({ tone: "success", title: "Splits assigned", body: "Grouped by coded patient." });
                  await onChanged();
                } catch (err) {
                  toast.show({ tone: "error", title: "Splits not assigned", body: errorText(err) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Assign splits
            </Button>
          </div>
          {diag ? (
            <Notice tone="info" className="mt-3" title="Split diagnostics">
              <pre className="whitespace-pre-wrap font-mono text-micro">{JSON.stringify(diag, null, 2)}</pre>
            </Notice>
          ) : null}
        </section>
      ) : null}

      {dv.status === "frozen" ? (
        <section className="rounded-[var(--radius-panel)] border border-line bg-surface p-4" data-testid="patient-grouping">
          <h3 className="font-bold">Patients and their split (from the frozen manifest)</h3>
          <table className="mt-3 w-full text-left text-small">
            <thead>
              <tr className="border-b border-line-strong text-micro text-graphite">
                <th scope="col" className="py-1 font-semibold">Coded patient</th>
                <th scope="col" className="py-1 font-semibold">Cases</th>
                <th scope="col" className="py-1 text-right font-semibold">Slides</th>
                <th scope="col" className="py-1 pl-4 font-semibold">Split</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.code} className="border-b border-line">
                  <th scope="row" className="py-1.5 font-mono font-semibold">
                    {p.code}
                  </th>
                  <td className="py-1.5">{[...p.cases].join(", ")}</td>
                  <td className="tabular py-1.5 text-right">{p.slides}</td>
                  <td className="py-1.5 pl-4">
                    <span className={cn("rounded border px-1.5 text-micro font-bold", SPLIT_STYLE[p.split])}>{p.split}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-micro text-graphite">Each patient appears once: all of their cases and slides share one split.</p>
        </section>
      ) : null}
    </div>
  );
}
