"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, FileWarning, FolderTree, Search, Send, Upload } from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { api, errorText } from "@/lib/api";
import { LABEL_SHORT, REVIEW_STATE_LABEL, formatDate, slideTitle } from "@/lib/format";
import type { CaseSummary, ReviewState, Worklist, WorklistItem } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ErrorBox, Loading, Notice } from "@/components/ui/Notice";
import { LabelStatus, ProvenanceChip, ReviewStateBadge } from "@/components/ui/Badges";
import { SlideGlyph } from "@/components/ui/SlideGlyph";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { CaseDetailDialog } from "./CaseDetailDialog";
import { UploadDialog } from "./UploadDialog";

const STATES: ReviewState[] = ["imported", "pending_review", "approved", "disputed", "excluded"];

type Filters = {
  state: ReviewState | "all";
  provenance: "all" | "demo_synthetic" | "public_cc0" | "real_authorized";
  label: "all" | "unlabeled" | "single_reader" | "agreed" | "disputed" | "adjudicated";
  qcOnly: boolean;
  ingestProblems: boolean;
  q: string;
};

const FILTER_KEY = "wb.worklist.filters";

export function WorklistView() {
  const { projectId, can, me } = useSession();
  const router = useRouter();
  const toast = useToast();
  const wl = useApi<Worklist>(projectId ? `/projects/${projectId}/worklist` : null);
  const cases = useApi<{ items: CaseSummary[] }>(projectId ? `/projects/${projectId}/cases` : null);
  const [filters, setFilters] = useState<Filters>({ state: "all", provenance: "all", label: "all", qcOnly: false, ingestProblems: false, q: "" });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [caseOpen, setCaseOpen] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [routing, setRouting] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(FILTER_KEY);
      if (raw) setFilters((f) => ({ ...f, ...JSON.parse(raw) }));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      /* ignore */
    }
  }, [filters]);

  // Cases are matched by the case id the worklist carries (by accession code only for older payloads).
  const caseById = useMemo(() => {
    const m = new Map<string, CaseSummary>();
    for (const c of cases.data?.items ?? []) m.set(c.id, c);
    return m;
  }, [cases.data]);
  const caseByAccession = useMemo(() => {
    const m = new Map<string, CaseSummary>();
    for (const c of cases.data?.items ?? []) m.set(c.accession_code, c);
    return m;
  }, [cases.data]);

  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return (wl.data?.items ?? []).filter((r) => {
      if (filters.state !== "all" && r.review_state !== filters.state) return false;
      if (filters.provenance !== "all" && r.provenance !== filters.provenance) return false;
      if (filters.label !== "all" && r.slide_label_status !== filters.label) return false;
      if (filters.qcOnly && r.open_qc_issues === 0) return false;
      if (filters.ingestProblems && r.ingest_status === "succeeded") return false;
      if (q && !`${r.patient_code ?? ""} ${r.accession_code ?? ""} ${r.stain ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [wl.data, filters]);

  const groups = useMemo(() => {
    const out: { key: string; caseInfo: CaseSummary | undefined; patient: string | null; accession: string | null; rows: WorklistItem[] }[] = [];
    for (const r of visible) {
      const key = r.accession_code ?? "unassigned";
      let g = out.find((x) => x.key === key);
      if (!g) {
        const caseInfo = (r.case_id ? caseById.get(r.case_id) : undefined) ?? (r.accession_code ? caseByAccession.get(r.accession_code) : undefined);
        g = { key, caseInfo, patient: r.patient_code, accession: r.accession_code, rows: [] };
        out.push(g);
      }
      g.rows.push(r);
    }
    return out;
  }, [visible, caseById, caseByAccession]);

  const order = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.slide_id)), [groups]);

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    rowRefs.current[id]?.focus();
  }, []);

  const tabStopRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || Boolean(t?.closest("dialog[open]"));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (["j", "k", "ArrowDown", "ArrowUp"].includes(e.key) && !t?.closest("[data-testid=worklist-row]") && !t?.closest("[role=group]")) {
        // From anywhere on the page, j / k (or the arrows) jump into the slide list.
        const id = tabStopRef.current;
        if (id && rowRefs.current[id]) {
          e.preventDefault();
          rowRefs.current[id]?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onRowKey = (e: React.KeyboardEvent, id: string) => {
    const i = order.indexOf(id);
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      if (i < order.length - 1) focusRow(order[i + 1]);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      if (i > 0) focusRow(order[i - 1]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      router.push(`/review/${id}`);
    } else if (e.key === "Home") {
      e.preventDefault();
      if (order.length) focusRow(order[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      if (order.length) focusRow(order[order.length - 1]);
    }
  };

  const tabStop = focusId && order.includes(focusId) ? focusId : order[0];
  tabStopRef.current = tabStop;

  const routeToReview = async (r: WorklistItem) => {
    setRouting(r.slide_id);
    try {
      await api(`/slides/${r.slide_id}/review-state`, { method: "POST", body: { state: "pending_review", reason: "routed for pathologist review from the worklist" } });
      toast.show({ tone: "success", title: "Routed for review", body: `${r.accession_code} ${slideTitle(r)} is now pending review. Nothing was reprioritised.` });
      await wl.reload();
    } catch (err) {
      toast.show({ tone: "error", title: "Could not route the slide", body: errorText(err) });
    } finally {
      setRouting(null);
    }
  };

  const reingest = async (r: WorklistItem) => {
    try {
      const res = await api<{ job_id: string }>(`/slides/${r.slide_id}/reingest`, { method: "POST" });
      toast.show({ tone: "info", title: "Ingest queued again", body: `Job ${res.job_id.slice(0, 8)}… Other slides and jobs are unaffected.` });
      await wl.reload();
    } catch (err) {
      toast.show({ tone: "error", title: "Could not queue the ingest", body: errorText(err) });
    }
  };

  const counts = wl.data?.counts_by_review_state;
  const total = wl.data?.items.length ?? 0;
  const canRoute = can("review.state.route");
  const canUpload = can("upload.write");
  const uploadReason = canUpload ? null : "Uploading needs the histology assistant demo role (permission upload.write).";

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-16 pt-6 md:px-6 xl:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display font-bold tracking-tight">Worklist</h1>
          <p className="mt-1 max-w-[70ch] text-graphite">
            Slides grouped by case, in accession order. Nothing here is reprioritised automatically; routing a slide only moves it to a pathologist&rsquo;s
            pending list.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" icon={<Upload size={16} aria-hidden />} unavailable={uploadReason} onClick={() => setUploadOpen(true)} data-testid="open-upload">
            Upload slide
          </Button>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-3">
        <div role="group" aria-label="Filter by review state" className="flex flex-wrap gap-1.5">
          {(["all", ...STATES] as const).map((s) => {
            const n = s === "all" ? total : counts?.[s] ?? 0;
            const active = filters.state === s;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => setFilters((f) => ({ ...f, state: s }))}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] border px-3 text-small font-semibold",
                  active ? "border-teal bg-teal-tint text-teal-deep" : "border-line-strong bg-sheet text-ink hover:border-teal",
                  s === "pending_review" && !active && n > 0 && "border-amber/70",
                )}
              >
                {s === "all" ? "All slides" : REVIEW_STATE_LABEL[s]}
                <span className={cn("tabular rounded px-1.5 text-micro", active ? "bg-sheet text-teal-deep" : "bg-paraffin text-graphite")}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative min-w-[220px] flex-1">
            <label htmlFor="wl-search" className="block text-micro font-semibold text-graphite">
              Search patient code, accession or stain
            </label>
            <Search size={15} aria-hidden className="pointer-events-none absolute bottom-3 left-2.5 text-graphite" />
            <input
              id="wl-search"
              ref={searchRef}
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder="e.g. P-0001 or DEMO-S26-0003"
              className="mt-1 h-10 w-full rounded-[var(--radius-control)] border border-line-strong bg-sheet pl-8 pr-2 text-body"
            />
          </div>
          <div>
            <label htmlFor="wl-prov" className="block text-micro font-semibold text-graphite">
              Provenance
            </label>
            <select id="wl-prov" value={filters.provenance} onChange={(e) => setFilters((f) => ({ ...f, provenance: e.target.value as Filters["provenance"] }))} className="mt-1 h-10 rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2 text-body">
              <option value="all">All</option>
              <option value="demo_synthetic">DEMO synthetic</option>
              <option value="public_cc0">PUBLIC CC0</option>
              <option value="real_authorized">REAL DATA</option>
            </select>
          </div>
          <div>
            <label htmlFor="wl-label" className="block text-micro font-semibold text-graphite">
              Label status
            </label>
            <select id="wl-label" value={filters.label} onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value as Filters["label"] }))} className="mt-1 h-10 rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2 text-body">
              <option value="all">All</option>
              <option value="unlabeled">Unlabeled</option>
              <option value="single_reader">One reader</option>
              <option value="agreed">Readers agree</option>
              <option value="disputed">Readers disagree</option>
              <option value="adjudicated">Adjudicated</option>
            </select>
          </div>
          <label className="flex h-10 items-center gap-2 text-small font-semibold">
            <input type="checkbox" checked={filters.qcOnly} onChange={(e) => setFilters((f) => ({ ...f, qcOnly: e.target.checked }))} className="h-4 w-4 accent-[var(--color-teal)]" />
            Open QC issues
          </label>
          <label className="flex h-10 items-center gap-2 text-small font-semibold">
            <input type="checkbox" checked={filters.ingestProblems} onChange={(e) => setFilters((f) => ({ ...f, ingestProblems: e.target.checked }))} className="h-4 w-4 accent-[var(--color-teal)]" />
            Ingest problems
          </label>
          {filters.state !== "all" || filters.provenance !== "all" || filters.label !== "all" || filters.qcOnly || filters.ingestProblems || filters.q ? (
            <Button size="sm" variant="quiet" className="h-10" onClick={() => setFilters({ state: "all", provenance: "all", label: "all", qcOnly: false, ingestProblems: false, q: "" })}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      <p className="mt-3 text-small text-graphite" id="wl-keys">
        Keyboard: <kbd className="rounded border border-line-strong bg-sheet px-1 font-mono text-micro">j</kbd> /{" "}
        <kbd className="rounded border border-line-strong bg-sheet px-1 font-mono text-micro">k</kbd> or arrow keys move between slides,{" "}
        <kbd className="rounded border border-line-strong bg-sheet px-1 font-mono text-micro">Enter</kbd> opens the slide,{" "}
        <kbd className="rounded border border-line-strong bg-sheet px-1 font-mono text-micro">/</kbd> searches.
      </p>

      <ErrorBox error={wl.error} what="load the worklist" className="mt-4" />
      {wl.loading && !wl.data ? <Loading label="Loading the worklist" /> : null}

      {wl.data ? (
        <div className="mt-3 overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-sheet">
          <table className="w-full min-w-[980px] text-left" aria-describedby="wl-keys" data-testid="worklist-table">
            <caption className="sr-only">Slides grouped by case. {visible.length} of {total} slides shown.</caption>
            <thead className="border-b border-line-strong bg-surface text-micro font-semibold text-graphite">
              <tr>
                <th scope="col" className="py-2 pl-4 pr-3">Slide</th>
                <th scope="col" className="px-3 py-2">Review state</th>
                <th scope="col" className="px-3 py-2">Expert label</th>
                <th scope="col" className="px-3 py-2">QC</th>
                <th scope="col" className="px-3 py-2">Ingest</th>
                <th scope="col" className="py-2 pl-3 pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-graphite">
                    No slide matches these filters. Clear a filter to see more.
                  </td>
                </tr>
              ) : null}
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <tr className="border-t-2 border-line-strong bg-surface/70 first:border-t-0">
                    <th scope="rowgroup" colSpan={6} className="px-4 py-2.5 text-left font-normal">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-small font-semibold text-graphite">{g.patient ?? "no patient"}</span>
                          <ChevronRight size={14} aria-hidden className="text-line-strong" />
                          <span className="font-bold text-ink">{g.accession ?? "Unassigned slides"}</span>
                        </span>
                        <ProvenanceChip provenance={g.caseInfo?.provenance ?? g.rows[0].provenance} />
                        {g.caseInfo ? (
                          <>
                            <span className="text-small text-graphite">
                              Collected {formatDate(g.caseInfo.collected_on)} · {g.caseInfo.site_id ?? "site not recorded"} · Parts {g.caseInfo.parts.join(", ") || "none"}
                            </span>
                            {g.caseInfo.incomplete ? (
                              <span className="inline-flex items-center gap-1 text-small font-semibold text-amber-ink">
                                <AlertTriangle size={14} aria-hidden /> Incomplete case
                              </span>
                            ) : null}
                            <span className="ml-auto">
                              <Button size="sm" variant="quiet" icon={<FolderTree size={15} aria-hidden />} onClick={() => setCaseOpen(g.caseInfo!.id)} data-testid={`case-details-${g.accession}`}>
                                Case and hierarchy
                              </Button>
                            </span>
                          </>
                        ) : null}
                      </div>
                      {g.caseInfo?.note ? <p className="mt-1 max-w-[110ch] text-small text-graphite">{g.caseInfo.note}</p> : null}
                    </th>
                  </tr>
                  {g.rows.map((r) => {
                    const failed = r.ingest_status === "failed";
                    return (
                      <Fragment key={r.slide_id}>
                        <tr
                          ref={(el) => {
                            rowRefs.current[r.slide_id] = el;
                          }}
                          tabIndex={r.slide_id === tabStop ? 0 : -1}
                          onFocus={() => setFocusId(r.slide_id)}
                          onKeyDown={(e) => {
                            if (e.target === e.currentTarget) onRowKey(e, r.slide_id);
                          }}
                          onDoubleClick={() => router.push(`/review/${r.slide_id}`)}
                          aria-label={`${r.accession_code ?? ""} ${slideTitle(r)}, ${REVIEW_STATE_LABEL[r.review_state]}`}
                          data-testid="worklist-row"
                          data-slide-id={r.slide_id}
                          className={cn(
                            "group border-t border-line outline-none focus-visible:bg-teal-tint/60 focus-visible:shadow-[inset_4px_0_0_var(--color-teal)]",
                            focusId === r.slide_id ? "bg-teal-tint/30" : "hover:bg-paraffin/50",
                          )}
                        >
                          <td className="py-2.5 pl-4 pr-3">
                            <div className="flex items-center gap-3">
                              <SlideGlyph stain={r.stain} imageKind={r.image_kind} provenance={r.provenance} failed={failed} />
                              <div className="min-w-0">
                                <Link href={`/review/${r.slide_id}`} tabIndex={-1} className="font-semibold text-ink hover:text-teal-deep hover:underline">
                                  Part {r.part ?? "?"} · {slideTitle(r)}
                                </Link>
                                <p className="text-micro text-graphite">
                                  {r.image_kind === "field_image"
                                    ? "Camera field image, not a whole slide"
                                    : r.image_kind === "synthetic_tiles"
                                      ? r.has_thumbnail || r.ingest_status !== "succeeded"
                                        ? "Synthetic tiles, no histology"
                                        : "Generator-spec record, no image"
                                      : "Whole-slide image"}
                                  {r.scanner_id ? ` · ${r.scanner_id}` : ""}
                                  {g.caseInfo && r.provenance !== g.caseInfo.provenance ? <span className="ml-1 inline-block align-middle"><ProvenanceChip provenance={r.provenance} /></span> : null}
                                  {r.identifier_risk_flags > 0 ? (
                                    <span className="ml-1 font-semibold text-amber-ink">· {r.identifier_risk_flags} identifier-risk flag{r.identifier_risk_flags === 1 ? "" : "s"}</span>
                                  ) : null}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <ReviewStateBadge state={r.review_state} />
                          </td>
                          <td className="px-3 py-2.5">
                            <LabelStatus status={r.slide_label_status} />
                            <p className="text-micro text-graphite">
                              {r.expert_readers} reader{r.expert_readers === 1 ? "" : "s"}
                              {r.my_label ? ` · mine: ${LABEL_SHORT[r.my_label]}` : ""}
                              {r.suggestions_hidden ? " · suggestion hidden until you assess" : r.model_suggestions ? ` · ${r.model_suggestions} suggestion` : ""}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            {r.open_qc_issues > 0 ? (
                              <span className="inline-flex items-center gap-1 text-small font-semibold text-amber-ink">
                                <span aria-hidden className="h-2 w-2 rounded-full bg-amber" />
                                {r.open_qc_issues} open
                              </span>
                            ) : (
                              <span className="text-small text-graphite">none open</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {failed ? (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-small font-semibold text-rust underline-offset-2 hover:underline"
                                aria-expanded={expandedError === r.slide_id}
                                onClick={() => setExpandedError((v) => (v === r.slide_id ? null : r.slide_id))}
                              >
                                <FileWarning size={14} aria-hidden /> Failed: why?
                              </button>
                            ) : (
                              <span className={cn("text-small", r.ingest_status === "succeeded" ? "text-graphite" : "font-semibold text-amber-ink")}>
                                {r.ingest_status === "succeeded" ? "Ingested" : r.ingest_status}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pl-3 pr-4">
                            <div className="flex justify-end gap-1.5">
                              {r.review_state === "imported" ? (
                                <Button
                                  size="sm"
                                  variant="review"
                                  icon={<Send size={14} aria-hidden />}
                                  busy={routing === r.slide_id}
                                  unavailable={
                                    !canRoute
                                      ? "Routing needs the histology assistant or pathologist demo role."
                                      : r.ingest_status !== "succeeded"
                                        ? "Only successfully ingested slides can be routed for review."
                                        : null
                                  }
                                  onClick={() => routeToReview(r)}
                                >
                                  Route to review
                                </Button>
                              ) : null}
                              <Link
                                href={`/review/${r.slide_id}`}
                                tabIndex={-1}
                                aria-hidden
                                className="inline-flex h-8 items-center rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2.5 text-small font-semibold text-ink hover:border-teal hover:text-teal-deep"
                              >
                                Open
                              </Link>
                            </div>
                          </td>
                        </tr>
                        {failed && expandedError === r.slide_id ? (
                          <tr className="bg-rust-tint/40">
                            <td colSpan={6} className="px-4 py-3">
                              <div className="flex flex-wrap items-start gap-3">
                                <p className="max-w-[110ch] flex-1 text-small text-ink" data-testid="ingest-error">
                                  {r.ingest_error}
                                </p>
                                <Button size="sm" unavailable={can("upload.write") ? null : "Re-queuing an ingest needs the histology assistant demo role."} onClick={() => reingest(r)}>
                                  Retry ingest
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {me && me.user.role === "medical_director" ? (
        <Notice tone="neutral" className="mt-4" title="Read-only role">
          The medical director role reads everything and can comment, but cannot change slides, labels or datasets.
        </Notice>
      ) : null}

      <CaseDetailDialog caseId={caseOpen} onClose={() => setCaseOpen(null)} onChanged={() => void Promise.all([wl.reload(), cases.reload()])} />
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        cases={cases.data?.items ?? []}
        onIngested={() => void Promise.all([wl.reload(), cases.reload()])}
      />
    </div>
  );
}
