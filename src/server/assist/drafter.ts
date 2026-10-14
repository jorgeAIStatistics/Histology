import type { DB } from "../db/db";
import { getSetting } from "../core/settings";
import { DomainError } from "../core/errors";
import { genericBody } from "../sim/notifications";

/**
 * Deterministic clarification drafting assistant (demo).
 *
 * Inputs: the clarification's category, the structured discrepancy evidence
 * (field, order value, observed value), the part designation and the source
 * order id. It does NOT read free text such as order clinical notes or office
 * answers, and evidence values are quoted as data, never interpreted. It has
 * no tools: it cannot change records, roles or permissions. Its output is a
 * proposal that a person edits/accepts before anything is sent.
 *
 * The drafted QUESTION is meant for the office's secure case view (a future
 * connector; simulated here). It contains no patient details by default:
 * values of identity fields (name, date of birth, MRN) and every value of an
 * identity-conflict question are described as "differs", never quoted. The
 * OUTBOUND notification body stays generic (no patient identifiers).
 */

export const DRAFTER_ID = "deterministic-demo-drafter v1";
export const DRAFTER_LABEL = "Draft text: deterministic demo output, not live AI. Edit before sending.";

export interface DraftEvidence {
  field: string;
  order_value: string | null;
  observed_value: string | null;
  requisition_value?: string | null;
  source?: string | null;
}

export interface DraftInput {
  displayId: string;
  category: string;
  partDesignation: string | null;
  orderRef: string | null;
  accessionNumber: string | null;
  evidence: DraftEvidence[];
  /** Describe every difference without quoting any value (fallback when a value would expose a patient identifier). */
  withholdValues?: boolean;
}

export interface DraftOutput {
  question: string;
  notificationBody: string;
  label: string;
  generator: string;
  basedOn: string[];
}

export function assistantMode(db: DB): "deterministic" | "unavailable" {
  return getSetting(db, "assistant_mode") === "unavailable" ? "unavailable" : "deterministic";
}

export function assertAssistantAvailable(db: DB): void {
  if (assistantMode(db) === "unavailable") {
    throw new DomainError(
      "ASSISTANT_UNAVAILABLE",
      "The drafting assistant is unavailable (simulated outage). Type the question yourself. Sending, follow-up and resolution all work without it.",
    );
  }
}

/**
 * Treat a value strictly as data: strip control characters and bracketed
 * markup, collapse whitespace, cap the length. The result is only ever quoted.
 */
export function quoteValue(v: string | null | undefined, max = 60): string {
  if (v === null || v === undefined) return "(not stated)";
  let s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^<>]{0,40}>/g, " ").replace(/[[\]{}<>]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "(blank)";
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return `"${s}"`;
}

function subjectPhrase(i: DraftInput): string {
  const part = i.partDesignation ? `part ${i.partDesignation}` : "this specimen";
  if (i.orderRef && i.accessionNumber) return `${part} (order ${i.orderRef}, case ${i.accessionNumber})`;
  if (i.orderRef) return `${part} (order ${i.orderRef})`;
  if (i.accessionNumber) return `${part} (case ${i.accessionNumber})`;
  return part;
}

function observedSource(e: DraftEvidence): string {
  const s = (e.source ?? "").toLowerCase();
  if (s.includes("bottle") || s.includes("container")) return "the container label";
  if (s.includes("requisition")) return "the paper requisition";
  if (s.includes("gross")) return "the grossing bench";
  return "what we received";
}

