/**
 * Concept C view model: pure functions over the real intake read model
 * (intakeBench). Nothing here is hard-coded to the fixture; every sentence is
 * assembled from the selected item's data. Safe to import from client code
 * (type-only imports from the server module are erased).
 */
import type { BenchPermissions, ContainerView, IntakeBench, ItemDetail, QueueItem } from "@/server/queries/intake";
import { CLARIFICATION_STATE, RELATED_STATUS, type ClarificationState, type RelatedStatus } from "@/lib/domain";
import { fmtTime } from "@/lib/time";

export type StepKey = "container" | "differences" | "related" | "routing" | "accession";
/** done: settled. yours: the person acting can do it now. waiting: someone else owns it now. blocked: cannot start yet. later: not reached. */
export type StepState = "done" | "yours" | "waiting" | "blocked" | "later";
/** Progress by tone: settled steps sit back, steps in motion are full ink, steps not yet possible are pale. */
export type StepTone = "done" | "active" | "later";

export interface StepModel {
  key: StepKey;
  n: number;
  title: string;
  state: StepState;
  tone: StepTone;
  status: string;
  detail: string;
  owner: string | null;
}

export interface FindingNote {
  kind: "hold" | "info";
  text: string;
}

export interface Finding {
  lead: string;
  follow: string | null;
  notes: FindingNote[];
}

export const STEP_KEYS: StepKey[] = ["container", "differences", "related", "routing", "accession"];

export const HOLD_STOPS: Record<string, string> = {
  accession_request: "the accession request",
  routing_confirm: "routing confirmation",
  gross_approval: "gross approval",
  processing: "processing",
  sectioning: "sectioning",
  print: "label printing",
  tray_delivery: "tray delivery",
  all: "all steps",
};

export const ROLE_LABEL: Record<string, string> = {
  accessioner: "Accessioner",
  accessioning_lead: "Accessioning lead",
  supervisor: "Operations supervisor",
  grosser: "Grosser",
  histology_assistant: "Histology assistant",
  histotech: "Histotech",
  director: "Director (demo)",
  medical_director: "Medical director (demo)",
  pathologist: "Dermatopathologist",
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "Unknown role";
  return ROLE_LABEL[role] ?? role.replace(/_/g, " ");
}

export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function partsOf(item: ItemDetail): string[] {
  const fromContainers = item.containers.map((c) => c.designation).filter((d): d is string => !!d);
  const fromOrders = item.orders.flatMap((o) => o.parts.map((p) => p.designation));
  return [...new Set(fromContainers.length ? fromContainers : fromOrders)].sort();
}

export function partLabel(item: ItemDetail): string {
  const p = partsOf(item);
  if (!p.length) return "Part Unknown";
  return p.length === 1 ? `Part ${p[0]}` : `Parts ${listWords(p)}`;
}

function relatedTask(item: ItemDetail) {
  return item.tasks.find((t) => t.kind === "related_order_review") ?? null;
}

function routingTask(item: ItemDetail) {
  return item.tasks.find((t) => /routing|dermatopathologist/i.test(`${t.kind} ${t.title}`)) ?? null;
}

const clarState = (s: string) => CLARIFICATION_STATE[s as ClarificationState] ?? s;
export const relatedState = (s: string) => RELATED_STATUS[s as RelatedStatus] ?? s;

type Row = ContainerView["comparison"][number];

const IDENTITY = ["patient_name", "birth_date", "mrn"];
/** Clarification categories that can cover a difference in each compared field. */
const CLAR_FOR_FIELD: Record<string, string[]> = {
  laterality: ["laterality"],
  site: ["site", "laterality"],
  procedure: ["biopsy_method"],
  patient_name: ["identity_conflict"],
  birth_date: ["identity_conflict"],
  mrn: ["identity_conflict"],
  part_designation: ["other"],
  collection_date: ["other"],
};
const isOpen = (state: string) => state !== "resolved" && state !== "canceled";

export interface DiffEntry {
  container: ContainerView;
  row: Row;
  /** The recorded (open) finding for this field, if staff recorded one. */
  mismatch: ContainerView["openMismatches"][number] | null;
  /** The open question that covers it, if any. */
  clar: { displayId: string; state: string; category: string; ownerName: string | null } | null;
  identity: boolean;
}

