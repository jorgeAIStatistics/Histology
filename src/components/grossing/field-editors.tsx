"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { CircleCheck, CircleDashed, Plus, Quote, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CassetteAllocation, Dimensions } from "@/lib/gross";
import { Button, DisabledReason } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { Timestamp } from "@/components/domain/timestamp";
import { FIELD_LABEL, fmtFieldValue, isRequired, SPECIMEN_TYPES, type FieldKey, type StoredField } from "./model";

/* ------------------------------------------------------------------ */
/* Editor model: what the inputs hold (strings while typing)           */
/* ------------------------------------------------------------------ */

export type DimsModel = { length: string; width: string; depth: string; unit: "" | "cm" | "mm" };
export type CassetteModel = { label: string; pieces: string; description: string };
export type EditorModel = string | DimsModel | CassetteModel[];

const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

export function toModel(key: FieldKey, value: unknown): EditorModel {
  switch (key) {
    case "dimensions": {
      const d = (value ?? null) as Dimensions | null;
      return { length: num(d?.length), width: num(d?.width), depth: num(d?.depth), unit: (d?.unit ?? "") as DimsModel["unit"] };
    }
    case "cassettes":
      return ((value ?? []) as CassetteAllocation[]).map((c) => ({ label: c.label, pieces: num(c.pieces), description: c.description ?? "" }));
    case "container_label_matches":
      return value === true ? "yes" : value === false ? "no" : "";
    case "piece_count":
      return num(value as number | null);
    default:
      return value === null || value === undefined ? "" : String(value);
  }
}

function parseNum(s: string): number | null | "bad" {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : "bad";
}

/** Convert the editor model into a command value. `null` = cleared. */
export function fromModel(key: FieldKey, m: EditorModel): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (key) {
    case "dimensions": {
      const d = m as DimsModel;
      const l = parseNum(d.length);
      const w = parseNum(d.width);
      const h = parseNum(d.depth);
      if (l === "bad" || w === "bad" || h === "bad") return { ok: false, error: "Dimensions must be numbers" };
      if (l === null && w === null && h === null && !d.unit) return { ok: true, value: null };
      return { ok: true, value: { length: l, width: w, depth: h, unit: d.unit || null } };
    }
    case "cassettes": {
      const list = m as CassetteModel[];
      const out: CassetteAllocation[] = [];
      for (const c of list) {
        const label = c.label.trim().toUpperCase();
        if (!label) return { ok: false, error: "Each cassette needs a label (for example A1)" };
        const p = parseNum(c.pieces);
        if (p === "bad" || (p !== null && (!Number.isInteger(p) || p < 0))) return { ok: false, error: `Pieces in ${label} must be a whole number (or leave it blank if not stated)` };
        out.push({ label, pieces: p, description: c.description.trim() });
      }
      return { ok: true, value: out.length ? out : null };
    }
    case "container_label_matches":
      return { ok: true, value: m === "yes" ? true : m === "no" ? false : null };
    case "piece_count": {
      const p = parseNum(m as string);
      if (p === "bad") return { ok: false, error: "Piece count must be a number" };
      return { ok: true, value: p };
    }
    default: {
      const s = (m as string).trim();
      return { ok: true, value: s ? s : null };
    }
  }
}

