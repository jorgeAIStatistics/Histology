/**
 * Concept A: pure derivations from the intake read model (no I/O, no writes).
 * Everything here turns ItemDetail / QueueItem into plain words and states the
 * screen shows. Nothing is hardcoded for the hero item.
 */
import type { BenchPermissions, ContainerView, HoldView, ItemDetail, RelatedView } from "@/server/queries/intake";
import { RELATED_STATUS } from "@/lib/domain";
import { fmtTime } from "@/lib/time";

export type CompareRow = ContainerView["comparison"][number];
export type SourceKey = "order" | "observed" | "requisition";

/** A run of text where identifiers are kept apart so they can be set in mono. */
export type Seg = string | { id: string };

export const SOURCE_WORD: Record<SourceKey, string> = { order: "order", observed: "bottle", requisition: "requisition" };

const SHORT_FIELD: Record<string, string> = {
  patient_name: "patient name",
  birth_date: "date of birth",
  mrn: "MRN",
  site: "site",
  laterality: "laterality",
  procedure: "procedure",
  part_designation: "part designation",
  collection_date: "collection date",
};

export const HOLD_BLOCK_LABEL: Record<string, string> = {
  accession_request: "Accession request",
  gross_approval: "Gross approval",
  processing: "Processing",
  print: "Label printing",
  tray_delivery: "Tray delivery",
};

const ID_RE = /\b((?:INT|ORD|CLR|REL|H|CR|ENC|REQ-SIM-ORD|D\d{2})-[0-9A-Z-]+|LSC-\d+)\b/g;