/**
 * Every field where the three sources disagree, per container: from the
 * comparison itself (so a difference shows even before it is recorded) plus
 * recorded findings whose values now agree. Identity fields first.
 */
export function differences(item: ItemDetail): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const c of item.containers) {
    for (const row of c.comparison) {
      const mismatch = c.openMismatches.find((m) => m.field === row.field) ?? null;
      if (row.status !== "differs" && !mismatch) continue;
      const cats = CLAR_FOR_FIELD[row.field] ?? [];
      const viaContainer = c.clarification && isOpen(c.clarification.state) ? item.clarifications.find((q) => q.displayId === c.clarification!.displayId) ?? null : null;
      const viaItem = item.clarifications.find((q) => isOpen(q.state) && cats.includes(q.category)) ?? null;
      const q = viaContainer && cats.includes(viaContainer.category) ? viaContainer : viaItem ?? viaContainer;
      out.push({
        container: c,
        row,
        mismatch,
        clar: q ? { displayId: q.displayId, state: q.state, category: q.category, ownerName: q.ownerName } : null,
        identity: IDENTITY.includes(row.field),
      });
    }
  }
  return out.sort((a, b) => Number(b.identity) - Number(a.identity));
}

// ---------------------------------------------------------------- steps

export function buildSteps(item: ItemDetail, actorName: string, perms: BenchPermissions): StepModel[] {
  const you = (name: string | null | undefined) => !!name && name === actorName;
  const cs = item.containers;
  const unverified = cs.filter((c) => c.verificationState === "unverified");
  const stale = cs.filter((c) => c.orderChangedSinceVerification);
  const missing = item.missingParts;

  // 1 Container
  let s1: Omit<StepModel, "tone">;
  if (!cs.length) {
    s1 = { key: "container", n: 1, title: "Container", state: perms.verify ? "yours" : "waiting", status: "No container linked", detail: "Link the bottle to an order part", owner: item.ownerName };
  } else if (unverified.length) {
    s1 = {
      key: "container", n: 1, title: "Container",
      state: perms.verify ? "yours" : "waiting",
      status: `${unverified.length} of ${cs.length} not checked`,
      detail: missing.length ? `and ${missing.length} container missing` : "Check against the physical bottle",
      owner: item.ownerName,
    };
  } else if (stale.length) {
    s1 = { key: "container", n: 1, title: "Container", state: perms.verify ? "yours" : "waiting", status: "Order changed since the check", detail: "Check the bottle again", owner: item.ownerName };
  } else if (missing.length) {
    s1 = {
      key: "container", n: 1, title: "Container", state: perms.raiseClarification ? "yours" : "waiting",
      status: `${missing.length} container missing`, detail: `${missing[0].orderRef} part ${missing[0].designation}`, owner: item.ownerName,
    };
  } else {
    const disc = cs.filter((c) => c.verificationState === "discrepancy");
    s1 = {
      key: "container", n: 1, title: "Container", state: "done",
      status: disc.length ? "Checked, differences recorded" : "Staff verified",
      detail: cs[0].verifiedAt ? `${cs[0].verifiedByName ?? "Checker unknown"}, ${fmtTime(cs[0].verifiedAt)}` : "Checker and time not on record",
      owner: null,
    };
  }

  // 2 Differences
  const diffs = differences(item);
  const recorded = diffs.filter((d) => d.mismatch);
  const covering = diffs.find((d) => d.clar)?.clar ?? null;
  let s2: Omit<StepModel, "tone">;
  if (cs.length && unverified.length === cs.length && !recorded.length && !covering) {
    const typed = [...new Set(diffs.map((d) => d.row.label))];
    s2 = {
      key: "differences", n: 2, title: "Differences", state: "later",
      status: "After the container check",
      detail: typed.length ? `Typed label: ${listWords(typed).toLowerCase()} differs` : "Typed label: no field differs yet",
      owner: null,
    };
  } else if (!diffs.length) {
    const notCompared = new Set(cs.flatMap((c) => c.comparison.filter((r) => r.status === "not_compared").map((r) => r.field)));
    s2 = {
      key: "differences", n: 2, title: "Differences", state: "done", status: "Nothing differs",
      detail: notCompared.size ? `${notCompared.size} fields not compared` : "Every field compared",
      owner: null,
    };
  } else {
    const labels = [...new Set(diffs.map((d) => d.row.label))];
    const clar = covering;
    const owner = clar?.ownerName ?? null;
    if (!clar) {
      s2 = {
        key: "differences", n: 2, title: "Differences", state: perms.raiseClarification ? "yours" : "waiting",
        status: `${listWords(labels)} differs`, detail: "No question raised yet", owner: item.ownerName,
      };
    } else if (clar.state === "drafted" || clar.state === "delivery_failed") {
      s2 = {
        key: "differences", n: 2, title: "Differences", state: you(owner) ? "yours" : "waiting",
        status: `${clar.displayId} ${clar.state === "drafted" ? "drafted, not sent" : "delivery failed"}`,
        detail: you(owner) ? "Your next step: send it" : `Owner ${owner ?? "Unknown"}`,
        owner,
      };
    } else if (clar.state === "answered" || clar.state === "reviewed") {
      s2 = {
        key: "differences", n: 2, title: "Differences", state: you(owner) ? "yours" : "waiting",
        status: `${clar.displayId}: answer in`, detail: `Lab review: ${owner ?? "Unknown"}`, owner,
      };
    } else {
      s2 = {
        key: "differences", n: 2, title: "Differences", state: "waiting",
        status: `${clar.displayId}: ${clarState(clar.state).toLowerCase()}`, detail: "Waiting on the office", owner,
      };
    }
  }

  // 3 Related orders
  const rels = item.related;
  const pending = rels.filter((r) => r.status === "pending_review");
  const asked = rels.filter((r) => r.status === "escalated_to_office");
  const rt = relatedTask(item);
  let s3: Omit<StepModel, "tone">;
  if (!rels.length) {
    s3 = {
      key: "related", n: 3, title: "Related orders", state: "done", status: "No candidates detected",
      detail: item.separateEncounters.length ? `${item.separateEncounters.length} other visit kept separate` : "Same patient, visit, office, day",
      owner: null,
    };
  } else if (pending.length) {
    const ownerName = rt?.ownerName ?? null;
    s3 = {
      key: "related", n: 3, title: "Related orders", state: perms.reviewRelated ? "yours" : "waiting",
      status: perms.reviewRelated ? `${pending[0].displayId} needs your review` : `Waiting on ${ownerName ?? "the accessioning lead"}`,
      detail: perms.reviewRelated ? "Link, keep separate or ask" : `${roleLabel(rt?.ownerRole ?? "accessioning_lead")} decides`,
      owner: ownerName,
    };
  } else if (asked.length) {
    s3 = { key: "related", n: 3, title: "Related orders", state: "waiting", status: "Asked the office", detail: asked[0].displayId, owner: rt?.ownerName ?? null };
  } else {
    const r = rels[0];
    s3 = {
      key: "related", n: 3, title: "Related orders", state: "done",
      status: r.status === "single_accession_approved" ? "Linked: one accession" : r.status === "keep_separate" ? "Kept separate" : "Not related",
      detail: `${r.reviewedByName ?? "Unknown"}, ${fmtTime(r.reviewedAt)}`,
      owner: null,
    };
  }

  // 4 Routing
  const r = item.routing;
  let s4: Omit<StepModel, "tone">;
  if (!r) {
    s4 = { key: "routing", n: 4, title: "Routing", state: "later", status: "No suggestion yet", detail: "Office not matched to a rule", owner: null };
  } else if (r.status === "confirmed" || r.status === "overridden") {
    s4 = {
      key: "routing", n: 4, title: "Routing", state: "done",
      status: `${r.status === "overridden" ? "Overridden" : "Confirmed"}: ${(r.final ?? r.suggested)?.name ?? "Unknown"}`,
      detail: `${r.decidedByName ?? "Unknown"}, ${fmtTime(r.decidedAt)}`,
      owner: null,
    };
  } else if (r.status === "exception") {
    const t = routingTask(item);
    s4 = {
      key: "routing", n: 4, title: "Routing", state: perms.resolveException ? "yours" : "waiting",
      status: "Routing exception", detail: perms.resolveException ? "Assign with a reason" : `Waiting on ${t?.ownerName ?? "the accessioning lead"}`,
      owner: t?.ownerName ?? null,
    };
  } else {
    s4 = {
      key: "routing", n: 4, title: "Routing", state: perms.confirmRouting ? "yours" : "waiting",
      status: `Suggested: ${r.suggested?.name ?? "Unknown"}`, detail: `Rule set v${r.ruleSetVersion ?? "?"}, accept or override`, owner: item.ownerName,
    };
  }

  // 5 Accession
  let s5: Omit<StepModel, "tone">;
  if (item.accession) {
    s5 = { key: "accession", n: 5, title: "Accession", state: "done", status: item.accession.number, detail: "Issued by the source (simulated)", owner: null };
  } else if (item.latestRequest?.status === "submitted") {
    s5 = { key: "accession", n: 5, title: "Accession", state: "waiting", status: "Requested, not issued yet", detail: item.latestRequest.displayId, owner: null };
  } else if (item.readiness.ready) {
    s5 = { key: "accession", n: 5, title: "Accession", state: perms.requestAccession ? "yours" : "waiting", status: "Ready to request", detail: "Number comes from the source", owner: item.ownerName };
  } else {
    const b = primaryBlocker(item);
    const n = item.readiness.blockers.length;
    s5 = {
      key: "accession", n: 5, title: "Accession", state: "blocked",
      status: b ? `Blocked by ${blockerShort(b.code, b.message)}` : "Blocked",
      detail: n > 1 ? `and ${n - 1} more reason${n - 1 === 1 ? "" : "s"}` : "Opens when that clears",
      owner: null,
    };
  }

  const tone = (s: StepState): StepTone => (s === "done" ? "done" : s === "yours" || s === "waiting" ? "active" : "later");
  return [s1, s2, s3, s4, s5].map((s) => ({ ...s, tone: tone(s.state) }));
}