export function sameModel(a: EditorModel, b: EditorModel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------------------ */
/* Status line                                                         */
/* ------------------------------------------------------------------ */

function FieldStatusLine({ f, required, now }: { f: StoredField; required: boolean; now: string }) {
  if (f.status === "confirmed") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-xs text-success-fg">
        <CircleCheck className="size-3.5 text-success-solid" aria-hidden />
        <span className="font-medium">Confirmed by operator</span>
        {f.confirmedByName ? (
          <span className="text-ink-secondary">· {f.confirmedByName}</span>
        ) : (
          <span className="text-ink-secondary">· who and when not recorded (seeded record)</span>
        )}
        {f.confirmedAt ? (
          <span className="text-ink-secondary">
            · <Timestamp iso={f.confirmedAt} now={now} />
          </span>
        ) : null}
      </span>
    );
  }
  if (f.status === "proposed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-info-fg">
        <CircleDashed className="size-3.5 text-info-solid" aria-hidden />
        <span className="font-medium">{f.origin === "typed" ? "Typed" : "Proposed from transcript"}</span>
        <span className="text-ink-secondary">· not confirmed</span>
      </span>
    );
  }
  if (f.status === "needs_review") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-warning-fg">
        <TriangleAlert className="size-3.5 text-warning-solid" aria-hidden />
        <span className="font-medium">Needs review</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", required ? "text-warning-fg" : "text-ink-muted")}>
      {required ? <TriangleAlert className="size-3.5 text-warning-solid" aria-hidden /> : null}
      <span className="font-medium">{required ? "Missing" : "Not stated"}</span>
      {required ? <span className="text-ink-secondary">· required before approval</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* One field row                                                       */
/* ------------------------------------------------------------------ */

export interface FieldRowProps {
  fieldKey: FieldKey;
  stored: StoredField;
  model: EditorModel;
  dirty: boolean;
  onModel: (m: EditorModel) => void;
  onConfirm: () => void;
  /** Needs-review value: the operator checked the specimen and keeps the dictated value (explicit second step). */
  onKeepAsDictated?: () => void;
  onRevert: () => void;
  onShowEvidence: () => void;
  onFocusField: () => void;
  active: boolean;
  frozen: boolean;
  /** Visible reason when the actor cannot confirm this field (role). */
  confirmBlockedReason: string | null;
  /** id of a page-level element that already shows the reason (avoids repeating it on every row). */
  sharedReasonId?: string;
  editBlockedReason: string | null;
  pending: boolean;
  error: string | null;
  partDesignation: string;
  now: string;
}

export function FieldRow(p: FieldRowProps) {
  const uid = useId();
  const baseId = `gf-${p.fieldKey}`;
  const statusId = `${uid}-status`;
  const noteId = `${uid}-note`;
  const reasonId = `${uid}-reason`;
  const errorId = `${uid}-error`;
  const required = isRequired(p.fieldKey);
  const f = p.stored;
  const disabledEdit = p.frozen || Boolean(p.editBlockedReason);
  const needsReview = f.status === "needs_review";
  const canKeep = needsReview && f.value !== null && f.value !== undefined && Boolean(p.onKeepAsDictated);
  const [keepOpen, setKeepOpen] = useState(false);
  const describedBy = [statusId, f.note ? noteId : null, p.error ? errorId : null].filter(Boolean).join(" ");

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      if (!p.frozen && !p.confirmBlockedReason) p.onConfirm();
    }
    if (e.key === "Escape" && p.dirty) {
      e.preventDefault();
      e.stopPropagation();
      p.onRevert();
    }
  };

  const confirmLabel = p.dirty ? "Confirm my value" : f.status === "confirmed" ? "Confirmed" : "Confirm";
  // A needs-review value is never confirmed as shown: it needs an edit, or the separate "Checked: keep as dictated" step.
  const canConfirmNow = !p.frozen && !p.confirmBlockedReason && (p.dirty || (f.status !== "confirmed" && !needsReview));

  const tone =
    f.status === "confirmed"
      ? "border-success-border border-solid"
      : f.status === "proposed"
        ? "border-info-border border-dashed"
        : f.status === "needs_review" || required
          ? "border-warning-border border-solid bg-warning-bg"
          : "border-line border-solid";

  let editor: ReactNode;
  const native = {
    disabled: disabledEdit,
    onKeyDown,
    onFocus: p.onFocusField,
    "aria-describedby": describedBy,
  } as const;
  const common = { ...native, invalid: Boolean(p.error) } as const;

  switch (p.frozen ? "__frozen" : p.fieldKey) {
    case "__frozen":
      editor = <p className="text-base text-ink">{f.value === null || f.value === undefined ? <span className="text-ink-muted">Not stated</span> : fmtFieldValue(p.fieldKey, f.value)}</p>;
      break;
    case "specimen_type":
      editor = (
        <Select id={baseId} size="sm" value={p.model as string} onChange={(e) => p.onModel(e.target.value)} {...common}>
          <option value="">Choose the observed type…</option>
          {SPECIMEN_TYPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      );
      break;
    case "container_label_matches": {
      const v = p.model as string;
      editor = (
        <div role="radiogroup" aria-labelledby={`${baseId}-label`} aria-describedby={describedBy} className="flex flex-wrap gap-3">
          {[
            ["yes", "Yes, matches the part"],
            ["no", "No, does not match"],
          ].map(([val, text], i) => (
            <label key={val} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                id={i === 0 ? baseId : undefined}
                type="radio"
                name={`${uid}-label`}
                value={val}
                checked={v === val}
                onChange={() => p.onModel(val)}
                className="size-4 accent-brand"
                aria-invalid={p.error ? true : undefined}
                {...native}
              />
              {text}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "piece_count":
      editor = (
        <Input id={baseId} size="sm" inputMode="numeric" className="w-28 num-tabular" value={p.model as string} onChange={(e) => p.onModel(e.target.value)} placeholder="Count" {...common} />
      );
      break;
    case "dimensions": {
      const d = p.model as DimsModel;
      const set = (patch: Partial<DimsModel>) => p.onModel({ ...d, ...patch });
      editor = (
        <div className="flex flex-wrap items-end gap-2" role="group" aria-labelledby={`${baseId}-label`}>
          {(["length", "width", "depth"] as const).map((k, i) => (
            <div key={k} className="flex flex-col gap-0.5">
              <label htmlFor={i === 0 ? baseId : `${baseId}-${k}`} className="text-xs text-ink-muted">
                {k === "length" ? "Length" : k === "width" ? "Width" : "Depth"}
              </label>
              <Input
                id={i === 0 ? baseId : `${baseId}-${k}`}
                size="sm"
                inputMode="decimal"
                className="w-16 num-tabular"
                value={d[k]}
                onChange={(e) => set({ [k]: e.target.value })}
                {...common}
              />
            </div>
          ))}
          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${baseId}-unit`} className="text-xs text-ink-muted">
              Unit (required)
            </label>
            <Select id={`${baseId}-unit`} size="sm" className="w-40" value={d.unit} onChange={(e) => set({ unit: e.target.value as DimsModel["unit"] })} {...common}>
              <option value="">Choose unit…</option>
              <option value="cm">cm (centimeters)</option>
              <option value="mm">mm (millimeters)</option>
            </Select>
          </div>
        </div>
      );
      break;
    }
    case "cassettes": {
      const list = p.model as CassetteModel[];
      const setRow = (i: number, patch: Partial<CassetteModel>) => p.onModel(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
      editor = (
        <div className="flex flex-col gap-1.5" role="group" aria-labelledby={`${baseId}-label`}>
          {list.length === 0 ? <p className="text-sm text-ink-muted">No cassettes allocated.</p> : null}
          {list.map((c, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-0.5">
                <label htmlFor={i === 0 ? baseId : `${baseId}-${i}-label`} className="text-xs text-ink-muted">Cassette</label>
                <Input id={i === 0 ? baseId : `${baseId}-${i}-label`} size="sm" mono className="w-16" value={c.label} onChange={(e) => setRow(i, { label: e.target.value.toUpperCase() })} {...common} />
              </div>
              <div className="flex flex-col gap-0.5">
                <label htmlFor={`${baseId}-${i}-pieces`} className="text-xs text-ink-muted" title="Specimen pieces in this cassette. Cut pieces from bisecting or trisecting go in Contents.">
                  Pieces (blank = not stated)
                </label>
                <Input id={`${baseId}-${i}-pieces`} size="sm" inputMode="numeric" className="w-20 num-tabular" value={c.pieces} onChange={(e) => setRow(i, { pieces: e.target.value })} {...common} />
              </div>
              <div className="flex min-w-40 flex-1 flex-col gap-0.5">
                <label htmlFor={`${baseId}-${i}-desc`} className="text-xs text-ink-muted">Contents</label>
                <Input id={`${baseId}-${i}-desc`} size="sm" value={c.description} onChange={(e) => setRow(i, { description: e.target.value })} {...common} />
              </div>
              <Button variant="quiet" size="sm" icon={<X />} disabled={disabledEdit} onClick={() => p.onModel(list.filter((_, j) => j !== i))} aria-label={`Remove cassette ${c.label || i + 1}`}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus />}
              disabled={disabledEdit}
              onClick={() => p.onModel([...list, { label: `${p.partDesignation}${list.length + 1}`, pieces: "", description: "" }])}
            >
              Add cassette
            </Button>
          </div>
        </div>
      );
      break;
    }
    default:
      editor = <Input id={baseId} size="sm" value={p.model as string} onChange={(e) => p.onModel(e.target.value)} {...common} />;
  }

  const showHint = p.active || p.dirty;
  return (
    <div
      data-field={p.fieldKey}
      className={cn("rounded-md border bg-surface px-3 py-2", tone, p.active && "ring-2 ring-focus ring-offset-1")}
      onMouseEnter={p.onFocusField}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <Label htmlFor={p.fieldKey === "container_label_matches" ? undefined : baseId} id={`${baseId}-label`} required={required}>
          {FIELD_LABEL[p.fieldKey]}
        </Label>
        {f.evidence?.text ? (
          <button
            type="button"
            onClick={p.onShowEvidence}
            className="inline-flex min-w-0 max-w-full items-start gap-1 rounded-sm text-left text-xs text-brand hover:underline"
            aria-label={`Show where ${FIELD_LABEL[p.fieldKey].toLowerCase()} was heard in the transcript: ${f.evidence.text}`}
          >
            <Quote className="mt-px size-3 shrink-0" aria-hidden />
            <span className="italic">“{f.evidence.text}”</span>
          </button>
        ) : null}
        <span id={statusId} className="ml-auto">
          <FieldStatusLine f={f} required={required} now={p.now} />
        </span>
      </div>
      {f.note ? (
        <p id={noteId} className={cn("mt-0.5 text-xs", f.status === "needs_review" || (f.status === "missing" && required) ? "text-warning-fg" : "text-ink-secondary")}>
          {f.note}
        </p>
      ) : null}
      {f.status === "confirmed" && f.proposedValue !== undefined && f.proposedValue !== null && fmtFieldValue(p.fieldKey, f.proposedValue) !== fmtFieldValue(p.fieldKey, f.value) ? (
        <p className="mt-0.5 text-xs text-ink-muted">Transcript proposed: {fmtFieldValue(p.fieldKey, f.proposedValue)}</p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">{editor}</div>
        {!p.frozen ? (
          <div className="flex items-center gap-1.5">
            {p.dirty ? (
              <Button variant="quiet" size="sm" onClick={p.onRevert}>
                Undo edit
              </Button>
            ) : null}
            {f.status === "confirmed" && !p.dirty ? (
              p.editBlockedReason || p.confirmBlockedReason ? null : <span className="px-1 text-xs text-ink-muted">Edit to change</span>
            ) : (
              <Button
                variant={canConfirmNow ? "primary" : "secondary"}
                size="sm"
                loading={p.pending}
                loadingLabel="Confirming..."
                disabled={!canConfirmNow}
                reasonId={p.confirmBlockedReason ? p.sharedReasonId ?? reasonId : undefined}
                onClick={p.onConfirm}
                aria-label={`${confirmLabel}: ${FIELD_LABEL[p.fieldKey]}`}
              >
                {confirmLabel}
              </Button>
            )}
            {canKeep && !p.confirmBlockedReason ? (
              <Button variant="secondary" size="sm" disabled={p.pending} aria-expanded={keepOpen} onClick={() => setKeepOpen((o) => !o)}>
                Checked: keep as dictated…
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {keepOpen && canKeep && !p.frozen && !p.confirmBlockedReason ? (
        <div role="group" aria-label={`Keep ${FIELD_LABEL[p.fieldKey]} as dictated`} className="mt-1.5 flex flex-wrap items-center gap-2 rounded-sm border border-warning-border bg-surface px-2 py-1.5 text-sm">
          <span className="text-ink">
            Keep <span className="font-medium">{fmtFieldValue(p.fieldKey, f.value)}</span>
            {p.fieldKey === "dimensions" && p.dirty ? " (with the unit you chose)" : ""} after checking the specimen? Review note: {f.note ?? "uncertain value"}
          </span>
          <Button
            variant="primary"
            size="sm"
            loading={p.pending}
            loadingLabel="Confirming..."
            onClick={() => {
              setKeepOpen(false);
              p.onKeepAsDictated?.();
            }}
          >
            I checked the specimen: keep it
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setKeepOpen(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {p.dirty && !p.frozen ? (
        <p className="mt-1 text-xs text-ink-muted">
          Edited, not saved. <Kbd>Enter</Kbd> confirms your value; <Kbd>Esc</Kbd> undoes.
        </p>
      ) : !p.frozen && needsReview && !p.confirmBlockedReason ? (
        <p className="mt-1 text-xs text-ink-muted">
          Enter the value you observed, or check the specimen and keep the dictated value. <Kbd>Enter</Kbd> does not accept it as shown.
        </p>
      ) : showHint && !p.frozen && f.status === "proposed" && !p.confirmBlockedReason ? (
        <p className="mt-1 text-xs text-ink-muted">
          <Kbd>Enter</Kbd> in the field confirms the proposed value as shown.
        </p>
      ) : null}
      {p.confirmBlockedReason && !p.frozen && !p.sharedReasonId ? <DisabledReason id={reasonId} className="mt-1 text-xs">{p.confirmBlockedReason}</DisabledReason> : null}
      {p.error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-danger-fg">
          {p.error}
        </p>
      ) : null}
    </div>
  );
}
