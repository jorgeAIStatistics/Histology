/**
 * Client-safe helpers for the grossing screen (no server imports).
 */
import { decodeLabel, humanLabel } from "@/lib/identifiers";
import type { CassetteAllocation, Dimensions, GrossFields, GrossValue } from "@/lib/gross";
import { GROSS_FIELD_LABEL, REQUIRED_FOR_APPROVAL } from "@/lib/gross";
import type { GrossState, SourceUpdateState } from "@/lib/domain";

export type FieldKey = Exclude<keyof GrossFields, "template_id">;

/** Body order of the structured fields (Tab order follows it). */
export const FIELD_ORDER: FieldKey[] = [
  "specimen_type",
  "received_in",
  "container_label_matches",
  "piece_count",
  "dimensions",
  "appearance",
  "ink_orientation",
  "sectioning",
  "cassettes",
];

export const FIELD_LABEL = GROSS_FIELD_LABEL;

export function isRequired(key: FieldKey): boolean {
  return (REQUIRED_FOR_APPROVAL as string[]).includes(key);
}

/** Stored value with provenance (mirrors server StoredValue). */
export type StoredField<T = unknown> = GrossValue<T> & {
  origin?: "transcript" | "typed" | null;
  proposedValue?: T | null;
  reviewReasons?: string[] | null;
  reviewAcknowledged?: { reasons: string[]; note: string | null; by: string; byName: string; at: string } | null;
  confirmedBy?: string | null;
  confirmedByName?: string | null;
  confirmedAt?: string | null;
};

export const SPECIMEN_TYPES: { value: string; label: string }[] = [
  { value: "shave", label: "Shave" },
  { value: "punch", label: "Punch" },
  { value: "excision", label: "Excision" },
  { value: "curettage", label: "Curettage" },
  { value: "nail_clipping", label: "Nail clipping" },
  { value: "other", label: "Other" },
];

export function fmtFieldValue(key: FieldKey, v: unknown): string {
  if (v === null || v === undefined) return "Not entered";
  if (key === "dimensions") {
    const d = v as Dimensions;
    const nums = [d.length, d.width, d.depth].filter((n) => n !== null && n !== undefined);
    return nums.length ? `${nums.join(" × ")} ${d.unit ?? "(unit not stated)"}` : "Not entered";
  }
  if (key === "cassettes") {
    const list = v as CassetteAllocation[];
    return list.length ? list.map((c) => `${c.label}${c.pieces !== null && c.pieces !== undefined ? ` (${c.pieces} pc)` : ""}`).join(", ") : "None";
  }
  if (key === "container_label_matches") return v ? "Yes, matches the part" : "No, does not match";
  if (key === "specimen_type") return SPECIMEN_TYPES.find((s) => s.value === v)?.label ?? String(v);
  return String(v);
}

/** Deterministic narrative draft from CONFIRMED values only; anything unconfirmed is marked, never filled in. */
export function composeNarrative(fields: GrossFields, part: { designation: string; site: string }): string {
  const c = <T,>(f: GrossValue<T>): T | null => (f.status === "confirmed" ? f.value : null);
  const gap = (label: string) => `[${label}: not confirmed]`;
  const type = c(fields.specimen_type);
  const typeText = type ? (SPECIMEN_TYPES.find((s) => s.value === type)?.label.toLowerCase() ?? type) : gap("specimen type");
  const count = c(fields.piece_count);
  const dims = c(fields.dimensions);
  const dimText = dims
    ? `${[dims.length, dims.width, dims.depth].filter((n) => n !== null && n !== undefined).join(" x ")} ${dims.unit}`
    : gap("dimensions");
  const recv = c(fields.received_in);
  const appearance = c(fields.appearance);
  const ink = c(fields.ink_orientation);
  const sect = c(fields.sectioning);
  const cas = c(fields.cassettes);
  const label = c(fields.container_label_matches);
  const parts: string[] = [];
  parts.push(
    `Part ${part.designation}: received ${recv ? `in ${recv}` : gap("received in")}${label === true ? ` labeled with the patient's name and "${part.site}"` : label === false ? "; container label does NOT match the part (see clarification)" : ""}.`,
  );
  parts.push(
    `Consists of ${count !== null ? (count === 1 ? "one" : String(count)) : gap("piece count")}${appearance ? ` ${appearance}` : ""} ${typeText} specimen${count !== null && count > 1 ? "s" : ""} measuring ${dimText}.`,
  );
  if (ink) parts.push(`${ink.charAt(0).toUpperCase()}${ink.slice(1)}.`);
  if (sect || cas) {
    const casText = cas && cas.length ? `${cas.length === 1 ? "cassette" : "cassettes"} ${cas.map((x) => x.label).join(", ")}` : gap("cassettes");
    parts.push(`${sect ? sect : gap("sectioning")}; ${casText}.`);
  }
  return parts.join(" ");
}