export function defaultFocus(steps: StepModel[]): StepKey {
  return (
    steps.find((s) => s.state === "yours")?.key ??
    steps.find((s) => s.state === "waiting")?.key ??
    steps.find((s) => s.state === "blocked" || s.state === "later")?.key ??
    "accession"
  );
}

// ---------------------------------------------------------------- blockers

const BLOCKER_PRIORITY = [
  "identity_unresolved", "related_pending", "routing_exception", "hold", "missing_container", "discrepancy_uncovered",
  "container_unverified", "verification_stale", "routing_not_confirmed", "routing_differs",
];

export function primaryBlocker(item: ItemDetail) {
  const bs = item.readiness.blockers;
  return [...bs].sort((a, b) => rank(a.code) - rank(b.code))[0] ?? null;
}
function rank(code: string) {
  const i = BLOCKER_PRIORITY.indexOf(code);
  return i === -1 ? 99 : i;
}

export function blockerShort(code: string, message: string): string {
  const rel = /REL-\d+/.exec(message)?.[0];
  const hold = /\bH-\d+/.exec(message)?.[0];
  switch (code) {
    case "related_pending": return rel ? `${rel} review` : "related-order review";
    case "identity_unresolved": return "identity question";
    case "routing_exception": return "routing exception";
    case "routing_not_confirmed": return "routing not accepted";
    case "container_unverified": return "container check";
    case "missing_container": return "missing container";
    case "hold": return hold ? `hold ${hold}` : "a hold";
    case "discrepancy_uncovered": return "unraised difference";
    case "verification_stale": return "stale check";
    default: return "an open item";
  }
}

