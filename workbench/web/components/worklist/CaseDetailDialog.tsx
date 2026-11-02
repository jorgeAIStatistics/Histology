"use client";

import Link from "next/link";
import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { api, errorText } from "@/lib/api";
import { LABEL_SHORT, LABEL_STATUS_TEXT, formatDate, slideTitle } from "@/lib/format";
import type { CaseDetail, Slide } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { ErrorBox, Loading, Notice } from "@/components/ui/Notice";
import { TextField } from "@/components/ui/Field";
import { ProvenanceChip, ReviewStateBadge } from "@/components/ui/Badges";
import { SlideGlyph } from "@/components/ui/SlideGlyph";
import { useToast } from "@/components/ui/Toaster";

type Edit =
  | { kind: "case" }
  | { kind: "part"; id: string; current: string | null }
  | { kind: "newPart" }
  | { kind: "block"; id: string; current: string }
  | { kind: "newBlock"; partId: string }
  | { kind: "slide"; slide: Slide };

export function CaseDetailDialog({ caseId, onClose, onChanged }: { caseId: string | null; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const detail = useApi<CaseDetail>(caseId ? `/cases/${caseId}` : null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canEdit = can("hierarchy.write");
  const editReason = canEdit ? null : "Hierarchy edits need the histology assistant demo role (permission hierarchy.write).";
  const c = detail.data;

  const begin = (e: Edit, initial: Record<string, string>) => {
    setEdit(e);
    setForm(initial);
    setErr(null);
  };

  const save = async () => {
    if (!edit) return;
    setSaving(true);
    setErr(null);
    try {
      if (edit.kind === "case" && c) {
        await api(`/cases/${c.id}`, {
          method: "PATCH",
          body: { collected_on: form.collected_on || null, site_id: form.site_id || null, note: form.note || null, reason: form.reason || null },
        });
      } else if (edit.kind === "part") {
        await api(`/parts/${edit.id}`, { method: "PATCH", body: { anatomic_site_text: form.anatomic_site_text || null, reason: form.reason || null } });
      } else if (edit.kind === "newPart" && c) {
        await api(`/cases/${c.id}/parts`, { method: "POST", body: { designation: form.designation, anatomic_site_text: form.anatomic_site_text || null } });
      } else if (edit.kind === "block") {
        await api(`/blocks/${edit.id}`, { method: "PATCH", body: { designation: form.designation } });
      } else if (edit.kind === "newBlock") {
        await api(`/parts/${edit.partId}/blocks`, { method: "POST", body: { designation: form.designation } });
      } else if (edit.kind === "slide") {
        const body: Record<string, unknown> = { reason: form.reason || null };
        if (form.level_index !== String(edit.slide.level_index ?? "")) body.level_index = form.level_index === "" ? null : Number(form.level_index);
        if (form.stain !== (edit.slide.stain ?? "")) body.stain = form.stain || null;
        if (form.scanner_id !== (edit.slide.scanner_id ?? "")) body.scanner_id = form.scanner_id || null;
        if (form.block_id && form.block_id !== edit.slide.block_id) body.block_id = form.block_id;
        await api(`/slides/${edit.slide.id}`, { method: "PATCH", body });
      }
      toast.show({ tone: "success", title: "Hierarchy updated", body: "The change and its reason are in the audit trail." });
      setEdit(null);
      await detail.reload();
      onChanged();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const allBlocks = c?.parts.flatMap((p) => p.blocks.map((b) => ({ id: b.id, label: `Part ${p.designation} / Block ${b.designation}` }))) ?? [];

  const editor = edit ? (
    <div className="mt-3 rounded-[var(--radius-control)] border border-teal/40 bg-teal-tint/40 p-3" data-testid="hierarchy-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        {edit.kind === "case" ? (
          <>
            <TextField label="Collected on" type="date" value={form.collected_on ?? ""} onChange={(e) => setForm({ ...form, collected_on: e.target.value })} />
            <TextField label="Site code" hint="A short code such as site-north, never an address" value={form.site_id ?? ""} onChange={(e) => setForm({ ...form, site_id: e.target.value })} />
            <TextField className="sm:col-span-2" label="Note" value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </>
        ) : null}
        {edit.kind === "part" || edit.kind === "newPart" ? (
          <>
            {edit.kind === "newPart" ? <TextField label="Part designation" required placeholder="C" value={form.designation ?? ""} onChange={(e) => setForm({ ...form, designation: e.target.value })} /> : null}
            <TextField
              label="Anatomic site (free text)"
              hint="Fictional in this demo. Never include identifiers."
              value={form.anatomic_site_text ?? ""}
              onChange={(e) => setForm({ ...form, anatomic_site_text: e.target.value })}
            />
          </>
        ) : null}
        {edit.kind === "block" || edit.kind === "newBlock" ? (
          <TextField label="Block designation" required placeholder="A2" value={form.designation ?? ""} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
        ) : null}
        {edit.kind === "slide" ? (
          <>
            <TextField label="Level" type="number" min={0} max={999} value={form.level_index ?? ""} onChange={(e) => setForm({ ...form, level_index: e.target.value })} />
            <TextField label="Stain" value={form.stain ?? ""} onChange={(e) => setForm({ ...form, stain: e.target.value })} />
            <TextField label="Scanner code" value={form.scanner_id ?? ""} onChange={(e) => setForm({ ...form, scanner_id: e.target.value })} />
            <div className="space-y-1">
              <label htmlFor="slide-block" className="block text-small font-semibold">
                Block
              </label>
              <select id="slide-block" value={form.block_id ?? ""} onChange={(e) => setForm({ ...form, block_id: e.target.value })} className="h-10 w-full rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2">
                {allBlocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        {edit.kind === "case" || edit.kind === "part" || edit.kind === "slide" ? (
          <TextField className="sm:col-span-2" label="Reason for the change" hint="Recorded in the audit trail" value={form.reason ?? ""} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        ) : null}
      </div>
      {err ? <p className="mt-2 text-small text-rust" role="alert">{err}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" onClick={() => setEdit(null)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" busy={saving} onClick={save}>
          Save change
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <Dialog
      open={Boolean(caseId)}
      onClose={() => {
        setEdit(null);
        onClose();
      }}
      wide
      testId="case-dialog"
      title={c ? `${c.patient_code} › ${c.accession_code}` : "Case"}
      description="Coded patient → case → parts → blocks → slides (levels and stains). Codes only: never names, record numbers or birth dates."
    >
      <ErrorBox error={detail.error} what="load the case" />
      {detail.loading && !c ? <Loading label="Loading the case" /> : null}
      {c ? (
        <div className="space-y-5">
          <section aria-label="Case">
            <div className="flex flex-wrap items-center gap-3">
              <ProvenanceChip provenance={c.provenance} long />
              <span className="text-small text-graphite">
                Collected {formatDate(c.collected_on)} · {c.site_id ?? "site not recorded"}
              </span>
              <span className="ml-auto">
                <Button
                  size="sm"
                  variant="quiet"
                  icon={<Pencil size={14} aria-hidden />}
                  unavailable={editReason}
                  onClick={() => begin({ kind: "case" }, { collected_on: c.collected_on ?? "", site_id: c.site_id ?? "", note: c.note ?? "", reason: "" })}
                >
                  Edit case
                </Button>
              </span>
            </div>
            {c.note ? <p className="mt-2 text-small text-graphite">{c.note}</p> : null}
            <p className="mt-2 text-small">
              <span className="font-semibold">Case-level label: </span>
              {c.case_label.value ? LABEL_SHORT[c.case_label.value] : "none"} ({LABEL_STATUS_TEXT[c.case_label.status] ?? c.case_label.status}).{" "}
              <span className="text-graphite">{c.case_label.note}</span>
            </p>
            {edit?.kind === "case" ? editor : null}
          </section>

          {c.parts.map((p) => (
            <section key={p.id} aria-label={`Part ${p.designation}`} className="rounded-[var(--radius-panel)] border border-line">
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
                <h3 className="font-bold">Part {p.designation}</h3>
                <span className="text-small text-graphite">{p.anatomic_site_text ?? "anatomic site not recorded"}</span>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="quiet" unavailable={editReason} onClick={() => begin({ kind: "part", id: p.id, current: p.anatomic_site_text }, { anatomic_site_text: p.anatomic_site_text ?? "", reason: "" })}>
                    Edit part
                  </Button>
                  <Button size="sm" variant="quiet" icon={<Plus size={14} aria-hidden />} unavailable={editReason} onClick={() => begin({ kind: "newBlock", partId: p.id }, { designation: "" })}>
                    Add block
                  </Button>
                </span>
              </div>
              {(edit?.kind === "part" && edit.id === p.id) || (edit?.kind === "newBlock" && edit.partId === p.id) ? <div className="px-3 pb-3">{editor}</div> : null}
              {p.blocks.length === 0 ? <p className="px-3 py-3 text-small text-graphite">No blocks yet.</p> : null}
              {p.blocks.map((b) => (
                <div key={b.id} className="border-t border-line px-3 py-2 first:border-t-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-small font-bold">Block {b.designation}</h4>
                    <span className="text-micro text-graphite">
                      {b.slides.length} slide{b.slides.length === 1 ? "" : "s"}
                    </span>
                    <Button size="sm" variant="quiet" className="ml-auto" unavailable={editReason} onClick={() => begin({ kind: "block", id: b.id, current: b.designation }, { designation: b.designation })}>
                      Rename block
                    </Button>
                  </div>
                  {edit?.kind === "block" && edit.id === b.id ? editor : null}
                  {b.slides.length === 0 ? <p className="py-1 text-small text-graphite">Not scanned yet.</p> : null}
                  <ul className="mt-1 space-y-1">
                    {b.slides.map((s) => (
                      <li key={s.id}>
                        <div className="flex flex-wrap items-center gap-3 rounded px-1 py-1 hover:bg-paraffin/60">
                          <SlideGlyph stain={s.stain} imageKind={s.image_kind} provenance={s.provenance} failed={s.ingest_status === "failed"} />
                          <Link href={`/review/${s.id}`} className="text-small font-semibold text-ink hover:text-teal-deep hover:underline">
                            {slideTitle({ level_index: s.level_index, stain: s.stain })}
                          </Link>
                          <ReviewStateBadge state={s.review_state} />
                          <span className="text-micro text-graphite">
                            {s.scanner_id ?? "scanner not recorded"} · {s.ingest_status === "failed" ? "ingest failed" : s.mpp_x ? `${s.mpp_x} µm/px` : "no calibration"}
                          </span>
                          <Button
                            size="sm"
                            variant="quiet"
                            className="ml-auto"
                            unavailable={editReason}
                            onClick={() =>
                              begin({ kind: "slide", slide: s }, { level_index: s.level_index === null ? "" : String(s.level_index), stain: s.stain ?? "", scanner_id: s.scanner_id ?? "", block_id: s.block_id ?? "", reason: "" })
                            }
                          >
                            Edit slide
                          </Button>
                        </div>
                        {edit?.kind === "slide" && edit.slide.id === s.id ? editor : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
          <div className="flex items-center justify-between gap-3">
            <Notice tone="neutral" className="flex-1">
              Repeated specimens from one coded patient stay linked, so dataset splits keep all of that patient&rsquo;s slides together.
            </Notice>
            <Button icon={<Plus size={15} aria-hidden />} unavailable={editReason} onClick={() => begin({ kind: "newPart" }, { designation: "", anatomic_site_text: "" })}>
              Add part
            </Button>
          </div>
          {edit?.kind === "newPart" ? editor : null}
        </div>
      ) : null}
    </Dialog>
  );
}
