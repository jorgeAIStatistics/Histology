"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, CircleHelp, Hourglass, Pause, ScanLine, TriangleAlert } from "lucide-react";
import type { DeliveryView, IntakeBench, ItemDetail, QueueItem } from "@/server/queries/intake";
import { CLARIFICATION_CATEGORY, CLARIFICATION_STATE, OPEN_CLARIFICATION_STATES, type ClarificationState } from "@/lib/domain";
import { LAB_TZ, fmtTime } from "@/lib/time";
import { DOCTOR_COLORS } from "@/lib/tokens";
import {
  asWritten,
  findingFor,
  holdScopeText,
  partOf,
  partsOf,
  pathFor,
  scopeGrid,
  scopeSentence,
  segs,
  type CompareRow,
  type Seg,
  type SourceKey,
  type Step,
} from "./model";
import s from "./intake-a.module.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const HREF = (id: string) => `/concepts/intake-a?item=${encodeURIComponent(id)}`;

const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: LAB_TZ, weekday: "short", month: "short", day: "numeric" });

function roleLabel(role: string): string {
  const t = role.replace(/_/g, " ");
  return t[0].toUpperCase() + t.slice(1);
}

function capFirst(t: string): string {
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function surname(name: string | null): string | null {
  if (!name) return null;
  const parts = name.replace(/^Dr\.\s+/, "").split(" ");
  return `Dr. ${parts[parts.length - 1]}`;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ------------------------------------------------------------------ atoms

function Id({ v, strong }: { v: string; strong?: boolean }) {
  return <span className={cx(s.id, strong && s.idStrong)}>{v}</span>;
}

function Segs({ value }: { value: Seg[] }) {
  return (
    <>
      {value.map((x, i) => (typeof x === "string" ? <span key={i}>{x}</span> : <Id key={i} v={x.id} />))}
    </>
  );
}

function Swatch({ color }: { color: string | null }) {
  const hex = color && color in DOCTOR_COLORS ? DOCTOR_COLORS[color as keyof typeof DOCTOR_COLORS].swatch : "#8A949E";
  return <span className={s.swatch} style={{ background: hex }} aria-hidden />;
}

function Provisional({ id, size = "md" }: { id: string; size?: "md" | "lg" }) {
  return (
    <span className={cx(s.prov, size === "lg" && s.provLg)}>
      <span className={s.provWord}>Provisional</span>
      <span className={s.provId}>{id}</span>
    </span>
  );
}

function PreviewNote({ children }: { children: ReactNode }) {
  return (
    <p className={s.previewNote} role="status">
      {children}
    </p>
  );
}

// ------------------------------------------------------------------ top bar

const SECTIONS = [
  { href: "/intake", label: "Intake" },
  { href: "/clarifications", label: "Clarifications" },
  { href: "/worklist", label: "Worklist" },
  { href: "/grossing", label: "Grossing" },
  { href: "/materials", label: "Materials" },
  { href: "/operations", label: "Operations" },
  { href: "/insights", label: "Insights" },
  { href: "/settings", label: "Settings" },
];

function TopBar({ bench }: { bench: IntakeBench }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [scan, setScan] = useState("");
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!typing && e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    const v = scan.trim().toUpperCase();
    if (!v) return;
    const byInt = bench.queue.find((q) => q.displayId === v);
    const byOrd = bench.queue.find((q) => q.orderRefs.some((o) => o.toUpperCase() === v));
    const hit = byInt ?? byOrd;
    if (hit) {
      setScanMsg(`Matched record ${hit.displayId}. A match identifies the record; it does not verify the bottle.`);
      router.push(HREF(hit.displayId), { scroll: false });
      setScan("");
    } else {
      setScanMsg(`No intake item or order ${v} in today's queue (preview searches the queue only).`);
    }
  };

  const src = bench.source;
  return (
    <header className={s.top}>
      <div className={s.brand}>
        <span className={s.demoTag} title="Demo mode. Synthetic data only. Source system, notifications and printer are simulated.">
          Demo
        </span>
        <span className={s.mark}>Histology Lab OS</span>
      </div>

      <div className={s.switcher}>
        <button type="button" className={s.switchBtn} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
          <span className={s.switchLabel}>Bench</span>
          <span className={s.switchValue}>Intake</span>
          <ChevronDown size={16} aria-hidden />
        </button>
        {open ? (
          <ul className={s.menu} role="menu">
            {SECTIONS.map((x) => (
              <li key={x.href} role="none">
                <Link role="menuitem" href={x.href} className={cx(s.menuItem, x.label === "Intake" && s.menuItemOn)} aria-current={x.label === "Intake" ? "page" : undefined}>
                  {x.label}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <form
        className={s.scan}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="a-scan" className={s.scanPrefix}>
          <ScanLine size={16} aria-hidden />
          Find record
        </label>
        <input
          id="a-scan"
          ref={inputRef}
          className={s.scanInput}
          value={scan}
          onChange={(e) => {
            setScan(e.target.value);
            setScanMsg(null);
          }}
          placeholder="Scan or type an id"
          autoComplete="off"
          spellCheck={false}
        />
        <kbd className={s.kbd} aria-label="Shortcut: slash">/</kbd>
        {scanMsg ? <span className={s.scanMsg} role="status">{scanMsg}</span> : null}
      </form>

      <div className={s.status}>
        <span className={s.statusItem} title={src.name}>
          <span className={cx(s.dot, src.available ? s.dotOk : s.dotBad)} aria-hidden />
          <span>
            <span className={s.statusLabel}>EMA-SIM</span> {src.available ? `synced ${fmtTime(src.lastSuccessAt)}` : "unavailable"}
          </span>
          <span className={s.simTag}>Simulated</span>
        </span>
        <span className={s.statusItem}>
          <span className={s.statusLabel}>Demo clock</span>
          <span className={s.clock}>
            {clockFmt.format(new Date(bench.now))}, {fmtTime(bench.now)} ET
          </span>
        </span>
        <span className={s.actor}>
          <span className={s.actorName}>{bench.actor.name}</span>
          <span className={s.actorRole}>{roleLabel(bench.actor.role)}, demo role</span>
        </span>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ queue

function Courier({ d }: { d: DeliveryView }) {
  const [open, setOpen] = useState(false);
  const knownMissing = d.lines.reduce((n, l) => n + (l.missing ?? 0), 0);
  const noManifest = d.lines.filter((l) => l.expected === null);
  const missingLines = d.lines.filter((l) => (l.missing ?? 0) > 0);
  return (
    <section className={s.courier} aria-label="Courier delivery">
      <p className={s.courierHead}>
        <span className={s.courierWord}>Courier</span> <Id v={d.displayId} strong />
        <span className={s.courierTime}>arrived {fmtTime(d.arrivedAt)}</span>
      </p>
      <dl className={s.counts}>
        <div>
          <dt>Received</dt>
          <dd>{d.totals.received}</dd>
        </div>
        <div>
          <dt>Expected</dt>
          <dd className={d.totals.expected === null ? s.unknown : undefined}>
            {d.totals.expected === null ? (
              <>
                <CircleHelp size={15} aria-hidden /> Unknown
              </>
            ) : (
              d.totals.expected
            )}
          </dd>
        </div>
        <div>
          <dt>Missing</dt>
          <dd className={knownMissing ? s.countWarn : undefined}>
            {d.totals.missing === null ? (
              <>
                {knownMissing}
                <span className={s.countSuffix}>known</span>
              </>
            ) : (
              d.totals.missing
            )}
          </dd>
        </div>
      </dl>
      <p className={s.courierNote}>
        {noManifest.length ? `${noManifest.length} office${noManifest.length > 1 ? "s" : ""} sent no manifest, so the total expected is unknown. ` : null}
        {missingLines.map((l) => (
          <span key={l.id}>
            {l.officeName}: {l.missingParts.length ? l.missingParts.map((m, i) => (
              <span key={i}>
                <Id v={m.orderRef} /> part {m.designation}
              </span>
            )) : `${l.missing} container`} missing.{" "}
          </span>
        ))}
      </p>
      <button type="button" className={s.linkBtn} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Manifest by office ({d.lines.length + d.offManifest.length}) <ChevronDown size={14} aria-hidden className={open ? s.chevOpen : undefined} />
      </button>
      {open ? (
        <table className={s.manifest}>
          <thead>
            <tr>
              <th scope="col">Office</th>
              <th scope="col">Exp.</th>
              <th scope="col">Rec.</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id}>
                <th scope="row">{l.officeName}</th>
                <td>{l.expected === null ? <span className={s.unknown}>Unknown</span> : l.expected}</td>
                <td className={(l.missing ?? 0) > 0 ? s.countWarn : undefined}>{l.received}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className={s.simLine}>Courier contents are simulated.</p>
    </section>
  );
}

function reasonParts(q: QueueItem, relLabel: string | null): { text: string; kind: "differ" | "hold" | "rel" | "other"; id?: string }[] {
  return q.reasons.map((r) => {
    if (r.startsWith("Hold ")) return { text: "Hold", kind: "hold" as const, id: r.slice(5) };
    if (r.startsWith("Discrepancy: ")) return { text: `${r.slice(13)[0].toUpperCase()}${r.slice(14)} differs`, kind: "differ" as const };
    if (r.startsWith("Related orders")) return relLabel ? { text: "Related", kind: "rel" as const, id: relLabel } : { text: r.replace("Related orders: needs review", "Related orders review"), kind: "rel" as const };
    if (r === "Identity conflict") return { text: r, kind: "differ" as const };
    return { text: r, kind: "other" as const };
  });
}

function QueueRow({ q, selected, relLabel }: { q: QueueItem; selected: boolean; relLabel: string | null }) {
  const reasons = reasonParts(q, relLabel);
  return (
    <li className={cx(s.qitem, relLabel && s.qitemRel)}>
      <Link href={HREF(q.displayId)} scroll={false} className={cx(s.qrow, selected && s.qrowSel)} aria-current={selected ? "true" : undefined}>
        <span className={s.qline1}>
          <span className={s.qid}>{q.accessionNumber ?? q.displayId}</span>
          {q.accessionNumber ? <span className={s.qaccTag}>Accession</span> : null}
          <span className={s.qdoc}>
            {q.pathologistName ? (
              <>
                <Swatch color={q.pathologistColor} />
                {surname(q.pathologistName)}
              </>
            ) : (
              <span className={s.qnoroute}>No routing</span>
            )}
          </span>
        </span>
        <span className={s.qline2}>
          <span className={s.qpatient}>{q.patientName ?? "Unknown patient"}</span>
          <span className={s.qoffice}>{q.officeName}</span>
        </span>
        {reasons.length ? (
          <span className={s.qreasons}>
            {reasons.map((r, i) => (
              <span key={i} className={cx(s.qreason, r.kind === "differ" && s.qrDiffer, r.kind === "hold" && s.qrHold, r.kind === "rel" && s.qrRel)}>
                {r.kind === "hold" ? <Pause size={12} aria-hidden /> : r.kind === "differ" ? <TriangleAlert size={12} aria-hidden /> : null}
                {r.text}
                {r.id ? <> <Id v={r.id} /></> : null}
              </span>
            ))}
          </span>
        ) : q.lane !== "done" ? (
          <span className={s.qcheck}>
            {q.verifiedCount} of {q.containerCount} checked
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function Queue({ bench, relIds, relLabel }: { bench: IntakeBench; relIds: Set<string>; relLabel: string | null }) {
  const [doneOpen, setDoneOpen] = useState(false);
  const d = bench.deliveries.find((x) => x.id === bench.activeDeliveryId) ?? null;
  const sel = bench.selected?.id ?? null;
  const exceptions = bench.queue.filter((q) => q.lane === "exceptions");
  const review = bench.queue.filter((q) => q.lane === "to_review");
  const done = bench.queue.filter((q) => q.lane === "done");
  const row = (q: QueueItem) => <QueueRow key={q.id} q={q} selected={q.id === sel} relLabel={relIds.has(q.id) ? relLabel : null} />;
  return (
    <aside className={s.queue} aria-label="Arrival queue">
      {d ? <Courier d={d} /> : <p className={s.courierNote}>No courier delivery recorded today.</p>}
      <section aria-labelledby="a-exc">
        <h2 id="a-exc" className={s.qgroup}>
          Exceptions <span className={s.qcount}>{exceptions.length}</span>
        </h2>
        <p className={s.qgroupNote}>Other containers can continue under local policy.</p>
        <ul className={s.qlist}>{exceptions.map(row)}</ul>
      </section>
      <section aria-labelledby="a-rev">
        <h2 id="a-rev" className={s.qgroup}>
          To review <span className={s.qcount}>{review.length}</span>
        </h2>
        <ul className={s.qlist}>{review.map(row)}</ul>
      </section>
      <section>
        <button type="button" className={s.qdone} aria-expanded={doneOpen} onClick={() => setDoneOpen((o) => !o)}>
          Done today <span className={s.qcount}>{done.length}</span>
          <ChevronDown size={14} aria-hidden className={doneOpen ? s.chevOpen : undefined} />
        </button>
        {doneOpen ? <ul className={s.qlist}>{done.map(row)}</ul> : null}
      </section>
    </aside>
  );
}

// ------------------------------------------------------------------ identity

function Identity({ item, flashKey, showFinding }: { item: ItemDetail; flashKey: string; showFinding: boolean }) {
  const f = findingFor(item);
  const warn = f.tone === "differs" || f.tone === "missing" || f.tone === "exception";
  const parts = partsOf(item);
  const order = item.orders[0] ?? null;
  const routing = item.routing;
  const doctor = routing?.final ?? routing?.suggested ?? null;
  return (
    <section className={s.identity} aria-label="Current item" key={flashKey}>
      <div className={s.partBlock} aria-label={parts.length ? `Part${parts.length > 1 ? "s" : ""} ${parts.join(" and ")}` : "Part unknown"}>
        <span className={s.partWord}>{parts.length > 1 ? "Parts" : "Part"}</span>
        <span className={cx(s.partLetter, parts.length > 1 && s.partLetterMulti)}>{parts.length ? parts.join(" ") : "?"}</span>
        {order ? <span className={s.partOrder}>{order.sourceOrderId}</span> : null}
        {item.holds.map((h) => (
          <span key={h.id} className={s.partHold} title={`${h.displayId}: ${h.scopeLabel}. ${h.reasonText}`}>
            <span className={s.partHoldWord}>
              <Pause size={12} aria-hidden /> Hold
            </span>
            <span className={s.partHoldId}>{h.displayId}</span>
          </span>
        ))}
      </div>
      <div className={s.idMain}>
        <div className={s.idLine1}>
          <Provisional id={item.displayId} size="lg" />
          {item.accession ? (
            <span className={s.acc}>
              <span className={s.accWord}>Accession</span>
              <span className={s.accId}>{item.accession.number}</span>
            </span>
          ) : (
            <span className={s.noAcc}>No accession yet</span>
          )}
          {item.holds.map((h) => (
            <span key={h.id} className={s.holdNote}>
              Hold on {holdScopeText(h)}
            </span>
          ))}
        </div>
        <div className={s.idLine2}>
          <h1 className={s.patient}>{item.patient?.name ?? "Patient unknown"}</h1>
          {item.patient ? <span className={s.synth}>Synthetic</span> : null}
        </div>
        <div className={s.idLine3}>
          {item.patient ? (
            <>
              <span className={s.kv}>
                <span className={s.k}>DOB</span>
                <Id v={item.patient.birthDate} />
              </span>
              <span className={s.kv}>
                <span className={s.k}>MRN</span>
                <Id v={item.patient.mrn} strong />
                <span className={s.tenant}>{item.patient.tenantName}</span>
              </span>
            </>
          ) : (
            <span className={s.k}>No linked order, so no source patient record.</span>
          )}
          <span className={s.kv}>
            <span className={s.k}>Office</span>
            <span>{item.office?.name ?? item.observedOfficeText ?? "Unknown"}</span>
          </span>
        </div>
        <div className={s.idLine3}>
          <span className={s.kv}>
            <span className={s.k}>Assigned dermatopathologist</span>
            {doctor ? (
              <span className={s.doc}>
                <Swatch color={doctor.color} />
                {doctor.name}
                {routing?.status === "suggested" ? <span className={s.k}>(suggested)</span> : null}
              </span>
            ) : (
              <span className={s.noDoc}>
                <TriangleAlert size={14} aria-hidden /> None: routing exception
              </span>
            )}
          </span>
          {routing?.ruleSetVersion && routing.status !== "exception" ? <span className={s.k}>from rule set v{routing.ruleSetVersion}</span> : null}
        </div>
        <p className={cx(s.idFinding, warn && s.idFindingWarn, showFinding && s.idFindingOn)} aria-hidden={!showFinding}>
          {warn ? <TriangleAlert size={14} aria-hidden /> : <Check size={14} aria-hidden />}
          <span>
            <Segs value={f.headline} />
          </span>
        </p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ finding

function FindingLine({ item }: { item: ItemDetail }) {
  const f = findingFor(item);
  const icon =
    f.tone === "differs" || f.tone === "missing" || f.tone === "exception" ? (
      <TriangleAlert className={s.fIconWarn} size={20} aria-hidden />
    ) : f.tone === "unchecked" ? (
      <CircleHelp className={s.fIconMuted} size={20} aria-hidden />
    ) : (
      <Check className={s.fIconMuted} size={20} aria-hidden />
    );
  return (
    <section className={cx(s.finding, (f.tone === "differs" || f.tone === "missing" || f.tone === "exception") && s.findingWarn)} aria-label="Current finding">
      <p className={s.findingHead}>
        {icon}
        <span>
          <Segs value={f.headline} />
        </span>
      </p>
      {f.detail.length ? (
        <p className={s.findingDetail}>
          <Segs value={f.detail} />
        </p>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ evidence

const SOURCES: SourceKey[] = ["order", "observed", "requisition"];

function oddKeys(row: CompareRow): Set<SourceKey> {
  if (row.status !== "differs") return new Set();
  const groups = new Map<string, SourceKey[]>();
  for (const k of SOURCES) {
    const v = row[k].normalized;
    if (v === null) continue;
    groups.set(v, [...(groups.get(v) ?? []), k]);
  }
  if (groups.size < 2) return new Set(SOURCES.filter((k) => row[k].normalized === null));
  const sorted = [...groups.values()].sort((a, b) => a.length - b.length);
  return sorted[0].length < sorted[sorted.length - 1].length ? new Set(sorted[0]) : new Set();
}

function Cell({ row, k, odd }: { row: CompareRow; k: SourceKey; odd: boolean }) {
  const w = asWritten(row, k);
  if (!w.text) {
    return (
      <td className={cx(s.cell, s.cellAbsent, odd && s.cellOdd)}>
        <span className={s.absent}>{k === "observed" ? "Not on label" : "Not stated"}</span>
      </td>
    );
  }
  const monoField = row.field === "birth_date" || row.field === "mrn";
  let value: ReactNode = w.text;
  if (row.field === "mrn") {
    const m = w.text.match(/^(\S+)\s*\((.*)\)$/);
    value = m ? (
      <>
        <Id v={m[1]} /> <span className={s.tenantSmall}>{m[2]}</span>
      </>
    ) : (
      <Id v={w.text} />
    );
  } else if (monoField) value = <Id v={w.text} />;
  return (
    <td className={cx(s.cell, odd && s.cellOdd)}>
      <span className={s.cellValue}>{value}</span>
      {w.from && row.status === "differs" ? <span className={s.cellFrom}>read from “{w.from}”</span> : null}
    </td>
  );
}

const PAIR_WORD: Record<string, string> = {
  "order≠observed": "order and bottle disagree",
  "order≠requisition": "order and requisition disagree",
  "observed≠requisition": "bottle and requisition disagree",
};

function Result({ row, c, item, lateralityDiffers }: { row: CompareRow; c: ItemDetail["containers"][number]; item: ItemDetail; lateralityDiffers: boolean }) {
  if (row.status === "differs") {
    const odd = [...oddKeys(row)];
    const identity = ["patient_name", "birth_date", "mrn"].includes(row.field);
    const openQ = item.clarifications.filter((q) => (OPEN_CLARIFICATION_STATES as string[]).includes(q.state));
    const covered =
      (c.clarification && c.openMismatchFields.includes(row.field) ? c.clarification.displayId : null) ??
      openQ.find((q) => (identity ? q.category === "identity_conflict" : q.category === row.field))?.displayId ??
      null;
    const recorded = c.openMismatches.some((m) => m.field === row.field) || c.verificationState === "discrepancy";
    return (
      <td className={cx(s.result, s.resultDiff)}>
        <span className={s.resultWord}>
          <TriangleAlert size={15} aria-hidden /> Differs
        </span>
        <span className={s.resultSub}>
          {odd.length === 1 ? `The ${odd[0] === "observed" ? "bottle" : odd[0]} disagrees` : row.pairs.map((p) => PAIR_WORD[p] ?? p).join("; ")}
          {recorded ? "" : "; not recorded yet"}
        </span>
        {covered ? (
          <span className={s.resultSub}>
            Question <Id v={covered} />
          </span>
        ) : null}
      </td>
    );
  }
  if (row.status === "not_compared") {
    return (
      <td className={cx(s.result, s.resultNc)}>
        <span className={s.resultWord}>
          <CircleHelp size={15} aria-hidden /> Not compared
        </span>
        <span className={s.resultSub}>One source; not a match</span>
      </td>
    );
  }
  return (
    <td className={cx(s.result, s.resultSame)}>
      <span className={s.resultWord}>
        <Check size={15} aria-hidden /> {row.field === "site" ? "Same location" : "Same"}
      </span>
      {row.field === "site" && lateralityDiffers ? <span className={s.resultSub}>Side compared below</span> : null}
    </td>
  );
}

function Converge() {
  // Three sources meeting in one result: a small drawn cue, not decoration of data.
  return (
    <svg className={s.converge} width="26" height="18" viewBox="0 0 26 18" aria-hidden>
      <path d="M1 2 C 12 2, 14 9, 24 9 M1 9 L24 9 M1 16 C 12 16, 14 9, 24 9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="24" cy="9" r="1.8" fill="currentColor" />
    </svg>
  );
}

function Evidence({ item }: { item: ItemDetail }) {
  const [ci, setCi] = useState(0);
  const c = item.containers[Math.min(ci, item.containers.length - 1)];
  const order = item.orders.find((o) => o.sourceOrderId === c?.orderRef) ?? item.orders[0] ?? null;
  if (!c) {
    return (
      <section className={s.evidence}>
        <p className={s.k}>No container has been received for this item.</p>
      </section>
    );
  }
  const latDiff = c.comparison.some((r) => r.field === "laterality" && r.status === "differs");
  return (
    <section className={s.evidence} aria-labelledby="a-ev">
      <div className={s.evHead}>
        <h2 id="a-ev" className={s.h2}>
          Three sources, field by field
        </h2>
        {item.containers.length > 1 ? (
          <span className={s.ctrTabs} role="tablist" aria-label="Containers">
            {item.containers.map((x, i) => (
              <button key={x.id} role="tab" aria-selected={i === ci} className={cx(s.ctrTab, i === ci && s.ctrTabOn)} onClick={() => setCi(i)}>
                Container {x.seq}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      <p className={s.ctrLine}>
        <span>
          Container {c.seq} of {item.containers.length}
          {c.orderRef ? (
            <>
              {" "}linked to <Id v={c.orderRef} /> part {c.designation}
            </>
          ) : (
            " not linked to an order part"
          )}
          .
        </span>{" "}
        {c.verificationState === "unverified" ? (
          <span className={s.ctrUnchecked}>Not yet checked against the physical container.</span>
        ) : (
          <span className={s.ctrChecked}>
            {c.verifiedByName ? `Checked against the physical container by ${c.verifiedByName} at ${fmtTime(c.verifiedAt)}` : "Checked against the physical container (who and when not on record)"}
            {c.verificationState === "discrepancy" ? ", discrepancy recorded." : ", no differences."}
          </span>
        )}{" "}
        <span className={s.ctrScan}>A scan identifies the record; it does not verify the tissue.</span>
      </p>
      <table className={s.matrix}>
        <colgroup>
          <col className={s.colField} />
          <col />
          <col />
          <col />
          <col className={s.colResult} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={s.thField}>
              Field
            </th>
            <th scope="col">
              <span className={s.srcName}>Order {order ? <Id v={`${order.sourceOrderId}`} /> : null}</span>
              <span className={s.srcProv}>
                {order ? `Source system v${order.sourceVersion}, simulated` : "No order linked"}
              </span>
            </th>
            <th scope="col">
              <span className={s.srcName}>Bottle label</span>
              <span className={s.srcProv}>
                Staff entry{c.handwritten ? ", handwritten" : ""}
              </span>
            </th>
            <th scope="col">
              <span className={s.srcName}>Requisition</span>
              <span className={s.srcProv}>Paper, as read</span>
            </th>
            <th scope="col" className={s.thResult}>
              <Converge />
              <span className={s.srcName}>Result</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {c.comparison.map((row) => {
            const odd = oddKeys(row);
            return (
              <tr key={row.field} className={cx(s.mrow, row.status === "differs" && s.mrowDiff, row.status === "not_compared" && s.mrowNc)}>
                <th scope="row" className={s.mfield}>
                  {row.label}
                </th>
                {SOURCES.map((k) => (
                  <Cell key={k} row={row} k={k} odd={odd.has(k)} />
                ))}
                <Result row={row} c={c} item={item} lateralityDiffers={latDiff} />
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={s.labelRead}>
        <span className={s.k}>Label as typed by staff (not a photo):</span>{" "}
        <span className={cx(s.labelText, c.handwritten && s.handwritten)}>{c.labelText}</span>
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ related submission (A | B), never merged

function PartPlate({ it, isThis }: { it: ItemDetail; isThis: boolean }) {
  const part = partOf(it);
  const order = it.orders[0];
  const op = order?.parts[0];
  const differing = it.containers.flatMap((c) => c.comparison.filter((r) => r.status === "differs").map((r) => r.label));
  const unchecked = it.containers.filter((c) => c.verificationState === "unverified").length;
  return (
    <article className={cx(s.plate, isThis && s.plateThis)} aria-label={`Part ${part ?? "unknown"}, ${it.displayId}`}>
      <div className={s.plateTop}>
        <span className={s.plateLetter}>{part ?? "?"}</span>
        <span className={s.plateWhich}>{isThis ? "This item" : <Link href={HREF(it.displayId)} scroll={false} className={s.link}>Open Part {part}</Link>}</span>
      </div>
      <Provisional id={it.displayId} />
      <p className={s.plateLine}>
        <span className={s.k}>Order</span> <Id v={order?.sourceOrderId ?? "Unknown"} />
      </p>
      <p className={s.plateLine}>
        {op ? (
          <>
            <span className={s.k}>As ordered</span> {op.siteText}, {op.procedure ?? "procedure not stated"}
          </>
        ) : (
          "No order part"
        )}
      </p>
      <ul className={s.plateState}>
        <li className={differing.length ? s.psWarn : unchecked ? s.psMuted : undefined}>
          {differing.length ? <TriangleAlert size={13} aria-hidden /> : unchecked ? <CircleHelp size={13} aria-hidden /> : <Check size={13} aria-hidden />}
          {differing.length ? `${differing.join(", ")} differs` : unchecked ? "Not checked yet" : "Checked, sources agree"}
        </li>
        <li className={it.holds.length ? s.psHold : s.psMuted}>
          {it.holds.length ? (
            <>
              <Pause size={13} aria-hidden /> Hold <Id v={it.holds[0].displayId} />
            </>
          ) : (
            "No hold"
          )}
        </li>
      </ul>
    </article>
  );
}

function Relation({ item, siblings, reviewing, refEl }: { item: ItemDetail; siblings: ItemDetail[]; reviewing: boolean; refEl: RefObject<HTMLElement | null> }) {
  const rel = item.related[0];
  if (!rel) return null;
  const all = [item, ...siblings].sort((a, b) => (partOf(a) ?? "").localeCompare(partOf(b) ?? ""));
  const owner = item.tasks.find((t) => t.kind === "related_order_review")?.ownerName ?? null;
  const pending = rel.status === "pending_review";
  const left = all[0];
  const right = all[1];
  return (
    <section ref={refEl} className={cx(s.relation, reviewing && s.relationActive)} aria-labelledby="a-rel">
      <div className={s.relHead}>
        <h2 id="a-rel" className={s.h2}>
          Possibly related orders <Id v={rel.displayId} strong />
        </h2>
        <span className={cx(s.relStatus, pending && s.relPending)}>
          {reviewing ? "Decision in progress" : pending ? `Needs review${owner ? ` by ${owner}` : ""}` : "Reviewed"}
        </span>
      </div>
      <p className={s.relRule}>A review, not a merge. Whatever is decided, both source orders and both provisional ids stay on record.</p>
      <div className={s.relGrid}>
        {left ? <PartPlate it={left} isThis={left.id === item.id} /> : null}
        <div className={s.bridge}>
          <p className={s.bridgeTitle}>Shared by both ({rel.reasons.length})</p>
          <ul className={s.bridgeList}>
            {rel.reasons.map((r) => (
              <li key={r.code} className={s.bridgeItem}>
                <span className={s.stub} aria-hidden />
                <span className={s.bridgeText}>
                  <span className={s.bridgeLabel}>{capFirst(r.label.replace(/^Same /, ""))}</span>
                  {r.detail ? (
                    <span className={s.bridgeDetail}>
                      <Segs value={segs(r.detail)} />
                    </span>
                  ) : null}
                </span>
                <span className={s.stub} aria-hidden />
              </li>
            ))}
          </ul>
          {rel.conflicts.length ? (
            <>
              <p className={s.bridgeTitle}>Kept apart ({rel.conflicts.length})</p>
              <ul className={s.bridgeList}>
                {rel.conflicts.map((r) => (
                  <li key={r.code} className={cx(s.bridgeItem, s.bridgeConflict)}>
                    <span className={s.stub} aria-hidden />
                    <span className={s.bridgeText}>
                      <span className={s.bridgeLabel}>{r.label}</span>
                      {r.detail ? (
                        <span className={s.bridgeDetail}>
                          <Segs value={segs(r.detail.replace(/ stay separate source records \(both kept\)/, ", both kept"))} />
                        </span>
                      ) : null}
                    </span>
                    <span className={s.stub} aria-hidden />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        {right ? <PartPlate it={right} isThis={right.id === item.id} /> : <div className={s.plateMissing}>Other item not available</div>}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ metadata (last)

function RecordMeta({ item }: { item: ItemDetail }) {
  const o = item.orders[0];
  return (
    <section className={s.record} aria-labelledby="a-rec">
      <h2 id="a-rec" className={s.h2}>
        Record
      </h2>
      <dl className={s.meta}>
        <div>
          <dt>Received</dt>
          <dd>
            {fmtTime(item.receivedAt)} by {item.receivedByName ?? "Unknown"}
            {item.delivery ? (
              <>
                , courier <Id v={item.delivery.displayId} />
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Current owner</dt>
          <dd>{item.ownerName ?? "Unknown"}</dd>
        </div>
        {o ? (
          <div>
            <dt>Order source</dt>
            <dd>
              <Id v={o.sourceOrderId} /> v{o.sourceVersion}, {o.tenantName} (simulated). Updated {fmtTime(o.sourceUpdatedAt)}, imported {fmtTime(o.importedAt)}.
            </dd>
          </div>
        ) : null}
        {o?.encounter ? (
          <div>
            <dt>Encounter</dt>
            <dd>
              <Id v={o.encounter} /> at {fmtTime(o.encounterAt)}
            </dd>
          </div>
        ) : null}
        {item.requisition ? (
          <div>
            <dt>Requisition</dt>
            <dd>
              <Id v={item.requisition.docRef} />
            </dd>
          </div>
        ) : null}
        {item.routing ? (
          <div>
            <dt>Routing rule</dt>
            <dd>{item.routing.explanation}</dd>
          </div>
        ) : null}
      </dl>
      <h3 className={s.h3}>History</h3>
      <ol className={s.history}>
        {item.audit.slice(0, 6).map((a) => (
          <li key={a.id}>
            <span className={s.histTime}>{fmtTime(a.at)}</span>
            <span className={s.histWho}>{a.actorName ?? "System"}</span>
            <span className={s.histWhat}>
              <Segs value={segs(a.summary)} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ decision column

const DECISIONS = [
  { value: "single_accession_approved", label: "Link as related: one accession, parts kept with their original orders", hint: "Both orders stay separate source records. Nothing is merged." },
  { value: "keep_separate", label: "Keep separate (separate cases)", hint: "Each item is requested as its own accession." },
  { value: "not_related", label: "Not related", hint: "The match was coincidental." },
  { value: "escalated_to_office", label: "Ask the office first", hint: "Accession waits until a decision is recorded." },
] as const;

function ReviewForm({ relId, onClose }: { relId: string; onClose: () => void }) {
  const [choice, setChoice] = useState<string>("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);
  return (
    <fieldset className={s.review}>
      <legend className={s.reviewLegend}>
        Decision on <Id v={relId} />
      </legend>
      <div className={s.options}>
        {DECISIONS.map((d, i) => (
          <label key={d.value} className={cx(s.option, choice === d.value && s.optionOn)}>
            <input ref={i === 0 ? first : undefined} type="radio" name={`rel-${relId}`} value={d.value} checked={choice === d.value} onChange={() => setChoice(d.value)} />
            <span>
              <span className={s.optLabel}>{d.label}</span>
              <span className={s.optHint}>{d.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <label className={s.reasonLabel}>
        Reason <span className={s.k}>(required, recorded with your name)</span>
        <textarea className={s.reason} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className={s.reviewActions}>
        <button
          type="button"
          className={s.btnPrimary}
          aria-disabled={!choice || !reason.trim()}
          onClick={() => {
            if (!choice || !reason.trim()) {
              setNote("Choose a decision and give a reason first.");
              return;
            }
            setNote(`Preview only. The working screen would record this decision on ${relId} with your name and reason. Nothing was saved.`);
          }}
        >
          Record decision
        </button>
        <button type="button" className={s.btnGhost} onClick={onClose}>
          Cancel
        </button>
      </div>
      {note ? <PreviewNote>{note}</PreviewNote> : null}
    </fieldset>
  );
}

function StepRow({ step, n, actorName, flash, blocking }: { step: Step; n: number; actorName: string; flash: boolean; blocking: boolean }) {
  const mine = step.owner === actorName && !!step.action?.allowed;
  return (
    <li
      className={cx(s.step, step.state === "done" && s.stepDone, step.state === "current" && s.stepCurrent, step.state === "later" && s.stepLater, flash && s.flash)}
      aria-current={step.state === "current" ? "step" : undefined}
      data-blocking={blocking ? "true" : undefined}
    >
      <span className={s.stepNum}>{String(n).padStart(2, "0")}</span>
      <div className={s.stepBody}>
        <p className={s.stepTitle}>
          {step.title}
          {step.state === "done" ? <Check className={s.stepCheck} size={18} aria-label="done" /> : null}
        </p>
        {step.lines.map((l, i) => (
          <p key={i} className={s.stepLine}>
            <Segs value={l} />
          </p>
        ))}
        {step.state === "current" && step.owner ? (
          <p className={s.waitLine}>
            {mine || (step.action?.allowed && !step.waiting) ? (
              "Yours: see your next step above"
            ) : (
              <>
                <Hourglass size={14} aria-hidden /> Waiting on {step.owner}
                {step.ownerRole ? `, ${step.ownerRole}` : ""}
              </>
            )}
          </p>
        ) : null}
        {step.state === "current" && step.action && !step.action.allowed ? <p className={s.notAllowed}>{step.action.notAllowed}</p> : null}
      </div>
    </li>
  );
}

function stateLabel(st: string): string {
  if (st === "drafted") return "Drafted, not sent";
  return CLARIFICATION_STATE[st as ClarificationState] ?? st;
}

type ClarView = ItemDetail["clarifications"][number];
type NextStep =
  | { kind: "step"; step: Step }
  | { kind: "clarification"; c: ClarView }
  | { kind: "request" }
  | { kind: "none"; waitingOn: string | null; on: string | null };

function nextStepFor(item: ItemDetail, steps: Step[], actorName: string): NextStep {
  const current = steps.find((x) => x.state === "current") ?? null;
  if (current?.action?.allowed && current.key !== "accession") return { kind: "step", step: current };
  const draft = item.clarifications.find((c) => c.state === "drafted" && c.ownerName === actorName);
  if (draft) return { kind: "clarification", c: draft };
  if (item.readiness.ready && !item.accession) return { kind: "request" };
  return { kind: "none", waitingOn: current?.owner ?? null, on: current?.related?.displayId ?? current?.title.toLowerCase() ?? null };
}

function NextStepBlock({ item, next, reviewing, setReviewing }: { item: ItemDetail; next: NextStep; reviewing: boolean; setReviewing: (v: boolean) => void }) {
  const [note, setNote] = useState<string | null>(null);
  let body: ReactNode = null;
  if (next.kind === "step") {
    const st = next.step;
    const a = st.action!;
    if (a.kind === "review" && st.related) {
      const members = [item.displayId, ...st.related.otherItems.map((o) => o.displayId)].sort();
      body = (
        <>
          <p className={s.nextTitle}>
            Decide whether <Id v={members[0]} /> and <Id v={members[1] ?? "?"} /> belong to one case
          </p>
          <p className={s.nextText}>Accession for both waits for this. Both orders and both provisional ids are kept whatever you decide.</p>
          {reviewing ? (
            <ReviewForm relId={st.related.displayId} onClose={() => setReviewing(false)} />
          ) : (
            <button type="button" className={s.btnPrimary} onClick={() => setReviewing(true)}>
              Review {st.related.displayId}
            </button>
          )}
        </>
      );
    } else {
      body = (
        <>
          <p className={s.nextTitle}>{a.label}</p>
          <p className={s.nextText}>
            {a.kind === "verify"
              ? "Compare the bottle in your hand with the order and the requisition. A scan identifies the record; only your check verifies it."
              : a.kind === "route"
                ? item.routing?.explanation ?? "No routing rule applies."
                : null}
          </p>
          <button type="button" className={s.btnPrimary} onClick={() => setNote(`Preview only. The working screen would run “${a.label}” here. Nothing was saved.`)}>
            {a.label}
          </button>
        </>
      );
    }
  } else if (next.kind === "clarification") {
    const c = next.c;
    const task = item.tasks.find((t) => t.kind === "clarification_followup" && t.title.includes(c.displayId));
    body = (
      <>
        <p className={s.nextTitle}>
          Send clarification <Id v={c.displayId} /> to {item.office?.name ?? "the office"}
        </p>
        <p className={s.nextMeta}>
          <span className={s.clrState}>{stateLabel(c.state)}</span>
          <span>{CLARIFICATION_CATEGORY[c.category as keyof typeof CLARIFICATION_CATEGORY] ?? c.category}</span>
          {c.nextFollowUpAt ? <span>Follow-up due {fmtTime(c.nextFollowUpAt)}</span> : null}
          {task?.priority === "high" ? <span>High priority</span> : null}
        </p>
        <blockquote className={s.question}>
          <Segs value={segs(c.question)} />
        </blockquote>
        <div className={s.clrActions}>
          <button type="button" className={s.btnPrimary} onClick={() => setNote(`Preview only. The working screen would send ${c.displayId} through the simulated office connector. Nothing was sent.`)}>
            Send to office <span className={s.btnSim}>(simulated)</span>
          </button>
          <button type="button" className={s.btnGhost} onClick={() => setNote("Preview only. Editing opens the draft in the working screen.")}>
            Edit draft
          </button>
        </div>
      </>
    );
  } else if (next.kind === "request") {
    body = (
      <>
        <p className={s.nextTitle}>Request the accession</p>
        <p className={s.nextText}>Nothing blocks the request. Use Request accession at the foot of this column; the number comes from EMA-SIM (simulated).</p>
      </>
    );
  } else {
    body = (
      <>
        <p className={s.nextTitle}>{item.accession ? "Accessioned; nothing left to do at intake" : "Nothing for you on this item right now"}</p>
        <p className={s.nextText}>
          {next.waitingOn ? (
            <>
              It waits for {next.waitingOn}
              {next.on ? (
                <>
                  {" "}
                  (<Segs value={segs(next.on)} />)
                </>
              ) : null}
              . Other items in the queue can continue.
            </>
          ) : (
            "Other items in the queue can continue."
          )}
        </p>
      </>
    );
  }
  return (
    <section className={cx(s.next, next.kind === "none" && s.nextNone)} aria-labelledby="a-next">
      <h2 id="a-next" className={s.nextLabel}>
        Your next step
      </h2>
      {body}
      {note ? <PreviewNote>{note}</PreviewNote> : null}
    </section>
  );
}

function OtherQuestions({ item, exclude }: { item: ItemDetail; exclude: string | null }) {
  const open = item.clarifications.filter((c) => (OPEN_CLARIFICATION_STATES as string[]).includes(c.state) && c.id !== exclude);
  if (!open.length) return null;
  return (
    <section className={s.dsec} aria-labelledby="a-q">
      <h2 id="a-q" className={s.dh}>
        Open questions to the office
      </h2>
      {open.map((c) => (
        <p key={c.id} className={s.compactLine}>
          <Id v={c.displayId} strong /> {CLARIFICATION_CATEGORY[c.category as keyof typeof CLARIFICATION_CATEGORY] ?? c.category}: {stateLabel(c.state).toLowerCase()}.{" "}
          <span className={s.waitInline}>
            <Hourglass size={13} aria-hidden /> Owner {c.ownerName ?? "Unknown"}
          </span>
        </p>
      ))}
    </section>
  );
}

function Scope({ item, siblings, compact, flashRow }: { item: ItemDetail; siblings: ItemDetail[]; compact: boolean; flashRow: boolean }) {
  const grid = useMemo(() => scopeGrid(item, siblings), [item, siblings]);
  const sentence = scopeSentence(item, siblings);
  return (
    <section className={s.dsec} aria-labelledby="a-scope">
      <h2 id="a-scope" className={s.dh}>
        What can move, part by part
      </h2>
      <p className={s.scopeSentence}>
        <Segs value={sentence} />
      </p>
      {compact ? null : (
        <table className={s.scopeTable}>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Step</span>
              </th>
              {grid.columns.map((c) => (
                <th key={c.item.id} scope="col" className={cx(c.isThis && s.thisCol)}>
                  <span className={s.scopePart}>Part {c.part ?? "?"}</span>
                  <span className={s.scopeId}>{c.item.displayId}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r) => (
              <tr key={r.key} className={cx(flashRow && r.key === "accession_request" && s.flash)}>
                <th scope="row">{r.label}</th>
                {r.cells.map((cell, i) => (
                  <td key={i} className={cx(s.sc, cell.kind === "hold" && s.scHold, cell.kind === "wait" && s.scWait, cell.kind === "clear" && s.scClear, grid.columns[i]?.isThis && s.thisCol)}>
                    <span className={s.scInner}>
                      {cell.kind === "hold" ? <Pause size={12} aria-hidden className={s.scIcon} /> : cell.kind === "wait" ? <Hourglass size={12} aria-hidden className={s.scIcon} /> : null}
                      <span>
                        <Segs value={segs(cell.text)} />
                      </span>
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Decision({
  bench,
  item,
  siblings,
  reviewing,
  setReviewing,
}: {
  bench: IntakeBench;
  item: ItemDetail;
  siblings: ItemDetail[];
  reviewing: boolean;
  setReviewing: (v: boolean) => void;
}) {
  const [explain, setExplain] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const steps = useMemo(() => pathFor(item, bench.permissions, bench.actor.name), [item, bench.permissions, bench.actor.name]);
  const next = useMemo(() => nextStepFor(item, steps, bench.actor.name), [item, steps, bench.actor.name]);
  const ready = item.readiness.ready && !item.accession;
  const parts = partsOf(item);
  const relStep = steps.find((x) => x.key.startsWith("rel-"));
  const current = steps.find((x) => x.state === "current") ?? null;
  const blockers = item.accession ? [] : item.readiness.blockers;
  const many = blockers.length > 1;

  useEffect(() => {
    if (!explain) return;
    // Bring the blocking step and the part-by-part scope into view (context, not decoration).
    const box = scrollRef.current;
    const target = box?.querySelector<HTMLElement>("[data-blocking='true']");
    if (box && target) box.scrollTo({ top: Math.max(0, target.offsetTop - 44), behavior: reducedMotion() ? "auto" : "smooth" });
    const t = window.setTimeout(() => setExplain(false), 2600);
    return () => window.clearTimeout(t);
  }, [explain]);

  const relOwner = item.tasks.find((t) => t.kind === "related_order_review")?.ownerName ?? null;

  return (
    <aside className={s.decision} aria-label="Decision">
      <div className={s.decHead}>
        <span className={s.decTitle}>Decision</span>
        <span className={s.decFor}>
          for <span className={s.decId}>{item.displayId}</span>
          {parts.length ? ` ${parts.length > 1 ? "Parts" : "Part"} ${parts.join(", ")}` : ""}
        </span>
      </div>
      <div className={s.decScroll} ref={scrollRef}>
        <NextStepBlock item={item} next={next} reviewing={reviewing} setReviewing={setReviewing} />
        <section className={s.dsec} aria-labelledby="a-path">
          <h2 id="a-path" className={s.dh}>
            Path to accession
          </h2>
          <ol className={s.steps}>
            {steps.map((st, i) => (
              <StepRow
                key={st.key}
                step={st}
                n={i + 1}
                actorName={bench.actor.name}
                blocking={!many && st.state === "current"}
                flash={!many && explain && st.key === (relStep?.state === "current" ? relStep.key : current?.key)}
              />
            ))}
          </ol>
        </section>
        {many ? (
          <section className={cx(s.dsec, explain && s.flash)} aria-labelledby="a-blk" data-blocking="true">
            <h2 id="a-blk" className={s.dh}>
              What blocks the accession request ({blockers.length})
            </h2>
            <ol className={s.blockerList}>
              {blockers.map((b, i) => (
                <li key={i}>
                  <Segs value={segs(b.message)} />
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <OtherQuestions item={item} exclude={next.kind === "clarification" ? next.c.id : null} />
        <Scope item={item} siblings={siblings} compact={reviewing} flashRow={explain} />
      </div>
      <div className={s.dock}>
        {item.accession ? null : (
        <button
          type="button"
          className={ready ? s.btnPrimary : s.btnBlocked}
          aria-disabled={!ready}
          aria-describedby="a-dock-reason"
          onClick={() => {
            if (!ready) {
              setExplain(true);
              return;
            }
            setNote("Preview only. The working screen would request the accession from EMA-SIM (simulated). Nothing was sent.");
          }}
        >
          Request accession <span className={s.btnSim}>(simulated source)</span>
        </button>
        )}
        <p id="a-dock-reason" className={cx(s.dockReason, explain && s.flash)}>
          {item.accession ? (
            <>
              <span className={s.dockCannot}>Accession issued:</span> <Id v={item.accession.number} strong /> ({item.accession.namespace}, simulated source). Later changes go through a correction review on the case.
            </>
          ) : ready ? (
            "Nothing blocks the request."
          ) : (
            <>
              <span className={s.dockCannot}>Cannot request yet:</span>{" "}
              {many ? `${blockers.length} blockers, listed above.` : null}
              {(many ? [] : blockers).map((b, i) => {
                const rel = b.code === "related_pending" ? b.message.match(/REL-\d+/)?.[0] : null;
                return (
                  <span key={i}>
                    {rel ? (
                      <>
                        waits for the <Id v={rel} /> review{relOwner ? ` by ${relOwner}` : ""}
                      </>
                    ) : (
                      <Segs value={segs(b.message)} />
                    )}
                    {"."}
                  </span>
                );
              })}
              {!many && item.holds.length && !item.holds.some((h) => h.blocksAccession) ? (
                <>
                  {" "}
                  Hold <Id v={item.holds[0].displayId} /> does not block it.
                </>
              ) : null}
            </>
          )}
        </p>
        {note ? <PreviewNote>{note}</PreviewNote> : null}
        <p className={s.previewFoot}>Concept preview: buttons show what would happen; nothing is saved or sent.</p>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ screen

export function Workstation({ bench, siblings }: { bench: IntakeBench; siblings: ItemDetail[] }) {
  const item = bench.selected;
  const [reviewing, setReviewingState] = useState(false);
  const stageRef = useRef<HTMLElement>(null);
  const relRef = useRef<HTMLElement | null>(null);
  const findingRef = useRef<HTMLDivElement>(null);
  const [findingHidden, setFindingHidden] = useState(false);

  // When the finding sentence scrolls under the identity readout, the readout repeats it in one line.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = findingRef.current;
      const id = stage.querySelector<HTMLElement>("section[aria-label='Current item']");
      if (!el || !id) return;
      setFindingHidden(el.offsetTop + el.offsetHeight - 24 < stage.scrollTop + id.offsetHeight);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    stage.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stage.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [item?.id]);

  // A new item never inherits an open decision from the previous one.
  useEffect(() => setReviewingState(false), [item?.id]);

  const setReviewing = (v: boolean) => {
    setReviewingState(v);
    if (v && relRef.current && stageRef.current) {
      // Keep the related parts in view while the decision is made (context, not decoration).
      const stage = stageRef.current;
      const el = relRef.current;
      const bottom = el.offsetTop + el.offsetHeight + 16;
      const target = Math.max(0, bottom - stage.clientHeight);
      if (target > stage.scrollTop) stage.scrollTo({ top: target, behavior: reducedMotion() ? "auto" : "smooth" });
    }
  };

  const relIds = new Set<string>(item?.related.length ? [item.id, ...siblings.map((x) => x.id)] : []);
  const relLabel = item?.related[0]?.displayId ?? null;

  return (
    <>
      <TopBar bench={bench} />
      <div className={s.frame}>
        <Queue bench={bench} relIds={relIds} relLabel={relLabel} />
        <main className={s.stage} ref={stageRef} id="main">
          {item ? (
            <>
              <Identity item={item} flashKey={item.id} showFinding={findingHidden} />
              <div className={s.stageBody}>
                <div ref={findingRef}>
                  <FindingLine item={item} />
                </div>
                <Evidence key={item.id} item={item} />
                <Relation item={item} siblings={siblings} reviewing={reviewing} refEl={relRef} />
                <RecordMeta item={item} />
              </div>
            </>
          ) : (
            <div className={s.empty}>
              <p className={s.findingHead}>{bench.selectedNotFound ? `No intake item ${bench.selectedNotFound}.` : "Select an item from the queue, or scan a container."}</p>
              <p className={s.k}>A scan identifies the record; it does not verify the bottle.</p>
            </div>
          )}
        </main>
        {item ? <Decision key={item.id} bench={bench} item={item} siblings={siblings} reviewing={reviewing} setReviewing={setReviewing} /> : <aside className={s.decision} aria-label="Decision" />}
      </div>
    </>
  );
}
