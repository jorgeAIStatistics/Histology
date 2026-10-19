"use client";

import { useState } from "react";
import { Check, ChevronDown, CircleHelp, Pencil, TriangleAlert } from "lucide-react";
import type { BenchPermissions, ContainerView, ItemDetail, MissingPartView } from "@/server/queries/intake";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { StatePill } from "@/components/ui/status-pill";
import { IdChip, ProvisionalChip } from "@/components/domain/chips";
import { IdentityMark } from "@/components/domain/identity-mark";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useConflict } from "@/lib/client/conflict";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { cn } from "@/lib/cn";
import { BottleLabel } from "./bottle-label";
import type { ClarificationDraft } from "./clarification-dialog";
import { AcceptDiscrepancyDialog, type AcceptTarget } from "./accept-dialog";
import { clarificationWords, coveringClarification, oddSources, orderedRows, type CompareRow, type SourceKey } from "./plan";
import { useBackToScan } from "./bits";

const IDENTITY_FIELDS = new Set(["patient_name", "birth_date", "mrn"]);
const NONE: ReadonlySet<string> = new Set();

function categoryFor(field: string): ClarificationDraft["category"] {
  if (IDENTITY_FIELDS.has(field)) return "identity_conflict";
  if (field === "site") return "site";
  if (field === "laterality") return "laterality";
  if (field === "procedure") return "biopsy_method";
  return "other";
}

function closed(item: ItemDetail): boolean {
  return item.status === "accessioned" || item.status === "canceled";
}

function cellText(c: CompareRow["observed"]): string | null {
  if (!c.original) return null;
  return c.note ? `${c.original} (${c.note})` : c.original;
}

/** Pre-filled clarification for one differing row (that field only), with a hold scoped to the affected material. */
export function draftForRow(item: ItemDetail, c: ContainerView, row: CompareRow): ClarificationDraft {
  const partLabel = c.designation ? `Part ${c.designation}` : `Container ${c.seq}`;
  const orderRef = c.orderRef ?? item.orders[0]?.sourceOrderId ?? null;
  const identity = IDENTITY_FIELDS.has(row.field);
  const observed = row.observed.original ?? "nothing";
  const order = row.order.original ?? "not stated";
  const question = identity
    ? `The bottle for ${partLabel} shows ${row.label.toLowerCase()} "${observed}" but order ${orderRef ?? ""} says "${order}". Please confirm the patient identity for ${item.displayId} (all containers) before accessioning.`
    : `For ${partLabel}, the bottle label says ${row.label.toLowerCase()} "${observed}"${row.observed.note ? ` (${row.observed.note})` : ""} but order ${orderRef ?? ""} says "${order}". Which is correct?`;
  const sourceOrderId = item.orders.find((o) => o.sourceOrderId === orderRef)?.id ?? null;
  return {
    category: categoryFor(row.field),
    // An identity question concerns the whole requisition (every container), so it is raised on the item, not on one part.
    refs: identity ? { intakeItemId: item.id, sourceOrderId } : { intakeItemId: item.id, sourceOrderId, orderPartId: c.orderPartId, containerId: c.id },
    intakeDisplayId: item.displayId,
    orderRef,
    partLabel: identity ? `${item.displayId} (all containers)` : partLabel,
    subjectLabel: identity ? `${item.displayId} (all containers) · ${orderRef ?? "no order linked"}` : `${partLabel} · ${orderRef ?? item.displayId}`,
    question,
    evidence: [
      {
        field: row.label,
        order_value: row.order.original,
        observed_value: cellText(row.observed),
        requisition_value: cellText(row.requisition),
        source: "bottle label (typed observation) compared with the order and the requisition",
      },
    ],
    priority: identity ? "urgent" : "high",
    hold: identity
      ? { scope: { type: "intake_item", id: item.id }, scopeLabel: `${item.displayId} (all containers)`, blocks: ["all"] }
      : c.orderPartId
        ? {
            scope: { type: "order_part", id: c.orderPartId },
            scopeLabel: `${partLabel} (${orderRef} · ${c.designation})`,
            blocks: ["gross_approval", "processing", "print", "tray_delivery"],
          }
        : { scope: { type: "container", id: c.id }, scopeLabel: `${item.displayId} container ${c.seq}`, blocks: ["gross_approval", "processing", "print", "tray_delivery"] },
  };
}

