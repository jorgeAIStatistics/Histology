"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Check,
  CircleDot,
  CircleHelp,
  CirclePause,
  ClipboardList,
  Clock3,
  FileText,
  Info,
  Lock,
  ScanLine,
  TestTube,
  TriangleAlert,
} from "lucide-react";
import type { ContainerView, DeliveryView, IntakeBench, ItemDetail, QueueItem, RelatedView } from "@/server/queries/intake";
import { CLARIFICATION_CATEGORY, CLARIFICATION_STATE, CONTAINER_VERIFICATION, SOURCE_STATUS, type ClarificationCategory, type ClarificationState } from "@/lib/domain";
import { LAB_TZ, fmtTime } from "@/lib/time";
import { DOCTOR_COLORS } from "@/lib/tokens";
import {
  HOLD_STOPS,
  defaultFocus,
  differences,
  explainBlocker,
  listWords,
  partLabel,
  queueTicks,
  relatedState,
  roleLabel,
  type DeskModel,
  type Finding,
  type StepKey,
  type StepModel,
  type StepState,
} from "./model";
import s from "./desk.module.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: LAB_TZ, weekday: "short", month: "short", day: "numeric" });

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx(s.mono, className)}>{children}</span>;
}

function Swatch({ color }: { color: string | null }) {
  const hex = color && color in DOCTOR_COLORS ? DOCTOR_COLORS[color as keyof typeof DOCTOR_COLORS].swatch : "#7A8894";
  return <span className={s.swatch} style={{ background: hex }} aria-hidden />;
}

function PreviewTag() {
  return <span className={s.previewTag}>Preview: no record changes</span>;
}

// ================================================================= root

export function Desk({ model, initialStep }: { model: DeskModel; initialStep: StepKey | null }) {
  const { bench, siblings, steps, finding } = model;
  const item = bench.selected;
  const [focus, setFocus] = useState<StepKey>(initialStep ?? (steps ? defaultFocus(steps) : "accession"));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[1-5]$/.test(e.key) && steps) {
        setFocus(steps[Number(e.key) - 1].key);
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("c-scan")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps]);

  return (
    <div className={s.root}>
      <Rail bench={bench} />
      <main className={s.desk} id="c-desk">
        {item && steps && finding ? (
          <>
            <IdentityBand item={item} />
            <FindingBlock finding={finding} />
            <StepLine steps={steps} focus={focus} onFocus={setFocus} itemId={item.displayId} />
            <div className={s.work}>
              <section className={s.panel} aria-labelledby="c-panel-h">
                <div key={focus} className={s.panelBody}>
                  <StepPanel focus={focus} item={item} bench={bench} siblings={siblings} steps={steps} onFocus={setFocus} />
                </div>
                <MetaFooter item={item} />
              </section>
              <Evidence item={item} />
            </div>
          </>
        ) : (
          <div className={s.notFound}>
            <h1 className={s.lead}>No intake item {bench.selectedNotFound ?? ""} in this fixture.</h1>
            <p>Choose an item from the bench on the left.</p>
          </div>
        )}
      </main>
    </div>
  );
}

// ================================================================= rail (scan, courier, queue, session)

function Rail({ bench }: { bench: IntakeBench }) {
  const delivery = bench.deliveries.find((d) => d.id === bench.activeDeliveryId) ?? null;
  const selectedId = bench.selected?.displayId ?? null;
  const exceptions = bench.queue.filter((q) => q.lane === "exceptions");
  const review = bench.queue.filter((q) => q.lane === "to_review");
  const done = bench.queue.filter((q) => q.lane === "done");
  return (
    <aside className={s.rail} aria-label="Bench">
      <div className={s.brand}>
        <span className={s.brandName}>Histology Lab OS</span>
        <span className={s.brandSub}>Intake desk</span>
      </div>
      <ScanField queue={bench.queue} />
      <div className={s.railScroll}>
        {delivery ? <CourierBlock d={delivery} /> : <p className={s.railNote}>No courier recorded for this lab day.</p>}
        <nav aria-label="Intake items">
          <QueueLane title="Exceptions" count={bench.counts.exceptions} note="Other items can continue under local policy." items={exceptions} selectedId={selectedId} />
          <QueueLane title="To review" count={bench.counts.to_review} items={review} selectedId={selectedId} />
          <details className={s.doneLane}>
            <summary>Done today ({bench.counts.done})</summary>
            <ul className={s.doneList}>
              {done.map((q) => (
                <li key={q.id}>
                  <Mono className={s.accBox}>{q.accessionNumber ?? "Not issued"}</Mono>
                  <span className={s.doneFrom}>
                    from <Mono>{q.displayId}</Mono>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </nav>
      </div>
      <Session bench={bench} />
    </aside>
  );
}

function ScanField({ queue }: { queue: QueueItem[] }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className={s.scan}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim().toUpperCase();
        if (!v) return;
        const hit = queue.find((q) => q.displayId === v || q.orderRefs.some((o) => o.toUpperCase() === v));
        if (hit) {
          setMsg(`Matched ${hit.displayId}. A scan identifies the record; it does not verify the bottle.`);
          setValue("");
          router.push(`/concepts/intake-c?item=${hit.displayId}`);
        } else {
          setMsg(`No intake item or order “${value.trim()}” on today's bench (preview matches INT and order ids only).`);
        }
      }}
    >
      <label htmlFor="c-scan" className={s.scanLabel}>
        Find record <span className={s.dim}>(scan or type)</span>
        <kbd className={s.kbd}>/</kbd>
      </label>
      <span className={s.scanBox}>
        <ScanLine size={16} aria-hidden />
        <input
          id="c-scan"
          className={s.scanInput}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Order id or INT id"
          autoComplete="off"
          spellCheck={false}
        />
      </span>
      {msg ? (
        <p className={s.scanMsg} role="status">
          {msg}
        </p>
      ) : null}
    </form>
  );
}

