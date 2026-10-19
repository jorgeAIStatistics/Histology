"use client";

import { ListOrdered, TriangleAlert } from "lucide-react";
import type { ItemDetail } from "@/server/queries/intake";
import { DoctorChip, DoctorSwatch } from "@/components/domain/doctor-chip";
import { IdentityMark } from "@/components/domain/identity-mark";
import { SpecimenLabel } from "@/components/domain/specimen-label";
import { encodeLabel, namespaceCode } from "@/lib/identifiers";
import { identityFacts, partsOf } from "./plan";

/**
 * The current item set as its specimen label (shared SpecimenLabel): dashed
 * provisional label before accession, solid label with its DataMatrix after.
 */
function ItemLabel({ item }: { item: ItemDetail }) {
  const parts = partsOf(item);
  const order = item.orders[0] ?? null;
  const orderLine = order ? (
    <>
      Order <span className="id-mono">{order.sourceOrderId}</span>
      {item.orders.length > 1 ? <span className="text-ink-muted"> +{item.orders.length - 1}</span> : null}
    </>
  ) : (
    <span className="text-ink-muted">No source order linked</span>
  );
  if (item.accession) {
    const acc = item.accession;
    return (
      <SpecimenLabel
        status="official"
        id={acc.number}
        parts={parts}
        payload={encodeLabel({ kind: "C", namespace: namespaceCode(acc.namespace), accession: acc.number })}
        lines={[
          acc.namespace,
          <>
            From <span className="id-mono">{item.displayId}</span>
            {order ? (
              <>
                {" "}
                · Order <span className="id-mono">{order.sourceOrderId}</span>
              </>
            ) : null}
          </>,
        ]}
      />
    );
  }
  return <SpecimenLabel status="provisional" id={item.displayId} parts={parts} lines={[orderLine, "Official number: not issued"]} />;
}

/**
 * Identity band (pinned under the top bar): the specimen label, the patient
 * as written on the bottle with DOB and MRN (source system secondary), the
 * site and side, the office, who ordered it and who it is routed to. A patient
 * identity mismatch shows here with the red octagon, not only in the comparison.
 */