/** A blocker in plain words, plus who owns clearing it and which step it belongs to. */
export function explainBlocker(item: ItemDetail, b: ItemDetail["readiness"]["blockers"][number], actorName: string) {
  const rel = /REL-\d+/.exec(b.message)?.[0];
  const msg = b.message.startsWith(item.displayId) ? b.message.replace(/^[^:]+:\s+/, "") : b.message;
  const text = msg.charAt(0).toUpperCase() + msg.slice(1);
  let owner: string | null = null;
  let step: StepKey = "accession";
  switch (b.code) {
    case "related_pending": {
      const t = relatedTask(item);
      owner = t ? `${t.ownerName ?? "Unknown"} (${roleLabel(t.ownerRole).toLowerCase()})` : "Accessioning lead";
      step = "related";
      return { text: rel ? `${rel}: possible related orders need the lead's review first.` : text, owner, step };
    }
    case "routing_exception":
    case "routing_not_confirmed":
    case "routing_differs": {
      const t = routingTask(item);
      owner = t?.ownerName ?? item.ownerName;
      step = "routing";
      break;
    }
    case "container_unverified":
    case "verification_stale":
    case "missing_container":
      owner = item.ownerName;
      step = "container";
      break;
    case "identity_unresolved":
    case "discrepancy_uncovered":
      owner = item.clarifications[0]?.ownerName ?? item.ownerName;
      step = "differences";
      break;
    case "hold":
      step = "differences";
      break;
  }
  if (owner && owner === actorName) owner = `You (${owner})`;
  return { text, owner, step };
}

