"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleHelp, Pencil, TriangleAlert, UserRoundCheck } from "lucide-react";
import type { ContainerView, ItemDetail, BenchPermissions } from "@/server/queries/intake";
import type { ComparisonRow } from "@/server/domain/intake";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { AlertBanner } from "@/components/ui/alert-banner";
import { IdChip, ProvisionalChip } from "@/components/domain/chips";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useConflict } from "@/lib/client/conflict";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { cn } from "@/lib/cn";
import { BottleLabel } from "./bottle-label";
import type { ClarificationDraft } from "./clarification-dialog";
import { AcceptDiscrepancyDialog, type AcceptTarget } from "./accept-dialog";

const IDENTITY_FIELDS = new Set(["patient_name", "birth_date", "mrn"]);

function categoryFor(field: string): ClarificationDraft["category"] {
  if (IDENTITY_FIELDS.has(field)) return "identity_conflict";
  if (field === "site") return "site";
  if (field === "laterality") return "laterality";
  if (field === "procedure") return "biopsy_method";
  return "other";
}

function accessionedOrCanceled(item: ItemDetail): boolean {
  return item.status === "accessioned" || item.status === "canceled";
}

function cellText(c: ComparisonRow["observed"]): string | null {
  if (!c.original) return null;
  return c.note ? `${c.original} (${c.note})` : c.original;
}

