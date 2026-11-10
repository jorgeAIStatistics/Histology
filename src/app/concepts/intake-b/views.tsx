"use client";

import { useState, type ReactNode } from "react";
import type { ContainerView, IntakeBench, ItemDetail, RelatedView } from "@/server/queries/intake";
import { INTAKE_STATUS } from "@/lib/domain";
import s from "./atlas.module.css";
import {
  DOCTOR_SWATCH,
  cap,
  clarState,
  differingRows,
  findingFor,
  holdBlocksText,
  holdScopeShort,
  listText,
  nextStepFor,
  openLinesFor,
  partQuestion,
  partsOf,
  relatedState,
  reviewOwner,
  routingState,
  sequenceFor,
  timeShort,
  type Finding,
  type NodeKey,
  type OpenLine,
  type PartRef,
} from "./model";
import { Bottle, MissingBottle, OrderRecord, Requisition } from "./objects";

type Select = (k: NodeKey) => void;
type ComparisonRow = ContainerView["comparison"][number];

const ID_RE = /\b(\d{4}-\d{2}-\d{2}|INT-\d{4}-\d{3}|ORD-\d{4,6}|CLR-\d{3,5}|REL-\d{3,5}|H-\d{3,5}|ENC-\d{3,6}|D\d{2}-\d{5}|CR-\d{4}-\d{2}|REQ-SIM-ORD-\d+|LSC-\d+)\b/;

/** Plain text with every identifier set in the mono face and kept on one line. */
export function withIds(text: string | null | undefined): ReactNode {
  if (!text) return text ?? null;
  const parts = text.split(new RegExp(ID_RE.source, "g"));
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <span key={i} className={s.idText}>
        {p}
      </span>
    ) : (
      p
    ),
  );
}

/* ================================================================= shared pieces */

function Prov({ id }: { id: string }) {
  return (
    <span className={s.prov} title="Provisional intake item. Not an accession number.">
      <span className={s.provWord}>Provisional</span>
      <span className={s.provId}>{id}</span>
    </span>
  );
}

function Doctor({ name, color }: { name: string; color: string | null }) {
  return (
    <span className={s.doctor}>
      <span className={s.swatch} style={{ background: color ? DOCTOR_SWATCH[color] ?? "#777" : "#777" }} aria-hidden />
      {name}
    </span>
  );
}

function IdentityHeader({
  item,
  title,
  question,
  idLine,
}: {
  item: ItemDetail;
  title: ReactNode;
  question: ReactNode;
  idLine?: ReactNode;
}) {
  const order = item.orders[0];
  const r = item.routing;
  const doc = r ? r.final ?? r.suggested : null;
  return (
    <header className={s.identity}>
      <div className={s.idLine}>
        {idLine ?? (
          <>
            <Prov id={item.displayId} />
            {item.orders.map((o) => (
              <span key={o.id} className={s.idPair}>
                <span className={s.idLbl}>Order</span>
                <span className={s.idMono}>{o.sourceOrderId}</span>
                <span className={s.idSrc}>{o.tenantName}</span>
              </span>
            ))}
            {item.delivery ? (
              <span className={s.idPair}>
                <span className={s.idLbl}>Courier</span>
                <span className={s.idMono}>{item.delivery.displayId}</span>
              </span>
            ) : null}
            <span className={s.idPair}>
              <span className={s.idLbl}>Status</span>
              <span>{(INTAKE_STATUS as Record<string, string>)[item.status] ?? item.status}</span>
            </span>
            {item.ownerName ? (
              <span className={s.idPair}>
                <span className={s.idLbl}>Owner</span>
                <span>{item.ownerName}</span>
              </span>
            ) : null}
          </>
        )}
      </div>
      <div className={s.idMain}>
      <h1 className={s.display}>
        <span className={s.d1}>{title}</span>
        <span className={s.d2}>{question}</span>
      </h1>
      <dl className={s.facts}>
        <dt>Date of birth</dt>
        <dd className={s.mono}>{item.patient?.birthDate ?? "Unknown"}</dd>
        <dt>MRN</dt>
        <dd>
          {item.patient ? (
            <>
              <span className={s.mono}>{item.patient.mrn}</span>
              <span className={s.ddSub}>, {item.patient.tenantName}</span>
            </>
          ) : (
            "Unknown"
          )}
        </dd>
        <dt>Ordering clinician</dt>
        <dd>
          {order?.clinicianName ?? "Unknown"}
          <span className={s.ddSub}>, {item.office?.name ?? item.observedOfficeText ?? "Unknown office"}</span>
        </dd>
        <dt>Assigned dermatopathologist</dt>
        <dd>
          {doc ? <Doctor name={doc.name} color={doc.color} /> : <span className={s.toneException}>None, routing exception</span>}
          <span className={s.ddSub}>
            {r ? (r.status === "exception" ? ", no approved rule for this office" : `, ${routingState(r.status).toLowerCase()}, rule set v${r.ruleSetVersion ?? "Unknown"}`) : ", not routed yet"}
          </span>
        </dd>
      </dl>
      </div>
    </header>
  );
}

