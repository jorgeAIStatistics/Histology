/**
 * Pure display helpers shared by the case read model (server) and the case
 * components (client). No React, no database.
 */
import type { CasePart, TrackStep } from "@/server/queries/case";
import { ROLE_LABEL, rolesFor } from "@/lib/roles";

/** "accession.issued" → "Accession issued"; "related.reviewed" → "Related orders reviewed". Plain words for audit actions. */
export function actionLabel(action: string): string {
  const words = action
    .replace(/^related\./, "related_orders.")
    .split(/[._]/)
    .filter(Boolean)
    .join(" ")
    .replace(/\bgross\b/, "gross record");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** "Left upper back", null, "Shave" → "Left upper back, shave". The side is not repeated when the site already says it. */
export function partDescription(site: string, laterality: string | null, procedure: string | null): string {
  const side = laterality && !site.toLowerCase().includes(laterality.toLowerCase()) ? laterality.toLowerCase() : null;
  return [upperFirst(site), side, procedure ? procedure.charAt(0).toLowerCase() + procedure.slice(1) : null].filter(Boolean).join(", ");
}

/** "Part A: ready for grossing: case issued..." in Part A's own row → "Ready for grossing: case issued...". */
export function readinessLine(text: string, designation: string): string {
  return upperFirst(text.replace(new RegExp(`^Part ${designation}: `), ""));
}

/** One step of a part's physical or documentation rail, as drawn on the case page. */
export type RailState = "done" | "current" | "next" | "todo" | "unknown" | "na";
export interface RailStep {
  key: string;
  label: string;
  state: RailState;
  /** Shown under the label: counts and record state for done and current steps, the hold or problem otherwise. */
  detail: string | null;
  /** Holds (display ids) that stop this step. Never set on a done step. */
  held: string[];
  /** Amber: the source update failed, or the record needs clarification. */
  warning: boolean;
  /** Physical evidence shown in any state ("Loaded on P1"). */
  note: string | null;
  /** Why the step cannot start, when it is not a hold ("Gross record not approved"). Neutral, with a lock and words. */
  blocked: string | null;
}

/** Which rail step each hold transition stops (holds.ts HOLD_TRANSITION_LABEL). Printing labels has no step here. */
const STOPS: Record<"physical" | "documentation", Record<string, string[]>> = {
  physical: { processing: ["processing"], sectioning: ["sectioned"], tray_delivery: ["delivered"] },
  documentation: { gross_approval: ["approved"] },
};

/**
 * The rail for one track: done steps stay quiet, the step in progress is
 * current, and when nothing is in progress the first step not yet reached is
 * next. A step a rule blocks is never next: it keeps its lock and reason, so a
 * track has at most one outlined step and it is one that can actually start.
 * A hold marks the exact steps it stops (all remaining steps for "all").
 * "Source-system update: pending entry" splits into a label and its state.
 */
export function railSteps(steps: TrackStep[], holds: { displayId: string; blocks: string[] }[], track: "physical" | "documentation"): RailStep[] {
  const lastDone = steps.reduce((acc, s, i) => (s.state === "done" ? i : acc), -1);
  const hasCurrent = steps.some((s) => s.state === "current");
  const firstTodo = hasCurrent ? -1 : steps.findIndex((s, i) => i > lastDone && s.state === "todo");
  const nextIdx = firstTodo >= 0 && steps[firstTodo].blocked ? -1 : firstTodo;
  return steps.map((s, i) => {
    const state: RailState = i === nextIdx ? "next" : s.state;
    const held =
      state === "done" || state === "na"
        ? []
        : holds.filter((h) => h.blocks.includes("all") || h.blocks.some((b) => STOPS[track][b]?.includes(s.key))).map((h) => h.displayId);
    let label = s.label;
    let detail = s.detail ?? null;
    const split = /^(Source-system update): (.+)$/.exec(s.label);
    if (split) {
      label = split[1];
      detail = upperFirst(split[2]);
    }
    const warning = (s.key === "source" && /failed/i.test(s.label)) || (s.key === "reviewed" && s.detail === "Needs clarification");
    const shown = state === "done" || state === "current" || warning ? detail : null;
    const open = state !== "done" && state !== "na";
    return { key: s.key, label, state, detail: shown, held, warning, note: s.note ?? null, blocked: open && !held.length ? s.blocked ?? null : null };
  });
}

/** "A", "B", "C" → "A, B and C". */
export function joinWords(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
const partsWord = (letters: string[]) => `${letters.length > 1 ? "Parts" : "Part"} ${joinWords(letters)}`;

type ReadinessPart = Pick<CasePart, "designation" | "status" | "eligible" | "blockedBy" | "holds">;

/**
 * The case's readiness in one line under the focal sentence. Parts that share
 * a reason are named together ("A1, B1 and C1 waiting for ..."), never
 * "(+2 more)". Lines a hold already explains are left to the hold.
 */
export function caseReadiness(parts: ReadinessPart[], isComplete: boolean): string {
  if (isComplete) return "All parts delivered.";
  const ready = new Map<string, string[]>();
  const waits = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, key: string, subject: string) => m.set(key, [...(m.get(key) ?? []), subject]);
  for (const p of parts) {
    if (p.status === "canceled") continue;
    for (const e of p.eligible) {
      let m: RegExpExecArray | null;
      if ((m = /^Part (\w+): ready for grossing$/.exec(e))) add(ready, "grossing", m[1]);
      else if ((m = /^Part (\w+): enter approved gross description in source system/.exec(e))) add(ready, "source", m[1]);
      else if ((m = /^(.+) eligible for the next processing run$/.exec(e))) add(ready, "processing", m[1]);
      else if ((m = /^Sectioning: (.+)$/.exec(e))) add(ready, "sectioning", m[1]);
      else if ((m = /^(\d+) slide\(s\) ready for tray$/.exec(e))) add(ready, "tray", m[1]);
      else add(ready, `\u0000${e}`, e);
    }
    if (p.holds.length) add(waits, `hold:${p.holds.map((h) => h.displayId).join(", ")}`, p.designation);
    for (const b of p.blockedBy) {
      if (/^H-\d+ on /.test(b) || /cannot be approved/.test(b) || /held from processing/.test(b) || /^Sectioning held/.test(b)) continue;
      const m = /^(.+) loaded but not eligible for processing: gross record not approved/.exec(b);
      if (m) add(waits, "approval", m[1]);
      else if (/^Review needed:/.test(b)) add(waits, "review", p.designation);
      else add(waits, `\u0000${b}`, b);
    }
  }
  const readyText = [...ready].map(([k, s]) =>
    k === "grossing" ? `${partsWord(s)} for grossing`
    : k === "source" ? `${partsWord(s)} for source-system entry`
    : k === "processing" ? `${joinWords(s)} for the next processing run`
    : k === "sectioning" ? `sectioning ${joinWords(s)}`
    : k === "tray" ? `${s.reduce((n, x) => n + Number(x), 0)} ${s.reduce((n, x) => n + Number(x), 0) === 1 ? "slide" : "slides"} for a tray`
    : s[0],
  );
  const waitText = [...waits].map(([k, s]) =>
    k.startsWith("hold:") ? `${partsWord(s)} on hold (${k.slice(5)})`
    : k === "approval" ? `${joinWords(s)} waiting for gross record approval before processing (local policy setting)`
    : k === "review" ? `${partsWord(s)}: canceled or amended work to review`
    : s[0],
  );
  const out = [readyText.length ? `Eligible: ${readyText.join("; ")}.` : "", waitText.length ? `Not ready: ${waitText.join("; ")}.` : ""].filter(Boolean).join(" ");
  return out || "No eligible work right now.";
}

/** Where extra work was requested, in words: "Requested on order ORD-75392 v1, part A". */
export function stainSource(authorization: string, sourceReference: string): string {
  if (authorization === "Source order") return `Requested on order ${sourceReference.replace(/\s*\([^)]*requested on order\)$/i, "").replace(/ · /g, ", ")}`;
  if (authorization === "Pathologist request") return sourceReference;
  return `${authorization}: ${sourceReference}`;
}

/** The part's next step, who it waits on, and the link to do it. Read from the open task first, else from the records. */
export interface PartNext {
  action: string;
  /** The person (or unassigned role) it waits on; null when the records name no one. */
  who: string | null;
  /** Why this person, or who else may do it. */
  whoNote: string | null;
  since: string | null;
  /** What waits meanwhile, or what the step does not do. */
  note: string | null;
  href: string | null;
  hrefLabel: string | null;
  /** No task is open for it: the step and its owner come from the gross record. */
  fromRecord: boolean;
}

const OPEN_IN: [RegExp, string][] = [
  [/^\/clarifications/, "Open in Clarify"],
  [/^\/grossing/, "Open in Gross"],
  [/^\/materials/, "Open in Materials"],
  [/^\/intake/, "Open in Intake"],
  [/^\/worklist/, "Open in Worklist"],
];
/** A task title inside its own part's row: without "D26-04817 " in front or " — D26-04817 part A" behind. */
export function taskTitleInPart(title: string, accessionNumber: string, designation: string): string {
  const acc = accessionNumber.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return title.replace(new RegExp(`\\s+—\\s+${acc} part ${designation}$`), "").replace(new RegExp(`^${acc} (?=${designation}\\d)`), "");
}

const openIn = (href: string | null) => (href ? OPEN_IN.find(([re]) => re.test(href))?.[1] ?? "Open" : null);
const MANUAL_ENTRY = "A manual entry in the source system; approval here does not write to it.";

/** Short role words for running text ("supervisor", not "Operations supervisor"). */
const ROLE_WORD: Partial<Record<keyof typeof ROLE_LABEL, string>> = { grosser: "grosser", supervisor: "supervisor", pathologist: "dermatopathologist", histology_assistant: "histology assistant", histotech: "histotech" };
const roleWord = (r: string | null) => (r ? ROLE_WORD[r as keyof typeof ROLE_LABEL] ?? ROLE_LABEL[r as keyof typeof ROLE_LABEL]?.toLowerCase() ?? r.replace(/_/g, " ") : "role unknown");

/**
 * What waits on approval (a cassette loaded but not processed, and why) is said
 * once: on the Processed rail step ("Loaded on P1", lock, "Until approved") and,
 * with the local-policy reason, in the case's readiness line. The next step
 * does not repeat it.
 */
export function partNext(part: Pick<CasePart, "designation" | "status" | "stageLabel" | "eligible" | "blockedBy" | "openTasks" | "gross" | "physical">, accessionNumber: string): PartNext | null {
  if (part.status === "canceled" || part.stageLabel === "Delivered") return null;
  const d = part.designation;
  const t = part.openTasks[0];
  if (t) {
    return {
      action: taskTitleInPart(t.title, accessionNumber, d),
      who: t.ownerName ?? `Unassigned (${roleWord(t.ownerRole)})`,
      whoNote: null,
      since: t.createdAt,
      note: /source system/i.test(t.title) ? MANUAL_ENTRY : null,
      href: t.href,
      hrefLabel: openIn(t.href),
      fromRecord: false,
    };
  }
  const g = part.gross;
  const gross = `/grossing?part=${encodeURIComponent(`${accessionNumber}-${d}`)}`;
  const v = g?.version ? ` v${g.version}` : "";
  const fromRecord = { since: null, href: gross, hrefLabel: "Open in Gross", fromRecord: true } as const;
  if (g?.state === "operator_reviewed") {
    // Who may approve comes from the permission matrix, so the sentence cannot drift from the server rule.
    const roles = rolesFor("gross.approve").map(roleWord);
    const others = roles.filter((r) => r !== "grosser");
    const orList = (xs: string[]) => joinWords(xs).replace(/ and ([^ ]+)$/, " or $1");
    return {
      ...fromRecord,
      action: `Approve gross record${v} for downstream use`,
      who: g.grosserName,
      whoNote: g.grosserName ? `who grossed it${others.length ? ` (or a ${orList(others)})` : ""}` : `any ${orList(roles)} can approve`,
      note: null,
    };
  }
  if (g?.state === "draft" || g?.state === "needs_clarification") {
    return {
      ...fromRecord,
      action: g.state === "draft" ? `Review gross record${v}` : `Resolve the open question on gross record${v}`,
      who: g.grosserName,
      whoNote: g.grosserName ? "who grossed it" : null,
      note: null,
    };
  }
  if (!g && part.eligible.some((e) => /ready for grossing$/.test(e))) {
    return { ...fromRecord, action: `Gross part ${d}`, who: null, whoNote: null, note: null };
  }
  if (g?.state === "approved_for_downstream" && part.eligible.some((e) => /source system/.test(e))) {
    return { ...fromRecord, href: "/grossing?view=source", action: "Enter the approved gross description in the source system", who: null, whoNote: null, note: MANUAL_ENTRY };
  }
  return null;
}

/** Status-column lines not already said by the hold strip, a rail step, the next step or another open task of the part. */
export function partLines(part: Pick<CasePart, "designation" | "explanation"> & Partial<Pick<CasePart, "openTasks">>, heldIds: string[], next: PartNext | null, accessionNumber = ""): string[] {
  const taskTitles = (part.openTasks ?? []).map((t) => taskTitleInPart(t.title, accessionNumber, part.designation));
  return part.explanation.filter((e) => {
    const head = e.split(":")[0];
    if (taskTitles.some((t) => t === head)) return false; // the open task says it, with its owner
    if (e.startsWith("Blocked:") && heldIds.some((id) => e.includes(id))) return false;
    if (/loaded but not eligible for processing/.test(e)) return false; // on the Processed step
    if (next && /ready for grossing/.test(e) && /^Gross part/.test(next.action)) return false;
    if (next && /source system/i.test(e) && /source system/i.test(next.action)) return false;
    if (next && e === "No eligible next step right now.") return false;
    return true;
  });
}

/**
 * The status column's heading names the step the part's next action belongs
 * to, so a documentation action never sits under a physical stage ("Processing"
 * above a source-system entry). The physical position stays on the rail and in
 * the part's other open work.
 */
export function partHeading(stageLabel: string, next: Pick<PartNext, "action"> | null): string {
  if (!next) return stageLabel;
  if (/source system/i.test(next.action) && !/source/i.test(stageLabel)) return "Source-system entry";
  if (/gross record/i.test(next.action) && !/gross/i.test(stageLabel)) return "Gross documentation";
  return stageLabel;
}
