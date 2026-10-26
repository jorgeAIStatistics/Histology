"use client";

import Link from "next/link";
import { CheckCircle2, OctagonAlert } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { LABEL_SHORT, formatDateTime, shortHash } from "@/lib/format";
import type { DatasetVersion, Manifest } from "@/lib/types";
import { ErrorBox, Loading, Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { useSession } from "@/lib/session";

type Staleness = { stale: boolean; changed_labels: { slide_id: string; dataset_value: string; current_value: string | null; current_status: string }[]; action: string };

export function ManifestPanel({ dv, onNewVersion }: { dv: DatasetVersion; onNewVersion: () => void }) {
  const { can } = useSession();
  const m = useApi<Manifest>(`/datasets/${dv.id}/manifest`);
  const st = useApi<Staleness>(`/datasets/${dv.id}/staleness`);
  if (m.error) return <ErrorBox error={m.error} what="load the manifest" />;
  if (!m.data) return <Loading label="Loading the manifest" />;
  const man = m.data.manifest;
  return (
    <div className="space-y-4" data-testid="manifest-panel">
      <section className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          {m.data.verified ? (
            <span className="inline-flex items-center gap-1 text-small font-semibold text-approved" data-testid="manifest-verified">
              <CheckCircle2 size={16} aria-hidden /> Hash verified now
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-small font-semibold text-rust">
              <OctagonAlert size={16} aria-hidden /> Hash does not match
            </span>
          )}
          <span className="text-small text-graphite">{m.data.hash_method}</span>
        </div>
        <p className="mt-2 break-all font-mono text-small text-ink" data-testid="manifest-hash">
          sha256 {m.data.manifest_sha256}
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small sm:grid-cols-[auto_1fr_auto_1fr]">
          <dt className="text-graphite">Schema</dt>
          <dd className="font-mono text-micro">{man.schema}</dd>
          <dt className="text-graphite">Frozen</dt>
          <dd>{formatDateTime(man.frozen_at)}</dd>
          <dt className="text-graphite">Counts</dt>
          <dd>
            {man.counts.patients} patients · {man.counts.cases} cases · {man.counts.blocks} blocks · {man.counts.slides} slides
          </dd>
          <dt className="text-graphite">Provenance</dt>
          <dd>{Object.entries(man.provenance_mix).map(([k, v]) => `${k} ${v}`).join(", ")}</dd>
        </dl>
        {man.notice ? <p className="mt-2 text-small text-hema">Recorded in the manifest: {man.notice}</p> : null}
      </section>

      {st.data?.stale ? (
        <Notice tone="warning" title={`${st.data.changed_labels.length} label${st.data.changed_labels.length === 1 ? "" : "s"} changed since this version was frozen`}>
          <p>This version does not change. {st.data.action}</p>
          <Button size="sm" variant="primary" className="mt-2" unavailable={can("dataset.write") ? null : "Needs the research lead demo role."} onClick={onNewVersion}>
            Create a new version
          </Button>
        </Notice>
      ) : st.data ? (
        <Notice tone="success">No label in this manifest has changed since it was frozen.</Notice>
      ) : null}

      <section className="overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-sheet">
        <table className="w-full min-w-[860px] text-left text-small">
          <caption className="px-4 py-3 text-left font-bold text-ink">Items ({man.items.length}): exact image hash, label version and split for each slide</caption>
          <thead className="border-y border-line-strong bg-surface text-micro text-graphite">
            <tr>
              <th scope="col" className="px-4 py-1.5 font-semibold">Patient</th>
              <th scope="col" className="px-2 py-1.5 font-semibold">Case / part / block / level</th>
              <th scope="col" className="px-2 py-1.5 font-semibold">Label (version id)</th>
              <th scope="col" className="px-2 py-1.5 font-semibold">Image sha256</th>
              <th scope="col" className="px-2 py-1.5 font-semibold">Split</th>
            </tr>
          </thead>
          <tbody>
            {man.items.map((it) => (
              <tr key={it.slide_id} className="border-b border-line">
                <td className="px-4 py-1.5 font-mono">{it.patient_code}</td>
                <td className="px-2 py-1.5">
                  <Link href={`/review/${it.slide_id}`} className="text-teal-deep underline">
                    {it.accession_code} / {it.part} / {it.block} / L{it.level_index ?? "-"}
                  </Link>{" "}
                  <span className="text-graphite">{it.stain}</span>
                </td>
                <td className="px-2 py-1.5">
                  {LABEL_SHORT[it.label_value]} <span className="font-mono text-micro text-graphite">{shortHash(it.label_version_id, 8)}</span>
                </td>
                <td className="px-2 py-1.5 font-mono text-micro">{shortHash(it.slide_sha256, 16)}</td>
                <td className="px-2 py-1.5 font-semibold">{it.split}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <details className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
        <summary className="cursor-pointer font-semibold text-teal-deep">Configuration recorded in the manifest</summary>
        <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap font-mono text-micro text-ink">{JSON.stringify(man.config, null, 2)}</pre>
      </details>
      <p className="text-micro text-graphite">Version {dv.version}. Export the manifest as JSON or CSV with the buttons above; the export is identical to what is hashed.</p>
    </div>
  );
}