/**
 * Optimistic-concurrency policy for the workspace. `known` is the version my next command will be checked
 * against; `incoming` is the version in freshly refreshed props. Without unsaved edits I adopt the newer version
 * (I can see what changed). With unsaved edits I keep `known`, so saving or confirming my edits returns CONFLICT
 * and the conflict dialog, instead of silently overwriting what someone else saved.
 */
export function onRefreshedVersion(known: number, incoming: number, dirty: boolean): { adopt: boolean; changedUnderEdits: boolean } {
  if (incoming <= known) return { adopt: false, changedUnderEdits: false };
  return dirty ? { adopt: false, changedUnderEdits: true } : { adopt: true, changedUnderEdits: false };
}

export type StepKey = "draft" | "operator_reviewed" | "approved_for_downstream" | "pending_entry" | "entered_attested" | "source_acknowledged";

export const STEPS: { key: StepKey; label: string }[] = [
  { key: "draft", label: "Draft" },
  { key: "operator_reviewed", label: "Operator reviewed" },
  { key: "approved_for_downstream", label: "Approved for downstream use" },
  { key: "pending_entry", label: "Source update pending" },
  { key: "entered_attested", label: "Entered (staff attested)" },
  { key: "source_acknowledged", label: "Source acknowledged (simulated)" },
];

/** Index of the current step (the last reached one). -1 = not started. */
export function currentStepIndex(state: GrossState | null, source: SourceUpdateState | null): number {
  if (!state) return -1;
  if (state === "approved_for_downstream") {
    if (source === "source_acknowledged") return 5;
    if (source === "entered_attested") return 4;
    return 3;
  }
  if (state === "operator_reviewed") return 1;
  return 0;
}

/**
 * Turn a scanned or typed value into a /grossing URL. A scan identifies a
 * record; it never verifies what tissue is in a cassette.
 */
export function scanToGrossingHref(raw: string): { href: string; message: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: "Scan a cassette label or type an accession and part, for example D26-04817 A." };
  if (/^HL1:/i.test(value)) {
    const d = decodeLabel(value);
    if (!d.ok) return { error: `Not accepted: ${d.reason}. Rescan the label or type the accession and part.` };
    const id = d.identity;
    if (id.part) return { href: `/grossing?part=${encodeURIComponent(`${id.accession}-${id.part}`)}`, message: `Scanned ${humanLabel(id)}. Matched part ${id.part} of ${id.accession}.` };
    return { href: `/grossing?case=${encodeURIComponent(id.accession)}`, message: `Scanned ${id.accession}. Opening the first part that still needs grossing.` };
  }
  const m = /^(D\d{2}-\d{5})(?:[\s\-_]*([A-Za-z])(\d+)?(?:-\d+)?)?$/i.exec(value);
  if (!m) return { error: `Not recognized: "${value}". Scan a cassette label or type an accession and part, for example D26-04817 A.` };
  const acc = m[1].toUpperCase();
  if (m[2]) {
    const letter = m[2].toUpperCase();
    return { href: `/grossing?part=${encodeURIComponent(`${acc}-${letter}`)}`, message: `Opening ${acc} part ${letter}.` };
  }
  return { href: `/grossing?case=${encodeURIComponent(acc)}`, message: `Opening ${acc}: first part that still needs grossing.` };
}
