import type { ReactNode } from "react";
import type { ContainerView, ItemDetail, OrderPartView, OrderView } from "@/server/queries/intake";

type ComparisonRow = ContainerView["comparison"][number];
import s from "./atlas.module.css";

/**
 * The three evidence sources drawn as restrained physical objects. Each is
 * bound to its own record and never borrows a value from another source:
 * the order record (source system, simulated), the bottle (staff's typed
 * observation of the handwritten label), and the paper requisition (as read).
 */

function markWithin(text: string, needle: string | null): ReactNode {
  if (!needle) return text;
  const re = new RegExp(`(^|\\b)(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(\\b|$)`);
  const m = re.exec(text);
  if (!m) return text;
  const start = m.index + m[1].length;
  return (
    <>
      {text.slice(0, start)}
      <mark className={s.diffMark}>{m[2]}</mark>
      {text.slice(start + m[2].length)}
    </>
  );
}

function diffNeedle(rows: ComparisonRow[], field: string, cell: "order" | "observed" | "requisition"): string | null {
  const r = rows.find((x) => x.field === field && x.status === "differs");
  return r ? r[cell].original : null;
}

export function OrderRecord({ order, part, rows }: { order: OrderView; part: OrderPartView; rows: ComparisonRow[] }) {
  const latNeedle = diffNeedle(rows, "laterality", "order");
  return (
    <figure className={s.obj}>
      <div className={s.record} role="img" aria-label={`Order ${order.sourceOrderId} version ${order.sourceVersion} from ${order.tenantName}, simulated source`}>
        <div className={s.recordBar}>
          <span>{order.tenantName}</span>
        </div>
        <div className={s.recordBody}>
          <span className={s.objId}>
            {order.sourceOrderId} <span className={s.objIdSub}>v{order.sourceVersion}</span>
          </span>
          <span className={s.objLine}>
            Part {part.designation}: {markWithin(part.siteText, latNeedle)}
          </span>
          <span className={s.objLine}>{part.procedure ? part.procedure[0].toUpperCase() + part.procedure.slice(1) : "Procedure not stated"}</span>
        </div>
      </div>
      <figcaption className={s.objCap}>
        <strong>Order</strong>
        <span>Source system, simulated</span>
      </figcaption>
    </figure>
  );
}

export function Bottle({ container, rows }: { container: ContainerView; rows: ComparisonRow[] }) {
  const o = container.observed;
  const siteNeedle = diffNeedle(rows, "laterality", "observed") ?? diffNeedle(rows, "site", "observed");
  const dobNeedle = diffNeedle(rows, "birth_date", "observed");
  const nameNeedle = diffNeedle(rows, "patient_name", "observed");
  const line = (v: string | null, needle: string | null, missing: string) =>
    v ? <span className={container.handwritten ? s.hand : undefined}>{markWithin(v, needle)}</span> : <span className={s.notOnLabel}>{missing}</span>;
  return (
    <figure className={s.obj}>
      <div className={s.bottle} role="img" aria-label={`Bottle for container ${container.seq}: ${container.labelText}. Typed observation, not a photo.`}>
        <div className={s.cap} aria-hidden />
        <div className={s.jar}>
          <div className={s.jarLabel}>
            {line(o.patient_name, nameNeedle, "No name")}
            {line(o.birth_date, dobNeedle, "No date of birth")}
            <span className={s.jarRow}>
              {o.part_designation ? <span className={s.partBox}>{o.part_designation}</span> : <span className={s.notOnLabel}>No part</span>}
              {line(o.site_text, siteNeedle, "No site")}
            </span>
            {line(o.procedure, diffNeedle(rows, "procedure", "observed"), "No method")}
          </div>
        </div>
      </div>
      <figcaption className={s.objCap}>
        <strong>
          Bottle {container.seq}, {container.handwritten ? "handwritten" : "printed label"}
        </strong>
        <span>Typed by staff, not a photo</span>
      </figcaption>
    </figure>
  );
}

export function MissingBottle({ designation }: { designation: string }) {
  return (
    <figure className={s.obj}>
      <div className={`${s.bottle} ${s.bottleMissing}`} role="img" aria-label={`No container received for part ${designation}`}>
        <div className={s.cap} aria-hidden />
        <div className={s.jar}>
          <div className={s.jarLabel}>
            <span className={s.notOnLabel}>No container received</span>
          </div>
        </div>
      </div>
      <figcaption className={s.objCap}>
        <strong>Bottle, not received</strong>
        <span>The order expects one</span>
      </figcaption>
    </figure>
  );
}

type ReqFields = { order_id?: string; patient_name?: string; birth_date?: string; specimens?: { designation?: string; site?: string; procedure?: string; laterality?: string }[] };

export function Requisition({ item, designation, rows }: { item: ItemDetail; designation: string; rows: ComparisonRow[] }) {
  const req = item.requisition;
  if (!req) {
    return (
      <figure className={s.obj}>
        <div className={`${s.paper} ${s.paperMissing}`} role="img" aria-label="No paper requisition received">
          <span className={s.notOnLabel}>No requisition received</span>
        </div>
        <figcaption className={s.objCap}>
          <strong>Requisition</strong>
          <span>Paper, not received</span>
        </figcaption>
      </figure>
    );
  }
  const f = req.fields as ReqFields;
  const spec = (f.specimens ?? []).find((x) => x.designation === designation);
  const latNeedle = diffNeedle(rows, "laterality", "requisition");
  return (
    <figure className={s.obj}>
      <div className={s.paper} role="img" aria-label={`Paper requisition ${req.docRef}`}>
        <span className={s.objId}>{req.docRef}</span>
        <span className={s.objLine}>{f.patient_name ?? <span className={s.notOnLabel}>No name</span>}</span>
        <span className={s.objLine}>
          {spec ? (
            <>
              <span className={s.partBox}>{designation}</span> {spec.site ? markWithin(spec.site, latNeedle) : <span className={s.notOnLabel}>No site</span>}
            </>
          ) : (
            <span className={s.notOnLabel}>Part {designation} not listed</span>
          )}
        </span>
      </div>
      <figcaption className={s.objCap}>
        <strong>Requisition</strong>
        <span>Paper, as read at the bench</span>
      </figcaption>
    </figure>
  );
}