function CourierBlock({ d }: { d: DeliveryView }) {
  const noManifest = d.lines.filter((l) => l.expected === null);
  const knownMissing = d.lines.reduce((n, l) => n + (l.missing ?? 0), 0);
  const missingParts = d.lines.flatMap((l) => l.missingParts.map((m) => ({ ...m, office: l.officeName })));
  return (
    <section className={s.courier} aria-labelledby="c-courier-h">
      <h2 id="c-courier-h" className={s.courierH}>
        Courier <Mono>{d.displayId}</Mono>
        <span className={s.courierWhen}>arrived {fmtTime(d.arrivedAt)}</span>
      </h2>
      <dl className={s.figures}>
        <div>
          <dt>Received{d.unpackingComplete ? "" : " so far"}</dt>
          <dd>{d.totals.received}</dd>
        </div>
        <div>
          <dt>Expected</dt>
          <dd className={d.totals.expected === null ? s.figUnknown : undefined}>
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
          <dd className={d.totals.missing === null && !knownMissing ? s.figUnknown : undefined}>
            {d.totals.missing === null ? (knownMissing ? `${knownMissing}+` : "Unknown") : d.totals.missing}
          </dd>
        </div>
      </dl>
      {noManifest.length ? (
        <p className={s.railNote}>
          No manifest from {listWords(noManifest.map((l) => l.officeName))}. The other manifests list {d.totals.expectedKnownPart}.
        </p>
      ) : null}
      {missingParts.map((m) => (
        <p key={`${m.orderRef}-${m.designation}`} className={s.railMissing}>
          <TriangleAlert size={14} aria-hidden className={s.inlineIcon} />
          Missing <Mono>{m.orderRef}</Mono> part {m.designation}, {m.office}
        </p>
      ))}
    </section>
  );
}

