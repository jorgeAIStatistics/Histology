import type { Stage } from "@/lib/domain";
import { LAB_TZ } from "@/lib/time";

/** "Wed 2026-10-14 10:52 AM ET" — unambiguous day and time for printed snapshot headers. */
export function fmtSnapshotTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown time";
  const d = new Date(iso);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: LAB_TZ, weekday: "short" }).format(d);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: LAB_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: LAB_TZ, hour: "numeric", minute: "2-digit" }).format(d);
  return `${weekday} ${day} ${time} ET`;
}

const PART_WORD_LABEL: Record<string, string> = { hold: "on hold", "gross record": "gross in progress" };
/** A part that can move now names the step it is ready for ("A ready for processing"), never a bare "ready". */
const PART_STAGE_WORD: Partial<Record<Stage, string>> = {
  processing: "ready for processing", embedding: "ready for embedding", sectioning: "ready for sectioning", staining: "ready for staining", qc: "ready for QC", ready_for_tray: "ready for tray",
};

/** The words shown for one part ("awaiting gross", "on hold", "ready for processing"). */
export function partWord(p: { word: string; stage: Stage }): string {
  if (p.word === "ready") return PART_STAGE_WORD[p.stage] ?? "ready";
  return PART_WORD_LABEL[p.word] ?? p.word;
}

/** Parts grouped so equal states read once: "A, B, C awaiting gross" or "A ready for processing · B on hold". */
export function groupParts(parts: { word: string; stage: Stage; designation: string }[]): { word: string; hold: boolean; letters: string[] }[] {
  const groups: { word: string; hold: boolean; letters: string[] }[] = [];
  for (const p of parts) {
    const word = partWord(p);
    const last = groups[groups.length - 1];
    if (last && last.word === word) last.letters.push(p.designation);
    else groups.push({ word, hold: p.word === "hold", letters: [p.designation] });
  }
  return groups;
}

/** One line for titles, print and CSV: "A, B awaiting gross · C on hold". */
export function partsText(parts: { word: string; stage: Stage; designation: string }[]): string {
  return groupParts(parts).map((g) => `${g.letters.join(", ")} ${g.word}`).join(" · ");
}

/** "1 part", "3 parts"; pass the plural when it is not just +s ("1 case", "2 cases"). Never "part(s)". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Text written by other modules sometimes says "2 part(s)". Shown text never does: "1 part", "2 parts".
 * Only the simple "+s" case is rewritten; anything else is left as written.
 */
export function tidyPlurals(text: string): string {
  return text.replace(/\b(\d+) ([A-Za-z]+)\(s\)/g, (_m, n: string, word: string) => `${n} ${n === "1" ? word : `${word}s`}`);
}
