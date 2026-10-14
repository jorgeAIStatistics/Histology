/**
 * Structured grossing capture. Every value carries its own status so proposed
 * (machine-extracted) values are never confused with operator-confirmed ones,
 * and missing values stay visibly missing — never zero, never a default.
 */
export type FieldStatus = "confirmed" | "proposed" | "missing" | "needs_review";

export interface Evidence {
  /** Exact text from the source transcript/narrative the value came from. */
  text: string;
  start: number;
  end: number;
  source: "transcript" | "narrative";
}

export interface GrossValue<T> {
  value: T | null;
  status: FieldStatus;
  evidence?: Evidence | null;
  /** Why it needs review (ambiguous decimal, unit missing, conflicting counts...). */
  note?: string | null;
}

export type DimensionUnit = "cm" | "mm";

export interface Dimensions {
  length: number | null;
  width: number | null;
  depth: number | null;
  unit: DimensionUnit | null;
  /** Original words as spoken/typed, e.g. "point eight by point six by point one centimeters". */
  raw?: string | null;
}

export interface CassetteAllocation {
  label: string; // 'A1'
  pieces: number | null;
  description: string; // 'trisected, submitted entirely'
}

export interface GrossFields {
  template_id: string;
  specimen_type: GrossValue<string>;
  received_in: GrossValue<string>;
  container_label_matches: GrossValue<boolean>;
  piece_count: GrossValue<number>;
  dimensions: GrossValue<Dimensions>;
  appearance: GrossValue<string>;
  ink_orientation: GrossValue<string>;
  sectioning: GrossValue<string>;
  cassettes: GrossValue<CassetteAllocation[]>;
}

export const GROSS_FIELD_LABEL: Record<Exclude<keyof GrossFields, "template_id">, string> = {
  specimen_type: "Specimen type",
  received_in: "Received in",
  container_label_matches: "Container label matches part",
  piece_count: "Piece count",
  dimensions: "Dimensions",
  appearance: "Appearance",
  ink_orientation: "Ink / orientation",
  sectioning: "Sectioning",
  cassettes: "Cassette allocation",
};

/** Fields that must be operator-confirmed before approval (synthetic local template). */
export const REQUIRED_FOR_APPROVAL: (keyof GrossFields)[] = [
  "specimen_type",
  "received_in",
  "container_label_matches",
  "piece_count",
  "dimensions",
  "cassettes",
];

export const GROSS_TEMPLATES: Record<string, { id: string; label: string }> = {
  shave: { id: "DERM-SHAVE-v1", label: "Skin shave (synthetic template)" },
  punch: { id: "DERM-PUNCH-v1", label: "Skin punch (synthetic template)" },
  excision: { id: "DERM-EXC-v1", label: "Skin excision (synthetic template)" },
  nail_clipping: { id: "DERM-NAIL-v1", label: "Nail clipping (synthetic template)" },
  other: { id: "DERM-GEN-v1", label: "General skin (synthetic template)" },
};

export function emptyGrossFields(procedure: string | null | undefined): GrossFields {
  const tpl = GROSS_TEMPLATES[procedure ?? "other"] ?? GROSS_TEMPLATES.other;
  const missing = <T,>(): GrossValue<T> => ({ value: null, status: "missing" });
  return {
    template_id: tpl.id,
    specimen_type: missing<string>(),
    received_in: missing<string>(),
    container_label_matches: missing<boolean>(),
    piece_count: missing<number>(),
    dimensions: missing<Dimensions>(),
    appearance: missing<string>(),
    ink_orientation: missing<string>(),
    sectioning: missing<string>(),
    cassettes: missing<CassetteAllocation[]>(),
  };
}

export interface FinalizeBlocker {
  field: keyof GrossFields | "narrative";
  message: string;
}

/**
 * Why a record cannot move to "approved for downstream use". Used by the
 * server (authoritative) and the UI (to explain disabled buttons).
 */
export function grossFinalizeBlockers(fields: GrossFields, narrative: string): FinalizeBlocker[] {
  const out: FinalizeBlocker[] = [];
  for (const key of REQUIRED_FOR_APPROVAL) {
    const v = fields[key] as GrossValue<unknown>;
    const label = GROSS_FIELD_LABEL[key as Exclude<keyof GrossFields, "template_id">];
    if (v.status === "missing" || v.value === null || v.value === undefined) out.push({ field: key, message: `${label} is missing` });
    else if (v.status === "needs_review") out.push({ field: key, message: `${label} needs review: ${v.note ?? "uncertain value"}` });
    else if (v.status === "proposed") out.push({ field: key, message: `${label} was proposed from the transcript and has not been confirmed` });
  }
  const pc = fields.piece_count;
  if (pc.status === "confirmed" && (!Number.isInteger(pc.value) || (pc.value ?? 0) < 1)) {
    out.push({ field: "piece_count", message: "Piece count must be a whole number of at least 1" });
  }
  const d = fields.dimensions;
  if (d.status === "confirmed" && d.value) {
    if (!d.value.unit) out.push({ field: "dimensions", message: "Dimension unit is not stated (cm or mm)" });
    if (d.value.length === null) out.push({ field: "dimensions", message: "At least one measured dimension is required" });
  }
  const c = fields.cassettes;
  if (c.status === "confirmed" && c.value) {
    if (c.value.length === 0) out.push({ field: "cassettes", message: "No cassettes allocated" });
    const pieces = c.value.reduce((s, x) => s + (x.pieces ?? 0), 0);
    if (pc.status === "confirmed" && pc.value && c.value.every((x) => x.pieces !== null) && pieces !== pc.value && fields.sectioning.value?.match(/entirely/i)) {
      out.push({ field: "cassettes", message: `Cassette piece total (${pieces}) does not match piece count (${pc.value}) — confirm sectioning` });
    }
  }
  if (!narrative.trim()) out.push({ field: "narrative", message: "Narrative is empty" });
  return out;
}

export function fmtDimensions(d: Dimensions | null | undefined): string {
  if (!d) return "—";
  const nums = [d.length, d.width, d.depth].filter((n) => n !== null) as number[];
  if (!nums.length) return "—";
  return `${nums.join(" × ")} ${d.unit ?? "(unit not stated)"}`;
}