/** Split free text into segments, marking identifiers (INT-, ORD-, CLR-, REL-, H-...) for mono. */
export function segs(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(ID_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push({ id: m[1] });
    last = i + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The value as the sentence should say it: plain words for sides and methods, quoted originals otherwise. */
function spoken(row: CompareRow, key: SourceKey): string {
  const c = row[key];
  if (row.field === "laterality" || row.field === "procedure") return c.normalized ?? "nothing";
  return c.original ? `“${c.original}”` : "nothing";
}

/** One plain sentence for a differing comparison row. */
export function differSentence(row: CompareRow): string {
  const keys: SourceKey[] = ["order", "observed", "requisition"];
  const stated = keys.filter((k) => row[k].normalized !== null);
  const groups = new Map<string, SourceKey[]>();
  for (const k of stated) {
    const v = row[k].normalized as string;
    groups.set(v, [...(groups.get(v) ?? []), k]);
  }
  const label = cap(SHORT_FIELD[row.field] ?? row.label);
  if (groups.size < 2) return row.note ? `${label}: ${row.note.replace(/\.$/, "")}.` : `${label} differs between sources.`;
  const g = [...groups.values()].sort((a, b) => a.length - b.length);
  if (g.length === 2 && g[0].length === 1 && g[1].length === 2) {
    const odd = g[0][0];
    const [m1, m2] = g[1];
    return `${label} differs: the ${SOURCE_WORD[odd]} says ${spoken(row, odd)}, while the ${SOURCE_WORD[m1]} and the ${SOURCE_WORD[m2]} say ${spoken(row, m1)}.`;
  }
  if (g.length === 2) {
    const a = g[0][0];
    const b = g[1][0];
    return `${label} differs: the ${SOURCE_WORD[a]} says ${spoken(row, a)}, the ${SOURCE_WORD[b]} says ${spoken(row, b)}.`;
  }
  return `${label} differs across all three sources.`;
}

/** Text of a cell as written in that source; the site-text origin when the value was read from it. */
export function asWritten(row: CompareRow, key: SourceKey): { text: string | null; from: string | null } {
  const c = row[key];
  const m = c.note?.match(/from site text "(.*)"/);
  return { text: c.original, from: m ? m[1] : null };
}

/** Every part designation on this item's containers (an item can carry more than one part). */
export function partsOf(item: ItemDetail): string[] {
  const list = [...new Set(item.containers.map((c) => c.designation).filter((d): d is string => !!d))].sort();
  if (list.length) return list;
  return [...new Set(item.orders.flatMap((o) => o.parts.map((p) => p.designation)))].sort();
}

export function holdScopeText(h: HoldView): string {
  return h.scopeType === "order_part" ? `${scopeName(h)} only` : h.scopeLabel;
}

export function partOf(item: ItemDetail): string | null {
  return item.containers[0]?.designation ?? item.orders[0]?.parts[0]?.designation ?? null;
}

/** "Part B (ORD-77121 · B)" → "Part B". */
export function scopeName(h: HoldView): string {
  return h.scopeLabel.split(" (")[0] || h.scopeLabel;
}

function relId(message: string): string | null {
  return message.match(/REL-\d+/)?.[0] ?? null;
}

// ------------------------------------------------------------------ finding

export interface Finding {
  tone: "differs" | "missing" | "exception" | "unchecked" | "agrees" | "done";
  headline: Seg[];
  detail: Seg[];
}

/** The current finding in plain words: what the evidence says, then what the item waits for. */
export function findingFor(item: ItemDetail): Finding {
  let tone: Finding["tone"] = "agrees";
  let headline = "";
  const detail: string[] = [];

  const differing = item.containers.flatMap((c) => c.comparison.filter((r) => r.status === "differs").map((r) => ({ c, r })));
  const identityFirst = [...differing].sort((a, b) => Number(["patient_name", "birth_date", "mrn"].includes(b.r.field)) - Number(["patient_name", "birth_date", "mrn"].includes(a.r.field)));
  const unchecked = item.containers.filter((c) => c.verificationState === "unverified");

  if (item.accession) {
    tone = "done";
    headline = `Accessioned as ${item.accession.number}, issued by ${item.accession.issuedBy}.`;
  } else if (identityFirst.length) {
    tone = "differs";
    headline = differSentence(identityFirst[0].r);
    const fields = [...new Set(identityFirst.map((d) => d.r.field))];
    const sameOn = identityFirst.filter((d) => d.r.field === identityFirst[0].r.field).map((d) => d.c.seq);
    if (sameOn.length > 1) detail.push(`Containers ${joinWords(sameOn.map(String))} show the same difference.`);
    if (fields.length > 1) detail.push(`${fields.length - 1} more field${fields.length > 2 ? "s differ" : " differs"}; see the comparison.`);
    detail.push("Both values are kept; nothing is corrected automatically.");
  } else if (item.missingParts.length) {
    tone = "missing";
    const m = item.missingParts[0];
    headline = `Order ${m.orderRef} expects ${m.expected ?? "an unknown number of"} container${m.expected === 1 ? "" : "s"} for part ${m.designation}; ${m.received === 0 ? "none has" : `${m.received} ha${m.received === 1 ? "s" : "ve"}`} arrived.`;
  } else if (item.routing?.status === "exception") {
    tone = "exception";
    headline = `${item.office?.name ?? item.observedOfficeText ?? "This office"} is not in the routing directory, so no dermatopathologist is suggested.`;
  } else if (unchecked.length) {
    tone = "unchecked";
    headline =
      unchecked.length === item.containers.length
        ? `${item.containers.length === 1 ? "The container has" : "No container has"} not been checked against the physical bottle yet.`
        : `${unchecked.length} of ${item.containers.length} containers have not been checked against the physical bottle yet.`;
    detail.push("A scan identifies the record; it does not verify what is in the bottle.");
  } else {
    headline = "Order, bottle and requisition agree on every field they share.";
  }

  if ((tone === "missing" || tone === "exception") && unchecked.length) {
    detail.push(`${unchecked.length === 1 ? `Container ${unchecked[0].seq} has` : `${unchecked.length} containers have`} not been checked against the physical bottle yet.`);
  }

  // Fields stated by one source only: never counted as a match.
  if (tone === "agrees" || tone === "differs") {
    const c0 = item.containers[0];
    const single = c0?.comparison.filter((r) => r.status === "not_compared") ?? [];
    if (single.length && tone === "agrees") {
      const onlyOrder = single.every((r) => r.order.normalized !== null && r.observed.normalized === null && r.requisition.normalized === null);
      const words = single.map((r) => SHORT_FIELD[r.field] ?? r.label);
      detail.push(`${cap(joinWords(words))} ${single.length === 1 ? "is" : "are"} ${onlyOrder ? "on the order only" : "stated by one source only"}, so ${single.length === 1 ? "it was" : "they were"} not compared.`);
    }
  }

  for (const h of item.holds) {
    detail.push(`${scopeName(h)} is held (${h.displayId})${h.clarificationDisplayId ? ` while clarification ${h.clarificationDisplayId} is open` : ""}.`);
  }
  if (!item.accession) {
    const rel = item.readiness.blockers.find((b) => b.code === "related_pending");
    const relDisplay = rel ? relId(rel.message) : null;
    if (relDisplay) detail.push(`Accession waits for the related-order review ${relDisplay}.`);
    else if (item.readiness.ready) detail.push("Nothing blocks the accession request.");
  }
  return { tone, headline: segs(headline), detail: segs(detail.join(" ")) };
}

// ------------------------------------------------------------------ path to accession

export type StepState = "done" | "current" | "later";
export interface StepAction {
  label: string;
  allowed: boolean;
  /** Shown instead of the button when the actor may not act. */
  notAllowed?: string;
  kind: "review" | "verify" | "route" | "request";
}
export interface Step {
  key: string;
  title: string;
  state: StepState;
  /** Waiting on someone else (current step owned by another person or role). */
  waiting: boolean;
  lines: Seg[][];
  owner: string | null;
  ownerRole?: string | null;
  action: StepAction | null;
  related?: RelatedView;
}

export function pathFor(item: ItemDetail, perms: BenchPermissions, actorName: string): Step[] {
  const steps: Omit<Step, "state">[] = [];

  // 1. Container check (a person against the physical bottle; never a scan).
  const unchecked = item.containers.filter((c) => c.verificationState === "unverified");
  steps.push({
    key: "check",
    title: "Container checked",
    waiting: false,
    owner: unchecked.length ? item.ownerName : null,
    lines: item.containers.length
      ? item.containers.map((c) =>
          c.verificationState === "unverified"
            ? segs(`Container ${c.seq}: not checked against the physical bottle yet.`)
            : segs(
                `Container ${c.seq}: ${c.verificationState === "discrepancy" ? "discrepancy recorded" : "no differences"}${c.verifiedByName ? `, ${c.verifiedByName} at ${fmtTime(c.verifiedAt)}` : " (who and when not on record)"}.`,
              ),
        )
      : [segs("No container received.")],
    action: unchecked.length ? { label: "Record check against the bottle", allowed: perms.verify, notAllowed: "Your role cannot record a container check.", kind: "verify" } : null,
  });

  // 2. Routing from the approved rule.
  const r = item.routing;
  const routed = !!r && (r.status === "confirmed" || r.status === "overridden");
  const who = r?.final?.name ?? r?.suggested?.name ?? null;
  steps.push({
    key: "route",
    title: "Routing confirmed",
    waiting: !!r && r.status === "exception" && !perms.resolveException,
    owner: r?.status === "exception" ? "Accessioning lead" : null,
    lines: !r
      ? [segs("No routing decision yet.")]
      : r.status === "exception"
        ? [segs("No approved rule for this office. A lead resolves the exception; no doctor is guessed.")]
        : [segs(`${who ?? "Unknown"}, rule set v${r.ruleSetVersion ?? "?"}${routed ? `. ${r.status === "overridden" ? "Overridden" : "Confirmed"} by ${r.decidedByName ?? "Unknown"}.` : ". Suggested; not confirmed yet."}`)],
    action: !r
      ? null
      : r.status === "suggested"
        ? { label: "Accept routing", allowed: perms.confirmRouting, notAllowed: "Your role cannot confirm routing.", kind: "route" }
        : r.status === "exception"
          ? { label: "Resolve routing exception", allowed: perms.resolveException, notAllowed: "Only the accessioning lead or a supervisor resolves a routing exception.", kind: "route" }
          : null,
  });

  // 3. Related-order review (only when a candidate exists). A review, never a merge.
  for (const rel of item.related) {
    const pending = rel.status === "pending_review" || rel.status === "escalated_to_office";
    const task = item.tasks.find((t) => t.kind === "related_order_review");
    const owner = rel.status === "escalated_to_office" ? `${item.office?.name ?? "the office"} (asked)` : task?.ownerName ?? "Accessioning lead";
    const ownerRole = task?.ownerRole === "accessioning_lead" ? "accessioning lead" : task?.ownerRole?.replace(/_/g, " ") ?? null;
    const members = [item.displayId, ...rel.otherItems.map((o) => o.displayId)].sort();
    steps.push({
      key: `rel-${rel.id}`,
      title: "Related orders reviewed",
      waiting: pending && (!perms.reviewRelated || owner !== actorName),
      owner: pending ? owner : null,
      related: rel,
      ownerRole: rel.status === "escalated_to_office" ? null : ownerRole,
      lines: pending
        ? [
            segs(`${rel.displayId} ${rel.status === "escalated_to_office" ? "was sent to the office as a question." : "needs a decision."} Accession for ${joinWords(members)} waits for it.`),
          ]
        : [segs(`${rel.displayId}: ${RELATED_STATUS[rel.status as keyof typeof RELATED_STATUS] ?? rel.status}. ${rel.reviewedByName ?? ""}`.trim())],
      action: pending && rel.status === "pending_review"
        ? { label: `Review ${rel.displayId}`, allowed: perms.reviewRelated, notAllowed: "Only the accessioning lead or a supervisor records this decision.", kind: "review" }
        : null,
    });
  }

  // 4. Accession request (simulated source).
  steps.push({
    key: "accession",
    title: "Accession requested",
    waiting: false,
    owner: null,
    lines: item.accession
      ? [segs(`${item.accession.number}, issued by ${item.accession.issuedBy}${/simulat/i.test(item.accession.issuedBy) ? "" : " (simulated)"}.`)]
      : item.latestRequest
        ? [segs(`${item.latestRequest.displayId}: ${item.latestRequest.status}.`)]
        : [segs("Issued by the source system (EMA-SIM, simulated). The provisional id stays on record.")],
    action: null,
  });

  const doneKeys = new Set<string>();
  if (!unchecked.length && item.containers.length) doneKeys.add("check");
  if (routed) doneKeys.add("route");
  for (const rel of item.related) if (rel.status !== "pending_review" && rel.status !== "escalated_to_office") doneKeys.add(`rel-${rel.id}`);
  if (item.accession) doneKeys.add("accession");
  let currentSet = false;
  return steps.map((s) => {
    if (doneKeys.has(s.key)) return { ...s, state: "done" as const };
    if (!currentSet) {
      currentSet = true;
      return { ...s, state: "current" as const };
    }
    return { ...s, state: "later" as const };
  });
}

// ------------------------------------------------------------------ scope grid (holds and waits per part)

export interface ScopeColumn {
  item: ItemDetail;
  part: string | null;
  isThis: boolean;
}
export interface ScopeCell {
  text: string;
  kind: "hold" | "wait" | "clear" | "done";
}
export interface ScopeRow {
  key: string;
  label: string;
  cells: ScopeCell[];
}

export function scopeGrid(item: ItemDetail, siblings: ItemDetail[]): { columns: ScopeColumn[]; rows: ScopeRow[] } {
  const columns: ScopeColumn[] = [item, ...siblings]
    .map((it) => ({ item: it, part: partOf(it), isThis: it.id === item.id }))
    .sort((a, b) => (a.part ?? "").localeCompare(b.part ?? ""));
  const blockKeys = ["gross_approval", "processing", "print", "tray_delivery"];
  const rows: ScopeRow[] = [];
  rows.push({
    key: "accession_request",
    label: "Accession request",
    cells: columns.map(({ item: it }) => {
      if (it.accession) return { text: it.accession.number, kind: "done" };
      const hold = it.holds.find((h) => h.blocksAccession);
      if (hold) return { text: `Hold ${hold.displayId}`, kind: "hold" };
      const rel = it.readiness.blockers.find((b) => b.code === "related_pending");
      if (rel) return { text: `Waits for ${relId(rel.message) ?? "review"}`, kind: "wait" };
      if (it.readiness.blockers.length) return { text: `${it.readiness.blockers.length} blocker${it.readiness.blockers.length > 1 ? "s" : ""}`, kind: "wait" };
      return { text: "Can be requested", kind: "clear" };
    }),
  });
  for (const k of blockKeys) {
    rows.push({
      key: k,
      label: HOLD_BLOCK_LABEL[k],
      cells: columns.map(({ item: it }) => {
        const h = it.holds.find((x) => x.blocks.includes(k) || x.blocks.includes("all"));
        return h ? { text: `Hold ${h.displayId}`, kind: "hold" } : { text: "No hold", kind: "clear" };
      }),
    });
  }
  return { columns, rows };
}

/** "Hold H-0090 applies to Part B only. Part A is not held." */
export function scopeSentence(item: ItemDetail, siblings: ItemDetail[]): Seg[] {
  const all = [item, ...siblings];
  const held = all.filter((it) => it.holds.length);
  if (!held.length) return segs(all.length > 1 ? "No holds on either part." : "No holds on this item.");
  const parts: string[] = [];
  for (const it of held) for (const h of it.holds) parts.push(`Hold ${h.displayId} applies to ${h.scopeType === "order_part" ? `${scopeName(h)} only` : h.scopeLabel}.`);
  const free = all.filter((it) => !it.holds.length).map((it) => `Part ${partOf(it) ?? "?"}`);
  if (free.length) parts.push(`${joinWords(free)} ${free.length > 1 ? "are" : "is"} not held.`);
  return segs(parts.join(" "));
}
