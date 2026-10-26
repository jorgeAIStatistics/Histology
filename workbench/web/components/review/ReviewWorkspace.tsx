"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Hand,
  Keyboard,
  Layers,
  Maximize,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Pentagon,
  Plus,
  RotateCcw,
  RotateCw,
  Square,
} from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { LABEL_SHORT, QC_CATEGORY_LABEL, REVIEW_STATE_LABEL, isSpecOnlySlide, slideTitle } from "@/lib/format";
import { ringOf, type DraftGeom, type Pt } from "@/lib/geometry";
import type { Annotation, CaseDetail, Comment, LabelsView, Project, QcView, Slide, ViewerToken, Worklist } from "@/lib/types";
import { ErrorBox, Loading, Notice } from "@/components/ui/Notice";
import { ProvenanceChip, ReviewStateBadge } from "@/components/ui/Badges";
import { SlideGlyph } from "@/components/ui/SlideGlyph";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { SlideViewer, type DraftMeta, type Tool, type ViewerHandle, type ViewerMetrics } from "./SlideViewer";
import { LabelsPanel } from "./LabelsPanel";
import { QcPanel } from "./QcPanel";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { CommentsPanel } from "./CommentsPanel";
import { DetailsPanel } from "./DetailsPanel";

const SHORTCUTS: [string, string][] = [
  ["V or Esc", "Pan (no drawing tool)"],
  ["R", "Rectangle tool"],
  ["P", "Polygon tool"],
  ["Enter", "Close the polygon"],
  ["Backspace", "Remove the last polygon point"],
  ["+ / −", "Zoom in / out"],
  ["0", "Fit the whole slide"],
  ["[ / ]", "Rotate 90° left / right"],
  ["Arrow keys", "Pan the view"],
  ["M", "Tissue mask on / off"],
  ["J / K", "Next / previous slide in the worklist"],
  ["1 – 5", "Labels, QC, Annotations, Comments, Details"],
  ["?", "This list"],
];

const TABS = ["labels", "qc", "annotations", "comments", "details"] as const;
type TabId = (typeof TABS)[number];

function useIsNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

const TEXT_INPUTS = new Set(["text", "search", "email", "number", "password", "tel", "url", "date", "time", "datetime-local", "month", "week"]);

/** True when a key press belongs to a text field (or an open dialog), not to the viewer shortcuts. */
function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) return true;
  return Boolean(el.closest("dialog[open]"));
}

/** Arrow keys stay with radios, checkboxes, tabs and sliders; elsewhere they pan the slide. */
function ownsArrows(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return Boolean(el && (el instanceof HTMLInputElement || el.closest("[role=tablist],[role=radiogroup],fieldset")));
}