/** Pre-filled clarification for one differing row (that field only), with a hold scoped per the storyline. */
export function draftForRow(item: ItemDetail, c: ContainerView, row: ComparisonRow): ClarificationDraft {
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

function StatusCell({ row, sideDiffers }: { row: ComparisonRow; sideDiffers?: boolean }) {
  if (row.field === "site" && row.status === "match") {
    // Site is compared without the side ("Right dorsal forearm" vs "L dorsal forearm" share the location); the side has its own row.
    return (
      <span className="block">
        <span className="inline-flex items-center gap-1 text-success-fg">
          <CircleCheck className="size-4 shrink-0" aria-hidden />
          Same location
        </span>
        {sideDiffers ? (
          <span className="flex items-center gap-1 text-xs font-medium text-warning-fg">
            <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
            Side differs
          </span>
        ) : (
          <span className="block text-xs text-ink-muted">Side compared below</span>
        )}
      </span>
    );
  }
  if (row.status === "differs") {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-warning-fg">
        <TriangleAlert className="size-4 shrink-0 text-warning-solid" aria-hidden />
        Differs
      </span>
    );
  }
  if (row.status === "match") {
    return (
      <span className="inline-flex items-center gap-1 text-success-fg">
        <CircleCheck className="size-4 shrink-0" aria-hidden />
        Same
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-ink-muted" title={row.note ?? undefined}>
      <CircleHelp className="size-4 shrink-0" aria-hidden />
      Not compared
    </span>
  );
}

function Value({ cell, missing }: { cell: ComparisonRow["order"]; missing: string }) {
  if (!cell.original) return <span className="text-xs text-ink-muted">{missing}</span>;
  // "448210 (EMA-SIM Sunrise Coast)": the MRN on the first line, its tenant (an MRN is unique only within one source) below.
  const tenant = /^(\S+) \(([^()]+)\)$/.exec(cell.original);
  if (tenant && /\d/.test(tenant[1])) {
    return (
      <span className="block min-w-0">
        <span className="id-mono text-ink">{tenant[1]}</span>
        <span className="block text-xs text-ink-muted">{tenant[2]}</span>
      </span>
    );
  }
  return (
    <span className="block min-w-0">
      <span className="break-words text-ink">{cell.original}</span>
      {cell.note ? <span className="block text-xs text-ink-muted">{cell.note}</span> : null}
    </span>
  );
}

interface VerifyResult {
  state: "verified" | "discrepancy";
  discrepancies: { field: string; label: string; orderValue: string | null; observedValue: string | null }[];
  stillOpen: { field: string; label: string; reason: string }[];
  accepted: { field: string; label: string }[];
}

function verifyToast(seq: number, r: VerifyResult): string {
  if (r.state === "verified") return `Container ${seq}: staff verified against the physical container`;
  const parts: string[] = [];
  if (r.discrepancies.length) parts.push(`discrepancy recorded (${r.discrepancies.map((d) => d.label.toLowerCase()).join(", ")}); both values kept`);
  if (r.stillOpen.length) parts.push(`recorded mismatch still open (${r.stillOpen.map((d) => d.label.toLowerCase()).join(", ")})`);
  return `Container ${seq}: ${parts.join("; ")}`;
}

export function ComparisonPanel({
  item,
  container: c,
  permissions,
  now,
  onRaise,
}: {
  item: ItemDetail;
  container: ContainerView;
  permissions: BenchPermissions;
  now: string;
  onRaise: (draft: ClarificationDraft) => void;
}) {
  const parts = useMemo(() => item.orders.flatMap((o) => o.parts.map((p) => ({ id: p.id, label: `${o.sourceOrderId} · part ${p.designation} (${p.siteText})` }))), [item.orders]);
  const [partId, setPartId] = useState<string>(c.orderPartId ?? parts[0]?.id ?? "");
  useEffect(() => setPartId(c.orderPartId ?? parts[0]?.id ?? ""), [c.id, c.orderPartId, parts]);
  const [editing, setEditing] = useState(false);
  const [accepting, setAccepting] = useState<AcceptTarget | null>(null);
  const verify = useCommand<VerifyResult, { containerId: string; expectedVersion: number; orderPartId: string }>("intake.verifyContainer", {
    successToast: (r) => verifyToast(c.seq, r),
    errorToast: false,
  });
  const acceptTarget = (m: ContainerView["openMismatches"][number]): AcceptTarget => ({
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
  });
  const heldOpen = c.openMismatches.filter((m) => m.holdReason);
  const canAccept = (m: ContainerView["openMismatches"][number]) => permissions.acceptDiscrepancy && !m.identity && !accessionedOrCanceled(item) && !(c.clarification && c.clarification.state !== "resolved");

  const accessioned = item.status === "accessioned" || item.status === "canceled";
  // The order id is already in the card title chip; the column says which version is compared.
  const orderHeader = c.orderRef ? `Order v${c.currentOrderVersion ?? "?"}` : item.orders.length ? "Order (choose the part)" : "Order (not linked)";
  const tenant = item.orders.find((o) => o.sourceOrderId === c.orderRef)?.tenantName ?? item.orders[0]?.tenantName ?? null;
  const differing = c.comparison.filter((r) => r.status === "differs");
  const sideDiffers = c.comparison.some((r) => r.field === "laterality" && r.status === "differs");
  const live = (q: ItemDetail["clarifications"][number]) => q.state !== "canceled";
  const openFirst = (list: ItemDetail["clarifications"]) => list.find((q) => q.state !== "resolved") ?? list[0] ?? null;
  const identityClar = openFirst(item.clarifications.filter((q) => live(q) && q.category === "identity_conflict"));
  const fieldClar = openFirst(
    item.clarifications.filter((q) => live(q) && q.category !== "identity_conflict" && (q.containerId === c.id || (!!c.orderPartId && q.orderPartId === c.orderPartId))),
  );
  const coveringFor = (row: ComparisonRow) => (IDENTITY_FIELDS.has(row.field) ? identityClar : fieldClar);
  const pill =
    c.verificationState === "verified" ? (
      <StatusPill tone="success">Staff verified</StatusPill>
    ) : c.verificationState === "discrepancy" ? (
      <StatusPill tone="warning">Discrepancy recorded</StatusPill>
    ) : (
      <StatusPill tone="neutral">Not yet verified</StatusPill>
    );

  const verifyDisabledReason = !permissions.verify
    ? "Not allowed for your demo role. Accessioners, the accessioning lead and supervisors verify containers."
    : accessioned
      ? "Already accessioned. Post-accession questions go through a correction review."
      : !partId
        ? !item.office
          ? "No order can be looked up: the office is not in the office directory, so there is no source tenant to search. Accession stays blocked; raise a clarification with the office. Adding an office is not available in this demo."
          : "No source order was found for the requisition's order id in this office's tenant, so there is no order part to compare with. Accession stays blocked; raise a clarification with the office."
        : null;

  return (
    <Card
      id={`container-${c.seq}`}
      headingLevel={3}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Container {c.seq}
          {c.designation ? <span className="text-ink-secondary">· Part {c.designation}</span> : null}
          {c.orderRef ? <IdChip kind="ORD" id={c.orderRef} tenant={tenant ?? undefined} /> : null}
          {pill}
        </span>
      }
      description={
        // Exceptions first: when fields differ, say which ones at the top of the card (the rows keep their fixed order).
        differing.length && !accessioned ? (
          <span className="inline-flex items-start gap-1.5 text-warning-fg">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
            <span>
              <span className="font-medium">
                {differing.length === 1 ? "1 field differs" : `${differing.length} fields differ`}:{" "}
                {differing.map((r) => `${r.label} (order “${r.order.original ?? "not stated"}”, bottle “${r.observed.original ?? "not on label"}”)`).join("; ")}.
              </span>{" "}
              <span className="text-ink-secondary">Both values are kept; nothing is corrected automatically.</span>
            </span>
          </span>
        ) : (
          "Order (source), bottle as observed by staff, and paper requisition, shown as written. Abbreviations are normalized only to compare."
        )
      }
      bodyClassName="space-y-3"
    >
      {/* On a tablet the table comes first (the rows are what is compared); the label card follows it. */}
      <div className="flex gap-3 max-xl:flex-col-reverse">
        <div className="flex shrink-0 flex-col gap-2 max-xl:flex-row max-xl:flex-wrap max-xl:items-start">
          <BottleLabel observed={c.observed} handwritten={c.handwritten} seq={c.seq} className="max-w-[164px]" />
          {c.conditionNote ? <p className="max-w-[220px] text-xs text-ink-secondary">Condition: {c.conditionNote}</p> : null}
          {permissions.edit && !accessioned ? (
            <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(true)}>
              Edit observation
            </Button>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <table className="w-full min-w-[520px] table-fixed border-collapse text-sm">
            <caption className="sr-only">
              Field comparison for {item.displayId} container {c.seq}: order, observed container and requisition
            </caption>
            <thead>
              <tr className="bg-surface-subtle text-left align-bottom text-xs text-ink-secondary">
                <th scope="col" className="w-[7.25rem] px-2 py-1.5 font-medium">Field</th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  {orderHeader}
                  <span className="block font-normal text-ink-muted">Source</span>
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Bottle label
                  <span className="block font-normal text-ink-muted">Staff entry</span>
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Requisition
                  {/* The document id (REQ-…) is in the Source order card; identifiers never wrap, so it is not squeezed in here. */}
                  <span className="block font-normal text-ink-muted">{item.requisition ? "Paper, as read" : "Not on file"}</span>
                </th>
                <th scope="col" className="w-[8.75rem] px-2 py-1.5 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {c.comparison.map((row) => {
                const cover = coveringFor(row);
                const covered = !!cover;
                return (
                  <tr key={row.field} className={cn("border-t border-line align-top", row.status === "differs" && "bg-warning-bg")}>
                    <th scope="row" className="px-2 py-1 text-left font-medium whitespace-nowrap text-ink">
                      {row.label}
                      {row.field === "site" ? <span className="block text-xs font-normal text-ink-muted">location, no side</span> : null}
                    </th>
                    <td className="px-2 py-1">
                      <Value cell={row.order} missing="Not stated" />
                    </td>
                    <td className="px-2 py-1">
                      <Value cell={row.observed} missing="Not on label" />
                    </td>
                    <td className="px-2 py-1">
                      <Value cell={row.requisition} missing="Not stated" />
                    </td>
                    <td className="px-2 py-1">
                      <StatusCell row={row} sideDiffers={sideDiffers} />
                      {row.status === "differs" && row.note ? <span className="block text-xs text-ink-secondary">{row.note}</span> : null}
                      {row.status === "differs" && c.acceptedMismatches.some((a) => a.field === row.field) && !c.openMismatches.some((m) => m.field === row.field)
                        ? (() => {
                            const a = c.acceptedMismatches.find((x) => x.field === row.field)!;
                            return (
                              <span className="mt-1 block text-xs text-ink-secondary">
                                Accepted by {a.byName ?? "Unknown"}
                                {a.at ? (
                                  <>
                                    {" "}
                                    at <Timestamp iso={a.at} now={now} />
                                  </>
                                ) : null}
                                : {a.reason ?? "no reason recorded"}
                              </span>
                            );
                          })()
                        : null}
                      {row.status === "differs" && !accessioned ? (
                        covered ? (
                          <span className="mt-1 block text-xs text-ink-secondary">
                            Covered by <IdChip kind="CLR" id={cover!.displayId} href={`/clarifications?selected=${encodeURIComponent(cover!.displayId)}`} />
                            {IDENTITY_FIELDS.has(row.field) ? <span className="block">Identity question: all containers</span> : null}
                          </span>
                        ) : permissions.raiseClarification ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="mt-1 h-7 px-2"
                            aria-label={`Raise clarification for ${row.label.toLowerCase()} on container ${c.seq}`}
                            onClick={() => onRaise(draftForRow(item, c, row))}
                          >
                            Raise clarification
                          </Button>
                        ) : null
                      ) : null}
                      {row.status === "differs" && !accessioned && !covered
                        ? (() => {
                            const m = c.openMismatches.find((x) => x.field === row.field && !x.holdReason);
                            return m && canAccept(m) ? (
                              <Button
                                size="sm"
                                variant="quiet"
                                className="mt-1"
                                aria-label={`Accept the recorded ${row.label.toLowerCase()} mismatch on container ${c.seq} with a reason (lead)`}
                                onClick={() => setAccepting(acceptTarget(m))}
                              >
                                Accept with reason (lead)
                              </Button>
                            ) : null;
                          })()
                        : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {heldOpen.length && !accessioned ? (
        <AlertBanner tone="warning" title={`Recorded mismatch still open on container ${c.seq}`}>
          <ul className="space-y-1.5">
            {heldOpen.map((m) => (
              <li key={m.id}>
                <span className="font-medium">{m.label}</span>: recorded as order &ldquo;{m.order ?? "not stated"}&rdquo;, bottle &ldquo;{m.observed ?? "not on label"}&rdquo;
                {m.orderVersion ? ` (order v${m.orderVersion})` : ""} by {m.detectedByName ?? "Unknown"} at <Timestamp iso={m.detectedAt} now={now} />. The values now agree, but this
                finding stays open: {m.holdReason}.
                {canAccept(m) ? (
                  <Button size="sm" variant="secondary" className="ml-2" onClick={() => setAccepting(acceptTarget(m))}>
                    Accept with reason (lead)
                  </Button>
                ) : !permissions.acceptDiscrepancy && !m.identity ? (
                  <span className="block text-xs text-ink-secondary">Only the accessioning lead or a supervisor can accept it.</span>
                ) : null}
              </li>
            ))}
          </ul>
        </AlertBanner>
      ) : null}

      {c.orderChangedSinceVerification ? (
        <AlertBanner tone="warning" title={`Order changed since this container was checked (v${c.lastVerification?.orderVersion} → v${c.currentOrderVersion})`}>
          The comparison above uses the current order version. Check the container again and record a new verification.
        </AlertBanner>
      ) : null}

      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 border-t border-line pt-3">
        {parts.length > 1 || (!c.orderPartId && parts.length > 0) ? (
          <Field
            label="Order part this container belongs to"
            hint={
              !c.orderPartId
                ? "Not matched automatically. Choose the part, then check the container."
                : c.linkBasis === "staff_match"
                  ? "Linked by staff. Change it if the link is wrong, then check again."
                  : c.linkBasis === "single_part_order"
                    ? "Suggested because the order has one part and the bottle shows none. Change it if wrong."
                    : "Suggested from the bottle's part designation. Change it if wrong."
            }
            className="w-80"
          >
            <Select size="sm" value={partId} onChange={(e) => setPartId(e.target.value)}>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="flex max-w-[60ch] flex-col items-start gap-1">
          <Button
            variant={c.verificationState === "unverified" ? "primary" : "secondary"}
            icon={<UserRoundCheck />}
            loading={verify.pending}
            loadingLabel="Recording..."
            disabled={!!verifyDisabledReason}
            reasonId={verifyDisabledReason ? `verify-reason-${c.id}` : undefined}
            data-intake-step={c.verificationState === "unverified" ? "verify" : undefined}
            onClick={() => void verify.run({ containerId: c.id, expectedVersion: c.version, orderPartId: partId })}
          >
            {c.verificationState === "unverified" ? "Staff verified against physical container" : "Record a new check of the physical container"}
          </Button>
          <p id={verifyDisabledReason ? `verify-reason-${c.id}` : undefined} className="max-w-[56ch] text-xs text-ink-secondary">
            {verifyDisabledReason ?? "Records who checked the bottle and when. A scan or lookup identifies the record only; it never sets this."}
          </p>
          <CommandError error={verify.error} />
        </div>
        <div className="ml-auto text-right text-xs text-ink-secondary">
          {c.lastVerification ? (
            <>
              Last check by {c.lastVerification.byName ?? "Unknown"}
              {c.lastVerification.origin === "demo" ? " (guided demo rehearsal, not a real check)" : ""} at <Timestamp iso={c.lastVerification.at} now={now} /> against{" "}
              {c.orderRef ?? "the order"} v{c.lastVerification.orderVersion}: {c.lastVerification.result === "verified" ? "all compared fields agree" : "discrepancy recorded"}
            </>
          ) : c.verifiedAt ? (
            <>
              Checked by {c.verifiedByName ?? "Unknown"} at <Timestamp iso={c.verifiedAt} now={now} /> (seeded history; the field comparison was not recorded)
            </>
          ) : (
            "No staff check recorded yet."
          )}
          {differing.length && c.verificationState === "unverified" ? (
            <span className="mt-0.5 block text-warning-fg">Checking the container records the differing {differing.length === 1 ? "field" : "fields"} as a discrepancy.</span>
          ) : null}
        </div>
      </div>

      {editing ? <ObservationDialog item={item} container={c} onClose={() => setEditing(false)} /> : null}
      {accepting ? <AcceptDiscrepancyDialog target={accepting} onClose={() => setAccepting(null)} /> : null}
    </Card>
  );
}

const OBS_FIELDS: { key: string; label: string; mono?: boolean; hint?: string }[] = [
  { key: "patient_name", label: "Patient name (as written)" },
  { key: "birth_date", label: "Date of birth (as written)", mono: true },
  { key: "mrn", label: "MRN (if on the label)", mono: true },
  { key: "part_designation", label: "Part designation", mono: true },
  { key: "site_text", label: "Site (as written)", hint: "Type exactly what the label says, e.g. \"L dorsal forearm\"." },
  { key: "laterality", label: "Side, if written separately" },
  { key: "procedure", label: "Procedure (as written)" },
  { key: "collection_date", label: "Collection date (if on the label)", mono: true },
];

function ObservationDialog({ item, container: c, onClose }: { item: ItemDetail; container: ContainerView; onClose: () => void }) {
  const conflict = useConflict();
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
    successToast: `Observation saved for container ${c.seq}. Verify it again against the physical container.`,
    conflict: false,
    errorToast: false,
    onSuccess: () => onClose(),
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
      description="Type what the physical label says. Saving clears any earlier verification of this container; check it again afterwards."
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
