"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Download, GitBranch, Lock, Plus, RefreshCw, Snowflake } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { api, errorText } from "@/lib/api";
import { formatDateTime, shortHash, userName } from "@/lib/format";
import type { DatasetSummary, DatasetVersion, Manifest } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ErrorBox, Loading, Notice } from "@/components/ui/Notice";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { Dialog } from "@/components/ui/Dialog";
import { TextField } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { CreateDatasetDialog } from "./CreateDatasetDialog";
import { FreezeDialog } from "./FreezeDialog";
import { SummaryPanel } from "./SummaryPanel";
import { SplitsPanel } from "./SplitsPanel";
import { ManifestPanel } from "./ManifestPanel";

export function DatasetView() {
  const { projectId, can, demoUsers } = useSession();
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const list = useApi<{ items: DatasetVersion[] }>(projectId ? `/projects/${projectId}/datasets` : null);
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const selectedId = search.get("id") ?? items[items.length - 1]?.id ?? null;
  const dv = items.find((d) => d.id === selectedId) ?? null;
  const summary = useApi<DatasetSummary>(dv ? `/datasets/${dv.id}/summary` : null);
  const [tab, setTab] = useState("summary");
  const [createOpen, setCreateOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionReason, setVersionReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const canWrite = can("dataset.write");
  const writeReason = canWrite ? null : "Building and freezing datasets needs the research lead demo role (permission dataset.write).";

  const lineages = useMemo(() => {
    const m = new Map<string, DatasetVersion[]>();
    for (const d of items) m.set(d.lineage_id, [...(m.get(d.lineage_id) ?? []), d]);
    return [...m.values()].map((vs) => vs.sort((a, b) => a.version - b.version));
  }, [items]);

  const select = (id: string) => router.replace(`/dataset?id=${id}`, { scroll: false });

  const reloadAll = async () => {
    await Promise.all([list.reload(), summary.reload()]);
  };

  const refresh = async () => {
    if (!dv) return;
    setBusy("refresh");
    try {
      const r = await api<{ refresh: { items: number; excluded: number } }>(`/datasets/${dv.id}/refresh`, { method: "POST" });
      toast.show({ tone: "success", title: "Eligibility re-evaluated", body: `${r.refresh.items} slides included, ${r.refresh.excluded} excluded, from the current labels and review states.` });
      await reloadAll();
    } catch (err) {
      toast.show({ tone: "error", title: "Refresh failed", body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-16 pt-6 md:px-6 xl:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display font-bold tracking-tight">Dataset</h1>
          <p className="mt-1 max-w-[74ch] text-graphite">
            Versioned datasets built from approved expert labels. Patients are counted separately from slides, every split keeps a patient&rsquo;s slides
            together, and a frozen version never changes.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={16} aria-hidden />} unavailable={writeReason} onClick={() => setCreateOpen(true)} data-testid="new-dataset">
          New draft
        </Button>
      </div>

      <ErrorBox error={list.error} what="load datasets" className="mt-4" />
      {list.loading && !list.data ? <Loading /> : null}

      {list.data && items.length === 0 ? (
        <div className="mt-8 rounded-[var(--radius-panel)] border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
          <p className="text-lead font-semibold">No dataset yet</p>
          <p className="mx-auto mt-1 max-w-[60ch] text-graphite">
            A draft collects every slide that passes the eligibility rules (ingested, approved, a reference expert label, no QC exclusion). Create one to see
            the summary, then assign patient-grouped splits and freeze it.
          </p>
          <div className="mt-4 flex justify-center">
            <Button variant="primary" icon={<Plus size={16} aria-hidden />} unavailable={writeReason} onClick={() => setCreateOpen(true)}>
              Create the first draft
            </Button>
          </div>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <nav aria-label="Dataset versions" className="space-y-4">
            {lineages.map((vs) => (
              <div key={vs[0].lineage_id} className="rounded-[var(--radius-panel)] border border-line bg-surface">
                <p className="border-b border-line px-3 py-2 text-small font-bold text-ink">{vs[0].name}</p>
                <ul>
                  {vs.map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => select(d.id)}
                        aria-current={d.id === selectedId ? "true" : undefined}
                        data-testid="dataset-version"
                        className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-small hover:bg-paraffin", d.id === selectedId && "bg-teal-tint hover:bg-teal-tint")}
                      >
                        {d.status === "frozen" ? <Lock size={14} aria-hidden className="text-teal-deep" /> : <span aria-hidden className="h-3.5 w-3.5 rounded-full border-2 border-dashed border-amber" />}
                        <span className="flex-1">
                          <span className="font-semibold">v{d.version}</span> <span className="text-graphite">{d.status === "frozen" ? "frozen" : "draft"}</span>
                          <span className="block text-micro text-graphite">
                            {d.item_count ?? 0} slides · {d.excluded_count} excluded
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          {dv ? (
            <section aria-labelledby="dv-title" className="min-w-0">
              <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 id="dv-title" className="text-title font-bold" data-testid="dataset-title">
                      {dv.name} · v{dv.version}
                    </h2>
                    <p className="mt-0.5 text-small text-graphite">
                      {dv.status === "frozen" ? (
                        <>
                          <Lock size={13} aria-hidden className="mr-1 inline text-teal-deep" />
                          Frozen {formatDateTime(dv.frozen_at)} by {userName(dv.frozen_by, demoUsers)} · manifest{" "}
                          <span className="font-mono">{shortHash(dv.manifest_sha256, 16)}</span>
                        </>
                      ) : (
                        <>Draft · re-evaluated {formatDateTime(dv.materialized_at)}. Approvals made since then appear after you refresh.</>
                      )}
                      {dv.parent_version_id ? (
                        <>
                          {" "}
                          · new version of{" "}
                          <button type="button" className="font-semibold text-teal-deep underline" onClick={() => select(dv.parent_version_id!)}>
                            v{items.find((x) => x.id === dv.parent_version_id)?.version ?? "parent"}
                          </button>
                          {dv.reason ? ` (“${dv.reason}”)` : ""}
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {dv.status === "draft" ? (
                      <>
                        <Button size="sm" icon={<RefreshCw size={14} aria-hidden />} busy={busy === "refresh"} unavailable={writeReason} onClick={refresh} data-testid="refresh-dataset">
                          Refresh eligibility
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Snowflake size={14} aria-hidden />}
                          unavailable={writeReason ?? (summary.data && !summary.data.splits.assigned ? "Assign patient-grouped splits before freezing (Splits tab)." : null)}
                          onClick={() => setFreezeOpen(true)}
                          data-testid="freeze-open"
                        >
                          Freeze
                        </Button>
                      </>
                    ) : (
                      <>
                        <a
                          href={`/api/v1/datasets/${dv.id}/export?format=json`}
                          download
                          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2.5 text-small font-semibold text-ink hover:border-teal"
                          data-testid="export-json"
                        >
                          <Download size={14} aria-hidden /> Export JSON
                        </a>
                        <a
                          href={`/api/v1/datasets/${dv.id}/export?format=csv`}
                          download
                          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2.5 text-small font-semibold text-ink hover:border-teal"
                        >
                          <Download size={14} aria-hidden /> Export CSV
                        </a>
                        <Button size="sm" variant="primary" icon={<GitBranch size={14} aria-hidden />} unavailable={writeReason} onClick={() => setVersionOpen(true)} data-testid="new-version">
                          New version from this
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {summary.data?.notice ? (
                  <p className="mt-3 rounded-[var(--radius-control)] border border-hema/40 bg-hema-tint px-3 py-2 text-small font-semibold text-hema">{summary.data.notice}</p>
                ) : null}
              </div>

              <Tabs
                idBase="ds"
                active={tab}
                onChange={setTab}
                className="mt-4"
                tabs={[
                  { id: "summary", label: "Summary" },
                  { id: "splits", label: "Splits and test lock" },
                  { id: "manifest", label: dv.status === "frozen" ? "Manifest" : "Manifest (after freezing)" },
                ]}
              />
              <ErrorBox error={summary.error} what="load the summary" className="mt-3" />
              <TabPanel idBase="ds" id="summary" active={tab} className="pt-4">
                {summary.data ? <SummaryPanel dv={dv} s={summary.data} onChanged={summary.reload} /> : <Loading />}
              </TabPanel>
              <TabPanel idBase="ds" id="splits" active={tab} className="pt-4">
                {summary.data ? <SplitsPanel dv={dv} s={summary.data} onChanged={reloadAll} /> : <Loading />}
              </TabPanel>
              <TabPanel idBase="ds" id="manifest" active={tab} className="pt-4">
                {dv.status === "frozen" ? (
                  <ManifestPanel dv={dv} onNewVersion={() => setVersionOpen(true)} />
                ) : (
                  <Notice tone="neutral" title="No manifest yet">
                    A manifest is written when the draft is frozen: exact image hashes, label versions, split assignments and the configuration, hashed with
                    SHA-256 over canonical JSON.
                  </Notice>
                )}
              </TabPanel>
            </section>
          ) : null}
        </div>
      ) : null}

      <CreateDatasetDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (id) => {
          setCreateOpen(false);
          await list.reload();
          select(id);
        }}
      />

      <FreezeDialog
        open={freezeOpen}
        onClose={() => setFreezeOpen(false)}
        dv={dv}
        summary={summary.data}
        onFrozen={async () => {
          await reloadAll();
          setTab("manifest");
        }}
      />

      <Dialog
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        title="Create a new version"
        description="A new draft whose parent is this frozen version, re-built from the current labels and review states. The frozen parent is not touched."
        footer={
          <>
            <Button onClick={() => setVersionOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy === "version"}
              unavailable={versionReason.trim() ? null : "Give a reason for the new version."}
              data-testid="new-version-confirm"
              onClick={async () => {
                if (!dv) return;
                setBusy("version");
                try {
                  const child = await api<DatasetVersion>(`/datasets/${dv.id}/new-version`, { method: "POST", body: { reason: versionReason } });
                  toast.show({ tone: "success", title: `Draft v${child.version} created`, body: "Assign splits and freeze it when ready." });
                  setVersionOpen(false);
                  setVersionReason("");
                  await list.reload();
                  select(child.id);
                  setTab("summary");
                } catch (err) {
                  toast.show({ tone: "error", title: "Not created", body: errorText(err) });
                } finally {
                  setBusy(null);
                }
              }}
            >
              Create draft
            </Button>
          </>
        }
      >
        <TextField label="Reason" required placeholder="e.g. two labels were corrected after adjudication" value={versionReason} onChange={(e) => setVersionReason(e.target.value)} />
      </Dialog>
      <p className="mt-8 text-small text-graphite">
        Counts here describe workflow metadata, not experiment results.{" "}
        <Link href="/experiments" className="font-semibold text-teal-deep underline">
          Experiments
        </Link>{" "}
        use frozen versions only.
      </p>
    </div>
  );
}