export function ReviewWorkspace({ slideId }: { slideId: string }) {
  const { me, projectId, setProjectId, can } = useSession();
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const narrow = useIsNarrow();
  const slide = useApi<Slide>(`/slides/${slideId}`);
  const pid = slide.data?.project_id ?? projectId;
  const project = useApi<Project>(pid ? `/projects/${pid}` : null);
  const labels = useApi<LabelsView>(`/slides/${slideId}/labels`);
  const qc = useApi<QcView>(`/slides/${slideId}/qc`);
  const anns = useApi<{ items: Annotation[] }>(`/slides/${slideId}/annotations`);
  const comments = useApi<{ items: Comment[] }>(`/slides/${slideId}/comments`);
  const wl = useApi<Worklist>(pid ? `/projects/${pid}/worklist` : null);
  const caseId = slide.data?.lineage.case_id ?? null;
  const caseDetail = useApi<CaseDetail>(caseId ? `/cases/${caseId}` : null);
  const runId = search.get("run");
  const attention = useApi<{ notice: string; patches: { x: number; y: number; w: number; h: number; weight: number }[]; synthetic: boolean }>(runId ? `/experiments/${runId}/attention/${slideId}` : null);

  const viewer = useRef<ViewerHandle>(null);
  const [tool, setTool] = useState<Tool>("pan");
  const [tab, setTab] = useState<TabId>("labels");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftGeom | null>(null);
  const [draftMeta, setDraftMeta] = useState<DraftMeta | null>(null);
  const [replaceFor, setReplaceFor] = useState<string | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ViewerMetrics | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  // Below 1280 px the case rail starts collapsed so the slide keeps most of the width.
  useEffect(() => {
    if (window.innerWidth < 1280) setRailOpen(false);
  }, []);
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  // Keep the project switcher in step with a deep-linked slide.
  useEffect(() => {
    if (slide.data && projectId && slide.data.project_id !== projectId && me?.memberships.some((m) => m.project_id === slide.data!.project_id)) {
      setProjectId(slide.data.project_id);
    }
  }, [slide.data, projectId, me, setProjectId]);

  useEffect(() => {
    setOpenedAt(Date.now());
    setSelectedId(null);
    setDraft(null);
    setReplaceFor(null);
    setMaskUrl(null);
    setTool("pan");
    try {
      window.localStorage.setItem("wb.lastSlide", slideId);
    } catch {
      /* ignore */
    }
  }, [slideId]);

  // The tissue-mask URL carries a user-bound token: drop it when the demo role changes (the viewer is rebuilt too).
  const userId = me?.user.id ?? null;
  useEffect(() => {
    setMaskUrl(null);
  }, [userId]);

  const order = useMemo(() => (wl.data?.items ?? []).map((r) => r.slide_id), [wl.data]);
  const pos = order.indexOf(slideId);
  const goto = useCallback(
    (delta: number) => {
      if (pos < 0) return;
      const next = order[pos + delta];
      if (next) router.push(`/review/${next}`);
    },
    [order, pos, router],
  );

  const reloadLabels = useCallback(async () => {
    await Promise.all([labels.reload(), slide.reload(), wl.reload(), project.reload()]);
  }, [labels, slide, wl, project]);
  const reloadQc = useCallback(async () => {
    await Promise.all([qc.reload(), slide.reload(), wl.reload()]);
  }, [qc, slide, wl]);

  const toggleMask = useCallback(async () => {
    if (maskUrl) {
      setMaskUrl(null);
      return;
    }
    const latest = qc.data?.reviews.find((r) => r.kind === "automated_screen" && r.has_mask);
    if (!latest) {
      toast.show({ tone: "info", title: "No tissue mask", body: "Run the automated screen (QC tab) to produce one." });
      return;
    }
    try {
      const t = await api<ViewerToken>(`/slides/${slideId}/viewer-token`);
      setMaskUrl(`/api/v1/slides/${slideId}/qc/mask?token=${encodeURIComponent(t.token)}&review_id=${latest.id}`);
    } catch (err) {
      toast.show({ tone: "error", title: "Mask unavailable", body: errorText(err) });
    }
  }, [maskUrl, qc.data, slideId, toast]);

  const specOnly = slide.data ? isSpecOnlySlide(slide.data) : false;
  const canDraw = can("annotation.write") && slide.data?.ingest_status === "succeeded" && !specOnly;
  const drawReason = !can("annotation.write") ? "Annotating needs the pathologist demo role." : slide.data?.ingest_status !== "succeeded" || specOnly ? "This slide has no image to annotate." : null;

  const chooseTool = useCallback(
    (t: Tool) => {
      if (t !== "pan" && !canDraw) {
        toast.show({ tone: "info", title: "Drawing unavailable", body: drawReason ?? undefined });
        return;
      }
      setTool(t);
      if (t !== "pan") setTab("annotations");
    },
    [canDraw, drawReason, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const v = viewer.current;
      const k = e.key;
      if (k === "?") {
        e.preventDefault();
        setLegendOpen(true);
      } else if (k === "v" || k === "V") chooseTool("pan");
      else if (k === "Escape") {
        v?.cancelDraft();
        setTool("pan");
      } else if (k === "r" || k === "R") chooseTool(tool === "rect" ? "pan" : "rect");
      else if (k === "p" || k === "P") chooseTool(tool === "polygon" ? "pan" : "polygon");
      else if (k === "Enter" && tool === "polygon") {
        e.preventDefault();
        v?.finishPolygon();
      } else if (k === "Backspace" && tool === "polygon") {
        e.preventDefault();
        v?.undoVertex();
      } else if (k === "+" || k === "=") v?.zoomBy(1.4);
      else if (k === "-" || k === "_") v?.zoomBy(1 / 1.4);
      else if (k === "0") v?.home();
      else if (k === "[") v?.rotateBy(-90);
      else if (k === "]") v?.rotateBy(90);
      else if (k === "m" || k === "M") void toggleMask();
      else if (k === "j" || k === "J") goto(1);
      else if (k === "k" || k === "K") goto(-1);
      else if (k.startsWith("Arrow") && !ownsArrows(e.target)) {
        e.preventDefault();
        if (k === "ArrowLeft") v?.panBy(-0.15, 0);
        else if (k === "ArrowRight") v?.panBy(0.15, 0);
        else if (k === "ArrowUp") v?.panBy(0, -0.15);
        else v?.panBy(0, 0.15);
      }
      else if (/^[1-5]$/.test(k)) setTab(TABS[Number(k) - 1]);
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, chooseTool, toggleMask, goto]);

  const annotations = useMemo(() => anns.data?.items ?? [], [anns.data]);
  const regions = useMemo(
    () =>
      (qc.data?.issues ?? [])
        .filter((i) => i.region && (i.region as { coordinates?: unknown }).coordinates)
        .map((i) => ({ id: i.id, ring: ringOf(i.region as { coordinates: number[][][] }) as Pt[], label: `QC: ${QC_CATEGORY_LABEL[i.category] ?? i.category} (${i.status.replace("_", " ")})` })),
    [qc.data],
  );

  if (slide.error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <ErrorBox error={slide.error} what="open this slide" />
        <Link href="/worklist" className="mt-4 inline-block font-semibold text-teal-deep underline">
          Back to the worklist
        </Link>
      </div>
    );
  }
  if (!slide.data) return <Loading className="px-6" label="Opening the slide" />;
  const s = slide.data;
  const l = s.lineage;
  const myLabel = labels.data ? labels.data.expert_labels.find((x) => x.author_id === me?.user.id && x.scope === "slide" && x.value && !x.is_adjudication) : null;
  const openIssues = qc.data?.issues.filter((i) => i.status !== "resolved").length ?? s.qc_summary?.open_issues ?? 0;
  const openDisagreement = labels.data?.disagreements.some((d) => d.status === "open");
  const unlabeledByMe = me?.user.role === "pathologist" && labels.data && !myLabel;
  const synthetic = s.image_kind === "synthetic_tiles" || (s.provenance === "demo_synthetic" && s.image_kind === "field_image");

  // ---------------------------------------------------------------- narrow screens: status review only
  if (narrow) {
    return (
      <div className="px-4 py-5" data-testid="mobile-status">
        <Link href="/worklist" className="inline-flex items-center gap-1 text-small font-semibold text-teal-deep">
          <ArrowLeft size={15} aria-hidden /> Worklist
        </Link>
        <h1 className="mt-3 text-title font-bold">
          {l.accession_code} · Part {l.part} · {slideTitle(s)}
        </h1>
        <div className="mt-2 flex flex-wrap gap-2">
          <ReviewStateBadge state={s.review_state} />
          <ProvenanceChip provenance={s.provenance} />
        </div>
        <Notice tone="info" className="mt-4" title="Status review only on a phone">
          Viewing tiles, drawing outlines and labelling need a screen at least 768 pixels wide (a tablet or desktop). Here you can check the case and its
          review status.
        </Notice>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-small">
          <dt className="text-graphite">Patient</dt>
          <dd>{l.patient_code}</dd>
          <dt className="text-graphite">Reference label</dt>
          <dd>{labels.data?.reference.slide.label?.value ? LABEL_SHORT[labels.data.reference.slide.label.value] : "none"} ({labels.data?.reference.slide.status})</dd>
          <dt className="text-graphite">Open QC issues</dt>
          <dd>{openIssues}</dd>
          <dt className="text-graphite">Ingest</dt>
          <dd>{s.ingest_status === "failed" ? s.ingest_error : s.ingest_status}</dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="review-workspace">
      {/* -------------------------------------------------------------- header strip */}
      <div className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5 xl:px-4">
        <Link href="/worklist" className="inline-flex h-8 items-center gap-1 rounded px-1.5 text-small font-semibold text-teal-deep hover:bg-teal-tint" aria-label="Back to the worklist">
          <ArrowLeft size={15} aria-hidden />
          <span className="hidden xl:inline">Worklist</span>
        </Link>
        <h1 className="flex min-w-0 items-center gap-1.5 text-small" data-testid="review-title">
          <span className="font-mono text-graphite">{l.patient_code ?? "unassigned"}</span>
          <ChevronRight size={13} aria-hidden className="text-line-strong" />
          <span className="font-bold text-ink">{l.accession_code ?? "no case"}</span>
          <ChevronRight size={13} aria-hidden className="text-line-strong" />
          <span className="truncate text-ink">
            Part {l.part}
            <span className="hidden text-graphite 2xl:inline">{l.anatomic_site_text ? ` (${l.anatomic_site_text})` : ""}</span> · {slideTitle(s)}
          </span>
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <ReviewStateBadge state={s.review_state} />
          <ProvenanceChip provenance={s.provenance} />
          {unlabeledByMe ? (
            <span className="inline-flex h-6 items-center rounded-[var(--radius-chip)] border border-amber/70 bg-amber-tint px-1.5 text-micro font-semibold text-amber-ink" data-testid="unreviewed-indicator">
              Not labelled by you
            </span>
          ) : null}
          {openDisagreement ? <span className="inline-flex h-6 items-center rounded-[var(--radius-chip)] border border-berry/50 bg-berry-tint px-1.5 text-micro font-semibold text-berry">Readers disagree</span> : null}
          {openIssues > 0 ? (
            <span className="inline-flex h-6 items-center rounded-[var(--radius-chip)] border border-amber/70 bg-amber-tint px-1.5 text-micro font-semibold text-amber-ink">
              {openIssues} open QC issue{openIssues === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="tabular hidden text-micro text-graphite lg:inline">{pos >= 0 ? `${pos + 1} of ${order.length}` : ""}</span>
          <button type="button" onClick={() => goto(-1)} disabled={pos <= 0} className="inline-flex h-8 items-center gap-0.5 rounded border border-line-strong bg-sheet px-2 text-small font-semibold disabled:opacity-40" aria-label="Previous slide (K)">
            <ChevronLeft size={15} aria-hidden /> K
          </button>
          <button type="button" onClick={() => goto(1)} disabled={pos < 0 || pos >= order.length - 1} className="inline-flex h-8 items-center gap-0.5 rounded border border-line-strong bg-sheet px-2 text-small font-semibold disabled:opacity-40" aria-label="Next slide (J)">
            J <ChevronRight size={15} aria-hidden />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* -------------------------------------------------------------- case rail */}
        {railOpen ? (
          <aside aria-label="Slides in this case" className="relative hidden w-[228px] shrink-0 overflow-y-auto border-r border-line bg-surface lg:block" data-testid="case-rail">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <p className="text-small font-bold">Case {l.accession_code}</p>
              <button type="button" onClick={() => setRailOpen(false)} className="rounded p-1 text-graphite hover:bg-paraffin" aria-label="Hide the case rail">
                <PanelLeftClose size={16} aria-hidden />
              </button>
            </div>
            {caseDetail.data ? (
              <div className="px-2 py-2">
                {caseDetail.data.parts.map((p) => (
                  <div key={p.id} className="mb-3">
                    <p className="px-1 text-micro font-bold text-graphite">
                      Part {p.designation}
                      {p.anatomic_site_text ? <span className="font-normal">, {p.anatomic_site_text}</span> : null}
                    </p>
                    {p.blocks.map((b) => (
                      <div key={b.id} className="mt-1">
                        <p className="px-1 text-[11px] font-semibold text-graphite">Block {b.designation}</p>
                        <ul>
                          {b.slides.length === 0 ? <li className="px-1 text-[11px] text-graphite">not scanned</li> : null}
                          {b.slides.map((x) => (
                            <li key={x.id}>
                              <Link
                                href={`/review/${x.id}`}
                                aria-current={x.id === slideId ? "page" : undefined}
                                className={cn("flex items-center gap-2 rounded px-1 py-1.5 text-small", x.id === slideId ? "bg-teal-tint font-semibold text-ink" : "text-ink hover:bg-paraffin")}
                              >
                                <SlideGlyph stain={x.stain} imageKind={x.image_kind} provenance={x.provenance} failed={x.ingest_status === "failed"} size={30} />
                                <span className="min-w-0 flex-1 truncate">{x.level_index === null ? "No level" : `Level ${x.level_index}`} · {x.stain}</span>
                                <span
                                  aria-label={REVIEW_STATE_LABEL[x.review_state]}
                                  title={REVIEW_STATE_LABEL[x.review_state]}
                                  className={cn(
                                    "h-2 w-2 shrink-0 rounded-full",
                                    x.review_state === "pending_review" ? "bg-amber" : x.review_state === "approved" ? "bg-approved" : x.review_state === "disputed" ? "bg-berry" : "bg-line-strong",
                                  )}
                                />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ))}
                <p className="px-1 text-[11px] text-graphite">Dots: amber pending, green approved, berry disputed, grey imported or excluded.</p>
              </div>
            ) : (
              <p className="px-3 py-3 text-small text-graphite">{caseId ? "Loading…" : "Not assigned to a case."}</p>
            )}
          </aside>
        ) : null}

        {/* -------------------------------------------------------------- stage */}
        <section aria-label="Slide viewer" className="relative flex min-w-0 flex-1 flex-col bg-stage">
          <div className="relative min-h-0 flex-1" tabIndex={0} aria-label="Slide image. Use the keyboard shortcuts listed below to zoom, rotate and draw." data-testid="viewer-focus">
            {isSpecOnlySlide(s) ? (
              <div className="flex h-full items-center justify-center p-6" data-testid="spec-only">
                <div className="max-w-lg rounded-[var(--radius-panel)] border border-hema/50 bg-surface p-5">
                  <p className="font-bold text-hema">Generator-spec record: no image</p>
                  <p className="mt-1 text-small text-graphite">
                    This fictional slide belongs to the pipeline-test cohort. It was never ingested and has no thumbnail; any tiles would be procedural noise, not
                    tissue, so no viewer is opened. {s.processing_version}
                  </p>
                </div>
              </div>
            ) : s.ingest_status === "succeeded" ? (
              <SlideViewer
                ref={viewer}
                slide={s}
                annotations={annotations}
                regions={regions}
                selectedId={selectedId}
                onSelect={setSelectedId}
                tool={tool}
                pendingDraft={draft}
                onDraft={(g, m) => {
                  setDraft(g);
                  setDraftMeta(m);
                  setTab("annotations");
                }}
                maskPngUrl={maskUrl}
                attention={attention.data?.patches ?? null}
                onMetrics={setMetrics}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6">
                <div className="max-w-lg rounded-[var(--radius-panel)] border border-rust/50 bg-surface p-5" role="alert">
                  <p className="font-bold text-ink">No image: ingest {s.ingest_status}</p>
                  <p className="mt-1 text-small text-graphite">{s.ingest_error ?? "The ingest job has not finished. Is the worker running?"}</p>
                </div>
              </div>
            )}

            {/* toolbar (left) and provenance badges (right) share one row and wrap when the stage is narrow */}
            <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start justify-between gap-2">
            <div className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-[var(--radius-control)] border border-white/10 bg-stage/90 p-1 text-stage-ink shadow-lg" role="toolbar" aria-label="Viewer tools">
              {!railOpen ? (
                <ToolButton label="Show the case rail" onClick={() => setRailOpen(true)}>
                  <PanelLeftOpen size={16} aria-hidden />
                </ToolButton>
              ) : null}
              <ToolButton label="Pan (V)" pressed={tool === "pan"} onClick={() => chooseTool("pan")} testId="vt-pan">
                <Hand size={16} aria-hidden />
              </ToolButton>
              <ToolButton label="Rectangle (R)" pressed={tool === "rect"} onClick={() => chooseTool("rect")} disabledReason={drawReason} testId="vt-rect">
                <Square size={16} aria-hidden />
              </ToolButton>
              <ToolButton label="Polygon (P)" pressed={tool === "polygon"} onClick={() => chooseTool("polygon")} disabledReason={drawReason} testId="vt-polygon">
                <Pentagon size={16} aria-hidden />
              </ToolButton>
              <span aria-hidden className="mx-0.5 h-5 w-px bg-white/20" />
              <ToolButton label="Zoom in (+)" onClick={() => viewer.current?.zoomBy(1.4)} testId="vt-zoom-in">
                <Plus size={16} aria-hidden />
              </ToolButton>
              <ToolButton label="Zoom out (−)" onClick={() => viewer.current?.zoomBy(1 / 1.4)} testId="vt-zoom-out">
                <Minus size={16} aria-hidden />
              </ToolButton>
              <ToolButton label="Fit the whole slide (0)" onClick={() => viewer.current?.home()} testId="vt-home">
                <Maximize size={16} aria-hidden />
              </ToolButton>
              <ToolButton label="Rotate 90° left ([)" onClick={() => viewer.current?.rotateBy(-90)} testId="vt-rot-left">
                <RotateCcw size={16} aria-hidden />
              </ToolButton>
              <ToolButton label="Rotate 90° right (])" onClick={() => viewer.current?.rotateBy(90)} testId="vt-rot-right">
                <RotateCw size={16} aria-hidden />
              </ToolButton>
              <span aria-hidden className="mx-0.5 h-5 w-px bg-white/20" />
              <ToolButton label="Tissue mask (M)" pressed={Boolean(maskUrl)} onClick={() => void toggleMask()} testId="vt-mask">
                <Layers size={16} aria-hidden />
              </ToolButton>
              <ToolButton label="Keyboard shortcuts (?)" onClick={() => setLegendOpen(true)}>
                <Keyboard size={16} aria-hidden />
              </ToolButton>
            </div>

            {/* provenance overlay on the image itself */}
            <div className="ml-auto flex flex-col items-end gap-1.5">
              {synthetic ? (
                <span className="rounded-[var(--radius-chip)] border border-[#b9addf]/60 bg-[#463c78]/90 px-2.5 py-1 text-small font-bold tracking-wide text-white" data-testid="synthetic-badge">
                  SYNTHETIC — NO HISTOLOGY
                </span>
              ) : null}
              {s.provenance === "public_cc0" ? (
                <span className="rounded-[var(--radius-chip)] border border-[#9cc1dc]/60 bg-[#2b5676]/90 px-2.5 py-1 text-small font-bold tracking-wide text-white" data-testid="cc0-badge">
                  PUBLIC CC0 — unlabeled
                </span>
              ) : null}
              {s.image_kind === "field_image" ? <span className="rounded bg-stage/90 px-2 py-1 text-micro text-stage-ink">Camera field image: not a whole slide</span> : null}
              {attention.data ? (
                <span className="pointer-events-auto max-w-[320px] rounded bg-[#7a4600]/95 px-2 py-1 text-right text-micro font-semibold text-white" data-testid="attention-notice">
                  {attention.data.notice}
                  {attention.data.synthetic ? <span className="block">PIPELINE TEST — NOT PATHOLOGY VALIDATION</span> : null}
                  <Link href={`/review/${slideId}`} className="mt-0.5 block underline">
                    Hide attention
                  </Link>
                </span>
              ) : null}
              {tool !== "pan" ? <span className="rounded bg-teal px-2 py-1 text-micro font-semibold text-white">{tool === "rect" ? "Rectangle: drag on the slide" : "Polygon: click points, Enter to close"}</span> : null}
            </div>
            </div>
          </div>

          {/* visible shortcut legend */}
          <div className="flex h-8 shrink-0 items-center gap-x-3 overflow-hidden border-t border-white/10 bg-[#1e2123] px-3 text-[12px] text-stage-ink/90" aria-label="Keyboard shortcuts">
            {[
              ["V", "pan"],
              ["R", "rectangle"],
              ["P", "polygon"],
              ["+ −", "zoom"],
              ["0", "fit"],
              ["[ ]", "rotate"],
              ["M", "mask"],
              ["J K", "slides"],
              ["1–5", "panels"],
              ["?", "help"],
            ].map(([k, v]) => (
              <span key={k} className="whitespace-nowrap">
                <kbd className="rounded border border-white/25 px-1 font-mono text-[11px] text-white">{k}</kbd> {v}
              </span>
            ))}
          </div>
        </section>

        {/* -------------------------------------------------------------- side panel */}
        <aside aria-label="Review panels" className="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface xl:w-[420px]">
          <Tabs
            idBase="rv"
            active={tab}
            onChange={(t) => setTab(t as TabId)}
            className="shrink-0 overflow-x-auto px-2"
            tabs={[
              { id: "labels", label: "Labels", badge: unlabeledByMe || openDisagreement ? <span aria-label="needs attention" className="h-2 w-2 rounded-full bg-amber" /> : undefined },
              { id: "qc", label: "QC", badge: openIssues ? <span className="tabular rounded bg-amber-tint px-1 text-micro text-amber-ink">{openIssues}</span> : undefined },
              { id: "annotations", label: "Outlines", badge: annotations.length ? <span className="tabular rounded bg-paraffin px-1 text-micro text-graphite">{annotations.length}</span> : undefined },
              { id: "comments", label: "Comments", badge: comments.data?.items.length ? <span className="tabular rounded bg-paraffin px-1 text-micro text-graphite">{comments.data.items.length}</span> : undefined },
              { id: "details", label: "Details" },
            ]}
          />
          {/* relative: the panels' absolutely positioned screen-reader texts stay inside this scroller instead of
              lengthening the document, which otherwise lets the wheel scroll the whole review layout off screen. */}
          <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <TabPanel idBase="rv" id="labels" active={tab}>
              <LabelsPanel
                slide={s}
                labels={labels.data}
                annotations={annotations}
                selectedAnnotationId={selectedId}
                openedAt={openedAt}
                onChanged={reloadLabels}
                independentEffective={Boolean(project.data?.independent_review_effective)}
                onIndependentChanged={reloadLabels}
              />
            </TabPanel>
            <TabPanel idBase="rv" id="qc" active={tab}>
              <QcPanel
                slide={s}
                qc={qc.data}
                onChanged={reloadQc}
                selectedAnnotation={annotations.find((a) => a.annotation_id === selectedId) ?? null}
                maskOn={Boolean(maskUrl)}
                onToggleMask={() => void toggleMask()}
                onShowRegion={(id) => {
                  const r = regions.find((x) => x.id === id);
                  if (!r) return;
                  const xs = r.ring.map((p) => p.x);
                  const ys = r.ring.map((p) => p.y);
                  viewer.current?.fitLevel0Box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
                }}
              />
            </TabPanel>
            <TabPanel idBase="rv" id="annotations" active={tab}>
              <AnnotationsPanel
                slide={s}
                annotations={annotations}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                }}
                tool={tool}
                onTool={chooseTool}
                draft={draft}
                draftMeta={draftMeta}
                onDiscardDraft={() => {
                  setDraft(null);
                  setDraftMeta(null);
                  setTool("pan");
                }}
                onSaved={async () => {
                  await anns.reload();
                  await labels.reload();
                }}
                replaceFor={replaceFor}
                onReplaceFor={setReplaceFor}
                onCentreRectangle={() => {
                  const r = viewer.current?.centreRectangle();
                  if (r) {
                    setDraft(r.geometry);
                    setDraftMeta(r.meta);
                  }
                }}
              />
            </TabPanel>
            <TabPanel idBase="rv" id="comments" active={tab}>
              <CommentsPanel slideId={slideId} comments={comments.data?.items ?? null} onChanged={comments.reload} />
            </TabPanel>
            <TabPanel idBase="rv" id="details" active={tab}>
              <DetailsPanel slide={s} metrics={metrics} />
            </TabPanel>
          </div>
        </aside>
      </div>

      <Dialog open={legendOpen} onClose={() => setLegendOpen(false)} title="Keyboard shortcuts" description="Shortcuts work whenever focus is not in a text field.">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-small">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="rounded border border-line-strong bg-sheet px-1.5 py-0.5 font-mono text-micro">{k}</kbd>
              </dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </div>
  );
}

function ToolButton({
  label,
  pressed,
  onClick,
  children,
  disabledReason,
  testId,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabledReason?: string | null;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={disabledReason ? `${label}: unavailable. ${disabledReason}` : label}
      title={disabledReason ? `${label}: ${disabledReason}` : label}
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-[5px]",
        pressed ? "bg-teal text-white" : "text-stage-ink hover:bg-white/10",
        disabledReason && "opacity-45",
      )}
    >
      {children}
    </button>
  );
}