// ---------------------------------------------------------------- finding sentence

function sayRow(row: Row): string {
  const plain = row.field === "laterality" || row.field === "procedure";
  const sources = [
    { who: "the bottle", cell: row.observed },
    { who: "the order", cell: row.order },
    { who: "the requisition", cell: row.requisition },
  ];
  const groups = new Map<string, { who: string; original: string | null }[]>();
  for (const s of sources) {
    if (s.cell.normalized === null) continue;
    groups.set(s.cell.normalized, [...(groups.get(s.cell.normalized) ?? []), { who: s.who, original: s.cell.original }]);
  }
  const parts = [...groups.entries()].map(([norm, g]) => {
    const value = plain ? norm : `“${g[0].original ?? norm}”`;
    return `${listWords(g.map((x) => x.who))} ${g.length > 1 ? "say" : "says"} ${value}`;
  });
  const silent = sources.filter((s) => s.cell.normalized === null).map((s) => s.who);
  if (silent.length && parts.length < 2) parts.push(`${listWords(silent)} ${silent.length > 1 ? "state" : "states"} none`);
  return `${row.label}: ${parts.join("; ")}.`;
}

export function buildFinding(item: ItemDetail, actorName: string, siblings: ItemDetail[]): Finding {
  const diffs = differences(item);
  const unverified = item.containers.filter((c) => c.verificationState === "unverified");
  let lead: string;
  const first = diffs[0];
  if (first && first.row.status === "differs") {
    lead = sayRow(first.row);
  } else if (first?.mismatch) {
    lead = `${first.row.label}: the values now agree, but the recorded difference is still open. ${first.mismatch.holdReason ?? ""}`.trim();
  } else if (item.missingParts.length) {
    const m = item.missingParts[0];
    lead = `No container arrived for ${m.orderRef} part ${m.designation}; the order expects ${m.expected ?? "Unknown"}.`;
  } else if (item.routing?.status === "exception" || !item.office) {
    const office = item.office?.name ?? item.observedOfficeText ?? "This office";
    lead = `${office} has no approved routing rule, so no dermatopathologist is suggested.`;
  } else if (unverified.length) {
    lead =
      unverified.length === 1 && item.containers.length === 1
        ? "The container has not been checked against the physical bottle yet."
        : `${unverified.length} of ${item.containers.length} containers have not been checked against the physical bottle yet.`;
  } else if (item.accession) {
    lead = `Accessioned as ${item.accession.number}.`;
  } else {
    lead = "Order, bottle and requisition agree on every field they state.";
  }

  let follow: string | null = null;
  if (item.accession) follow = null;
  else if (item.readiness.ready) follow = "Nothing blocks the accession request.";
  else {
    const b = primaryBlocker(item);
    const more = item.readiness.blockers.length - 1;
    const tail = more > 0 ? `, and ${more} more` : "";
    if (b) {
      const rel = /REL-\d+/.exec(b.message)?.[0] ?? "the related-order candidate";
      const t = relatedTask(item);
      const owner = t?.ownerName ?? "the accessioning lead";
      const whose = owner === actorName ? "your" : `${owner}’s`;
      switch (b.code) {
        case "related_pending": follow = `Accession waits on ${whose} review of ${rel}${tail}.`; break;
        case "identity_unresolved": follow = `Accession waits until a lead resolves the identity question${tail}.`; break;
        case "routing_exception": follow = `Accession waits until ${routingTask(item)?.ownerName ?? "a lead"} assigns a dermatopathologist${tail}.`; break;
        case "container_unverified": follow = `Accession waits for the container check${tail}.`; break;
        case "missing_container": follow = `Accession waits on the missing container${tail}.`; break;
        case "hold": follow = `Accession waits on hold ${/\bH-\d+/.exec(b.message)?.[0] ?? ""}${tail}.`; break;
        case "routing_not_confirmed": follow = `Accession waits for routing to be accepted${tail}.`; break;
        default: follow = `Accession is blocked: ${b.message}`;
      }
    }
  }

  const notes: FindingNote[] = [];
  for (const h of item.holds) {
    const stops = listWords(h.blocks.map((x) => HOLD_STOPS[x] ?? x));
    // "Part B (ORD-77121 · B)" reads as "Part B" here: the order id is already in the identity strip.
    const scope = h.scopeType === "order_part" ? h.scopeLabel.replace(/\s*\(.*\)\s*$/, "") : h.scopeLabel;
    let text = `Hold ${h.displayId} is on ${scope} only. It stops ${stops}${h.blocksAccession ? "" : ", not accession"}.`;
    const free = siblings.filter((s) => !s.holds.some((x) => x.id === h.id));
    if (free.length) text += ` ${listWords(free.map((s) => `${partLabel(s)} (${s.displayId})`))} ${free.length > 1 ? "are" : "is"} not on hold.`;
    notes.push({ kind: "hold", text });
  }
  for (const s of siblings) {
    for (const h of s.holds) {
      if (item.holds.some((x) => x.id === h.id)) continue;
      notes.push({ kind: "info", text: `${partLabel(s)} (${s.displayId}) has hold ${h.displayId}. It does not apply to this item.` });
    }
  }
  return { lead, follow, notes };
}