/** Pre-filled clarification for a part with no container (or more than expected). */
export function draftForCount(item: ItemDetail, m: MissingPartView, extra = false): ClarificationDraft {
  const order = item.orders.find((o) => o.sourceOrderId === m.orderRef);
  return {
    category: "missing_container",
    refs: { intakeItemId: item.id, sourceOrderId: order?.id ?? null, orderPartId: m.orderPartId },
    intakeDisplayId: item.displayId,
    orderRef: m.orderRef,
    partLabel: `Part ${m.designation}`,
    subjectLabel: `Part ${m.designation} · ${m.orderRef}`,
    question: extra
      ? `Order ${m.orderRef} expects ${m.expected ?? "an unknown number of"} container(s) for part ${m.designation}, but ${m.received} arrived labeled for this part. Are they all part ${m.designation}, or does one belong to another specimen?`
      : `Order ${m.orderRef} lists part ${m.designation}, but no container for part ${m.designation} arrived with this delivery. Was it collected and sent separately?`,
    evidence: [{ field: "Containers", order_value: `expected ${m.expected ?? "Unknown"}`, observed_value: `received ${m.received}`, requisition_value: null, source: "courier unpacking" }],
    priority: "high",
    hold: { scope: { type: "order_part", id: m.orderPartId }, scopeLabel: `Part ${m.designation} (${m.orderRef} · ${m.designation})`, blocks: ["gross_approval"] },
  };
}

// ------------------------------------------------------------------ cells

function Value({ row, k, odd, noRequisition = false }: { row: CompareRow; k: SourceKey; odd: boolean; noRequisition?: boolean }) {
  const cell = row[k];
  const differs = row.status === "differs";
  if (!cell.original) {
    return <span className="text-sm text-ink-muted">{k === "observed" ? "Not on label" : k === "requisition" && noRequisition ? "No requisition" : "Not stated"}</span>;
  }
  // "448210 (EMA-SIM Sunrise Coast)": the MRN, then its source system (an MRN is unique only within one source).
  const tenant = /^(\S+) \(([^()]+)\)$/.exec(cell.original);
  if (row.field === "mrn" && tenant) {
    return (
      <span className="block min-w-0">
        <span className="id-mono text-ink">{tenant[1]}</span>
        <span className="block text-sm text-ink-muted">{tenant[2]}</span>
      </span>
    );
  }
  const mono = row.field === "birth_date" || row.field === "mrn";
  return (
    <span className="block min-w-0">
      <span
        className={cn(
          "break-words",
          mono && "id-mono",
          differs ? "text-md text-ink" : "text-ink-secondary",
          odd && "font-semibold underline decoration-2 underline-offset-4",
          odd && (IDENTITY_FIELDS.has(row.field) ? "decoration-danger-solid" : "decoration-warning-solid"),
        )}
      >
        {cell.original}
      </span>
      {cell.note && differs ? <span className="block text-sm text-ink-muted">{cell.note}</span> : null}
    </span>
  );
}

const PAIR_WORD: Record<string, string> = {
  "order≠observed": "order and bottle disagree",
  "order≠requisition": "order and requisition disagree",
  "observed≠requisition": "bottle and requisition disagree",
};

function sameWords(row: CompareRow, sideDiffers: boolean) {
  if (row.field === "site") return { word: "Same location", sub: sideDiffers ? "Side compared above" : null };
  return { word: "Same", sub: null };
}