function FindingBlock({ finding, lines, onSelect, relKey }: { finding: Finding; lines: OpenLine[]; onSelect?: Select; relKey?: (id: string) => NodeKey | null }) {
  return (
    <section className={s.finding} aria-label="Current finding">
      <div className={s.findingText} data-tone={finding.tone}>
        <p className={s.sentence}>{withIds(finding.sentence)}</p>
        {finding.context ? <p className={s.context}>{withIds(finding.context)}</p> : null}
      </div>
      {lines.length ? (
        <ul className={s.openList} aria-label="Open on this item">
          {lines.map((l) => {
            const k = l.id && relKey ? relKey(l.id) : null;
            const inner = <OpenInner tone={l.tone} text={l.text} id={l.id} note={l.note} />;
            return (
              <li key={l.key}>
                {k && onSelect ? (
                  <button type="button" className={s.openRow} onClick={() => onSelect(k)}>
                    {inner}
                  </button>
                ) : (
                  <span className={s.openRow}>{inner}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function OpenInner({ tone, text, id, note }: { tone: string; text: ReactNode; id: string | null; note: ReactNode }) {
  return (
    <>
      <span className={s.openText}>
        <span className={s.openTone} data-tone={tone} aria-hidden />
        {typeof text === "string" ? withIds(text) : text}
      </span>
      {id ? <span className={s.openId}>{id}</span> : <span />}
      {note ? <span className={s.openNote}>{typeof note === "string" ? withIds(note) : note}</span> : null}
    </>
  );
}

function accessionWhy(item: ItemDetail): string {
  const b = item.readiness.blockers[0];
  if (!b) return "";
  if (b.code === "related_pending") {
    const r = item.related.find((x) => x.status === "pending_review");
    const owner = r ? reviewOwner(item, r) : null;
    return `Waits for ${r?.displayId ?? "the related-order review"}${owner ? `, ${owner}'s review` : ""}.`;
  }
  const short: Record<string, string> = {
    identity_unresolved: "Identity conflict must be resolved by a lead first",
    container_unverified: "A container is not yet checked against the bottle",
    missing_container: "A part has no container; ask the office first",
    routing_not_confirmed: "Routing is not accepted yet",
    routing_exception: "No dermatopathologist assigned yet",
    hold: "An active hold blocks the request",
    discrepancy_uncovered: "A difference has no clarification yet",
  };
  const codes = [...new Set(item.readiness.blockers.map((x) => x.code))];
  const more = codes.length - 1;
  return `${short[b.code] ?? b.message.replace(/^INT-\d{4}-\d{3}:?\s*/, "").replace(/\.$/, "")}${more > 0 ? `, and ${more} more` : ""}.`;
}

function NextBand({ bench, item }: { bench: IntakeBench; item: ItemDetail }) {
  const ns = nextStepFor(item, bench);
  const [previewed, setPreviewed] = useState(false);
  const detail = previewed ? "Preview only. Nothing was sent or saved." : ns.primary ? ns.primary.detail : ns.ownerNote;
  return (
    <div className={s.band} role="region" aria-label="Next step">
      <div className={s.bandTop}>
        <span className={s.bandLabel} aria-live="polite">
          <strong>{ns.primary ? `Next for ${bench.actor.name}.` : `Nothing waiting on ${bench.actor.name} here.`}</strong> {withIds(detail)}
        </span>
        <span className={s.previewTag}>Concept preview: buttons do not save</span>
      </div>
      <div className={s.bandRow}>
        <div className={s.bandMain}>
          {ns.primary ? (
            <button type="button" className={s.pill} onClick={() => setPreviewed(true)}>
              {withIds(ns.primary.label)}
            </button>
          ) : (
            <span className={s.bandOwner}>{ns.owner ? `Next step belongs to ${ns.owner}` : "No open task on this item"}</span>
          )}
        </div>
        <div className={s.bandGate}>
          <span id="b-acc-why" className={s.bandDetail}>
            {item.accession
              ? withIds(`Issued ${item.accession.number} by ${item.accession.issuedBy} (simulated).`)
              : ns.accession.allowed
                ? "Ready. The number comes from the source system."
                : withIds(accessionWhy(item))}
          </span>
          <button type="button" className={s.pillGhost} disabled={!ns.accession.allowed} aria-describedby="b-acc-why">
            Request accession <span className={s.pillSim}>(simulated)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function RecordMeta({ item }: { item: ItemDetail }) {
  const o = item.orders[0];
  return (
    <section className={s.meta} aria-label="Record details">
      <h2 className={s.h2}>Record</h2>
      <dl className={s.metaGrid}>
        <div>
          <dt>Received</dt>
          <dd>
            {timeShort(item.receivedAt)} by {item.receivedByName ?? "Unknown"}
            {item.delivery ? (
              <>
                , courier <span className={s.mono}>{item.delivery.displayId}</span>
              </>
            ) : null}
          </dd>
        </div>
        {o ? (
          <div>
            <dt>Order imported</dt>
            <dd>
              {timeShort(o.importedAt)} from {o.tenantName} (simulated), version {o.sourceVersion}
            </dd>
          </div>
        ) : null}
        {item.routing ? (
          <div>
            <dt>Routing</dt>
            <dd>
              {item.routing.explanation}
              {item.routing.decidedByName ? ` ${routingState(item.routing.status)} by ${item.routing.decidedByName}, ${timeShort(item.routing.decidedAt)}.` : ""}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Last change</dt>
          <dd>
            {timeShort(item.updatedAt)} by {item.updatedByName ?? "Unknown"}, version {item.version}
          </dd>
        </div>
      </dl>
      {item.audit.length ? (
        <ol className={s.history} aria-label="History">
          {item.audit.slice(0, 5).map((a) => (
            <li key={a.id}>
              <span className={s.histTime}>{timeShort(a.at)}</span>
              <span>{withIds(a.summary)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/* ================================================================= evidence (part / container) */

const MISSING_TEXT: Record<"order" | "observed" | "requisition", string> = {
  order: "Not in order",
  observed: "Not on label",
  requisition: "Not stated",
};

const PAIR_TEXT: Record<string, string> = {
  "order≠observed": "bottle vs order",
  "order≠requisition": "order vs requisition",
  "observed≠requisition": "bottle vs requisition",
};

const SOURCE_NAME: Record<string, string> = { order: "Order", observed: "Bottle", requisition: "Requisition" };

/** Which source is the odd one out, in words ("Bottle differs from both"). */
function pairSummary(pairs: string[]): string {
  const count: Record<string, number> = {};
  for (const p of pairs) for (const side of p.split("≠")) count[side] = (count[side] ?? 0) + 1;
  const odd = Object.keys(count).find((k) => count[k] === pairs.length);
  if (odd && pairs.length >= 2) return `${SOURCE_NAME[odd]} differs from both`;
  if (pairs.length === 1) {
    let [a, b] = pairs[0].split("≠");
    if (b === "observed") [a, b] = [b, a];
    return `${SOURCE_NAME[a]} differs from ${SOURCE_NAME[b].toLowerCase()}`;
  }
  return cap(listText(pairs.map((p) => PAIR_TEXT[p] ?? p)));
}

function Cell({ row, which, noReq }: { row: ComparisonRow; which: "order" | "observed" | "requisition"; noReq?: boolean }) {
  const v = row[which];
  if (which === "requisition" && noReq) return <span className={s.cellMissing}>No requisition</span>;
  const differs = row.status === "differs" && row.pairs.some((p) => p.includes(which === "observed" ? "observed" : which));
  if (v.original === null) return <span className={s.cellMissing}>{MISSING_TEXT[which]}</span>;
  return (
    <span className={s.cellVal}>
      <span className={`${differs ? s.cellDiff : ""} ${row.field === "birth_date" || row.field === "part_designation" ? s.mono : ""}`}>{v.original}</span>
      {v.note ? <span className={s.cellNote}>{v.note}</span> : null}
    </span>
  );
}

const FIELD_CATEGORY: Record<string, string> = {
  laterality: "laterality",
  site: "site",
  procedure: "biopsy_method",
  patient_name: "identity_conflict",
  birth_date: "identity_conflict",
  mrn: "identity_conflict",
};

function ResultCell({ row, container, item, lateralityDiffers }: { row: ComparisonRow; container: ContainerView; item: ItemDetail; lateralityDiffers: boolean }) {
  const [raised, setRaised] = useState(false);
  if (row.status === "match") {
    return (
      <span className={s.res} data-res="match">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M2.5 7.4l3 3 6-6.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
        </svg>
        <span>
          {row.field === "site" && lateralityDiffers ? "Same location" : "Same"}
          {row.field === "site" && lateralityDiffers ? <span className={s.resSub}>Side compared separately</span> : null}
        </span>
      </span>
    );
  }
  if (row.status === "not_compared") {
    return (
      <span className={s.res} data-res="unknown">
        <span className={s.qGlyph} aria-hidden>
          ?
        </span>
        <span>
          Not compared
          <span className={s.resSub}>Only one source states it</span>
        </span>
      </span>
    );
  }
  const open = item.clarifications.filter((q) => q.state !== "resolved" && q.state !== "canceled");
  const covering =
    open.find((q) => q.containerId === container.id && q.category === FIELD_CATEGORY[row.field]) ??
    open.find((q) => q.category === FIELD_CATEGORY[row.field] && (!q.containerId || q.containerId === container.id)) ??
    null;
  const clar = covering ? { displayId: covering.displayId, state: covering.state } : container.clarification;
  return (
    <span className={s.res} data-res="differs">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <path d="M7 1.6l5.8 10.4H1.2z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 5.4v3.2M7 9.8v1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span>
        Differs
        <span className={s.resSub}>{pairSummary(row.pairs)}</span>
        {clar ? (
          <span className={s.resSub}>
            <span className={s.idText}>{clar.displayId}</span>, {clarState(clar.state).toLowerCase()}
          </span>
        ) : (
          <button type="button" className={s.linkBtn} onClick={() => setRaised(true)}>
            {raised ? "Preview only: not raised" : "Raise clarification"}
          </button>
        )}
      </span>
    </span>
  );
}

export function EvidenceView({ bench, group, part, containerId, onSelect }: { bench: IntakeBench; group: ItemDetail[]; part: PartRef; containerId: string | null; onSelect: Select }) {
  const item = part.item;
  const siblings = group.filter((g) => g.id !== item.id);
  const container = (containerId ? part.containers.find((c) => c.id === containerId) : null) ?? part.containers[0] ?? null;
  // Exceptions first: rows that differ lead, rows only one source states go last.
  const rank = (st: string) => (st === "differs" ? 0 : st === "match" ? 1 : 2);
  const rows = [...(container?.comparison ?? [])].sort((a, b) => rank(a.status) - rank(b.status));
  const latDiff = rows.some((r) => r.field === "laterality" && r.status === "differs");
  const finding = findingFor(part);
  const lines = openLinesFor(item, siblings);
  const relKey = (id: string) => {
    const r = item.related.find((x) => x.displayId === id);
    if (r) return `rel:${r.id}`;
    if (item.holds.some((h) => h.displayId === id)) return "acc";
    return null;
  };
  const verifiedLine = container
    ? container.verificationState === "unverified"
      ? "Not yet checked against the physical container. A scan only finds the record."
      : `Checked against the physical container by ${container.verifiedByName ?? "Unknown"} at ${timeShort(container.verifiedAt)}${container.verificationState === "discrepancy" ? ", discrepancy recorded" : ", staff verified"}. Compared with order version ${container.lastVerification?.orderVersion ?? "Unknown"}.`
    : null;
  return (
    <>
      <div className={s.mainInner}>
        <IdentityHeader item={item} title={`${item.patient?.name ?? "Unknown patient"}, part ${part.part.designation}`} question={partQuestion(part)} />
        <FindingBlock finding={finding} lines={lines} onSelect={onSelect} relKey={relKey} />

        <section className={s.evidence} aria-label="Evidence: three sources, kept separate">
          <div className={s.evHead}>
            <div className={s.evIntro}>
              <h2 className={s.h2}>Three sources</h2>
              <p>Kept separate. Differences first. Abbreviations normalized only to compare.</p>
            </div>
            <OrderRecord order={part.order} part={part.part} rows={rows} />
            {container ? <Bottle container={container} rows={rows} /> : <MissingBottle designation={part.part.designation} />}
            <Requisition item={item} designation={part.part.designation} rows={rows} />
            <div className={s.evIntro} data-align="end">
              <span className={s.converge} aria-hidden>
                <svg width="46" height="34" viewBox="0 0 46 34">
                  <path d="M1 3 C 20 3, 24 17, 44 17 M1 17 H44 M1 31 C 20 31, 24 17, 44 17" fill="none" stroke="currentColor" strokeWidth="1.2" />
                  <circle cx="44" cy="17" r="2" fill="currentColor" />
                </svg>
              </span>
              <h2 className={s.h2}>Agreement</h2>
            </div>
          </div>
          {container ? (
            <div className={s.table} role="table" aria-label={`Comparison for container ${container.seq}`}>
              <div className={`${s.tr} ${s.srOnlyRow}`} role="row" data-head="1">
                <span role="columnheader">Field</span>
                <span role="columnheader">Order</span>
                <span role="columnheader">Bottle</span>
                <span role="columnheader">Requisition</span>
                <span role="columnheader">Result</span>
              </div>
              {rows.map((r) => (
                <div key={r.field} className={s.tr} role="row" data-status={r.status}>
                  <span role="rowheader" className={s.fieldName}>
                    {r.label}
                  </span>
                  <span role="cell">
                    <Cell row={r} which="order" />
                  </span>
                  <span role="cell">
                    <Cell row={r} which="observed" />
                  </span>
                  <span role="cell">
                    <Cell row={r} which="requisition" noReq={!item.requisition} />
                  </span>
                  <span role="cell">
                    <ResultCell row={r} container={container} item={item} lateralityDiffers={latDiff} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className={s.context}>No container to compare. The order and requisition are shown as received.</p>
          )}
          {verifiedLine ? <p className={s.verifyLine}>{withIds(verifiedLine)}</p> : null}
        </section>
        <RecordMeta item={item} />
      </div>
      <NextBand bench={bench} item={item} />
    </>
  );
}

/* ================================================================= related-order review (a review, never a merge) */

type Decision = "single_accession_approved" | "keep_separate" | "not_related" | "escalated_to_office";

const REASON_SHORT: Record<string, (d: string) => string> = {
  same_office: () => "office",
  same_collection_day: () => "collection date",
  same_clinician: () => "ordering clinician",
  same_delivery: () => "courier delivery",
};

export function RelatedReview({ bench, group, relId, onSelect }: { bench: IntakeBench; group: ItemDetail[]; relId: string; onSelect: Select }) {
  const head = group[0];
  const rel = group.flatMap((g) => g.related).find((r) => r.id === relId) as RelatedView;
  const sides = rel.orders.map((o) => {
    const item = group.find((g) => g.orders.some((x) => x.id === o.id)) ?? null;
    return { order: o, item, parts: item ? partsOf(item).filter((p) => p.order.id === o.id) : [] };
  });
  const [decision, setDecision] = useState<Decision | "">("");
  const [reason, setReason] = useState("");
  const [recorded, setRecorded] = useState<string | null>(null);
  const can = bench.permissions.reviewRelated && rel.status === "pending_review";
  const owner = reviewOwner(head, rel) ?? "the accessioning lead";
  const ids = sides.map((x) => x.item?.displayId).filter(Boolean) as string[];
  const ords = sides.map((x) => x.order.sourceOrderId).sort();

  const DECISIONS: { value: Decision; label: string; effect: string }[] = [
    { value: "single_accession_approved", label: "Link as related: one accession", effect: `${listText(ids)} are requested together as one accession, parts kept with their original orders. ${listText(ords)} stay separate source records. Nothing is merged.` },
    { value: "keep_separate", label: "Keep separate: two cases, cross-referenced", effect: "Each item is requested as its own accession. The cross-reference is kept." },
    { value: "not_related", label: "Not related", effect: "The match was coincidental. Each item continues on its own." },
    { value: "escalated_to_office", label: "Ask the office first", effect: "Accession waits until the office answers and a decision is recorded." },
  ];
  const enc = rel.reasons.find((r) => r.code === "same_encounter");
  const pat = rel.reasons.some((r) => r.code === "same_patient_reference");
  const rest = rel.reasons.filter((r) => r.code !== "same_encounter" && r.code !== "same_patient_reference").map((r) => (REASON_SHORT[r.code] ? REASON_SHORT[r.code](r.detail) : r.label.toLowerCase()));
  const finding: Finding = {
    sentence:
      enc && pat
        ? `${listText(ords)} come from the same encounter, ${enc.detail}, under the same source patient reference.`
        : `${listText(ords)} share ${listText(rel.reasons.map((r) => r.label.toLowerCase()))}.`,
    context: `${enc && pat && rest.length ? `Same ${listText(rest)} too. ` : ""}Grouping is a review, never a merge: both orders and both provisional ids are kept whatever is decided.`,
    tone: "pending",
  };
  const holds = group.flatMap((g) => g.holds);
  const chosen = DECISIONS.find((d) => d.value === decision) ?? null;

  return (
    <>
      <div className={s.mainInner}>
        <IdentityHeader
          item={head}
          title={`${head.patient?.name ?? "Unknown patient"}, two orders`}
          question={rel.status === "pending_review" ? "Parts of one submission?" : relatedState(rel.status)}
          idLine={
            <>
              <span className={s.relChip}>
                <span className={s.provWord}>Related-order review</span>
                <span className={s.provId}>{rel.displayId}</span>
              </span>
              {ids.map((id) => (
                <Prov key={id} id={id} />
              ))}
              <span className={s.idPair}>
                <span className={s.idLbl}>Status</span>
                <span>{relatedState(rel.status)}</span>
              </span>
              <span className={s.idPair}>
                <span className={s.idLbl}>Owner</span>
                <span>{owner}</span>
              </span>
            </>
          }
        />
        <FindingBlock finding={finding} lines={[]} />

        <section className={s.bridge} aria-label="The two orders and what links them">
          {sides.map((side, i) => (
            <div key={side.order.id} className={s.bridgeSide} style={{ order: i === 0 ? 0 : 2 }}>
              <div className={s.bridgeHead}>
                <button type="button" className={s.bridgeOrder} onClick={() => onSelect(`order:${side.order.id}`)}>
                  <span className={s.idMonoLg}>{side.order.sourceOrderId}</span>
                </button>
                {side.item ? <Prov id={side.item.displayId} /> : <span className={s.cellMissing}>Intake item Unknown</span>}
              </div>
              {side.parts.map((p) => {
                const d = p.containers[0] ? differingRows(p.containers[0]) : [];
                return (
                  <button key={p.part.id} type="button" className={s.bridgePart} onClick={() => onSelect(`part:${p.part.id}`)}>
                    <span className={s.partLetterLg}>{p.part.designation}</span>
                    <span>
                      <span className={s.bridgeSite}>
                        {p.part.siteText}
                        {p.part.procedure ? `, ${p.part.procedure}` : ""}
                      </span>
                      <span className={s.bridgeState} data-tone={d.length ? "differs" : "quiet"}>
                        {p.containers[0]
                          ? d.length
                            ? `${d.map((r) => r.label).join(", ")} differs on the bottle`
                            : p.containers[0].verificationState === "verified"
                              ? "Bottle staff verified, fields agree"
                              : "Bottle not checked yet"
                          : "No container"}
                      </span>
                      {p.holds.map((h) => (
                        <span key={h.id} className={s.holdTag}>
                          <span className={s.holdWord}>Hold</span> <span className={s.idInline}>{h.displayId}</span> {holdScopeShort(h)}
                        </span>
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className={s.bridgeMid} style={{ order: 1 }}>
            <div className={s.bridgeRule} aria-hidden>
              <span className={s.bridgeRuleLabel}>{rel.displayId}</span>
            </div>
            <h2 className={s.h3}>Shared</h2>
            <ul className={s.reasonList}>
              {rel.reasons.map((r) => (
                <li key={r.code}>
                  {r.label}
                  {r.detail ? <span className={s.reasonDetail}>, {withIds(r.detail)}</span> : null}
                </li>
              ))}
            </ul>
            <h2 className={s.h3}>Stays separate</h2>
            <ul className={s.reasonList}>
              {rel.conflicts.map((r) => (
                <li key={r.code}>
                  {r.code === "separate_orders" ? "Two source orders, both kept" : r.label}
                </li>
              ))}
              <li>
                Two provisional ids, both kept
              </li>
            </ul>
          </div>
        </section>
        <p className={s.verifyLine}>
          {withIds(
            `Detected ${timeShort(rel.detectedAt)} by rule ${rel.detectionRule.split(":")[0]}. Similar names or demographics alone never propose a link.${holds.length ? ` ${holds.map((h) => `${h.displayId} stays on ${h.scopeLabel} whatever is decided`).join("; ")}.` : ""}`,
          )}
        </p>
      </div>

      <div className={s.band} role="region" aria-label="Decision">
        <fieldset className={s.decision} disabled={!can}>
          <div className={s.bandTop}>
            <legend className={s.bandLabel}>{can ? `Decision on ${rel.displayId}, recorded by ${bench.actor.name}` : `Decision on ${rel.displayId} belongs to ${owner}. Options shown for reference.`}</legend>
            <span className={s.previewTag}>Concept preview: buttons do not save</span>
          </div>
          <div className={s.decisionGrid}>
            {DECISIONS.map((d) => (
              <label key={d.value} className={s.option} data-on={decision === d.value ? "1" : "0"}>
                <input type="radio" name="b-decision" value={d.value} checked={decision === d.value} onChange={() => setDecision(d.value)} disabled={rel.duplicateRecordKind && d.value === "single_accession_approved"} />
                <span className={s.optLabel}>{d.label}</span>
              </label>
            ))}
          </div>
          <p className={s.optEffect} aria-live="polite">
            {chosen ? withIds(`If recorded: ${chosen.effect}`) : "Choose an option to see what it would do."}
          </p>
          <div className={s.decisionFoot}>
            <label className={s.reasonField}>
              <span className={s.srOnly}>Reason (required)</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={1} placeholder="Reason (required): what you checked, and why" />
            </label>
            <div className={s.decisionAct}>
              <span className={s.bandDetail} aria-live="polite">
                {recorded ? "Preview only. Nothing saved." : !decision ? "Choose an option" : !reason.trim() ? "Add a reason" : "Ready to record"}
              </span>
              <button type="button" className={s.pill} disabled={!decision || !reason.trim()} onClick={() => setRecorded(chosen?.label ?? null)}>
                Record decision
              </button>
            </div>
          </div>
        </fieldset>
      </div>
    </>
  );
}

/* ================================================================= downstream: accession and what follows (progress by tone) */

function blockerPhrase(b: { code: string; message: string }, rel: RelatedView | undefined, owner: string | null): string {
  if (b.code === "related_pending" && rel) return `${owner ? `${owner}'s` : "the lead's"} review of possible related orders ${rel.displayId}`;
  return b.message.replace(/^INT-\d{4}-\d{3}[: ]\s*/, "").replace(/\.$/, "");
}

export function DownstreamView({ bench, group, onSelect }: { bench: IntakeBench; group: ItemDetail[]; onSelect: Select }) {
  const head = group[0];
  const parts = group.flatMap((g) => partsOf(g)).sort((a, b) => a.part.designation.localeCompare(b.part.designation));
  const blockers = [...new Map(group.flatMap((g) => g.readiness.blockers).map((b) => [b.message.replace(/^INT-\d{4}-\d{3}[: ]\s*/, ""), b])).values()];
  const holds = group.flatMap((g) => g.holds);
  const accessioned = group.filter((g) => g.accession);
  const rel = group.flatMap((g) => g.related).find((r) => r.status === "pending_review" || r.status === "escalated_to_office");
  const owner = rel ? reviewOwner(head, rel) : null;
  const finding: Finding = accessioned.length
    ? { sentence: `Accession ${accessioned.map((g) => g.accession!.number).join(", ")} issued by the source system (simulated).`, context: null, tone: "clear" }
    : {
        sentence: blockers.length
          ? `Accession cannot be requested yet. It waits for ${listText(blockers.map((b) => blockerPhrase(b, rel, owner)))}.`
          : "Nothing blocks the accession request.",
        context: holds.length
          ? holds
              .map((h) => `Hold ${h.displayId} ${h.blocksAccession ? "blocks the accession request" : "does not block accession"}. It holds ${holdBlocksText(h)} for ${holdScopeShort(h)}.`)
              .join(" ")
          : null,
        tone: blockers.length ? "pending" : "clear",
      };
  const free = parts.filter((p) => !p.holds.length);
  return (
    <>
      <div className={s.mainInner}>
        <IdentityHeader
          item={head}
          title={`${head.patient?.name ?? "Unknown patient"}, accession`}
          question={accessioned.length ? "Issued" : "Not requested yet"}
          idLine={
            <>
              {group.map((g) => (
                <Prov key={g.id} id={g.displayId} />
              ))}
              <span className={s.idPair}>
                <span className={s.idLbl}>Official number</span>
                <span className={s.accGhost}>Not issued. D26 numbers come only from the source system</span>
              </span>
            </>
          }
        />
        <FindingBlock finding={finding} lines={[]} />

        <section className={s.sequence} aria-label="Each part, from receipt to tray">
          <div className={s.seqHead}>
            <h2 className={s.h2}>Each part, from receipt to tray</h2>
            <p className={s.seqLegend}>
              <span data-k="done">Done</span>
              <span data-k="current">Current</span>
              <span data-k="blocked">Waiting</span>
              <span data-k="held">Held</span>
              <span data-k="future">Later</span>
            </p>
          </div>
          {parts.map((p) => {
            const steps = sequenceFor(p);
            return (
              <div key={p.part.id} className={s.seqRow}>
                <button type="button" className={s.seqPart} onClick={() => onSelect(`part:${p.part.id}`)}>
                  <span className={s.partLetterLg}>{p.part.designation}</span>
                  <span>
                    <span className={s.bridgeSite}>{p.part.siteText}</span>
                    <span className={s.idSmall}>{p.order.sourceOrderId}</span>
                    <span className={s.idSmall}>{p.item.displayId}</span>
                  </span>
                </button>
                <ol className={s.steps}>
                  {steps.map((st) => (
                    <li key={st.key} data-state={st.state}>
                      <span className={s.stepLabel}>{st.label}</span>
                      <span className={s.stepNote}>{withIds(st.state === "held" ? `Held, ${st.note}` : st.note ?? (st.state === "future" ? "Later" : ""))}</span>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
          {free.length && holds.length && !accessioned.length ? (
            <p className={s.verifyLine}>
              {withIds(
                `${listText(free.map((p) => `Part ${p.part.designation}`))} ${free.length > 1 ? "are" : "is"} not held: once accessioned, ${free.length > 1 ? "they move" : "it moves"} on to grossing without waiting for ${listText(holds.map((h) => h.displayId))}.`,
              )}
            </p>
          ) : null}
        </section>

        <section className={s.unblock} aria-label="What unblocks it">
          <h2 className={s.h2}>What unblocks it</h2>
          <ul>
            {rel ? (
              <li>
                <button type="button" className={s.openRow} onClick={() => onSelect(`rel:${rel.id}`)}>
                  <OpenInner tone="pending" text={`${owner ?? "The accessioning lead"} records a decision on the possible related orders, with a reason`} id={rel.displayId} note="Blocks accession for both parts" />
                </button>
              </li>
            ) : null}
            {holds.map((h) => (
              <li key={h.id}>
                <span className={s.openRow}>
                  <OpenInner
                    tone="hold"
                    text={`${h.clarificationDisplayId ? `${h.clarificationDisplayId} is answered and reviewed; then ` : ""}an authorized person releases the hold, with a reason`}
                    id={h.displayId}
                    note={`${cap(holdScopeShort(h))}. Holds ${holdBlocksText(h)}`}
                  />
                </span>
              </li>
            ))}
            {blockers
              .filter((b) => b.code !== "related_pending" && b.code !== "hold")
              .map((b) => (
                <li key={b.code + b.message}>
                  <span className={s.openRow}>
                    <OpenInner tone="pending" text={b.message} id={null} note={null} />
                  </span>
                </li>
              ))}
          </ul>
        </section>
      </div>
      <NextBand bench={bench} item={bench.selected ?? head} />
    </>
  );
}

/* ================================================================= patient reference and order record */

export function PatientView({ bench, group, onSelect }: { bench: IntakeBench; group: ItemDetail[]; onSelect: Select }) {
  const head = group[0];
  const parts = group.flatMap((g) => partsOf(g));
  const containers = parts.reduce((n, p) => n + p.containers.length, 0);
  const orders = group.flatMap((g) => g.orders);
  return (
    <>
      <div className={s.mainInner}>
        <IdentityHeader
          item={head}
          title={head.patient?.name ?? "Unknown patient"}
          question={`${orders.length} order${orders.length === 1 ? "" : "s"}, ${parts.length} part${parts.length === 1 ? "" : "s"}, ${containers} container${containers === 1 ? "" : "s"}`}
          idLine={
            <>
              {group.map((g) => (
                <Prov key={g.id} id={g.displayId} />
              ))}
              <span className={s.idPair}>
                <span className={s.idLbl}>Patient reference</span>
                <span>As stated by the source system, per tenant</span>
              </span>
            </>
          }
        />
        <FindingBlock
          finding={{
            sentence:
              group.length > 1
                ? `These orders sit together here because the source gives them the same patient reference${new Set(orders.map((o) => o.encounter)).size === 1 ? " and encounter" : ""}. They are not a case.`
                : "One order from this patient reference in today's arrivals.",
            context: "Matching names or birth dates never place orders together. An official case exists only once the source system issues an accession.",
            tone: "pending",
          }}
          lines={[]}
        />
        <section className={s.evidence}>
          <div className={s.table} role="table" aria-label="Orders from this patient reference">
            <div className={`${s.tr} ${s.tr4}`} role="row" data-head="1">
              <span role="columnheader">Order</span>
              <span role="columnheader">Intake item</span>
              <span role="columnheader">Parts</span>
              <span role="columnheader">Encounter, collected</span>
            </div>
            {group.flatMap((g) =>
              g.orders.map((o) => (
                <div key={o.id} className={`${s.tr} ${s.tr4}`} role="row">
                  <span role="cell">
                    <button type="button" className={s.linkBtn} onClick={() => onSelect(`order:${o.id}`)}>
                      <span className={s.mono}>{o.sourceOrderId}</span>
                    </button>
                  </span>
                  <span role="cell">
                    <Prov id={g.displayId} />
                  </span>
                  <span role="cell">
                    {o.parts.map((p) => (
                      <span key={p.id} className={s.cellVal}>
                        Part {p.designation}: {p.siteText}
                        {p.procedure ? `, ${p.procedure}` : ""}
                      </span>
                    ))}
                  </span>
                  <span role="cell" className={s.cellVal}>
                    <span className={s.mono}>{o.encounter ?? "Unknown"}</span>
                    <span className={s.cellNote}>{o.parts[0]?.collectedAt ? `Collected ${timeShort(o.parts[0].collectedAt)}` : "Collection time Unknown"}</span>
                  </span>
                </div>
              )),
            )}
          </div>
        </section>
        <RecordMeta item={head} />
      </div>
      <NextBand bench={bench} item={bench.selected ?? head} />
    </>
  );
}

export function OrderRecordView({ bench, item, group, orderKey, onSelect }: { bench: IntakeBench; item: ItemDetail; group: ItemDetail[]; orderKey: NodeKey; onSelect: Select }) {
  const o = item.orders.find((x) => `order:${x.id}` === orderKey) ?? item.orders[0];
  const siblings = group.filter((g) => g.id !== item.id);
  return (
    <>
      <div className={s.mainInner}>
        <IdentityHeader item={item} title={`Order ${o.sourceOrderId}`} question={`${o.parts.length} part${o.parts.length === 1 ? "" : "s"} for ${item.patient?.name ?? "Unknown patient"}`} />
        <FindingBlock
          finding={{
            sentence: `Version ${o.sourceVersion} from ${o.tenantName}, imported ${timeShort(o.importedAt)}. Status at source: ${o.sourceStatus}.`,
            context: "The order is one of three sources. It is shown as imported; nothing here edits the source record.",
            tone: "clear",
          }}
          lines={openLinesFor(item, siblings)}
          onSelect={onSelect}
          relKey={(id) => {
            const r = item.related.find((x) => x.displayId === id);
            return r ? `rel:${r.id}` : null;
          }}
        />
        <section className={s.evidence}>
          <div className={s.table} role="table" aria-label="Order parts">
            <div className={`${s.tr} ${s.tr4}`} role="row" data-head="1">
              <span role="columnheader">Part</span>
              <span role="columnheader">Site, side, procedure</span>
              <span role="columnheader">Containers</span>
              <span role="columnheader">Collected</span>
            </div>
            {o.parts.map((p) => (
              <div key={p.id} className={`${s.tr} ${s.tr4}`} role="row">
                <span role="cell">
                  <button type="button" className={s.linkBtn} onClick={() => onSelect(`part:${p.id}`)}>
                    Part {p.designation}
                  </button>
                </span>
                <span role="cell" className={s.cellVal}>
                  {p.siteText}
                  <span className={s.cellNote}>
                    {p.laterality ? cap(p.laterality) : "Side not stated"}, {p.procedure ?? "procedure not stated"}
                  </span>
                </span>
                <span role="cell">
                  {p.receivedContainers} received of {p.expectedContainers ?? "Unknown"} expected
                </span>
                <span role="cell">{timeShort(p.collectedAt)}</span>
              </div>
            ))}
          </div>
          <p className={s.verifyLine}>
            Ordering clinician {o.clinicianName ?? "Unknown"}
            {o.clinicianCredential ? `, ${o.clinicianCredential}` : ""}, {o.officeName}. Encounter <span className={s.mono}>{o.encounter ?? "Unknown"}</span>
            {o.encounterAt ? ` at ${timeShort(o.encounterAt)}` : ""}.{" "}
            {o.versions.length ? `Versions: ${o.versions.map((v) => `v${v.version} ${v.changeSummary ?? ""}`.trim()).join("; ")}.` : ""}
          </p>
        </section>
        <RecordMeta item={item} />
      </div>
      <NextBand bench={bench} item={item} />
    </>
  );
}