function QueueLane({ title, count, note, items, selectedId }: { title: string; count: number; note?: string; items: QueueItem[]; selectedId: string | null }) {
  return (
    <section className={s.lane} aria-label={`${title} (${count})`}>
      <h2 className={s.laneH}>
        {title} <span className={s.laneCount}>{count}</span>
      </h2>
      {note ? <p className={s.laneNote}>{note}</p> : null}
      <ul className={s.laneList}>
        {items.map((q) => {
          const sel = q.displayId === selectedId;
          const ticks = queueTicks(q);
          return (
            <li key={q.id}>
              <Link href={`/concepts/intake-c?item=${q.displayId}`} className={cx(s.qRow, sel && s.qRowSel)} aria-current={sel ? "page" : undefined}>
                <span className={s.qTop}>
                  <Mono className={s.qId}>{q.displayId}</Mono>
                  <span className={s.ticks} role="img" aria-label={ticks.map((t) => t.label).join(", ")}>
                    {ticks.map((t, i) => (
                      <span key={i} className={cx(s.tick, s[`tick_${t.tone}`])} />
                    ))}
                  </span>
                </span>
                <span className={s.qName}>{q.patientName ?? "Unknown patient"}</span>
                <span className={s.qReason}>
                  {q.reasons.length ? q.reasons.join("; ") : `${q.officeName}, ${q.verifiedCount} of ${q.containerCount} checked`}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Session({ bench }: { bench: IntakeBench }) {
  const status = SOURCE_STATUS[bench.source.status as keyof typeof SOURCE_STATUS] ?? bench.source.status;
  const sourceName = bench.source.name.replace(/\s*\(simulated source adapter\)\s*/i, "");
  return (
    <footer className={s.session}>
      <p>
        <span className={s.dim}>Demo clock</span> {fmtTime(bench.now)}, {dayFmt.format(new Date(bench.now))}
      </p>
      <p>
        <span className={s.dim}>Source</span> {sourceName}: {status.replace(/\s*\(simulated\)/i, "").toLowerCase()} (simulated)
      </p>
      <p>
        <span className={s.dim}>Acting as</span> {bench.actor.name}, {roleLabel(bench.actor.role)} <span className={s.dim}>(demo role)</span>
      </p>
      <p className={s.sessionNote}>Synthetic data. Preview: actions change nothing.</p>
    </footer>
  );
}

// ================================================================= identity

function IdentityBand({ item }: { item: ItemDetail }) {
  const r = item.routing;
  const doc = r ? r.final ?? r.suggested : null;
  const docLabel = r?.status === "suggested" ? "Suggested dermatopathologist" : "Assigned dermatopathologist";
  const order = item.orders[0] ?? null;
  return (
    <header className={s.band}>
      <div className={s.bandRow1}>
        <h1 className={s.bandTitle}>
          <span className={s.intBox}>
            <span className={s.srOnly}>Provisional intake item </span>
            {item.displayId}
          </span>
          <span className={s.provWord} aria-hidden>
            Provisional
            <br />
            intake id
          </span>
          {item.accession ? (
            <span className={s.bandAcc}>
              <span className={s.srOnly}>Accession </span>
              {item.accession.number}
            </span>
          ) : null}
          <span className={s.bandPart}>{partLabel(item)}</span>
          <span className={s.bandPatient}>{item.patient?.name ?? "Unknown patient"}</span>
        </h1>
        <span className={s.synth}>Synthetic patient</span>
        <div className={s.bandDoctor}>
          <span className={s.bandLabel}>{docLabel}</span>
          {doc ? (
            <span className={s.bandDoctorName}>
              <Swatch color={doc.color} />
              {doc.name}
            </span>
          ) : (
            <span className={s.bandDoctorName}>None suggested (routing exception)</span>
          )}
        </div>
      </div>
      <dl className={s.bandRow2}>
        <div>
          <dt>DOB</dt>
          <dd>{item.patient?.birthDate ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>MRN</dt>
          <dd>
            {item.patient ? (
              <>
                <Mono>{item.patient.mrn}</Mono> in {item.patient.tenantName}
              </>
            ) : (
              "Unknown"
            )}
          </dd>
        </div>
        <div>
          <dt>{item.orders.length > 1 ? "Orders" : "Order"}</dt>
          <dd>
            {item.orders.length ? (
              item.orders.map((o, i) => (
                <span key={o.id}>
                  {i ? ", " : ""}
                  <Mono>{o.sourceOrderId}</Mono>
                </span>
              ))
            ) : (
              "None linked"
            )}
          </dd>
        </div>
        <div>
          <dt>Office</dt>
          <dd>{item.office?.name ?? `${item.observedOfficeText ?? "Unknown"} (not in directory)`}</dd>
        </div>
        <div>
          <dt>Ordering clinician</dt>
          <dd>{order?.clinicianName ?? "Unknown"}</dd>
        </div>
      </dl>
    </header>
  );
}

// ================================================================= finding

function FindingBlock({ finding }: { finding: Finding }) {
  return (
    <section className={s.finding} aria-labelledby="c-finding">
      <h2 id="c-finding" className={s.lead}>
        <span className={s.leadLine}>{finding.lead}</span>
        {finding.follow ? <span className={s.followLine}>{finding.follow}</span> : null}
      </h2>
      {finding.notes.map((n, i) => (
        <p key={i} className={n.kind === "hold" ? s.noteHold : s.noteInfo}>
          {n.kind === "hold" ? <CirclePause size={16} aria-hidden /> : <Info size={16} aria-hidden />}
          <span>{n.text}</span>
        </p>
      ))}
    </section>
  );
}

// ================================================================= step line

const STATE_WORD: Record<StepState, string> = {
  done: "Done",
  yours: "Yours now",
  waiting: "Someone else's now",
  blocked: "Blocked",
  later: "Not yet",
};

function StateGlyph({ state }: { state: StepState }) {
  const size = 17;
  switch (state) {
    case "done":
      return <Check size={size} aria-hidden className={s.glyph} />;
    case "yours":
      return <CircleDot size={size} aria-hidden className={s.glyph} />;
    case "waiting":
      return <Clock3 size={size} aria-hidden className={s.glyph} />;
    case "blocked":
      return <Lock size={size - 1} aria-hidden className={s.glyph} />;
    default:
      return null;
  }
}

function StepLine({ steps, focus, onFocus, itemId }: { steps: StepModel[]; focus: StepKey; onFocus: (k: StepKey) => void; itemId: string }) {
  return (
    <nav className={s.stepLine} aria-label={`Review steps for ${itemId}`}>
      <ol>
        {steps.map((st) => (
          <li key={st.key}>
            <button
              type="button"
              className={cx(s.step, s[`tone_${st.tone}`], focus === st.key && s.stepFocus)}
              aria-current={focus === st.key ? "step" : undefined}
              onClick={() => onFocus(st.key)}
            >
              <span className={s.stepTitle}>
                <span className={s.stepNum}>{st.n}</span>
                {st.title}
                <StateGlyph state={st.state} />
                <span className={s.srOnly}>: {STATE_WORD[st.state]}.</span>
              </span>
              <span className={s.stepStatus}>{st.status}</span>
              <span className={s.stepDetail}>{st.detail}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ================================================================= panels

interface PanelProps {
  focus: StepKey;
  item: ItemDetail;
  bench: IntakeBench;
  siblings: ItemDetail[];
  steps: StepModel[];
  onFocus: (k: StepKey) => void;
}

function StepPanel(p: PanelProps) {
  const st = p.steps.find((x) => x.key === p.focus)!;
  const owner = ownerLine(st, p.bench.actor.name);
  return (
    <>
      <p className={s.panelOwner}>
        <span className={s.srOnly}>Step {st.n} of 5. </span>
        {owner}
      </p>
      <div className={s.panelInner}>
        {p.focus === "container" ? <ContainerPanel {...p} /> : null}
        {p.focus === "differences" ? <DifferencesPanel {...p} /> : null}
        {p.focus === "related" ? <RelatedPanel {...p} /> : null}
        {p.focus === "routing" ? <RoutingPanel {...p} /> : null}
        {p.focus === "accession" ? <AccessionPanel {...p} /> : null}
      </div>
    </>
  );
}

function ownerLine(st: StepModel, actorName: string): string {
  if (st.state === "done") return "Settled";
  if (st.state === "blocked") return "Blocked: see the reasons below";
  if (st.state === "later") return "Not reached yet";
  if (!st.owner) return st.state === "yours" ? "Yours now" : "Owner Unknown";
  return st.owner === actorName ? `Owner: you (${st.owner})` : `Owner: ${st.owner}`;
}

function usePreview() {
  const [msg, setMsg] = useState<string | null>(null);
  const node = msg ? (
    <p className={s.previewMsg} role="status">
      {msg}
    </p>
  ) : null;
  return { show: setMsg, node };
}

function Actions({ children, preview }: { children: ReactNode; preview: ReactNode }) {
  return (
    <div className={s.actionsWrap}>
      <div className={s.actions}>
        {children}
        <PreviewTag />
      </div>
      {preview}
    </div>
  );
}

// ---------------------------------------------------------------- 1 container

function ContainerPanel({ item, bench }: PanelProps) {
  const pv = usePreview();
  return (
    <>
      <h3 id="c-panel-h" className={s.panelH}>
        {item.containers.length === 1 ? "Check the container against the physical bottle" : `Check ${item.containers.length} containers against the physical bottles`}
      </h3>
      <p className={s.panelLede}>A scan or label read only finds the record. A person checking the bottle is the only thing that records a verification.</p>
      <ul className={s.plainList}>
        {item.containers.map((c) => (
          <li key={c.id} className={s.factRow}>
            <span className={s.factKey}>
              Container {c.seq}
              {c.designation ? `, part ${c.designation}` : ""}
            </span>
            <span className={s.factVal}>
              <strong>{CONTAINER_VERIFICATION[c.verificationState]}</strong>
              {c.verificationState !== "unverified" ? (
                <>
                  {" "}
                  by {c.verifiedByName ?? "Unknown"} at {fmtTime(c.verifiedAt)}, against <Mono>{c.orderRef ?? "Unknown order"}</Mono> v{c.lastVerification?.orderVersion ?? "?"}.
                </>
              ) : (
                "."
              )}
              {c.openMismatchFields.length ? ` Recorded difference: ${listWords(c.openMismatches.map((m) => m.label.toLowerCase()))}.` : ""}
              {c.orderChangedSinceVerification ? " The order changed after this check; check the bottle again." : ""}
            </span>
          </li>
        ))}
        {item.missingParts.map((m) => (
          <li key={m.discrepancyId} className={s.factRow}>
            <span className={s.factKey}>Missing</span>
            <span className={s.factVal}>
              No container received for <Mono>{m.orderRef}</Mono> part {m.designation}. The order expects {m.expected ?? "Unknown"}.
              {m.clarification ? ` Question ${m.clarification.displayId} is open.` : " No question raised yet."}
            </span>
          </li>
        ))}
      </ul>
      <Actions preview={pv.node}>
        <button
          type="button"
          className={item.containers.some((c) => c.verificationState === "unverified") ? s.btnPrimary : s.btnSecondary}
          disabled={!bench.permissions.verify}
          onClick={() => pv.show("Preview only. The working bench records who checked which bottle and when, against the current order version. Nothing was recorded.")}
        >
          {item.containers.some((c) => c.verificationState === "unverified") ? "Record staff verification" : "Record a new check of the bottle"}
        </button>
      </Actions>
    </>
  );
}

// ---------------------------------------------------------------- 2 differences

function FieldTriptych({ row }: { row: ContainerView["comparison"][number] }) {
  const cells = [
    { name: "Order", cell: row.order, none: "Not stated" },
    { name: "Bottle", cell: row.observed, none: "Not on label" },
    { name: "Requisition", cell: row.requisition, none: "Not stated" },
  ];
  // Neutral on purpose: two agreeing documents are not proof the bottle is wrong (the requisition is printed from the order).
  // Every stated value in a differing row is marked the same way; the office answers which is right.
  return (
    <div className={s.triptych}>
      {cells.map((c) => {
        const odd = row.status === "differs" && c.cell.normalized !== null;
        return (
          <div key={c.name} className={cx(s.tripCell, odd && s.tripOdd)}>
            <span className={s.tripName}>{c.name}</span>
            <span className={c.cell.original ? s.tripVal : s.tripNone}>{c.cell.original ?? c.none}</span>
            {c.cell.note ? <span className={s.tripNote}>{c.cell.note}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function DifferencesPanel({ item, bench }: PanelProps) {
  const pv = usePreview();
  const diffs = differences(item);
  if (!diffs.length) {
    const rows = item.containers.flatMap((c) => c.comparison);
    const same = [...new Set(rows.filter((r) => r.status === "match").map((r) => r.label.toLowerCase()))];
    const nc = [...new Set(rows.filter((r) => r.status === "not_compared").map((r) => r.label))];
    const unverified = item.containers.some((c) => c.verificationState === "unverified");
    const accepted = item.containers.flatMap((c) => c.acceptedMismatches);
    return (
      <>
        <h3 id="c-panel-h" className={s.panelH}>
          {unverified ? "Differences are confirmed at the container check" : "Nothing differs between order, bottle and requisition"}
        </h3>
        <ul className={s.plainList}>
          <li className={s.factRow}>
            <span className={s.factKey}>Same</span>
            <span className={s.factVal}>{same.length ? `${same.join(", ")}.` : "No field is stated by two sources."}</span>
          </li>
          {nc.length ? (
            <li className={s.factRow}>
              <span className={s.factKey}>Not compared</span>
              <span className={s.factVal}>
                {listWords(nc)}: only one source states {nc.length > 1 ? "them" : "it"}. Not compared is not a match.
              </span>
            </li>
          ) : null}
          {accepted.map((a) => (
            <li key={a.id} className={s.factRow}>
              <span className={s.factKey}>Accepted</span>
              <span className={s.factVal}>
                {a.label} accepted by {a.byName ?? "Unknown"} at {fmtTime(a.at)}. {a.reason ? `Reason: ${a.reason}` : ""}
              </span>
            </li>
          ))}
        </ul>
        {item.missingParts.length ? <p className={s.panelLede}>A missing container is handled at step 1.</p> : null}
      </>
    );
  }

  const first = diffs[0];
  const labels = [...new Set(diffs.map((d) => d.row.label))];
  const seqs = [...new Set(diffs.map((d) => d.container.seq))];
  const clarRef = diffs.find((d) => d.clar)?.clar ?? null;
  const clar = clarRef ? item.clarifications.find((q) => q.displayId === clarRef.displayId) ?? null : null;
  const recorded = diffs.some((d) => d.mismatch) || first.container.verificationState !== "unverified";
  const holds = item.holds.filter((h) => !clar || h.clarificationDisplayId === clar.displayId || !h.clarificationDisplayId);
  const actor = bench.actor.name;
  const officeName = item.office?.name ?? item.observedOfficeText ?? "the office";
  return (
    <>
      <h3 id="c-panel-h" className={s.panelH}>
        {listWords(labels)} {labels.length > 1 ? "differ" : "differs"} on {seqs.length > 1 ? `containers ${listWords(seqs.map(String))}` : `container ${seqs[0]}`}
        {seqs.length === 1 && first.container.designation ? `, part ${first.container.designation}` : ""}
      </h3>
      <p className={s.panelLede}>
        {recorded
          ? "Both values are kept as written. Nothing is corrected automatically."
          : "This is the typed label only. Confirm it at the container check; nothing is corrected automatically."}
      </p>
      <FieldTriptych row={first.row} />

      {clar ? (
        <div className={s.block}>
          <p className={s.blockHead}>
            <Mono className={s.idChip}>{clar.displayId}</Mono>
            <span className={s.stateWord}>{CLARIFICATION_STATE[clar.state as ClarificationState] ?? clar.state}</span>
            <span className={s.dim}>{CLARIFICATION_CATEGORY[clar.category as ClarificationCategory] ?? clar.category} question</span>
          </p>
          <blockquote className={s.quote}>{clar.question}</blockquote>
          <dl className={s.inlineFacts}>
            <div>
              <dt>Lab owner</dt>
              <dd>{clar.ownerName === actor ? `You (${clar.ownerName})` : clar.ownerName ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Follow up by</dt>
              <dd>{clar.nextFollowUpAt ? fmtTime(clar.nextFollowUpAt) : "Not set"}</dd>
            </div>
            <div>
              <dt>Office</dt>
              <dd>{officeName}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {holds.map((h) => (
        <div key={h.id} className={s.holdBlock}>
          <p className={s.blockHead}>
            <CirclePause size={16} aria-hidden />
            <Mono className={s.idChip}>{h.displayId}</Mono>
            <span className={s.stateWord}>Hold on {h.scopeLabel} only</span>
          </p>
          <p className={s.holdText}>
            Placed by {h.placedByName ?? "Unknown"}, {fmtTime(h.placedAt)}
            {h.clarificationDisplayId ? `, with ${h.clarificationDisplayId}` : ""}. It {h.blocksAccession ? "also stops" : "does not stop"} the accession request. Resolving the
            question does not release the hold; release is its own step, with a reason.
          </p>
        </div>
      ))}

      <Actions preview={pv.node}>
        {clar && (clar.state === "drafted" || clar.state === "delivery_failed") ? (
          <>
            <button
              type="button"
              className={s.btnPrimary}
              disabled={!bench.permissions.raiseClarification}
              onClick={() =>
                pv.show(
                  `Preview only. The working bench would mark ${clar.displayId} as sent through the simulated notifier to ${officeName}. No office is contacted and nothing was recorded.`,
                )
              }
            >
              Send {clar.displayId} to the office (simulated)
            </button>
            <button type="button" className={s.btnQuiet} onClick={() => pv.show("Preview only. Editing opens the question text with the evidence attached. Nothing changed.")}>
              Edit question
            </button>
          </>
        ) : !clar ? (
          <button
            type="button"
            className={s.btnPrimary}
            disabled={!bench.permissions.raiseClarification}
            onClick={() => pv.show(`Preview only. The working bench opens a ${labels[0].toLowerCase()} question pre-filled with these three values. Nothing was recorded.`)}
          >
            Raise a clarification for {labels[0].toLowerCase()}
          </button>
        ) : (
          <button type="button" className={s.btnSecondary} onClick={() => pv.show(`Preview only. Opens ${clar.displayId} on the clarifications screen.`)}>
            Open {clar.displayId}
          </button>
        )}
      </Actions>
    </>
  );
}

// ---------------------------------------------------------------- 3 related orders

type Decision = "single_accession_approved" | "keep_separate" | "not_related" | "escalated_to_office";
const DECISIONS: { value: Decision; label: string; hint: string }[] = [
  {
    value: "single_accession_approved",
    label: "Link as related: one accession",
    hint: "Each part stays with its original order. Nothing is merged.",
  },
  { value: "keep_separate", label: "Keep separate: two cases", hint: "Each item is requested as its own accession, cross-referenced." },
  { value: "not_related", label: "Not related", hint: "The shared facts were a coincidence." },
  { value: "escalated_to_office", label: "Ask the office first", hint: "Accession keeps waiting until a decision is recorded." },
];

function OrderRail({ holder, orderId, current }: { holder: ItemDetail | null; orderId: string; current: boolean }) {
  const order = holder?.orders.find((o) => o.sourceOrderId === orderId) ?? null;
  const part = order?.parts[0] ?? null;
  return (
    <div className={cx(s.railCard, current && s.railCardCurrent)}>
      <span className={s.railCardTop}>
        <span className={s.railPart}>{part ? `Part ${part.designation}` : "Part Unknown"}</span>
        <Mono className={s.railOrder}>{orderId}</Mono>
        {holder ? <Mono className={s.intSmall}>{holder.displayId}</Mono> : null}
      </span>
      <span className={s.railSite}>
        {part ? `${part.siteText}, ${part.procedure ?? "procedure not stated"}` : "Not on this bench"}
        {current ? <span className={s.thisItem}>this item</span> : null}
      </span>
    </div>
  );
}

function RelatedPanel({ item, bench, siblings }: PanelProps) {
  const pv = usePreview();
  const [decision, setDecision] = useState<Decision | "">("");
  const [reason, setReason] = useState("");
  const formId = useId();
  if (!item.related.length) {
    return (
      <>
        <h3 id="c-panel-h" className={s.panelH}>
          No related-order candidates for this item
        </h3>
        <p className={s.panelLede}>
          Detection compares the source-scoped patient reference, encounter, office and collection day, within one tenant only. Similar names or birth dates never
          group orders.
        </p>
        {item.separateEncounters.length ? (
          <ul className={s.plainList}>
            {item.separateEncounters.map((x) => (
              <li key={x.orderId} className={s.factRow}>
                <span className={s.factKey}>Separate visit</span>
                <span className={s.factVal}>
                  <Mono>{x.sourceOrderId}</Mono>, encounter <Mono>{x.encounter ?? "Unknown"}</Mono>: a different visit stays a separate case.
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </>
    );
  }
  const rel: RelatedView = item.related[0];
  const task = item.tasks.find((t) => t.kind === "related_order_review") ?? null;
  const holderOf = (orderId: string) =>
    item.orders.some((o) => o.sourceOrderId === orderId) ? item : siblings.find((x) => x.orders.some((o) => o.sourceOrderId === orderId)) ?? null;
  const orders = [...rel.orders].sort((a, b) => {
    const pa = holderOf(a.sourceOrderId)?.orders.find((o) => o.sourceOrderId === a.sourceOrderId)?.parts[0]?.designation ?? "";
    const pb = holderOf(b.sourceOrderId)?.orders.find((o) => o.sourceOrderId === b.sourceOrderId)?.parts[0]?.designation ?? "";
    return pa.localeCompare(pb) || a.sourceOrderId.localeCompare(b.sourceOrderId);
  });
  const pending = rel.status === "pending_review";
  const canDecide = bench.permissions.reviewRelated && pending;
  return (
    <>
      <h3 id="c-panel-h" className={s.panelH}>
        <Mono className={s.idChip}>{rel.displayId}</Mono> Are these two orders one case?
      </h3>
      {!pending ? <p className={s.panelLede}>{relatedState(rel.status)}</p> : null}

      <div className={s.ladder} aria-label="What the two orders share">
        <div className={s.ladderHeads}>
          <OrderRail holder={holderOf(orders[0].sourceOrderId)} orderId={orders[0].sourceOrderId} current={holderOf(orders[0].sourceOrderId) === item} />
          <OrderRail holder={holderOf(orders[1].sourceOrderId)} orderId={orders[1].sourceOrderId} current={holderOf(orders[1].sourceOrderId) === item} />
        </div>
        <ul className={s.rungs}>
          <li className={s.rungCaption} title={rel.detectionRule}>
            <span className={s.rungText}>
              Shared by both orders{" "}
              <span className={s.dim}>
                (found {fmtTime(rel.detectedAt)} by the {rel.duplicateRecordKind ? "possible-duplicate-record" : "same-patient-visit"} rule
                {/\((v\d+)\)/.exec(rel.detectionRule)?.[1] ? ` ${/\((v\d+)\)/.exec(rel.detectionRule)?.[1]}` : ""})
              </span>
            </span>
          </li>
          {rel.reasons.map((r) => (
            <li key={r.code} className={s.rung}>
              <span className={s.rungText}>
                <Check size={14} aria-hidden className={s.rungIcon} />
                {r.label}
                {r.detail ? <span className={s.rungDetail}> {r.detail}</span> : null}
              </span>
            </li>
          ))}
          {rel.conflicts.map((r) => (
            <li key={r.code} className={cx(s.rung, s.rungConflict)}>
              <span className={s.rungText}>
                <TriangleAlert size={14} aria-hidden className={s.rungIcon} />
                {r.label}
                {r.detail ? <span className={s.rungDetail}> {r.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {!canDecide ? <p className={s.rule}>Grouping is a review, never a merge: both orders and both provisional ids stay.</p> : null}

      {rel.reviewedAt ? (
        <p className={s.panelLede}>
          Decision by {rel.reviewedByName ?? "Unknown"} at {fmtTime(rel.reviewedAt)}: {relatedState(rel.status)}.{rel.decisionReason ? ` Reason: ${rel.decisionReason}` : ""}
        </p>
      ) : null}

      {canDecide ? (
        <fieldset className={s.decide} aria-describedby={`${formId}-why`}>
          <legend className={s.decideLegend}>
            Your decision on {rel.displayId} <span className={s.legendNote}>A review, never a merge</span>
          </legend>
          <div className={s.options}>
            {DECISIONS.map((d) => (
              <label key={d.value} className={cx(s.option, decision === d.value && s.optionOn)}>
                <input
                  type="radio"
                  name={`${formId}-d`}
                  value={d.value}
                  checked={decision === d.value}
                  disabled={rel.duplicateRecordKind && d.value === "single_accession_approved"}
                  onChange={() => setDecision(d.value)}
                />
                <span>
                  <span className={s.optionLabel}>{d.label}</span>
                  {decision === d.value ? <span className={s.optionHint}>{d.hint}</span> : null}
                </span>
              </label>
            ))}
          </div>
          <div className={s.decideRight}>
            <label className={s.reasonLabel} htmlFor={`${formId}-r`}>
              Reason <span className={s.dim}>(required, recorded with your name)</span>
            </label>
            <textarea id={`${formId}-r`} className={s.reason} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            <p id={`${formId}-why`} className={s.srOnly}>
              Recording a decision does not merge records.
            </p>
            <Actions preview={pv.node}>
              <button
                type="button"
                className={s.btnPrimary}
                disabled={!decision || !reason.trim()}
                onClick={() =>
                  pv.show(
                    `Preview only. The working bench would record “${DECISIONS.find((d) => d.value === decision)?.label}” on ${rel.displayId} with your reason, then re-check step 5 for both items. Nothing was recorded.`,
                  )
                }
              >
                Record decision
              </button>
              {!decision || !reason.trim() ? <span className={s.why}>Choose an outcome and give a reason.</span> : null}
            </Actions>
          </div>
        </fieldset>
      ) : pending ? (
        <div className={s.whoDecides}>
          <p>
            <strong>Who decides:</strong> {task?.ownerName ?? "the accessioning lead"} ({roleLabel(task?.ownerRole ?? "accessioning_lead").toLowerCase()}). Your demo role (
            {roleLabel(bench.actor.role)}) can view this review but not decide.
          </p>
          <p className={s.dim}>Possible outcomes: {listWords(DECISIONS.map((d) => d.label.split(":")[0].toLowerCase()))}.</p>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- 4 routing

function RoutingPanel({ item, bench }: PanelProps) {
  const pv = usePreview();
  const r = item.routing;
  const order = item.orders[0] ?? null;
  if (!r) {
    return (
      <h3 id="c-panel-h" className={s.panelH}>
        No routing suggestion yet
      </h3>
    );
  }
  const doc = r.final ?? r.suggested;
  return (
    <>
      <h3 id="c-panel-h" className={s.panelH}>
        {r.status === "exception" ? (
          "No approved routing rule for this office"
        ) : (
          <>
            {r.status === "suggested" ? "Suggested" : "Assigned"} dermatopathologist:{" "}
            <span className={s.nowrap}>
              <Swatch color={doc?.color ?? null} />
              {doc?.name ?? "Unknown"}
            </span>
          </>
        )}
      </h3>
      <p className={s.panelLede}>{r.explanation}</p>
      <ul className={s.plainList}>
        <li className={s.factRow}>
          <span className={s.factKey}>Status</span>
          <span className={s.factVal}>
            {r.status === "confirmed" || r.status === "overridden"
              ? `${r.status === "overridden" ? "Overridden" : "Confirmed"} by ${r.decidedByName ?? "Unknown"} at ${fmtTime(r.decidedAt)}.`
              : r.status === "exception"
                ? "Routing exception. A lead assigns a dermatopathologist with a reason."
                : "Suggested by rule, not yet accepted."}
            {r.overrideReason ? ` Reason: ${r.overrideReason}` : ""}
          </span>
        </li>
        <li className={s.factRow}>
          <span className={s.factKey}>Rule</span>
          <span className={s.factVal}>
            {r.ruleSetVersion ? `Rule set v${r.ruleSetVersion}, effective ${r.ruleSetEffectiveFrom ? dayFmt.format(new Date(r.ruleSetEffectiveFrom)) : "Unknown"}` : "No rule applies"}
            {r.coverage ? ", coverage exception applied" : ""}.
          </span>
        </li>
        <li className={s.factRow}>
          <span className={s.factKey}>Not the same person</span>
          <span className={s.factVal}>
            Ordering clinician {order?.clinicianName ?? "Unknown"} took the biopsy at {item.office?.name ?? "the office"}. The assigned dermatopathologist reads the case at the lab.
          </span>
        </li>
      </ul>
      <Actions preview={pv.node}>
        {r.status === "suggested" ? (
          <button type="button" className={s.btnPrimary} disabled={!bench.permissions.confirmRouting} onClick={() => pv.show("Preview only. Accepting records who accepted the rule's suggestion. Nothing was recorded.")}>
            Accept routing
          </button>
        ) : null}
        <button
          type="button"
          className={s.btnSecondary}
          disabled={!(r.status === "exception" ? bench.permissions.resolveException : bench.permissions.override)}
          onClick={() => pv.show("Preview only. An override needs a reason and is recorded with the lead's name. Nothing changed.")}
        >
          {r.status === "exception" ? "Assign dermatopathologist" : "Override routing"}
        </button>
        {!(r.status === "exception" ? bench.permissions.resolveException : bench.permissions.override) ? (
          <span className={s.why}>Only an accessioning lead or supervisor, with a reason.</span>
        ) : null}
      </Actions>
    </>
  );
}

// ---------------------------------------------------------------- 5 accession

function AccessionPanel({ item, bench, steps, siblings, onFocus }: PanelProps) {
  const pv = usePreview();
  const blockers = item.readiness.blockers.map((b) => ({ b, ...explainBlocker(item, b, bench.actor.name) }));
  const notBlocking: string[] = [];
  for (const h of item.holds) {
    if (!h.blocksAccession) notBlocking.push(`Hold ${h.displayId} on ${h.scopeLabel} stops ${listWords(h.blocks.map((x) => HOLD_STOPS[x] ?? x))}. All of these come after accession.`);
  }
  const covered = new Set<string>();
  for (const d of differences(item)) {
    if (!d.clar || covered.has(d.row.field)) continue;
    if (item.readiness.blockers.some((b) => b.code === "discrepancy_uncovered" || b.code === "identity_unresolved")) continue;
    covered.add(d.row.field);
    notBlocking.push(`${d.row.label} difference: question ${d.clar.displayId} covers it, so it does not stop accession.`);
  }
  const settled = steps.filter((x) => x.state === "done" && x.key !== "accession");
  const rel = item.related.find((r) => r.status === "pending_review" || r.status === "single_accession_approved");
  if (item.accession) {
    return (
      <>
        <h3 id="c-panel-h" className={s.panelH}>
          Accessioned as <Mono className={s.accBox}>{item.accession.number}</Mono>
        </h3>
        <p className={s.panelLede}>
          Issued by {item.accession.issuedBy} at {fmtTime(item.accession.issuedAt)}. {item.displayId} stays the provisional receipt id.
        </p>
      </>
    );
  }
  return (
    <>
      <h3 id="c-panel-h" className={s.panelH}>
        {item.readiness.ready ? "Ready to request the accession" : "Cannot request the accession yet"}
      </h3>
      {blockers.length ? (
        <ol className={s.blockers}>
          {blockers.map(({ b, text, owner, step }, i) => (
            <li key={i} className={s.blocker}>
              <Lock size={15} aria-hidden className={s.blockerIcon} />
              <span className={s.blockerText}>
                {text}
                <span className={s.blockerMeta}>
                  {owner ? `Owner: ${owner}. ` : ""}
                  {b.itemDisplay && b.itemDisplay !== item.displayId ? `On ${b.itemDisplay}. ` : ""}
                  <button type="button" className={s.linkBtn} onClick={() => onFocus(step)}>
                    Open step {steps.find((x) => x.key === step)?.n}
                  </button>
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {notBlocking.length ? (
        <div className={s.subsection}>
          <h4 className={s.subH}>Open, but not stopping accession</h4>
          <ul className={s.bullets}>
            {notBlocking.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {settled.length ? (
        <div className={s.subsection}>
          <h4 className={s.subH}>Already settled</h4>
          <ul className={s.bullets}>
            {settled.map((x) => (
              <li key={x.key}>
                {x.title}: {x.status} ({x.detail})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={s.numberRow}>
        <span className={s.numberSlot}>
          <span className={s.numberSlotLabel}>Official accession number</span>
          <Mono className={s.accEmpty}>Not issued</Mono>
        </span>
        <p className={s.numberNote}>
          Issued only by the source system, {bench.source.name.replace(/\s*\(simulated source adapter\)/i, "")} (simulated). <Mono>{item.displayId}</Mono> is a provisional receipt
          id and never becomes the accession number.
          {rel ? ` If ${rel.displayId} is linked as one accession, ${listWords([item.displayId, ...siblings.map((x) => x.displayId)])} are requested together.` : ""}
        </p>
      </div>
      <Actions preview={pv.node}>
        <button
          type="button"
          className={s.btnPrimary}
          disabled={!item.readiness.ready || !bench.permissions.requestAccession}
          onClick={() => pv.show("Preview only. The working bench asks the simulated source for a number. Nothing was requested.")}
        >
          Request accession (simulated source)
        </button>
        {!item.readiness.ready ? <span className={s.why}>Opens when the {blockers.length === 1 ? "reason above clears" : "reasons above clear"}.</span> : null}
      </Actions>
    </>
  );
}

// ================================================================= evidence (persistent)

function Evidence({ item }: { item: ItemDetail }) {
  const [idx, setIdx] = useState(0);
  const containers = item.containers;
  const c = containers[Math.min(idx, containers.length - 1)] ?? null;
  const order = c ? item.orders.find((o) => o.sourceOrderId === c.orderRef) ?? item.orders[0] ?? null : item.orders[0] ?? null;
  return (
    <aside className={s.evidence} aria-labelledby="c-ev-h">
      <div className={s.evTop}>
        <h2 id="c-ev-h" className={s.evH}>
          Evidence
        </h2>
        {containers.length > 1 ? (
          <div className={s.evTabs} role="tablist" aria-label="Containers">
            {containers.map((x, i) => (
              <button key={x.id} type="button" role="tab" aria-selected={i === idx} className={cx(s.evTab, i === idx && s.evTabOn)} onClick={() => setIdx(i)}>
                Container {x.seq}
                {x.designation ? ` (${x.designation})` : ""}
              </button>
            ))}
          </div>
        ) : c ? (
          <span className={s.evFor}>
            Container {c.seq}
            {c.designation ? `, part ${c.designation}` : ""}
          </span>
        ) : null}
      </div>
      <p className={s.evSub}>Three sources, compared field by field and never combined.</p>
      <ul className={s.sources}>
        <li>
          <FileText size={16} aria-hidden />
          <span className={s.srcName}>Order</span>
          <span className={s.srcWhat}>
            {order ? (
              <>
                <Mono>{order.sourceOrderId}</Mono> v{order.sourceVersion}, {order.tenantName} <span className={s.simTag}>simulated source</span>
              </>
            ) : (
              "No order linked"
            )}
          </span>
        </li>
        <li>
          <TestTube size={16} aria-hidden />
          <span className={s.srcName}>Bottle</span>
          <span className={s.srcWhat}>
            {c ? `Container ${c.seq}, staff entry${c.handwritten ? " from a handwritten label" : ""}` : "No container"}
          </span>
        </li>
        <li>
          <ClipboardList size={16} aria-hidden />
          <span className={s.srcName}>Requisition</span>
          <span className={s.srcWhat}>{item.requisition ? <><Mono>{item.requisition.docRef}</Mono>, paper, as read</> : "Not received"}</span>
        </li>
      </ul>
      {c ? (
        <table className={s.evTable}>
          <colgroup>
            <col className={s.colField} />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Order</th>
              <th scope="col">Bottle</th>
              <th scope="col">Requisition</th>
            </tr>
          </thead>
          <tbody>
            {c.comparison.map((r) => (
              <tr key={r.field} className={r.status === "differs" ? s.evDiffers : undefined}>
                <th scope="row">
                  {r.status === "match" ? (
                    <span className={s.evLabel}>
                      <Check size={13} aria-hidden className={s.resSame} />
                      {r.label}
                      <span className={s.srOnly}>: same in every source that states it</span>
                    </span>
                  ) : (
                    <>
                      <span className={s.evLabel}>{r.label}</span>
                      <span className={cx(s.evResult, r.status === "differs" ? s.resDiffers : s.resNc)}>
                        {r.status === "differs" ? <TriangleAlert size={13} aria-hidden /> : <CircleHelp size={13} aria-hidden />}
                        {r.status === "differs" ? "Differs" : "Not compared"}
                      </span>
                    </>
                  )}
                </th>
                <EvCell cell={r.order} none="Not stated" mrn={r.field === "mrn"} />
                <EvCell cell={r.observed} none="Not on label" mrn={r.field === "mrn"} />
                <EvCell cell={r.requisition} none={item.requisition ? "Not stated" : "No requisition"} mrn={r.field === "mrn"} />
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className={s.evFoot}>
        <CircleHelp size={14} aria-hidden /> Not compared: fewer than two sources state the value. It is never counted as a match.
      </p>
      {c ? (
        <p className={s.evFoot}>
          <ScanLine size={14} aria-hidden />
          {c.verificationState === "unverified"
            ? "No one has checked this bottle yet. A scan found the record; it does not verify the tissue."
            : `${c.verifiedByName ?? "Unknown"} checked the physical bottle at ${fmtTime(c.verifiedAt)}. A scan alone never sets this.`}
        </p>
      ) : null}
    </aside>
  );
}

function EvCell({ cell, none, mrn }: { cell: { original: string | null; note?: string | null }; none: string; mrn?: boolean }) {
  if (!cell.original) {
    return (
      <td>
        <span className={s.none}>{none}</span>
      </td>
    );
  }
  // "448210 (EMA-SIM Sunrise Coast)": the number is an identifier, the tenant is a name.
  const m = mrn ? /^(\S+)\s*\((.+)\)$/.exec(cell.original) : null;
  return (
    <td title={cell.note ?? undefined}>
      {m ? (
        <>
          <span className={s.mono}>{m[1]}</span>
          <span className={s.evNote}>{m[2]}</span>
        </>
      ) : (
        cell.original
      )}
    </td>
  );
}

// ================================================================= metadata

function MetaFooter({ item }: { item: ItemDetail }) {
  return (
    <footer className={s.meta}>
      <p>
        Received {fmtTime(item.receivedAt)} by {item.receivedByName ?? "Unknown"}
        {item.delivery ? (
          <>
            {" "}
            from courier <Mono>{item.delivery.displayId}</Mono>
          </>
        ) : null}
        . Last change {fmtTime(item.updatedAt)} by {item.updatedByName ?? "Unknown"}. Record version {item.version}.
      </p>
      <details className={s.history}>
        <summary>History ({item.audit.length} latest events)</summary>
        <ol>
          {item.audit.map((a) => (
            <li key={a.id}>
              <span className={s.histTime}>{fmtTime(a.at)}</span>
              <span>
                {a.actorName ?? "System"}
                {a.origin === "demo" ? " (demo setup)" : ""}: {a.summary}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </footer>
  );
}
