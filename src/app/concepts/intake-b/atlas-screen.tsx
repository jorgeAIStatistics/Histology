"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DeliveryView, IntakeBench, ItemDetail, QueueItem } from "@/server/queries/intake";
import { INTAKE_STATUS } from "@/lib/domain";
import s from "./atlas.module.css";
import { partsOf, partHasDifference, differingRows, type NodeKey, type PartRef } from "./model";
import { DownstreamView, EvidenceView, OrderRecordView, PatientView, RelatedReview } from "./views";

/* ================================================================= node index */

export interface NodeInfo {
  key: NodeKey;
  kind: "patient" | "order" | "part" | "container" | "rel" | "acc";
  item: ItemDetail;
  part?: PartRef;
  containerId?: string;
  relId?: string;
}

function buildIndex(group: ItemDetail[]): Map<NodeKey, NodeInfo> {
  const m = new Map<NodeKey, NodeInfo>();
  const head = group[0];
  if (!head) return m;
  m.set("patient", { key: "patient", kind: "patient", item: head });
  m.set("acc", { key: "acc", kind: "acc", item: head });
  for (const it of group) {
    for (const o of it.orders) m.set(`order:${o.id}`, { key: `order:${o.id}`, kind: "order", item: it });
    for (const p of partsOf(it)) {
      m.set(`part:${p.part.id}`, { key: `part:${p.part.id}`, kind: "part", item: it, part: p });
      for (const c of p.containers) m.set(`ctr:${c.id}`, { key: `ctr:${c.id}`, kind: "container", item: it, part: p, containerId: c.id });
    }
    for (const r of it.related) m.set(`rel:${r.id}`, { key: `rel:${r.id}`, kind: "rel", item: head, relId: r.id });
  }
  return m;
}

function defaultNode(selected: ItemDetail | null): NodeKey | null {
  if (!selected) return null;
  const parts = partsOf(selected);
  const flagged = parts.find((p) => partHasDifference(p)) ?? parts.find((p) => p.missing) ?? parts[0];
  return flagged ? `part:${flagged.part.id}` : selected.orders[0] ? `order:${selected.orders[0].id}` : "patient";
}

/* ================================================================= screen */