function MatrixRows({
  item,
  c,
  row,
  permissions,
  sideDiffers,
  onRaise,
  onAccept,
  now,
  stated,
}: {
  item: ItemDetail;
  c: ContainerView;
  row: CompareRow;
  permissions: BenchPermissions;
  sideDiffers: boolean;
  onRaise: (d: ClarificationDraft) => void;
  onAccept: (t: AcceptTarget) => void;
  now: string;
  stated: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const odd = new Set(oddSources(row));
  const identity = IDENTITY_FIELDS.has(row.field);
  if (row.status === "differs") {
    const cover = coveringClarification(item, c, row);
    const accepted = c.acceptedMismatches.find((a) => a.field === row.field && !c.openMismatches.some((m) => m.field === row.field));
    const recorded = c.openMismatches.some((m) => m.field === row.field) || c.verificationState === "discrepancy";
    const m = c.openMismatches.find((x) => x.field === row.field && !x.holdReason);
    const canAccept = !!m && permissions.acceptDiscrepancy && !m.identity && !closed(item) && !(c.clarification && c.clarification.state !== "resolved");
    const tint = identity ? "bg-danger-bg" : "bg-warning-bg";
    const oddWord = odd.size === 1 ? `The ${[...odd][0] === "observed" ? "bottle" : [...odd][0]} disagrees` : row.pairs.map((p) => PAIR_WORD[p] ?? p).join("; ");
    return (
      <>
        <tr id={`row-${c.id}-${row.field}`} className={cn("align-top", tint)}>
          <th scope="row" className="py-2.5 pr-2 pl-3 text-left text-base font-semibold text-ink">
            {row.label}
          </th>
          {(["order", "observed", "requisition"] as SourceKey[]).map((k) => (
            <td key={k} className="py-2.5 pr-2">
              <Value row={row} k={k} odd={odd.has(k)} noRequisition={!item.requisition} />
            </td>
          ))}
          <td className="py-2.5 pr-3">
            <span className={cn("inline-flex items-center gap-1 text-base font-semibold", identity ? "text-danger-fg" : "text-warning-fg")}>
              {identity ? <IdentityMark className="size-4" /> : <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />}
              Differs
            </span>
            <span className="block text-sm text-ink-secondary">
              {identity ? <span className="font-medium text-danger-fg">Patient identity: </span> : null}
              {oddWord}
              {recorded ? "" : "; not recorded yet"}
            </span>
          </td>
        </tr>
        <tr className={tint}>
          <td colSpan={5} className="border-b border-line px-3 pb-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <span className="text-ink-secondary">Both values are kept; nothing is corrected automatically.</span>
              {accepted ? (
                <span className="text-ink-secondary">
                  Accepted by {accepted.byName ?? "Unknown"}
                  {accepted.at ? (
                    <>
                      {" "}
                      at <Timestamp iso={accepted.at} now={now} />
                    </>
                  ) : null}
                  : {accepted.reason ?? "no reason recorded"}
                </span>
              ) : cover ? (
                // The rail and the decision column already name this question and its state: not said a third time here.
                stated.has(cover.displayId) ? null : (
                <span className="text-ink">
                  {identity ? "Identity question " : "Question "}
                  <IdChip kind="CLR" id={cover.displayId} href={`/clarifications?selected=${encodeURIComponent(cover.displayId)}`} />{" "}
                  <span className="font-semibold">{clarificationWords(cover.state)}</span>
                  {identity ? <span className="text-ink-secondary"> (all containers)</span> : null}
                </span>
                )
              ) : !closed(item) && permissions.raiseClarification ? (
                <Button size="sm" variant="secondary" aria-label={`Raise clarification for ${row.label.toLowerCase()} on container ${c.seq}`} onClick={() => onRaise(draftForRow(item, c, row))}>
                  Raise clarification
                </Button>
              ) : !closed(item) ? (
                <span className="font-medium text-ink">No question raised yet.</span>
              ) : null}
              {!cover && canAccept && m ? (
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Accept the recorded ${row.label.toLowerCase()} mismatch on container ${c.seq} with a reason (lead)`}
                  onClick={() =>
                    onAccept({
                      discrepancyId: m.id,
                      version: m.version,
                      intakeDisplayId: item.displayId,
                      orderRef: c.orderRef,
                      subject: `Container ${c.seq}${c.designation ? ` · Part ${c.designation}` : ""}: ${m.label.toLowerCase()}`,
                      rows: [
                        { label: `Order${m.orderVersion ? ` (v${m.orderVersion})` : ""}`, value: m.order },
                        { label: "Bottle (observed)", value: m.observed },
                        { label: "Requisition", value: m.requisition },
                        { label: "Recorded", value: `by ${m.detectedByName ?? "Unknown"}` },
                      ],
                    })
                  }
                >
                  Accept with reason (lead)
                </Button>
              ) : null}
            </div>
          </td>
        </tr>
      </>
    );
  }
  const notCompared = row.status === "not_compared";
  const originals = (["order", "observed", "requisition"] as SourceKey[]).map((k) => row[k].original).filter(Boolean);
  const expandable = !notCompared && new Set(originals).size > 1;
  const same = sameWords(row, sideDiffers);
  return (
    <>
      <tr className={cn("align-top", open ? "" : "border-b border-line")}>
        <th scope="row" className="py-1.5 pr-2 pl-3 text-left text-sm font-medium text-ink-secondary">
          {row.label}
        </th>
        {(["order", "observed", "requisition"] as SourceKey[]).map((k) => (
          <td key={k} className="py-1.5 pr-2 text-sm">
            <Value row={row} k={k} odd={false} noRequisition={!item.requisition} />
          </td>
        ))}
        <td className="py-1.5 pr-3 text-sm">
          {notCompared ? (
            <span className="block text-ink-muted">
              <span className="inline-flex items-center gap-1 font-medium text-ink-secondary">
                <CircleHelp className="size-3.5 shrink-0" aria-hidden />
                Not compared
              </span>
              <span className="block">One source only; not a match</span>
            </span>
          ) : (
            <span className="flex items-start gap-1">
              <span className="block text-ink-muted">
                <span className="inline-flex items-center gap-1">
                  <Check className="size-3.5 shrink-0" aria-hidden />
                  {same.word}
                </span>
                {same.sub ? <span className="block">{same.sub}</span> : null}
              </span>
              {expandable ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${open ? "Hide" : "Show"} how ${row.label.toLowerCase()} was compared`}
                  onClick={() => setOpen((o) => !o)}
                  className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-subtle hover:text-ink max-xl:size-11"
                >
                  <ChevronDown className={cn("size-4 transition-transform duration-[var(--hlo-duration-fast)]", open && "rotate-180")} aria-hidden />
                </button>
              ) : null}
            </span>
          )}
        </td>
      </tr>
      {expandable ? (
        <tr className={open ? "border-b border-line" : ""}>
          <td colSpan={5} className="p-0">
            <div className={cn("grid transition-[grid-template-rows] duration-[var(--hlo-duration-base)] ease-[var(--hlo-ease)]", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
              <div className="overflow-hidden">
                <p className="px-3 pb-2 text-sm text-ink-secondary">
                  Compared as{" "}
                  {(["order", "observed", "requisition"] as SourceKey[])
                    .filter((k) => row[k].normalized !== null)
                    .map((k) => `${k === "observed" ? "bottle" : k} “${row[k].normalized}”`)
                    .join(", ")}
                  . Abbreviations and letter case are normalized only to compare; every source keeps what it says.
                  {(["order", "observed", "requisition"] as SourceKey[])
                    .filter((k) => row[k].note)
                    .map((k) => ` ${k === "observed" ? "Bottle" : k === "order" ? "Order" : "Requisition"} value read ${row[k].note}.`)
                    .join("")}
                </p>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ requisition

const REQ_LABEL: Record<string, string> = {
  order_id: "Order",
  patient_name: "Patient",
  birth_date: "DOB",
  mrn: "MRN",
  office: "Office",
  printed_from: "Printed from",
  collected_at: "Collected",
};

function RequisitionFields({ item }: { item: ItemDetail }) {
  if (!item.requisition) {
    return (
      <p className="text-sm text-ink-secondary">
        <span className="font-medium text-ink">No requisition on file</span> for this item. Only the order and the bottle can be compared; a field one source states is never a match.
      </p>
    );
  }
  const f = item.requisition.fields;
  const specimens = Array.isArray(f.specimens) ? (f.specimens as Record<string, unknown>[]) : [];
  const rest = Object.entries(f).filter(([k, v]) => k !== "specimens" && v !== null && v !== undefined && String(v).trim() !== "");
  return (
    <div className="text-sm">
      <p className="text-ink-secondary">
        Requisition <span className="id-mono text-ink">{item.requisition.docRef}</span>, paper as read at the bench:
      </p>
      <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
        {rest.map(([k, v]) => (
          <div key={k} className="flex gap-1.5">
            <dt className="text-ink-muted">{REQ_LABEL[k] ?? k.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())}</dt>
            <dd className={cn("text-ink", (k === "order_id" || k === "birth_date" || k === "mrn") && "id-mono")}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
          </div>
        ))}
        {specimens.map((sp, i) => (
          <div key={i} className="flex gap-1.5">
            <dt className="text-ink-muted">Specimen {String(sp.designation ?? i + 1)}</dt>
            <dd className="text-ink">{[sp.site, sp.procedure].filter(Boolean).map(String).join(", ") || "Not stated"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ the sheet

function containerPill(c: ContainerView) {
  if (c.verificationState === "verified") return <StatusPill tone="neutral" icon={Check} className="text-sm">Staff verified</StatusPill>;
  if (c.verificationState === "discrepancy") return <StatusPill tone="warning" className="text-sm">Discrepancy recorded</StatusPill>;
  return <StatusPill tone="neutral" icon={CircleHelp} className="text-sm">Not yet verified</StatusPill>;
}

function CheckLine({ c, now }: { c: ContainerView; now: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-ink-secondary">
        {c.lastVerification ? (
          <>
            Last check by {c.lastVerification.byName ?? "Unknown"}
            {c.lastVerification.origin === "demo" ? " (guided demo rehearsal, not a real check)" : ""} at <Timestamp iso={c.lastVerification.at} now={now} /> against{" "}
            <span className="id-mono">{c.orderRef ?? "the order"}</span> v{c.lastVerification.orderVersion}: {c.lastVerification.result === "verified" ? "all compared fields agree" : "discrepancy recorded"}.
          </>
        ) : c.verifiedAt ? (
          <>
            Checked by {c.verifiedByName ?? "Unknown"} at <Timestamp iso={c.verifiedAt} now={now} /> (seeded history; the field comparison was not recorded).
          </>
        ) : c.verificationState !== "unverified" ? (
          <>Checked against the physical bottle ({c.verificationState === "discrepancy" ? "discrepancy recorded" : "fields agreed"}); who and when are not on record (seeded history).</>
        ) : (
          <>
            <span className="font-medium text-ink">Not checked against the physical bottle yet.</span>{" "}
            {/* Said once, here, while a check is still to do: the one place a scan could be mistaken for one. */}
            <span className="text-ink-muted">A scan identifies the record; it does not verify the tissue.</span>
          </>
        )}
      </p>
      {c.orderChangedSinceVerification ? (
        <p className="inline-flex items-start gap-1.5 rounded-sm bg-warning-bg px-2 py-1 text-sm font-medium text-warning-fg">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
          <span>
            The order changed after this check (v{c.lastVerification?.orderVersion} → v{c.currentOrderVersion}). The comparison uses the current order; check the bottle again.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function CountProblems({ item, permissions, onRaise, onAccept }: { item: ItemDetail; permissions: BenchPermissions; onRaise: (d: ClarificationDraft) => void; onAccept: (t: AcceptTarget) => void }) {
  if (!item.missingParts.length && !item.extraParts.length) return null;
  const open = !closed(item);
  return (
    <div id="evidence-counts" className="rounded-md bg-warning-bg px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-base font-semibold text-warning-fg">
        <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />
        {item.missingParts.length && !item.extraParts.length ? "Expected container not received" : "Container count differs from the order"}
      </p>
      <ul className="mt-1 space-y-1.5 text-sm">
        {item.missingParts.map((m) => (
          <li key={m.discrepancyId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink">
              <span className="id-mono">{m.orderRef}</span> part {m.designation}: expected {m.expected ?? "Unknown"}, received {m.received}. Other parts can continue.
            </span>
            {m.clarification ? (
              <span className="inline-flex items-center gap-1 text-ink-secondary">
                Asked in <IdChip kind="CLR" id={m.clarification.displayId} href={`/clarifications?selected=${encodeURIComponent(m.clarification.displayId)}`} />
                <StatePill domain="clarification" state={m.clarification.state} className="text-sm" />
              </span>
            ) : open && permissions.raiseClarification ? (
              <Button size="sm" variant="secondary" onClick={() => onRaise(draftForCount(item, m))}>
                Raise missing-container clarification
              </Button>
            ) : null}
          </li>
        ))}
        {item.extraParts.map((m) => (
          <li key={m.discrepancyId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink">
              <span className="id-mono">{m.orderRef}</span> part {m.designation}: more containers than expected (expected {m.expected ?? "Unknown"}, received {m.received}
              {m.containerSeqs.length ? `, containers ${m.containerSeqs.join(", ")}` : ""}).
            </span>
            {m.clarification ? (
              <span className="inline-flex items-center gap-1 text-ink-secondary">
                Asked in <IdChip kind="CLR" id={m.clarification.displayId} href={`/clarifications?selected=${encodeURIComponent(m.clarification.displayId)}`} />
                <StatePill domain="clarification" state={m.clarification.state} className="text-sm" />
              </span>
            ) : open ? (
              <>
                {permissions.raiseClarification ? (
                  <Button size="sm" variant="secondary" onClick={() => onRaise(draftForCount(item, m, true))}>
                    Raise clarification
                  </Button>
                ) : null}
                {permissions.acceptDiscrepancy ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() =>
                      onAccept({
                        discrepancyId: m.discrepancyId,
                        version: m.version,
                        intakeDisplayId: item.displayId,
                        orderRef: m.orderRef,
                        subject: `Part ${m.designation}: more containers than expected`,
                        rows: [
                          { label: "Expected (order)", value: m.expected === null ? "Unknown" : String(m.expected) },
                          { label: "Received", value: String(m.received) },
                        ],
                      })
                    }
                  >
                    Accept with reason (lead)
                  </Button>
                ) : (
                  <span className="text-ink-secondary">A lead or supervisor can accept this with a reason.</span>
                )}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Evidence sheet: order, bottle (as read by staff) and requisition (paper) side
 * by side for one container, with a result for each field. Differing rows come
 * first and carry the question about them; agreeing rows are quiet; a field one
 * source states is "Not compared", never a match. Originals are kept;
 * abbreviations are normalized only to compare.
 */
export function EvidenceSheet({
  item,
  permissions,
  now,
  onRaise,
  stated = NONE,
}: {
  item: ItemDetail;
  permissions: BenchPermissions;
  now: string;
  onRaise: (d: ClarificationDraft) => void;
  /** Identifiers the finding band and the decision column already state (a covering question is then not repeated per row). */
  stated?: ReadonlySet<string>;
}) {
  const [index, setIndex] = useState(() => {
    const i = item.containers.findIndex((c) => c.comparison.some((r) => r.status === "differs"));
    return i < 0 ? 0 : i;
  });
  const [editing, setEditing] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [accepting, setAccepting] = useState<AcceptTarget | null>(null);
  const c = item.containers[Math.min(index, item.containers.length - 1)];

  if (!c) {
    return (
      <section id="evidence" aria-label="Evidence" tabIndex={-1} className="rounded-lg border border-line bg-surface px-5 py-4 focus:outline-none">
        <h3 className="text-md font-semibold text-ink">No container recorded</h3>
        <p className="mt-1 text-sm text-ink-secondary">Nothing was logged from this requisition&apos;s bag. Check the courier delivery.</p>
        <div className="mt-3">
          <CountProblems item={item} permissions={permissions} onRaise={onRaise} onAccept={setAccepting} />
        </div>
      </section>
    );
  }
  const order = item.orders.find((o) => o.sourceOrderId === c.orderRef) ?? item.orders[0] ?? null;
  const rows = orderedRows(c.comparison);
  const sideDiffers = c.comparison.some((r) => r.field === "laterality" && r.status === "differs");
  const heldOpen = c.openMismatches.filter((m) => m.holdReason);
  const headingId = `evidence-${c.id}-title`;
  const canEdit = permissions.edit && !closed(item);

  return (
    <section id="evidence" aria-labelledby={headingId} tabIndex={-1} className="rounded-lg border border-line bg-surface focus:outline-none">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-5 pt-3.5 pb-2 max-xl:px-4">
        <h3 id={headingId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-md font-semibold text-ink">
          <span>
            Container {c.seq}
            {c.designation ? ` of Part ${c.designation}` : ""}
          </span>
          {c.orderRef ? <IdChip kind="ORD" id={c.orderRef} /> : null}
          {containerPill(c)}
        </h3>
        {item.containers.length > 1 ? (
          <div role="group" aria-label="Containers of this item" className="flex flex-wrap gap-1">
            {item.containers.map((x, i) => {
              const differs = x.comparison.some((r) => r.status === "differs");
              return (
                <button
                  key={x.id}
                  type="button"
                  aria-pressed={i === index}
                  onClick={() => setIndex(i)}
                  className={cn(
                    "inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm max-xl:min-h-11",
                    i === index ? "border-ink bg-surface font-semibold text-ink" : "border-line-strong text-ink-secondary hover:bg-surface-subtle",
                  )}
                >
                  Container {x.seq}
                  {x.designation ? ` of Part ${x.designation}` : ""}
                  {differs ? <TriangleAlert className="size-3.5 text-warning-solid" aria-label="has a difference" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="px-5 pb-3 max-xl:px-4">
        <CheckLine c={c} now={now} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] table-fixed border-collapse">
          <caption className="sr-only">
            Field comparison for {item.displayId} container {c.seq}: order, bottle as read by staff, and paper requisition. Differing fields first.
          </caption>
          <colgroup>
            <col className="w-[7.25rem]" />
            <col />
            <col />
            <col />
            <col className="w-[9rem] max-xl:w-[8rem]" />
          </colgroup>
          <thead>
            <tr className="border-y border-line-strong bg-surface-subtle text-left align-bottom">
              <th scope="col" className="py-1.5 pr-2 pl-3 text-sm font-medium text-ink-muted">
                Field
              </th>
              <th scope="col" className="py-1.5 pr-2">
                <span className="block text-sm font-semibold text-ink">Order</span>
                <span className="block text-sm font-normal text-ink-muted">{order ? `v${c.currentOrderVersion ?? order.sourceVersion}, ${order.tenantName}` : "Not linked"}</span>
              </th>
              <th scope="col" className="py-1.5 pr-2">
                <span className="block text-sm font-semibold text-ink">Bottle</span>
                <span className="block text-sm font-normal text-ink-muted">As read by staff{c.handwritten ? ", handwritten" : ""}</span>
              </th>
              <th scope="col" className="py-1.5 pr-2">
                <span className="block text-sm font-semibold text-ink">Requisition</span>
                <span className="block text-sm font-normal text-ink-muted">{item.requisition ? "Paper, as read" : "None on file"}</span>
              </th>
              <th scope="col" className="py-1.5 pr-3 text-sm font-semibold text-ink">
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <MatrixRows key={row.field} item={item} c={c} row={row} permissions={permissions} sideDiffers={sideDiffers} onRaise={onRaise} onAccept={setAccepting} now={now} stated={stated} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 px-5 py-3 max-xl:px-4">
        {heldOpen.length && !closed(item) ? (
          <div className="rounded-md bg-warning-bg px-3 py-2 text-sm">
            <p className="font-semibold text-warning-fg">Recorded mismatch still open on container {c.seq}</p>
            <ul className="mt-1 space-y-1 text-ink">
              {heldOpen.map((m) => (
                <li key={m.id}>
                  <span className="font-medium">{m.label}</span>: recorded as order &ldquo;{m.order ?? "not stated"}&rdquo;, bottle &ldquo;{m.observed ?? "not on label"}&rdquo;
                  {m.orderVersion ? ` (order v${m.orderVersion})` : ""} by {m.detectedByName ?? "Unknown"} at <Timestamp iso={m.detectedAt} now={now} />. The values now agree, but this finding stays open: {m.holdReason}.
                  {permissions.acceptDiscrepancy && !m.identity ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="ml-2"
                      onClick={() =>
                        setAccepting({
                          discrepancyId: m.id,
                          version: m.version,
                          intakeDisplayId: item.displayId,
                          orderRef: c.orderRef,
                          subject: `Container ${c.seq}${c.designation ? ` · Part ${c.designation}` : ""}: ${m.label.toLowerCase()}`,
                          rows: [
                            { label: "Order", value: m.order },
                            { label: "Bottle (observed)", value: m.observed },
                            { label: "Requisition", value: m.requisition },
                          ],
                        })
                      }
                    >
                      Accept with reason (lead)
                    </Button>
                  ) : !m.identity ? (
                    <span className="block text-ink-secondary">Only the accessioning lead or a supervisor can accept it.</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <CountProblems item={item} permissions={permissions} onRaise={onRaise} onAccept={setAccepting} />

        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-line pt-3">
          <p className="min-w-0 flex-1 text-sm">
            <span className="text-ink-muted">Bottle label as typed by staff (not a photo): </span>
            <span className={cn("text-ink", c.handwritten && "italic")}>{c.labelText}</span>
            {c.conditionNote ? <span className="block text-ink-secondary">Condition: {c.conditionNote}</span> : null}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="quiet" aria-expanded={labelOpen} onClick={() => setLabelOpen((o) => !o)} icon={<ChevronDown className={cn("transition-transform", labelOpen && "rotate-180")} />}>
              {labelOpen ? "Hide label card" : "Label card"}
            </Button>
            {canEdit ? (
              <Button size="sm" variant="quiet" icon={<Pencil />} onClick={() => setEditing(true)}>
                Edit observation
              </Button>
            ) : null}
          </div>
        </div>
        {labelOpen ? <BottleLabel observed={c.observed} handwritten={c.handwritten} seq={c.seq} className="animate-rise-in max-w-[220px]" /> : null}
        <RequisitionFields item={item} />
      </div>

      {editing ? <ObservationDialog item={item} container={c} onClose={() => setEditing(false)} /> : null}
      {accepting ? <AcceptDiscrepancyDialog target={accepting} onClose={() => setAccepting(null)} /> : null}
    </section>
  );
}

// ------------------------------------------------------------------ observation editing (stale-safe)

const OBS_FIELDS: { key: string; label: string; mono?: boolean; hint?: string }[] = [
  { key: "patient_name", label: "Patient name (as written)" },
  { key: "birth_date", label: "Date of birth (as written)", mono: true },
  { key: "mrn", label: "MRN (if on the label)", mono: true },
  { key: "part_designation", label: "Part designation", mono: true },
  { key: "site_text", label: "Site (as written)", hint: 'Type exactly what the label says, e.g. "L dorsal forearm".' },
  { key: "laterality", label: "Side, if written separately" },
  { key: "procedure", label: "Procedure (as written)" },
  { key: "collection_date", label: "Collection date (if on the label)", mono: true },
];

function ObservationDialog({ item, container: c, onClose }: { item: ItemDetail; container: ContainerView; onClose: () => void }) {
  const conflict = useConflict();
  const backToScan = useBackToScan();
  const [baseVersion, setBaseVersion] = useState(c.version);
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {};
    for (const { key } of OBS_FIELDS) f[key] = c.observed[key] ?? "";
    f.condition_note = c.conditionNote ?? "";
    return f;
  });
  const [initial, setInitial] = useState<Record<string, string>>(() => ({ ...form }));
  /** Re-base on the colleague's saved version, keeping only the fields you changed. */
  const loadLatest = (current: Record<string, unknown> | null) => {
    if (!current) return;
    let theirs: Record<string, unknown> = {};
    try {
      theirs = JSON.parse(String(current.observed_label ?? "{}")) as Record<string, unknown>;
    } catch {
      theirs = {};
    }
    const latest: Record<string, string> = {};
    for (const { key } of OBS_FIELDS) latest[key] = theirs[key] === null || theirs[key] === undefined ? "" : String(theirs[key]);
    latest.condition_note = current.condition_note === null || current.condition_note === undefined ? "" : String(current.condition_note);
    setForm((mine) => {
      const next = { ...latest };
      for (const k of Object.keys(mine)) if (mine[k] !== initial[k]) next[k] = mine[k];
      return next;
    });
    setInitial(latest);
    if (typeof current.version === "number") setBaseVersion(current.version);
  };
  const dirty = Object.keys(form).some((k) => form[k] !== initial[k]);
  useUnsavedChanges(dirty, `${item.displayId} container ${c.seq} observation`);
  const save = useCommand<{ version: number }, unknown>("intake.recordObservation", {
    successToast: `Observation saved for container ${c.seq}. Check it again against the physical bottle.`,
    conflict: false,
    errorToast: false,
    onSuccess: () => {
      onClose();
      backToScan();
    },
    onError: (err) => {
      if (err.code !== "CONFLICT") return;
      const current = ((err.details as { current?: Record<string, unknown> } | undefined)?.current ?? {}) as Record<string, unknown>;
      let theirs: Record<string, unknown> = {};
      try {
        theirs = JSON.parse(String(current.observed_label ?? "{}")) as Record<string, unknown>;
      } catch {
        theirs = {};
      }
      const fields = OBS_FIELDS.filter((f) => (theirs[f.key] ?? "") !== (form[f.key] ?? "")).map((f) => ({
        field: f.key,
        label: f.label,
        theirs: (theirs[f.key] as string | null | undefined) ?? null,
        yours: form[f.key] || null,
      }));
      if ((current.condition_note ?? "") !== form.condition_note) fields.push({ field: "condition_note", label: "Condition note", theirs: (current.condition_note as string | null) ?? null, yours: form.condition_note || null });
      conflict.open({
        message: err.message,
        details: err.details,
        subject: `Provisional intake item ${item.displayId}, container ${c.seq}`,
        fields: fields.length ? fields : [{ field: "version", label: "Version", theirs: current.version, yours: baseVersion }],
        onLoadLatest: (latest) => loadLatest(latest ?? current),
        onDiscard: () => onClose(),
      });
    },
  });
  const submit = () => {
    const observed: Record<string, string | null> = {};
    for (const { key } of OBS_FIELDS) if (form[key] !== initial[key]) observed[key] = form[key].trim() || null;
    if (form.condition_note !== initial.condition_note) observed.condition_note = form.condition_note.trim() || null;
    void save.run({ containerId: c.id, expectedVersion: baseVersion, observed });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Edit observation: container ${c.seq}`}
      description="Type what the physical label says. Saving clears any earlier check of this container; check it again afterwards."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep current observation
          </Button>
          <Button variant="primary" loading={save.pending} loadingLabel="Saving..." disabled={!dirty} onClick={submit}>
            Save observation
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-subtle px-3 py-2 text-sm">
        <ProvisionalChip id={item.displayId} href={false} />
        <span className="font-semibold">Container {c.seq}</span>
        {c.designation ? <span>Part {c.designation}</span> : null}
        {c.orderRef ? <IdChip kind="ORD" id={c.orderRef} /> : null}
        <span className="text-ink-muted">Editing version {baseVersion}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        {OBS_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <Input size="sm" mono={f.mono} value={form[f.key]} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Condition note" className="col-span-2 max-md:col-span-1">
          <Textarea rows={2} value={form.condition_note} onChange={(e) => setForm((s) => ({ ...s, condition_note: e.target.value }))} />
        </Field>
      </div>
      <CommandError error={save.error && save.error.code !== "CONFLICT" ? save.error : null} className="mt-2" />
    </Dialog>
  );
}
