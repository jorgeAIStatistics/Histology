"use client";

import { useState } from "react";
import { Download, Pentagon, Square } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { formatDateTime, userName } from "@/lib/format";
import type { DraftGeom } from "@/lib/geometry";
import type { Annotation, Slide } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { SelectField, TextArea, TextField } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toaster";
import { cn } from "@/components/ui/cn";
import { Disclosure, PanelSection } from "./shared";
import type { DraftMeta, Tool } from "./SlideViewer";

const ANN_LABELS = [
  { value: "region_of_interest", label: "Region of interest" },
  { value: "artifact", label: "Artifact (fold, chatter, debris)" },
  { value: "other", label: "Other" },
];

function bbox(a: Annotation) {
  const ring = a.geometry.coordinates[0] ?? [];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function AnnotationsPanel({
  slide,
  annotations,
  selectedId,
  onSelect,
  tool,
  onTool,
  draft,
  draftMeta,
  onDiscardDraft,
  onSaved,
  replaceFor,
  onReplaceFor,
  onCentreRectangle,
}: {
  slide: Slide;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  tool: Tool;
  onTool: (t: Tool) => void;
  draft: DraftGeom | null;
  draftMeta: DraftMeta | null;
  onDiscardDraft: () => void;
  onSaved: () => Promise<void> | void;
  replaceFor: string | null;
  onReplaceFor: (id: string | null) => void;
  onCentreRectangle: () => void;
}) {
  const { can, demoUsers, projectId } = useSession();
  const toast = useToast();
  const [label, setLabel] = useState("region_of_interest");
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; label: string; comment: string; reason: string } | null>(null);
  const [del, setDel] = useState<{ id: string; reason: string } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const canWrite = can("annotation.write");
  const writeReason = canWrite ? null : "Annotating needs the pathologist demo role (permission annotation.write).";
  const notReady = slide.ingest_status !== "succeeded" ? "Only ingested slides can be annotated." : null;

  const transformMeta = () =>
    draftMeta
      ? {
          viewer: "openseadragon 6.1.1 (canvas drawer)",
          conversion: "TiledImage.viewerElementToImageCoordinates + bounds_offset_level0",
          rotation_deg: draftMeta.rotation_deg,
          viewport_zoom: Number(draftMeta.viewport_zoom.toFixed(6)),
          image_zoom: Number(draftMeta.image_zoom.toFixed(6)),
          container_px: draftMeta.container_px,
          tool: draftMeta.tool,
          flip: false,
        }
      : null;

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      if (replaceFor) {
        await api(`/annotations/${replaceFor}`, { method: "PATCH", body: { reason, geometry: draft, transform_meta: transformMeta() } });
        toast.show({ tone: "success", title: "Outline redrawn (new version)", body: "The previous version is kept in the history." });
        onReplaceFor(null);
      } else {
        const r = await api<Annotation>(`/slides/${slide.id}/annotations`, { method: "POST", body: { geometry: draft, label, comment: comment || null, transform_meta: transformMeta() } });
        toast.show({ tone: "success", title: "Annotation saved", body: "Stored in level-0 pixel coordinates with how the view was transformed." });
        onSelect(r.annotation_id);
      }
      setComment("");
      setReason("");
      onDiscardDraft();
      await onSaved();
      setHistoryKey((k) => k + 1);
    } catch (err) {
      toast.show({ tone: "error", title: "Annotation not saved", body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="annotations-panel">
      <PanelSection title="Draw">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Annotation tools">
          <Button size="sm" variant={tool === "rect" ? "primary" : "secondary"} aria-pressed={tool === "rect"} icon={<Square size={14} aria-hidden />} unavailable={writeReason ?? notReady} onClick={() => onTool(tool === "rect" ? "pan" : "rect")} data-testid="tool-rect">
            Rectangle (R)
          </Button>
          <Button size="sm" variant={tool === "polygon" ? "primary" : "secondary"} aria-pressed={tool === "polygon"} icon={<Pentagon size={14} aria-hidden />} unavailable={writeReason ?? notReady} onClick={() => onTool(tool === "polygon" ? "pan" : "polygon")} data-testid="tool-polygon">
            Polygon (P)
          </Button>
          <Button size="sm" variant="quiet" unavailable={writeReason ?? notReady} onClick={onCentreRectangle} data-testid="centre-rect">
            Outline the view centre
          </Button>
        </div>
        <p className="mt-2 text-micro text-graphite">
          {tool === "rect"
            ? "Drag on the slide. The wheel still zooms."
            : tool === "polygon"
              ? "Click to add points; click the first point, double-click or press Enter to close. Backspace removes the last point, Escape cancels."
              : "Coordinates are stored in level-0 pixels (x right, y down), so outlines stay put through zoom, rotation and reload."}
        </p>
        {replaceFor ? (
          <Notice tone="info" className="mt-2" title="Redrawing an outline">
            Draw the replacement shape, then save it with a reason. <button type="button" className="font-semibold text-teal-deep underline" onClick={() => onReplaceFor(null)}>Stop redrawing</button>
          </Notice>
        ) : null}
        {draft ? (
          <div className="mt-3 space-y-2 rounded-[var(--radius-control)] border border-teal/50 bg-teal-tint/40 p-2.5" data-testid="draft-form">
            <p className="text-small font-semibold">
              New {draft.type === "rectangle" ? "rectangle" : `polygon (${draft.points.length} points)`} · rotated {draftMeta?.rotation_deg ?? 0}° when drawn
            </p>
            {replaceFor ? (
              <TextField label="Reason for the new version" required value={reason} onChange={(e) => setReason(e.target.value)} />
            ) : (
              <>
                <SelectField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} options={ANN_LABELS} />
                <TextArea label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="quiet" onClick={onDiscardDraft}>
                Discard
              </Button>
              <Button size="sm" variant="primary" busy={busy === "save"} unavailable={replaceFor && !reason.trim() ? "A new version needs a reason." : null} onClick={save} data-testid="save-annotation">
                {replaceFor ? "Save new version" : "Save annotation"}
              </Button>
            </div>
          </div>
        ) : null}
      </PanelSection>

      <PanelSection
        title={`Current outlines (${annotations.length})`}
        aside={
          projectId ? (
            <a href={`/api/v1/projects/${projectId}/export/annotations.geojson`} download className="inline-flex items-center gap-1 text-micro font-semibold text-teal-deep underline-offset-2 hover:underline">
              <Download size={13} aria-hidden /> GeoJSON (project)
            </a>
          ) : null
        }
      >
        {annotations.length === 0 ? <p className="text-small text-graphite">No outline on this slide.</p> : null}
        <ul className="space-y-2" data-testid="annotation-list">
          {annotations.map((a) => {
            const b = bbox(a);
            const sel = a.annotation_id === selectedId;
            return (
              <li key={a.annotation_id} className={cn("rounded-[var(--radius-control)] border p-2.5", sel ? "border-teal bg-teal-tint/40" : "border-line bg-sheet")} data-testid="annotation-item" data-annotation-id={a.annotation_id}>
                <button type="button" className="w-full text-left" aria-pressed={sel} onClick={() => onSelect(sel ? null : a.annotation_id)}>
                  <span className="block text-small font-semibold text-ink">
                    {(a.label ?? "annotation").replace(/_/g, " ")} · {a.geometry_type} · v{a.version}
                  </span>
                  <span className="block text-micro text-graphite">
                    {userName(a.author_id, demoUsers)} · {formatDateTime(a.created_at)}
                    {a.reason ? ` · “${a.reason}”` : ""}
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] text-graphite">
                    level-0 box x {b.x0.toFixed(1)}–{b.x1.toFixed(1)}, y {b.y0.toFixed(1)}–{b.y1.toFixed(1)}
                  </span>
                  {a.comment ? <span className="mt-1 block text-micro text-ink">{a.comment}</span> : null}
                </button>
                {sel && canWrite ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" onClick={() => setEdit({ id: a.annotation_id, label: a.label ?? "region_of_interest", comment: a.comment ?? "", reason: "" })}>
                      Edit label
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        onReplaceFor(a.annotation_id);
                        onTool(a.geometry_type === "rectangle" ? "rect" : "polygon");
                      }}
                    >
                      Redraw
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setDel({ id: a.annotation_id, reason: "" })}>
                      Delete
                    </Button>
                  </div>
                ) : null}
                {edit?.id === a.annotation_id ? (
                  <div className="mt-2 space-y-2">
                    <SelectField label="Label" value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} options={ANN_LABELS} />
                    <TextArea label="Comment" value={edit.comment} onChange={(e) => setEdit({ ...edit, comment: e.target.value })} />
                    <TextField label="Reason for the new version" required value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="quiet" onClick={() => setEdit(null)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        busy={busy === "edit"}
                        unavailable={edit.reason.trim() ? null : "A new version needs a reason."}
                        onClick={async () => {
                          setBusy("edit");
                          try {
                            await api(`/annotations/${edit.id}`, { method: "PATCH", body: { label: edit.label, comment: edit.comment, reason: edit.reason } });
                            toast.show({ tone: "success", title: "Annotation updated (new version)" });
                            setEdit(null);
                            await onSaved();
                          } catch (err) {
                            toast.show({ tone: "error", title: "Not saved", body: errorText(err) });
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Save new version
                      </Button>
                    </div>
                  </div>
                ) : null}
                {del?.id === a.annotation_id ? (
                  <div className="mt-2 space-y-2">
                    <TextField label="Reason for deleting" required hint="Deletion is soft: a new version marked deleted; the history stays." value={del.reason} onChange={(e) => setDel({ ...del, reason: e.target.value })} />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="quiet" onClick={() => setDel(null)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        busy={busy === "del"}
                        unavailable={del.reason.trim() ? null : "Deleting needs a reason."}
                        onClick={async () => {
                          setBusy("del");
                          try {
                            await api(`/annotations/${del.id}`, { method: "DELETE", body: { reason: del.reason } });
                            toast.show({ tone: "success", title: "Annotation deleted (soft)", body: "Its versions stay readable in the history." });
                            setDel(null);
                            onSelect(null);
                            await onSaved();
                          } catch (err) {
                            toast.show({ tone: "error", title: "Not deleted", body: errorText(err) });
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Delete outline
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="mt-3">
          <Disclosure summary="Version history, including deleted outlines" testId="annotation-history-toggle">
            <HistoryList key={`${historyKey}-${annotations.map((a) => a.id).join(",")}`} slideId={slide.id} />
          </Disclosure>
        </div>
      </PanelSection>
    </div>
  );
}

function HistoryList({ slideId }: { slideId: string }) {
  const { demoUsers } = useSession();
  const history = useApi<{ items: Annotation[] }>(`/slides/${slideId}/annotations?history=1`);
  const items = history.data?.items;
  if (!items) return <p className="text-micro text-graphite">Loading…</p>;
  return (
    <ol className="space-y-1 text-micro" data-testid="annotation-history">
      {items.map((v) => (
        <li key={v.id} className={cn("rounded border px-2 py-1", v.deleted ? "border-rust/30 bg-rust-tint/40" : "border-line bg-sheet")}>
          <strong>{(v.label ?? "annotation").replace(/_/g, " ")}</strong> v{v.version} {v.deleted ? "(deleted)" : ""} · {userName(v.author_id, demoUsers)} · {formatDateTime(v.created_at)}
          {v.reason ? ` · “${v.reason}”` : ""}
          {v.superseded_by ? " · superseded" : ""}
        </li>
      ))}
    </ol>
  );
}