// ---------------------------------------------------------------- queue progress ticks

/** Five tones per queue row, derived only from what the queue row states. */
export function queueTicks(q: QueueItem): { label: string; tone: StepTone }[] {
  const open = q.status !== "accessioned" && q.status !== "canceled";
  const checked = q.containerCount > 0 && q.verifiedCount === q.containerCount;
  const has = (re: RegExp) => q.reasons.some((r) => re.test(r));
  const diff = has(/Discrepancy|Identity|Missing|Extra|not matched/i);
  const rel = has(/Related orders/i);
  const routed = q.routingStatus === "confirmed" || q.routingStatus === "overridden";
  if (!open) return STEP_KEYS.map((k) => ({ label: `${k}: done`, tone: "done" }));
  return [
    { label: checked ? "Container: checked" : "Container: not checked", tone: checked ? "done" : "active" },
    { label: diff ? "Differences: open" : checked ? "Differences: none" : "Differences: after the check", tone: diff ? "active" : checked ? "done" : "later" },
    { label: rel ? "Related orders: needs review" : "Related orders: none open", tone: rel ? "active" : "done" },
    { label: routed ? "Routing: confirmed" : q.routingStatus === "exception" ? "Routing: exception" : "Routing: not accepted", tone: routed ? "done" : q.routingStatus === "exception" ? "active" : "later" },
    { label: "Accession: not requested", tone: "later" },
  ];
}

// ---------------------------------------------------------------- page model

export interface DeskModel {
  bench: IntakeBench;
  siblings: ItemDetail[];
  steps: StepModel[] | null;
  finding: Finding | null;
}

export function buildDesk(bench: IntakeBench, siblings: ItemDetail[]): DeskModel {
  const item = bench.selected;
  if (!item) return { bench, siblings, steps: null, finding: null };
  // Trim the audit trail: the desk shows the latest events only.
  const trimmed: IntakeBench = { ...bench, selected: { ...item, audit: item.audit.slice(0, 12) } };
  return {
    bench: trimmed,
    siblings: siblings.map((s) => ({ ...s, audit: [] })),
    steps: buildSteps(item, bench.actor.name, bench.permissions),
    finding: buildFinding(item, bench.actor.name, siblings),
  };
}