export function IdentityBand({
  item,
  queueCount,
  queueOpen,
  onToggleQueue,
}: {
  item: ItemDetail;
  queueCount: number;
  queueOpen: boolean;
  onToggleQueue: () => void;
}) {
  const f = identityFacts(item);
  const order = item.orders[0] ?? null;
  const r = item.routing;
  const doctor = r && r.status !== "exception" ? (r.final ?? r.suggested) : null;
  // "Dr. Hannah Cole" already says it; a credential is shown when the name has no title ("Jamal Reed, PA-C").
  const clinician = order?.clinicianName ? `${order.clinicianName}${order.clinicianCredential && !/^Dr\.?\s/.test(order.clinicianName) ? `, ${order.clinicianCredential}` : ""}` : null;
  const multi = item.containers.length > 1;
  const sites = multi
    ? item.containers.map((c) => {
        const part = c.orderPartId ? item.orders.flatMap((o) => o.parts).find((p) => p.id === c.orderPartId) : null;
        return { key: c.id, part: c.designation, text: part?.siteText ?? c.observed.site_text ?? "Site not stated" };
      })
    : [];
  return (
    <section
      aria-label="Current case"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-5 py-2 max-[89.9375rem]:gap-x-5 max-xl:px-4 xl:flex-nowrap"
    >
      <button
        type="button"
        onClick={onToggleQueue}
        aria-expanded={queueOpen}
        aria-controls="intake-queue"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-subtle xl:hidden"
      >
        <ListOrdered className="size-4" aria-hidden />
        Queue <span className="num-tabular font-normal text-ink-muted">({queueCount})</span>
      </button>

      <ItemLabel item={item} />

      <div className="shrink-0 leading-5">
        <p className="text-xl leading-8 font-bold tracking-[-0.015em] whitespace-nowrap text-ink">
          {f.name.value ?? "Patient unknown"}
          {f.name.from === "bottle" ? <span className="sr-only"> (name as written on the bottle)</span> : null}
        </p>
        {f.name.differs ? (
          <p className="mt-0.5 inline-flex items-center gap-1 rounded-sm bg-danger-bg px-1.5 text-sm font-medium text-danger-fg">
            <IdentityMark className="size-3.5" />
            <span className="sr-only">Patient identity differs:</span>
            Order says {f.name.orderValue ?? "no name"}
          </p>
        ) : null}
        {f.dob.differs ? (
          <dl className="mt-0.5 grid grid-cols-[auto_auto] items-baseline justify-start gap-x-1.5 rounded-sm bg-danger-bg px-1.5 text-sm text-danger-fg">
            <dt className="flex items-center gap-1 font-medium">
              <IdentityMark className="size-3.5 self-center" />
              <span className="sr-only">Patient identity differs:</span>
              DOB
            </dt>
            <dd>
              <span className="id-mono font-semibold">{f.dob.value}</span> on the bottle
            </dd>
            <dt className="sr-only">DOB on the order</dt>
            <dd className="col-start-2">
              <span className="id-mono">{f.dob.orderValue ?? "none"}</span> on the order
            </dd>
          </dl>
        ) : (
          <p className="flex flex-wrap gap-x-3 text-sm text-ink-secondary">
            <span>
              DOB <span className="id-mono text-ink">{f.dob.value ?? "Unknown"}</span>
            </span>
            {item.patient ? (
              <span>
                MRN <span className="id-mono text-ink">{item.patient.mrn}</span>
              </span>
            ) : null}
          </p>
        )}
        <p className="text-sm text-ink-muted">
          {item.patient ? (
            <>
              {f.dob.differs ? (
                <>
                  MRN <span className="id-mono text-ink-secondary">{item.patient.mrn}</span>{" "}
                </>
              ) : (
                "MRN in "
              )}
              {item.patient.tenantName}
            </>
          ) : (
            "No source patient record (no order linked)"
          )}
        </p>
      </div>

      <div className="min-w-0 max-w-[16rem] leading-5 xl:shrink">
        {multi ? (
          <ul className="text-sm text-ink">
            {sites.map((s) => (
              <li key={s.key} className="break-words">
                <span className="font-semibold">Part {s.part ?? "?"}</span> {s.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base font-medium text-ink">{f.site ?? "Site not stated"}</p>
        )}
        {f.sideWarning ? (
          <p className="mt-0.5 inline-flex items-center gap-1 rounded-sm bg-warning-bg px-1.5 text-sm font-medium text-warning-fg">
            <TriangleAlert className="size-3.5 shrink-0 text-warning-solid" aria-hidden />
            {f.sideWarning}
          </p>
        ) : null}
      </div>

      <dl className="ml-auto grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 text-sm leading-5 text-ink max-xl:ml-0 max-xl:flex max-xl:basis-full max-xl:flex-wrap max-xl:items-baseline max-xl:gap-x-2 xl:shrink">
        <dt className="text-ink-muted">{r?.status === "suggested" ? "Suggested" : "Routed to"}</dt>
        <dd className="min-w-0 break-words max-xl:mr-3">
          {doctor ? (
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <DoctorSwatch color={doctor.color} />
              {doctor.name}
            </span>
          ) : (
            <DoctorChip name={null} />
          )}
        </dd>
        <dt className="text-ink-muted">Ordered by</dt>
        <dd className="min-w-0 break-words max-xl:mr-3">{clinician ?? <span className="text-ink-muted">Unknown (no order linked)</span>}</dd>
        <dt className="text-ink-muted">Office</dt>
        <dd className="min-w-0 break-words">
          {item.office ? (
            <>
              {item.office.name}
              {item.office.status === "new_unreviewed" ? <span className="text-ink-muted"> (new office, not reviewed)</span> : null}
            </>
          ) : (
            <>&ldquo;{item.observedOfficeText ?? "Unknown"}&rdquo; (not in the directory)</>
          )}
        </dd>
      </dl>
    </section>
  );
}