export function AtlasScreen({ bench, siblings, initialNode }: { bench: IntakeBench; siblings: ItemDetail[]; initialNode: string | null }) {
  const selected = bench.selected;
  const group = useMemo(() => (selected ? [selected, ...siblings].sort((a, b) => a.displayId.localeCompare(b.displayId)) : []), [selected, siblings]);
  const index = useMemo(() => buildIndex(group), [group]);
  const [node, setNode] = useState<NodeKey | null>(() => (initialNode && index.has(initialNode) ? initialNode : defaultNode(selected)));
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const info = node ? index.get(node) ?? null : null;
  useScrollTopOn(node);

  return (
    <div className={s.root}>
      <TopBar bench={bench} />
      <div className={s.body}>
        <Rail bench={bench} group={group} node={node} onSelect={setNode} onlyExceptions={onlyExceptions} setOnlyExceptions={setOnlyExceptions} />
        <main className={s.main} id="b-main" aria-label="Selected record">
          {!selected ? (
            <div className={s.mainInner}>
              <p className={s.sentence}>{bench.selectedNotFound ? `No intake item ${bench.selectedNotFound}.` : "Choose an arrival from the atlas."}</p>
            </div>
          ) : info ? (
            <div key={info.key} className={s.enter}>
              {info.kind === "rel" ? (
                <RelatedReview bench={bench} group={group} relId={info.relId!} onSelect={setNode} />
              ) : info.kind === "acc" ? (
                <DownstreamView bench={bench} group={group} onSelect={setNode} />
              ) : info.kind === "patient" ? (
                <PatientView bench={bench} group={group} onSelect={setNode} />
              ) : info.kind === "order" ? (
                <OrderRecordView bench={bench} item={info.item} group={group} orderKey={info.key} onSelect={setNode} />
              ) : (
                <EvidenceView bench={bench} group={group} part={info.part!} containerId={info.containerId ?? null} onSelect={setNode} />
              )}
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

/* ================================================================= top bar */

function TopBar({ bench }: { bench: IntakeBench }) {
  const areas = [
    { href: "/intake", label: "Intake", current: true },
    { href: "/clarifications", label: "Clarifications" },
    { href: "/worklist", label: "Worklist" },
    { href: "/grossing", label: "Grossing" },
    { href: "/materials", label: "Materials" },
    { href: "/operations", label: "Operations" },
  ];
  const synced = bench.source.lastSuccessAt
    ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(bench.source.lastSuccessAt))
    : null;
  const now = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(bench.now));
  const srcName = bench.source.name.replace(/\s*\(simulated source adapter\)\s*/i, "");
  return (
    <header className={s.top}>
      <div className={s.brand}>
        <span className={s.brandMark} aria-hidden>
          <svg viewBox="0 0 20 20" width="18" height="18">
            <circle cx="5" cy="5" r="2.2" fill="currentColor" />
            <circle cx="5" cy="15" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="15" cy="10" r="2.2" fill="currentColor" />
            <path d="M5 7.2v5.6M7 5.6l6 3.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
        </span>
        <span className={s.brandName}>Histology Lab OS</span>
      </div>
      <nav className={s.areas} aria-label="Areas">
        {areas.map((a) => (
          <a key={a.href} href={a.href} className={a.current ? s.areaCurrent : s.area} aria-current={a.current ? "page" : undefined}>
            {a.label}
          </a>
        ))}
      </nav>
      <form className={s.scan} role="search" onSubmit={(e) => e.preventDefault()}>
        <label className={s.scanLabel} htmlFor="b-scan">
          Find record
        </label>
        <input id="b-scan" className={s.scanInput} placeholder="INT, order or label" aria-describedby="b-scan-hint" autoComplete="off" />
        <span id="b-scan-hint" className={s.scanHint}>A scan finds a record. It does not verify the bottle.</span>
      </form>
      <div className={s.status}>
        <span className={s.statusItem}>
          <span className={s.statusDot} data-ok={bench.source.available ? "1" : "0"} aria-hidden />
          <span>
            {srcName} <em>(simulated)</em>
            <br />
            <span className={s.statusSub}>{bench.source.available ? `Synced ${synced ?? "Unknown"} ET` : "Unavailable"}</span>
          </span>
        </span>
        <span className={s.statusItem}>
          <span>
            Demo clock {now} ET
            <br />
            <span className={s.statusSub}>Synthetic data</span>
          </span>
        </span>
        <span className={s.actor}>
          {bench.actor.name}
          <br />
          <span className={s.statusSub}>{bench.actor.role.replace(/_/g, " ")}</span>
        </span>
      </div>
    </header>
  );
}

/* ================================================================= rail (the atlas) */

function officeCount(line: DeliveryView["lines"][number]): { text: string; tone: "plain" | "missing" | "unknown" } {
  if (line.expected === null) return { text: `${line.received} received, expected Unknown`, tone: "unknown" };
  if (line.missing) return { text: `${line.received} of ${line.expected}, ${line.missing} missing`, tone: "missing" };
  return { text: `${line.received} of ${line.expected}`, tone: "plain" };
}

function Rail({
  bench,
  group,
  node,
  onSelect,
  onlyExceptions,
  setOnlyExceptions,
}: {
  bench: IntakeBench;
  group: ItemDetail[];
  node: NodeKey | null;
  onSelect: (k: NodeKey) => void;
  onlyExceptions: boolean;
  setOnlyExceptions: (v: boolean) => void;
}) {
  const delivery = bench.deliveries.find((d) => d.id === bench.activeDeliveryId) ?? null;
  const queueById = new Map(bench.queue.map((q) => [q.displayId, q]));
  const groupIds = new Set(group.map((g) => g.displayId));
  const open = bench.queue.filter((q) => q.lane !== "done");
  const inDelivery = new Set(delivery ? [...delivery.lines.flatMap((l) => l.items), ...delivery.offManifest.flatMap((o) => o.items)] : []);
  const earlier = open.filter((q) => !inDelivery.has(q.displayId));
  const done = bench.queue.filter((q) => q.lane === "done").length;
  let groupRendered = false;

  const visible = (q: QueueItem | undefined) => !!q && q.lane !== "done" && (!onlyExceptions || q.lane === "exceptions" || groupIds.has(q.displayId));

  const renderItems = (ids: string[]) => {
    const out: ReactNode[] = [];
    for (const id of ids) {
      const q = queueById.get(id);
      if (groupIds.has(id)) {
        if (!groupRendered) {
          groupRendered = true;
          out.push(<Submission key="group" group={group} node={node} onSelect={onSelect} />);
        }
        continue;
      }
      if (!visible(q)) continue;
      out.push(<ItemRow key={id} q={q!} />);
    }
    return out;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-nav]"));
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <aside className={s.rail} aria-label="Specimen atlas" onKeyDown={onKey}>
      {delivery ? (
        <div className={s.railHead}>
          <div className={s.courier}>
            <span className={s.courierWord}>Courier</span>
            <span className={s.courierId}>{delivery.displayId}</span>
            <span className={s.courierWhen}>Arrived {delivery.arrivedAt ? fmt(delivery.arrivedAt) : "Unknown"}</span>
          </div>
          <dl className={s.courierCounts}>
            <div>
              <dt>Received</dt>
              <dd>{delivery.totals.received}</dd>
            </div>
            <div>
              <dt>Expected</dt>
              <dd data-unknown={delivery.totals.expected === null ? "1" : "0"}>{delivery.totals.expected === null ? "Unknown" : delivery.totals.expected}</dd>
            </div>
            <p className={s.courierWhy}>
              {delivery.totals.expected === null
                ? `${delivery.totals.unknownLines} offices sent no manifest; ${delivery.totals.expectedKnownPart} expected from the others.`
                : delivery.unpackingComplete
                  ? "Unpacking complete."
                  : "Counts so far."}{" "}
              {delivery.receivedByName ? `Unpacked by ${delivery.receivedByName}. ` : ""}Courier contents are simulated.
            </p>
          </dl>
          <div className={s.filter} role="group" aria-label="Show">
            <button type="button" aria-pressed={!onlyExceptions} onClick={() => setOnlyExceptions(false)}>
              All open <span>{open.length}</span>
            </button>
            <button type="button" aria-pressed={onlyExceptions} onClick={() => setOnlyExceptions(true)}>
              Exceptions <span>{bench.counts.exceptions}</span>
            </button>
          </div>
        </div>
      ) : null}

      <div className={s.offices}>
        {delivery?.lines.map((l) => {
          const items = renderItems(l.items);
          const missingSlots = l.missingParts.filter((m) => !groupIds.has(m.intakeDisplay));
          if (!items.length && !missingSlots.length && onlyExceptions) return null;
          const c = officeCount(l);
          return (
            <section key={l.id} className={s.office}>
              <h3 className={s.officeHead}>
                <span className={s.officeName}>{l.officeName}</span>
                <span className={s.officeCount} data-tone={c.tone}>
                  {c.text}
                </span>
              </h3>
              {!l.officeId ? <p className={s.officeNote}>Not in the routing directory</p> : null}
              <ul className={s.items}>
                {items}
                {missingSlots.map((m) => (
                  <li key={`${m.orderRef}-${m.designation}`}>
                    <a className={s.missingSlot} href={`?item=${m.intakeDisplay}`} data-nav>
                      <span className={s.slotBottle} aria-hidden />
                      <span>
                        No container for <span className={s.idInline}>{m.orderRef}</span> part {m.designation}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {delivery?.offManifest.map((o) => {
          const items = renderItems(o.items);
          if (!items.length) return null;
          return (
            <section key={o.officeName} className={s.office}>
              <h3 className={s.officeHead}>
                <span className={s.officeName}>{o.officeName}</span>
                <span className={s.officeCount} data-tone="unknown">
                  {o.received} received, not on a manifest
                </span>
              </h3>
              <ul className={s.items}>{items}</ul>
            </section>
          );
        })}
        {earlier.length ? (
          <section className={s.office}>
            <h3 className={s.officeHead}>
              <span className={s.officeName}>Still open from earlier couriers</span>
            </h3>
            <ul className={s.items}>{renderItems(earlier.map((q) => q.displayId))}</ul>
          </section>
        ) : null}
        <p className={s.doneNote}>{done} accessioned today, not shown</p>
      </div>
    </aside>
  );
}

function fmt(iso: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " ET";
}

function flagFor(q: QueueItem): { text: string; tone: string } | null {
  const r = q.reasons;
  if (!r.length) return null;
  const tone = r.some((x) => x.startsWith("Identity")) ? "danger" : r.some((x) => x.startsWith("Hold")) ? "hold" : "differs";
  return { text: r.join(", "), tone };
}

function ItemRow({ q }: { q: QueueItem }) {
  const f = flagFor(q);
  return (
    <li>
      <a className={s.itemRow} href={`?item=${q.displayId}`} data-nav data-lane={q.lane}>
        <span className={s.itemTop}>
          <span className={s.pid}>{q.displayId}</span>
          <span className={s.itemName}>{q.patientName ?? "Unknown patient"}</span>
        </span>
        {f ? (
          <span className={s.itemFlag} data-tone={f.tone}>
            {f.text}
          </span>
        ) : (
          <span className={s.itemQuiet}>
            {(INTAKE_STATUS as Record<string, string>)[q.status] ?? q.status}, {q.verifiedCount} of {q.containerCount} checked
          </span>
        )}
      </a>
    </li>
  );
}

/* ----------------------------------------------------------------- the expanded submission */

function partState(p: PartRef): { text: string; tone: "differs" | "missing" | "quiet" | "pending" } {
  if (p.missing && !p.containers.length) return { text: "No container", tone: "missing" };
  const c = p.containers[0];
  const d = c ? differingRows(c) : [];
  if (d.length) return { text: `${d.map((r) => r.label).join(", ")} differs`, tone: "differs" };
  if (c?.verificationState === "unverified") return { text: "Not checked", tone: "pending" };
  return { text: "Fields agree", tone: "quiet" };
}

function Submission({ group, node, onSelect }: { group: ItemDetail[]; node: NodeKey | null; onSelect: (k: NodeKey) => void }) {
  const head = group[0];
  const wrap = useRef<HTMLLIElement>(null);
  const [bracket, setBracket] = useState<{ top: number; height: number; mid: number } | null>(null);
  const rels = [...new Map(group.flatMap((g) => g.related).map((r) => [r.id, r])).values()];
  const rel = rels[0];
  const encounters = [...new Set(group.flatMap((g) => g.orders.map((o) => o.encounter ?? "Unknown")))];
  const accessioned = group.filter((g) => g.accession);

  // Bring the opened submission into view in the rail (no animation).
  useEffect(() => {
    const el = wrap.current;
    const rail = el?.closest("aside");
    if (!el || !rail) return;
    const top = el.offsetTop - (rail as HTMLElement).offsetTop;
    if (top + 120 > rail.clientHeight) rail.scrollTop = Math.max(0, top - 140);
  }, [head.id]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || !rel) return;
    const measure = () => {
      const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-order-row]"));
      if (rows.length < 2) return setBracket(null);
      const base = el.getBoundingClientRect().top;
      const a = rows[0].getBoundingClientRect();
      const b = rows[rows.length - 1].getBoundingClientRect();
      const linkRow = el.querySelector<HTMLElement>("[data-rel-row]")?.getBoundingClientRect();
      const top = a.top - base + a.height / 2;
      const bottom = b.top - base + b.height / 2;
      setBracket({ top, height: bottom - top, mid: linkRow ? linkRow.top - base + linkRow.height / 2 - top : (bottom - top) / 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rel, group]);

  const btn = (k: NodeKey, cls: string, children: ReactNode, extra?: Record<string, string>) => (
    <button type="button" className={`${cls} ${node === k ? s.nodeOn : ""}`} aria-current={node === k ? "true" : undefined} onClick={() => onSelect(k)} data-nav {...extra}>
      {children}
    </button>
  );

  const orderBranch = (it: ItemDetail) =>
    it.orders.map((o) => (
      <li key={o.id} className={s.li}>
        {btn(
          `order:${o.id}`,
          s.node,
          <>
            <span className={s.nodeKind}>Order</span>
            <span className={s.nodeId}>{o.sourceOrderId}</span>
            <span className={s.provChip} title="Provisional intake item: not an accession number">
              {it.displayId}
            </span>
          </>,
          { "data-order-row": "1" },
        )}
        <ul className={s.branch}>
          {partsOf(it)
            .filter((p) => p.order.id === o.id)
            .map((p) => {
              const st = partState(p);
              return (
                <li key={p.part.id} className={s.li}>
                  {btn(
                    `part:${p.part.id}`,
                    s.node,
                    <>
                      <span className={s.partLetter}>{p.part.designation}</span>
                      <span className={s.partSite}>{p.part.siteText}</span>
                      <span className={s.partState} data-tone={st.tone}>
                        {st.text}
                      </span>
                    </>,
                  )}
                  <ul className={s.branch}>
                    {p.containers.map((c) => (
                      <li key={c.id} className={s.li}>
                        {btn(
                          `ctr:${c.id}`,
                          `${s.node} ${s.nodeSmall}`,
                          <>
                            <span className={s.miniBottle} aria-hidden />
                            <span>Container {c.seq}</span>
                            <span className={s.ctrState} data-state={c.verificationState}>
                              {c.verificationState === "verified" ? "Staff verified" : c.verificationState === "discrepancy" ? "Checked, discrepancy recorded" : "Not checked"}
                            </span>
                          </>,
                        )}
                        {p.holds.map((h) => (
                          <span key={h.id} className={s.holdTag}>
                            <span className={s.holdWord}>Hold</span> <span className={s.idInline}>{h.displayId}</span> {h.scopeType === "order_part" ? `Part ${p.part.designation} only` : "whole item"}
                          </span>
                        ))}
                      </li>
                    ))}
                    {!p.containers.length ? (
                      <li className={s.li}>
                        <span className={`${s.node} ${s.nodeSmall} ${s.ghost}`}>
                          <span className={`${s.miniBottle} ${s.miniBottleGhost}`} aria-hidden />
                          No container received
                        </span>
                      </li>
                    ) : null}
                  </ul>
                </li>
              );
            })}
        </ul>
      </li>
    ));

  return (
    <li className={s.submission} ref={wrap}>
      {btn(
        "patient",
        `${s.node} ${s.nodeRoot}`,
        <>
          <span className={s.rootName}>
            {head.patient?.name ?? "Unknown patient"} <span className={s.synth}>Synthetic</span>
          </span>
          <span className={s.rootSub}>
            {head.patient ? (
              <>
                MRN <span className={s.idInline}>{head.patient.mrn}</span> {head.patient.tenantName}
              </>
            ) : (
              "Patient reference Unknown"
            )}
          </span>
          <span className={s.rootSub}>
            Encounter{encounters.length > 1 ? "s" : ""} <span className={s.idInline}>{encounters.join(", ")}</span>
          </span>
        </>,
      )}
      <ul className={`${s.branch} ${s.branchRoot}`}>
        {group.map((it, i) => (
          <FragmentWithLink key={it.id} showLink={!!rel && i === 0 && group.length > 1} relRow={rel ? (
            <li className={s.li}>
              {btn(
                `rel:${rel.id}`,
                `${s.node} ${s.relNode}`,
                <>
                  <span className={s.relId}>{rel.displayId}</span>
                  <span className={s.relText}>{rel.status === "pending_review" ? "Possibly related. Lead review pending; not merged" : "Related-order review recorded"}</span>
                </>,
                { "data-rel-row": "1" },
              )}
            </li>
          ) : null}>
            {orderBranch(it)}
          </FragmentWithLink>
        ))}
        <li className={s.li}>
          {btn(
            "acc",
            `${s.node} ${accessioned.length ? "" : s.ghost}`,
            <>
              <span className={s.nodeKind}>Accession</span>
              {accessioned.length ? (
                accessioned.map((g) => (
                  <span key={g.id} className={s.accChip}>
                    {g.accession!.number}
                  </span>
                ))
              ) : (
                <span className={s.ghostText}>
                  Not issued
                  {rel && rel.status === "pending_review" ? (
                    <>
                      . One or two? <span className={s.idInline}>{rel.displayId}</span> decides
                    </>
                  ) : null}
                </span>
              )}
            </>,
          )}
          <ul className={s.branch}>
            <li className={s.li}>
              <span className={`${s.node} ${s.nodeSmall} ${s.ghost}`}>
                <span className={s.ghostText}>Blocks and slides do not exist yet</span>
              </span>
            </li>
          </ul>
        </li>
      </ul>
      {bracket && rel ? (
        <svg className={s.bracket} style={{ top: bracket.top, height: Math.max(bracket.height, 1) }} width="18" height={Math.max(bracket.height, 1)} aria-hidden>
          <path d={`M2 0.5 H12 V${bracket.height - 0.5} H2`} fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="3 3" />
          <circle cx="12" cy={bracket.mid} r="3" fill="currentColor" />
        </svg>
      ) : null}
    </li>
  );
}

/** Renders an order branch and, after the first one, the dashed related-order row (a review, never a merge). */
function FragmentWithLink({ children, showLink, relRow }: { children: ReactNode; showLink: boolean; relRow: ReactNode }) {
  return (
    <>
      {children}
      {showLink ? relRow : null}
    </>
  );
}

/* keep the main region scrolled to top on selection change */
export function useScrollTopOn(dep: unknown) {
  useEffect(() => {
    document.getElementById("b-main")?.scrollTo({ top: 0 });
  }, [dep]);
}
