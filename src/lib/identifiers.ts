/**
 * Demonstration machine-readable identifiers for labels.
 *
 *   HL1:<kind>:<ns>:<accession>[:<part>[:<block>[:<slide>:<stain>]]]:<check>
 *
 * kind: C = case/requisition sticker, B = block/cassette, S = slide.
 * The check character is a weighted mod-36 sum over the body so a mistyped or
 * truncated scan is rejected. This is a DEMO encoding, not a validated scheme;
 * a real deployment must follow the LIS/printer vendor's identifier format.
 */
export type LabelKind = "C" | "B" | "S";

export interface LabelIdentity {
  kind: LabelKind;
  namespace: string; // short code of the accession numbering namespace, e.g. 'EMS'
  accession: string; // 'D26-04817'
  part?: string; // 'A'
  block?: number; // 1
  slide?: number; // 2
  stain?: string; // 'HE', 'PAS'
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function checkChar(body: string): string {
  let sum = 0;
  const s = body.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    sum = (sum + c * (i + 7)) % 36;
  }
  return ALPHABET[sum];
}

export function stainCode(stain: string): string {
  const s = stain.trim().toUpperCase();
  if (s === "H&E" || s === "HE" || s === "H & E") return "HE";
  return s.replace(/[^A-Z0-9]/g, "");
}

export function encodeLabel(id: LabelIdentity): string {
  const parts = ["HL1", id.kind, id.namespace, id.accession];
  if (id.kind === "B" || id.kind === "S") {
    if (!id.part || id.block === undefined) throw new Error("block/slide labels need part and block");
    parts.push(id.part, String(id.block));
  }
  if (id.kind === "S") {
    if (id.slide === undefined || !id.stain) throw new Error("slide labels need slide number and stain");
    parts.push(String(id.slide), stainCode(id.stain));
  }
  const body = parts.join(":");
  return `${body}:${checkChar(body)}`;
}

export type DecodeResult = { ok: true; identity: LabelIdentity; payload: string } | { ok: false; reason: string; payload: string };

export function decodeLabel(raw: string): DecodeResult {
  const payload = raw.trim().toUpperCase();
  const fields = payload.split(":");
  if (fields[0] !== "HL1") return { ok: false, reason: "Not a Histology Lab OS demo label", payload };
  const check = fields.pop()!;
  const body = fields.join(":");
  if (checkChar(body) !== check) return { ok: false, reason: "Check character mismatch (misread or damaged label)", payload };
  const [, kind, namespace, accession, part, block, slide, stain] = fields;
  if (kind === "C" && fields.length === 4) return { ok: true, payload, identity: { kind: "C", namespace, accession } };
  if (kind === "B" && fields.length === 6 && /^\d+$/.test(block))
    return { ok: true, payload, identity: { kind: "B", namespace, accession, part, block: Number(block) } };
  if (kind === "S" && fields.length === 8 && /^\d+$/.test(block) && /^\d+$/.test(slide))
    return { ok: true, payload, identity: { kind: "S", namespace, accession, part, block: Number(block), slide: Number(slide), stain } };
  return { ok: false, reason: "Malformed label structure", payload };
}

/** Human-readable text printed next to the code. */
export function humanLabel(id: LabelIdentity): string {
  if (id.kind === "C") return id.accession;
  if (id.kind === "B") return `${id.accession} ${id.part}${id.block}`;
  return `${id.accession} ${id.part}${id.block}-${id.slide} ${id.stain === "HE" ? "H&E" : id.stain}`;
}

export const NAMESPACE_CODES: Record<string, string> = {
  "EMA-SIM DERM": "EMS",
};

export function namespaceCode(ns: string): string {
  return NAMESPACE_CODES[ns] ?? ns.replace(/[^A-Z]/gi, "").slice(0, 3).toUpperCase();
}