/** Field names come from callers too: treat them as data (no markup, no control characters, short). */
export function cleanFieldName(field: string | null | undefined): string {
  const s = String(field ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^<>]{0,40}>/g, " ").replace(/[[\]{}<>"]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "field";
  return s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s;
}

/** Fields whose values identify the patient. Their values are never quoted in a draft. */
export function isIdentityField(field: string | null | undefined): boolean {
  return /birth|\bdob\b|\bname\b|\bmrn\b|medical record|patient|identifier|\bssn\b/i.test(String(field ?? ""));
}

/** Rows added by the source import to annotate an amendment are not discrepancies to ask about. */
function isAmendmentNote(e: DraftEvidence): boolean {
  return /^source amendment$/i.test(String(e.field ?? "").trim());
}

function comparison(e: DraftEvidence, withhold: boolean): string {
  const field = cleanFieldName(e.field).toLowerCase();
  if (withhold) {
    const src = observedSource(e);
    return `${src[0].toUpperCase()}${src.slice(1)} and the order differ on ${field} (both values are kept in the lab's evidence and not repeated here).`;
  }
  return `The order says ${field} ${quoteValue(e.order_value)}; ${observedSource(e)} says ${quoteValue(e.observed_value)}.`;
}

/** Build the draft from structured evidence only. Pure and deterministic. */
export function draftClarification(input: DraftInput): DraftOutput {
  const subj = subjectPhrase(input);
  const ev = input.evidence.filter((e) => e && e.field && !isAmendmentNote(e));
  const withholdAll = input.withholdValues === true || input.category === "identity_conflict";
  const comparisons = ev
    .slice(0, 3)
    .map((e) => comparison(e, withholdAll || isIdentityField(e.field)))
    .join(" ");
  let question: string;
  switch (input.category) {
    case "laterality":
      question = `Laterality question for ${subj}. ${comparisons || "The side is unclear."} Which side is correct? If the order is wrong, please amend it in your system.`;
      break;
    case "site":
      question = `Site question for ${subj}. ${comparisons || "The exact site is unclear."} Please confirm the exact anatomic site. If the order is wrong, please amend it in your system.`;
      break;
    case "biopsy_method":
      question = `Biopsy method question for ${subj}. ${comparisons || "The method is unclear."} Which method was used (for example shave or punch)?`;
      break;
    case "orientation_marking":
      question = `Orientation or marking question for ${subj}. ${comparisons || "Orientation is not stated."} How is the specimen oriented or marked (suture or ink, and what each marks)?`;
      break;
    case "identity_conflict":
      question = `Identity question for ${subj}. ${comparisons || "Identifiers on the container and the order differ."} Please confirm that the container and the order belong to the same patient before we accession it.`;
      break;
    case "missing_container":
      question = `Container question for ${subj}. ${comparisons || "An expected container was not received."} Was another container collected and sent, and if so when?`;
      break;
    case "related_orders":
      question = `Related orders question for ${subj}. ${comparisons || "Two orders appear to come from the same visit."} Should these parts be handled as one case while keeping each part with its original order?`;
      break;
    default:
      question = `Specimen question for ${subj}. ${comparisons || ""} Please clarify.`.replace(/\s+/g, " ");
  }
  const basedOn = [
    `Category: ${input.category}`,
    ...(input.partDesignation ? [`Part ${input.partDesignation}`] : []),
    ...(input.orderRef ? [`Order ${input.orderRef}`] : []),
    ...ev.map((e) => `Evidence: ${cleanFieldName(e.field)}${withholdAll || isIdentityField(e.field) ? " (values not quoted)" : ""}`),
  ];
  return {
    question: question.replace(/\s+/g, " ").trim(),
    notificationBody: genericBody("initial", input.displayId),
    label: DRAFTER_LABEL,
    generator: DRAFTER_ID,
    basedOn,
  };
}

export const TEMPLATE_LABEL = "Default question from a fixed template (rule-based, not AI). Edit before sending.";

/**
 * Rule-based default question when a caller creates a clarification without
 * one (not AI, not the assistant). While the drafting assistant is switched
 * off, the template does not use the evidence values at all.
 */
export function templateQuestion(input: Omit<DraftInput, "displayId">, opts: { assistantAvailable: boolean }): string {
  return draftClarification({ ...input, displayId: "", evidence: opts.assistantAvailable ? input.evidence : [] }).question;
}
