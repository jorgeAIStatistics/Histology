/**
 * Deterministic demo extractor for synthetic grossing dictation.
 *
 * Bounded assistant: input = transcript text (+ the part's identity for
 * comparison); output = PROPOSED structured values, each with the exact
 * transcript span it came from, or a reason it needs review / is missing.
 * It never confirms anything, never fills a template default as observed,
 * never converts units, never invents a value it did not read, and never
 * acts on text inside the transcript (transcript text is data).
 *
 * This is pattern matching, not live AI. Pure function: no database access,
 * no network, same input -> same output.
 */
import type { CassetteAllocation, Dimensions, DimensionUnit, Evidence, FieldStatus, GrossFields, GrossValue } from "@/lib/gross";

export const EXTRACTOR_NAME = "deterministic-demo-extractor v1";

export type GrossFieldKey = Exclude<keyof GrossFields, "template_id">;

export const GROSS_FIELD_KEYS: GrossFieldKey[] = [
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

/**
 * Why a value needs review (machine-readable twin of `note`). The server uses it to decide
 * whether an operator's confirmation actually addressed the uncertainty: e.g. choosing a unit
 * resolves "unit_missing" but not "possible_missed_decimal".
 */
export type ReviewReason =
  | "unit_missing"
  | "mixed_units"
  | "ambiguous_number"
  | "possible_missed_decimal"
  | "extra_numbers"
  | "multiple_measurements"
  | "count_conflict"
  | "type_differs_from_order"
  | "label_site_differs"
  | "cassette_part_mismatch"
  | "cassette_range_spans_parts"
  | "cassette_pieces_unclear"
  | "unspecified";

/** A stored field value with provenance (extends the shared GrossValue shape). */
export type StoredValue<T> = GrossValue<T> & {
  origin?: "transcript" | "typed" | null;
  /** What the transcript (or typing) originally proposed, kept after confirmation. */
  proposedValue?: T | null;
  /** Codes for a needs_review status (see ReviewReason). */
  reviewReasons?: ReviewReason[] | null;
  /** Set when the operator kept a needs-review value as dictated after checking the specimen. */
  reviewAcknowledged?: { reasons: ReviewReason[]; note: string | null; by: string; byName: string; at: string } | null;
  confirmedBy?: string | null;
  confirmedByName?: string | null;
  confirmedAt?: string | null;
};

interface Issue {
  code: ReviewReason;
  text: string;
}

export type ExtractedFields = { [K in GrossFieldKey]: StoredValue<NonNullable<GrossFields[K]["value"]>> };

export interface ProposalRecord {
  field: GrossFieldKey;
  value: unknown;
  status: FieldStatus;
  evidence: Evidence | null;
  note: string | null;
}

export interface ExtractionResult {
  extractor: string;
  fields: ExtractedFields;
  proposals: ProposalRecord[];
  unresolved: { field: GrossFieldKey | "transcript"; message: string }[];
  /** Sentences that read like instructions. Recorded as data and ignored. */
  ignoredInstructions: Evidence[];
  counts: { proposed: number; needsReview: number; missing: number };
}

export interface ExtractOptions {
  /** Part letter the transcript was attached to (checks cassette labels). */
  partDesignation?: string | null;
  /** Part site as issued (compared with the dictated container label). */
  partSite?: string | null;
  /** Procedure on the order (compared with the dictated specimen type). */
  orderProcedure?: string | null;
}

// ------------------------------------------------------------------ text helpers

interface Span {
  text: string;
  start: number;
  end: number;
}

interface Tok extends Span {
  lower: string;
}

function ev(text: string, start: number, end: number): Evidence {
  return { text: text.slice(start, end), start, end, source: "transcript" };
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /\d*\.\d+|\d+|[A-Za-z]+(?:['’-][A-Za-z]+)*|×|[^\s]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], lower: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

/** Sentences with offsets. A period followed by a digit (0.8) does not end a sentence. */
function sentences(text: string): Span[] {
  const out: Span[] = [];
  const re = /(?:[^.!?;]|\.(?=\d))+[.!?;]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body) out.push({ text: body, start: m.index + lead, end: m.index + lead + body.length });
  }
  return out;
}

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const DIGIT_WORD: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

interface NumParse {
  value: number | null;
  start: number;
  end: number;
  next: number;
  decimal: boolean;
  ambiguous?: string;
}

function decimalDigits(toks: Tok[], j: number): { digits: string; next: number; end: number } | null {
  let digits = "";
  let k = j;
  let end = -1;
  while (k < toks.length) {
    const t = toks[k];
    if (/^\d+$/.test(t.text) && digits === "") {
      digits = t.text;
      end = t.end;
      k++;
      break;
    }
    const d = t.lower === "oh" && digits === "" ? null : DIGIT_WORD[t.lower];
    if (d === undefined || d === null) break;
    digits += d;
    end = t.end;
    k++;
  }
  return digits ? { digits, next: k, end } : null;
}

function parseNumber(toks: Tok[], i: number): NumParse | null {
  const t = toks[i];
  if (!t) return null;
  if (/^\d*\.\d+$|^\d+$/.test(t.text)) {
    const n = toks[i + 1];
    if (/^\d$/.test(t.text) && n && /^\d+$/.test(n.text) && n.start - t.end <= 1) {
      return {
        value: null, start: t.start, end: n.end, next: i + 2, decimal: false,
        ambiguous: `"${t.text} ${n.text}" could be ${t.text}.${n.text} or ${t.text}${n.text}`,
      };
    }
    return { value: Number(t.text.startsWith(".") ? `0${t.text}` : t.text), start: t.start, end: t.end, next: i + 1, decimal: t.text.includes(".") };
  }
  if (t.lower === "point") {
    const d = decimalDigits(toks, i + 1);
    if (!d) return null;
    return { value: Number(`0.${d.digits}`), start: t.start, end: d.end, next: d.next, decimal: true };
  }
  if (t.lower in ONES || t.lower in TENS) {
    let int = ONES[t.lower] ?? TENS[t.lower];
    let j = i + 1;
    let end = t.end;
    if (t.lower in TENS && toks[j] && ONES[toks[j].lower] !== undefined && ONES[toks[j].lower] < 10) {
      int += ONES[toks[j].lower];
      end = toks[j].end;
      j++;
    }
    if (toks[j]?.lower === "point") {
      const d = decimalDigits(toks, j + 1);
      if (d) return { value: Number(`${int}.${d.digits}`), start: t.start, end: d.end, next: d.next, decimal: true };
    }
    const n = toks[j];
    if (int < 10 && n && ONES[n.lower] !== undefined && ONES[n.lower] < 10) {
      return {
        value: null, start: t.start, end: n.end, next: j + 1, decimal: false,
        ambiguous: `"${t.text} ${n.text}" could be ${int}.${ONES[n.lower]} or ${int}${ONES[n.lower]}`,
      };
    }
    return { value: int, start: t.start, end, next: j, decimal: false };
  }
  return null;
}

function parseUnit(toks: Tok[], i: number): { unit: DimensionUnit; next: number; end: number } | null {
  const t = toks[i];
  if (!t) return null;
  if (/^(cm|centimet(?:er|re)s?)$/.test(t.lower)) return { unit: "cm", next: i + 1, end: t.end };
  if (/^(mm|millimet(?:er|re)s?)$/.test(t.lower)) return { unit: "mm", next: i + 1, end: t.end };
  return null;
}

const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, single: 1, "a single": 1,
};
const NUMW = "(?:\\d+|a single|single|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const VAGUE = "(?:a couple of|a couple|couple of|a few|several|multiple|numerous|some|many|various)";
const NOUN =
  "(?:nail clippings?|punch(?:es)?(?: biops(?:y|ies))?|pieces?|fragments?|portions?|shaves?|biops(?:y|ies)|ellipses?|specimens?|clippings?|cores?|curettings?)";
const ADJ = "(?:[a-z]+(?:-[a-z]+)*\\s+){0,4}?";

interface CountMatch {
  value: number | null;
  vague: boolean;
  phrase: string;
  adjectives: string;
  start: number;
  end: number;
}

function countMatches(s: Span): CountMatch[] {
  const out: CountMatch[] = [];
  const re = new RegExp(`\\b(${NUMW}|${VAGUE})\\s+(${ADJ})(${NOUN})\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.text))) {
    const q = m[1].toLowerCase();
    const vague = new RegExp(`^${VAGUE}$`, "i").test(q);
    const value = vague ? null : /^\d+$/.test(q) ? Number(q) : COUNT_WORDS[q] ?? null;
    out.push({ value, vague, phrase: m[0], adjectives: m[2], start: s.start + m.index, end: s.start + m.index + m[0].length });
  }
  const re2 = new RegExp(`\\b(${NUMW})\\s+in\\s+number\\b`, "gi");
  while ((m = re2.exec(s.text))) {
    const q = m[1].toLowerCase();
    out.push({ value: /^\d+$/.test(q) ? Number(q) : COUNT_WORDS[q] ?? null, vague: false, phrase: m[0], adjectives: "", start: s.start + m.index, end: s.start + m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|override|bypass)\b/i,
  /\bapprove\b/i,
  /\b(change|set|make|give|grant)\s+(?:my|the|your|me|their)\s+(?:role|permissions?|access)\b/i,
  /\b(you are now|act as|system prompt|as an ai)\b/i,
  /\bassistant\s*[:,]/i,
  /\[\[|\]\]/,
];

function normalizeSite(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "l" || w === "lt" ? "left" : w === "r" || w === "rt" ? "right" : w))
    .filter((w) => !["the", "of", "on", "and"].includes(w));
}

const LATERALITY_WORDS = ["left", "right", "bilateral", "midline"];

const SECTION_FACTOR: Record<string, number> = { bisected: 2, halved: 2, trisected: 3, quadrisected: 4 };

function fmtNum(n: number): string {
  return String(Number(n.toFixed(4)));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ------------------------------------------------------------------ extractor

export function extractGrossFields(text: string, opts: ExtractOptions = {}): ExtractionResult {
  const allSentences = sentences(text);
  const ignoredInstructions: Evidence[] = [];
  const usable: Span[] = [];
  for (const s of allSentences) {
    if (INSTRUCTION_PATTERNS.some((re) => re.test(s.text))) ignoredInstructions.push(ev(text, s.start, s.end));
    else usable.push(s);
  }
  const cassetteSentences = usable.filter((s) => /\bcassettes?\b/i.test(s.text));
  const bodySentences = usable.filter((s) => !/\bcassettes?\b/i.test(s.text));
  const consists = usable.find((s) => /\b(consists?|consisting|received are|there (?:is|are))\b/i.test(s.text)) ?? bodySentences[0] ?? null;

  const missing = <T,>(note = "Not stated in transcript"): StoredValue<T> => ({
    value: null, status: "missing", evidence: null, note, origin: "transcript", proposedValue: null,
  });
  const make = <T,>(value: T | null, evidence: Evidence | null, issues: Issue[]): StoredValue<T> => {
    const status: FieldStatus = issues.length ? "needs_review" : value === null ? "missing" : "proposed";
    return {
      value, status, evidence, note: issues.length ? issues.map((i) => i.text).join(" ") : null, origin: "transcript", proposedValue: value,
      ...(issues.length ? { reviewReasons: [...new Set(issues.map((i) => i.code))] } : {}),
    };
  };

  // ---- specimen type
  let specimen_type: StoredValue<string> = missing<string>();
  {
    const scope = consists ? [consists, ...usable.filter((s) => s !== consists)] : usable;
    for (const s of scope) {
      const m = /\b(nail clippings?|shave|punch|ellipse|excision|curettings?|curettage)\b/i.exec(s.text);
      if (!m) continue;
      const w = m[1].toLowerCase();
      const value = w.startsWith("nail") ? "nail_clipping" : w === "ellipse" || w === "excision" ? "excision" : w.startsWith("curett") ? "curettage" : w;
      const notes: Issue[] = [];
      if (opts.orderProcedure && opts.orderProcedure !== "not_stated" && opts.orderProcedure !== value) {
        notes.push({
          code: "type_differs_from_order",
          text: `Transcript describes "${m[1]}"; the order says ${opts.orderProcedure.replace("_", " ")}. Confirm the observed specimen type (nothing is corrected automatically).`,
        });
      }
      specimen_type = make(value, ev(text, s.start + m.index, s.start + m.index + m[0].length), notes);
      break;
    }
  }

  // ---- received in
  let received_in: StoredValue<string> = missing<string>("Fixative / transport medium not stated in transcript");
  for (const s of usable) {
    const m = /\breceived\s+(?:in\s+)?(formalin|fresh|saline|michel'?s(?:\s+medium)?)\b/i.exec(s.text);
    if (m) {
      received_in = make(m[1].toLowerCase(), ev(text, s.start + m.index, s.start + m.index + m[0].length), []);
      break;
    }
  }

  // ---- container label vs part
  let container_label_matches: StoredValue<boolean> = missing<boolean>(
    "Container label not read aloud in transcript. Compare the container label with the part and confirm.",
  );
  {
    const m = /\blabeled\s+with\s+([^.;]+)/i.exec(text);
    if (m) {
      const evd = ev(text, m.index, m.index + m[0].length);
      const content = m[1];
      const siteMatch = /\band\s+(.+)$/i.exec(content);
      const dictatedSite = siteMatch ? siteMatch[1].trim() : null;
      if (!dictatedSite) {
        container_label_matches = {
          value: null, status: "missing", evidence: evd, origin: "transcript", proposedValue: null,
          note: "Label read aloud without a site. Compare the container label with the part and confirm.",
        };
      } else if (!opts.partSite) {
        container_label_matches = {
          value: null, status: "missing", evidence: evd, origin: "transcript", proposedValue: null,
          note: `Label read aloud as "${dictatedSite}". Compare with the part and confirm.`,
        };
      } else {
        const a = normalizeSite(dictatedSite);
        const b = normalizeSite(opts.partSite);
        const latA = a.find((w) => LATERALITY_WORDS.includes(w));
        const latB = b.find((w) => LATERALITY_WORDS.includes(w));
        const sameWords = a.length === b.length && a.every((w) => b.includes(w));
        if (sameWords) {
          container_label_matches = {
            value: true, status: "proposed", evidence: evd, origin: "transcript", proposedValue: true,
            note: `Dictated label site "${dictatedSite}" matches the part site text. Confirm against the physical container.`,
          };
        } else {
          const lat = latA && latB && latA !== latB ? ` Laterality differs (${latA} vs ${latB}).` : "";
          container_label_matches = {
            value: null, status: "needs_review", evidence: evd, origin: "transcript", proposedValue: null, reviewReasons: ["label_site_differs"],
            note: `Dictated label site "${dictatedSite}" differs from the part site "${opts.partSite}".${lat} Check the physical container; the part site is not changed here.`,
          };
        }
      }
    }
  }

  // ---- piece count (outside cassette sentences)
  let piece_count: StoredValue<number> = missing<number>("Piece count not stated in transcript");
  let appearanceFromCount: { text: string; start: number; end: number } | null = null;
  {
    const scope = consists ? [consists, ...bodySentences.filter((s) => s !== consists)] : bodySentences;
    const matches = scope.flatMap((s) => countMatches(s));
    if (matches.length) {
      const first = matches[0];
      const evd = ev(text, first.start, first.end);
      const colorM = /\b((?:tan|pink|white|brown|gray|grey|yellow|red|purple|black)(?:-(?:tan|pink|white|brown|gray|grey|yellow|red|purple|black))*)\b/i.exec(first.adjectives);
      if (colorM) {
        const adjStart = first.start + first.phrase.indexOf(first.adjectives);
        appearanceFromCount = { text: colorM[1], start: adjStart + colorM.index, end: adjStart + colorM.index + colorM[1].length };
      }
      if (first.vague || first.value === null) {
        piece_count = {
          value: null, status: "missing", evidence: evd, origin: "transcript", proposedValue: null,
          note: `Dictation says "${first.phrase}": count not stated. Count the pieces and enter the number.`,
        };
      } else {
        const notes: Issue[] = [];
        const others = matches.slice(1).filter((m) => !m.vague && m.value !== null && m.value !== first.value);
        if (others.length) notes.push({ code: "count_conflict", text: `Transcript gives different counts ("${first.phrase}" and "${others[0].phrase}"). Confirm the piece count.` });
        piece_count = make(first.value, evd, notes);
      }
    }
  }

  // ---- dimensions
  let dimensions: StoredValue<Dimensions> = missing<Dimensions>("Dimensions not stated in transcript");
  {
    const toks = tokenize(text);
    const measuring = toks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => /^measur/.test(t.lower) && !ignoredInstructions.some((e) => t.start >= e.start && t.start < e.end));
    if (measuring.length) {
      const { t: mt, i: mi } = measuring[0];
      let j = mi + 1;
      while (toks[j] && ["in", "aggregate", "approximately", "about", "up", "to", "overall", "roughly"].includes(toks[j].lower)) j++;
      const nums: NumParse[] = [];
      const units: DimensionUnit[] = [];
      let lastEnd = mt.end;
      while (j < toks.length && nums.length < 4) {
        const n = parseNumber(toks, j);
        if (!n) break;
        nums.push(n);
        lastEnd = n.end;
        j = n.next;
        const u = parseUnit(toks, j);
        if (u) {
          units.push(u.unit);
          lastEnd = u.end;
          j = u.next;
        }
        if (toks[j] && ["by", "x", "×"].includes(toks[j].lower)) {
          j++;
          continue;
        }
        break;
      }
      if (!nums.length) {
        dimensions = { value: null, status: "missing", evidence: ev(text, mt.start, mt.end), note: "\"measuring\" was dictated but no number followed", origin: "transcript", proposedValue: null };
      } else {
        const notes: Issue[] = [];
        const distinctUnits = [...new Set(units)];
        let unit: DimensionUnit | null = null;
        if (distinctUnits.length === 1) unit = distinctUnits[0];
        else if (distinctUnits.length > 1) notes.push({ code: "mixed_units", text: "Mixed units dictated (cm and mm). Confirm each dimension and one unit." });
        else notes.push({ code: "unit_missing", text: "Unit not stated in transcript. Choose cm or mm; no unit is assumed." });
        for (const n of nums) if (n.ambiguous) notes.push({ code: "ambiguous_number", text: `Ambiguous number: ${n.ambiguous}.` });
        const hasSmallDecimal = nums.some((n) => n.decimal && n.value !== null && n.value < 1);
        for (const n of nums) {
          if (!n.decimal && n.value !== null && n.value >= 1 && hasSmallDecimal) {
            notes.push({ code: "possible_missed_decimal", text: `Possible missed decimal: ${fmtNum(n.value)} vs ${fmtNum(n.value / 10)}.` });
          }
        }
        if (nums.length > 3) notes.push({ code: "extra_numbers", text: "More than three numbers dictated; only the first three are proposed." });
        const first = nums[0];
        const raw = text.slice(first.start, lastEnd);
        const value: Dimensions = {
          length: nums[0]?.value ?? null,
          width: nums[1]?.value ?? null,
          depth: nums[2]?.value ?? null,
          unit,
          raw,
        };
        const extra: Issue[] = measuring.length > 1 ? [{ code: "multiple_measurements", text: "More than one measurement was dictated; the first is proposed." }] : [];
        dimensions = make(value, ev(text, mt.start, lastEnd), [...notes, ...extra]);
      }
    }
  }

  // ---- appearance (optional)
  let appearance: StoredValue<string> = missing<string>();
  if (appearanceFromCount) {
    appearance = make(appearanceFromCount.text.toLowerCase(), ev(text, appearanceFromCount.start, appearanceFromCount.end), []);
  }

  // ---- ink / orientation (optional)
  let ink_orientation: StoredValue<string> = missing<string>("Ink or orientation not stated in transcript");
  {
    const hits = usable.filter((s) => /\b(ink(?:ed)?|suture|stitch|orient(?:ed|ation)|o'clock)\b/i.test(s.text) && !/\bcassettes?\b/i.test(s.text));
    if (hits.length) {
      const value = hits
        .map((s, i) => {
          const t = s.text.replace(/[.;]+$/, "");
          return i === 0 ? t : t.charAt(0).toLowerCase() + t.slice(1);
        })
        .join("; ");
      ink_orientation = make(value, ev(text, hits[0].start, hits[hits.length - 1].end), []);
    }
  }

  // ---- sectioning
  let sectioning: StoredValue<string> = missing<string>("Sectioning not stated in transcript");
  /** Cut pieces per specimen piece implied by the dictated sectioning (bisected = 2, trisected = 3...), or null. */
  let sectionFactor: { factor: number; phrase: string } | null = null;
  {
    const found: { phrase: string; start: number; end: number }[] = [];
    for (const s of usable) {
      const re = /\b(bisected|trisected|quadrisected|serially sectioned|submitted entirely|entirely submitted|submitted in toto|representative sections?|after softening|halved)\b/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s.text))) found.push({ phrase: m[1].toLowerCase(), start: s.start + m.index, end: s.start + m.index + m[0].length });
    }
    if (found.length) {
      const phrases = [...new Set(found.map((f) => (f.phrase === "entirely submitted" || f.phrase === "submitted in toto" ? "submitted entirely" : f.phrase)))];
      const cut = phrases.find((p) => p in SECTION_FACTOR);
      if (cut) sectionFactor = { factor: SECTION_FACTOR[cut], phrase: cut };
      const main = phrases.filter((p) => p !== "after softening");
      let value = main.join(" and ");
      if (phrases.includes("after softening")) value = `${value} after softening`.trim();
      value = value.charAt(0).toUpperCase() + value.slice(1);
      sectioning = make(value, ev(text, found[0].start, found[found.length - 1].end), []);
    }
  }

  // ---- cassette allocation
  let cassettes: StoredValue<CassetteAllocation[]> = missing<CassetteAllocation[]>("Cassette allocation not stated in transcript");
  let cassettePieces: { value: number; phrase: string } | null = null;
  if (cassetteSentences.length) {
    const labels: string[] = [];
    const notes: Issue[] = [];
    let description = "";
    for (const s of cassetteSentences) {
      const covered: [number, number][] = [];
      const range = /\b([A-Z])(\d{1,2})\s*(?:through|thru|to|-|–)\s*([A-Z])?(\d{1,2})\b/g;
      let m: RegExpExecArray | null;
      while ((m = range.exec(s.text))) {
        const letter = m[1];
        if (m[3] && m[3] !== letter) notes.push({ code: "cassette_range_spans_parts", text: `Cassette range "${m[0]}" spans two part letters.` });
        const from = Number(m[2]);
        const to = Number(m[4]);
        if (to >= from && to - from < 20) for (let k = from; k <= to; k++) labels.push(`${letter}${k}`);
        covered.push([m.index, m.index + m[0].length]);
      }
      const single = /\b([A-Z])(\d{1,2})\b/g;
      while ((m = single.exec(s.text))) {
        const idx = m.index;
        if (covered.some(([a, b]) => idx >= a && idx < b)) continue;
        labels.push(`${m[1]}${m[2]}`);
      }
      if (!description) {
        description = s.text
          .replace(/\s*\bin\s+cassettes?\s+[A-Z]\d{1,2}(?:\s*(?:through|thru|to|-|–|and|,)\s*[A-Z]?\d{1,2})*/i, "")
          .replace(/,\s*\S+\s+(?:pieces?|fragments?)\b/i, "")
          .replace(/[.;]+$/, "")
          .trim();
        description = description.charAt(0).toLowerCase() + description.slice(1);
      }
      const cm = countMatches(s).filter((c) => !c.vague && c.value !== null);
      if (cm.length && !cassettePieces) cassettePieces = { value: cm[0].value!, phrase: cm[0].phrase };
    }
    const unique = [...new Set(labels)];
    if (unique.length) {
      if (opts.partDesignation) {
        const wrong = unique.filter((l) => l[0] !== opts.partDesignation);
        if (wrong.length) notes.push({ code: "cassette_part_mismatch", text: `Cassette label ${wrong.join(", ")} does not match part ${opts.partDesignation}. Confirm the cassette labels.` });
      }
      const pieces = cassettePieces && unique.length === 1 ? cassettePieces.value : null;
      if (cassettePieces && unique.length > 1) notes.push({ code: "cassette_pieces_unclear", text: `Dictated "${cassettePieces.phrase}" but it is not clear which cassette it refers to.` });
      const value: CassetteAllocation[] = unique.map((label) => ({ label, pieces, description }));
      const first = cassetteSentences[0];
      const last = cassetteSentences[cassetteSentences.length - 1];
      cassettes = make(value, ev(text, first.start, last.end), notes);
    } else {
      cassettes = {
        value: null, status: "missing", evidence: ev(text, cassetteSentences[0].start, cassetteSentences[0].end), origin: "transcript", proposedValue: null,
        note: "A cassette was mentioned but no cassette label (for example A1) could be read.",
      };
    }
  }

  // ---- cross-field check: piece count vs cassette pieces
  if (cassettePieces && piece_count.value !== null && cassettePieces.value !== piece_count.value) {
    const explained = sectionFactor && cassettePieces.value === piece_count.value * sectionFactor.factor && cassettes.value?.length === 1;
    if (explained && cassettes.value) {
      // "One shave, trisected ... three pieces in A1": the cut pieces are explained by the dictated sectioning, not a conflict.
      // The cassette "pieces" field counts specimen pieces, so the dictated cut pieces are kept in the cassette contents instead.
      const cutNote = `Dictated "${cassettePieces.phrase}" in ${cassettes.value[0].label} after the ${piece_count.value === 1 ? "piece was" : "pieces were"} ${sectionFactor!.phrase}: kept in the cassette contents. Specimen pieces in the cassette are left for you to enter.`;
      const cut = `${cassettePieces.phrase} (${sectionFactor!.phrase})`;
      const value = cassettes.value.map((c) => ({ ...c, pieces: null, description: [c.description, cut].filter(Boolean).join("; ") }));
      cassettes = { ...cassettes, value, proposedValue: value, note: [cassettes.note, cutNote].filter(Boolean).join(" ") };
    } else {
      const msg = `Transcript gives ${piece_count.value} piece(s) ("${piece_count.evidence?.text ?? ""}") but the cassette is dictated with "${cassettePieces.phrase}". Confirm the piece count and the cassette contents.`;
      const addReason = (r: ReviewReason[] | null | undefined): ReviewReason[] => [...new Set([...(r ?? []), "count_conflict" as const])];
      piece_count = { ...piece_count, status: "needs_review", note: [piece_count.note, msg].filter(Boolean).join(" "), reviewReasons: addReason(piece_count.reviewReasons) };
      if (cassettes.value) cassettes = { ...cassettes, status: "needs_review", note: [cassettes.note, msg].filter(Boolean).join(" "), reviewReasons: addReason(cassettes.reviewReasons) };
    }
  }

  const fields: ExtractedFields = {
    specimen_type,
    received_in,
    container_label_matches,
    piece_count,
    dimensions,
    appearance,
    ink_orientation,
    sectioning,
    cassettes,
  };

  const proposals: ProposalRecord[] = GROSS_FIELD_KEYS.map((k) => {
    const f = fields[k] as StoredValue<unknown>;
    return { field: k, value: f.value, status: f.status, evidence: f.evidence ?? null, note: f.note ?? null };
  });
  const unresolved: ExtractionResult["unresolved"] = [];
  for (const p of proposals) {
    if (p.status === "needs_review" || p.status === "missing") unresolved.push({ field: p.field, message: p.note ?? "Not stated in transcript" });
  }
  for (const i of ignoredInstructions) {
    unresolved.push({ field: "transcript", message: `Instruction-like text was treated as dictation data and ignored: "${i.text}"` });
  }
  const counts = {
    proposed: proposals.filter((p) => p.status === "proposed").length,
    needsReview: proposals.filter((p) => p.status === "needs_review").length,
    missing: proposals.filter((p) => p.status === "missing").length,
  };
  return { extractor: EXTRACTOR_NAME, fields, proposals, unresolved, ignoredInstructions, counts };
}

/** True if two stored values carry the same value (used when merging a new transcript over confirmed values). */
export function sameValue(a: unknown, b: unknown): boolean {
  return same(a, b);
}
