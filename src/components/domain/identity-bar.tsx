"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TriangleAlert } from "lucide-react";
import { encodeLabel, namespaceCode } from "@/lib/identifiers";
import { DoctorChip } from "./doctor-chip";
import { HoldPill } from "./hold";
import { SyntheticTag } from "./honesty";
import { PasTag } from "./pas-tag";
import { SpecimenLabel } from "./specimen-label";

/**
 * Sticky identity bar (spec §5.3): the current case or part stays visible
 * during every edit and confirmation, led by the part set as its specimen
 * label (dashed provisional, solid official). Sits directly under the top bar.
 * When `contextKey` changes (a scan opened a different case/part), it shows a
 * 2px brand outline for ~1.5 s (no movement) and announces "Now working on ...".
 * Pages must reset their form fields on context change (values never carry over)
 * and ask first when there are unsaved edits (see useUnsavedChanges).
 */
export type IdentityRef =
  | { kind: "accession"; accession: string; namespace?: string }
  | { kind: "provisional"; id: string };

export interface IdentityBarProps {
  identity: IdentityRef;
  part?: { letter: string; description?: string; warning?: string } | null;
  /** Synthetic patient. MRN always shows its tenant (an MRN is unique only within one source system). */
  patient?: { name: string; mrn?: string | null; tenant?: string | null } | null;
  office?: string | null;
  /** Assigned dermatopathologist. `null` = routing exception (unassigned); omit to hide. */
  doctor?: { name: string; color?: string | null; shortName?: string } | null;
  /** Hold scopes, e.g. ["Part B"]. */
  holds?: string[];
  pas?: boolean | { workOrder?: string; target?: string };
  /** Right-aligned actions. */
  actions?: ReactNode;
  /** Change it when the case/part in context changes. Default derived from identity + part. */
  contextKey?: string;
  /** Custom announcement; default "Now working on D26-04817 Part A". */
  announcement?: string;
  className?: string;
}

function identityText(identity: IdentityRef, part?: { letter: string } | null): string {
  const base = identity.kind === "accession" ? identity.accession : `provisional intake item ${identity.id}`;
  return part ? `${base} Part ${part.letter}` : base;
}

export function IdentityBar({
  identity,
  part,
  patient,
  office,
  doctor,
  holds,
  pas,
  actions,
  contextKey,
  announcement,
  className,
}: IdentityBarProps) {
  const key = contextKey ?? identityText(identity, part);
  const prev = useRef<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (prev.current === null) {
      prev.current = key;
      return;
    }
    if (prev.current === key) return;
    prev.current = key;
    setFlash(true);
    setMessage("");
    const say = window.setTimeout(() => setMessage(announcement ?? `Now working on ${identityText(identity, part)}`), 50);
    const off = window.setTimeout(() => setFlash(false), 1500);
    return () => {
      window.clearTimeout(say);
      window.clearTimeout(off);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const payload =
    identity.kind === "accession" && identity.namespace
      ? encodeLabel({ kind: "C", namespace: namespaceCode(identity.namespace), accession: identity.accession })
      : undefined;

  return (
    <section
      aria-label="Current case"
      data-identity-sticky
      className={cn(
        "sticky top-[var(--hlo-chrome-h)] z-20 flex min-h-[var(--hlo-identity-h)] flex-wrap [@media(max-height:35rem)]:static items-center gap-x-5 gap-y-2 border-b border-line bg-surface px-6 py-2 max-xl:gap-x-4 max-xl:px-4",
        flash && "hlo-identity-flash",
        className,
      )}
    >
      <SpecimenLabel
        size="md"
        status={identity.kind === "accession" ? "official" : "provisional"}
        id={identity.kind === "accession" ? identity.accession : identity.id}
        parts={part ? [part.letter] : []}
        payload={payload}
        lines={[
          identity.kind === "accession" ? (identity.namespace ?? "Accession") : "Official number: not issued",
        ]}
      />

      {patient ? (
        <div className="min-w-0 leading-5">
          <p className="flex items-center gap-2">
            <span className="text-md font-semibold tracking-[-0.01em] text-ink">{patient.name}</span>
            <SyntheticTag />
          </p>
          {patient.mrn ? (
            <p className="text-sm text-ink-secondary">
              MRN <span className="id-mono text-ink">{patient.mrn}</span>
              {patient.tenant ? <span className="text-ink-muted"> · {patient.tenant}</span> : null}
            </p>
          ) : null}
        </div>
      ) : null}

      {part?.description || part?.warning ? (
        <div className="min-w-0 max-w-[22rem] leading-5">
          {part.description ? <p className="text-base font-medium text-ink first-letter:uppercase">{part.description}</p> : null}
          {part.warning ? (
            <p className="mt-0.5 inline-flex items-start gap-1 rounded-sm bg-warning-bg px-1.5 text-sm font-medium text-warning-fg">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning-solid" aria-hidden />
              {part.warning}
            </p>
          ) : null}
        </div>
      ) : null}

      {doctor !== undefined || office ? (
        <div className="min-w-0 text-sm leading-5 text-ink-secondary">
          {doctor !== undefined ? <DoctorChip name={doctor?.name ?? null} color={doctor?.color} className="text-base font-medium text-ink" /> : null}
          {office ? <p>{office}</p> : null}
        </div>
      ) : null}

      {(holds && holds.length > 0) || pas ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {holds?.map((h) => (
            <HoldPill key={h} scope={h} />
          ))}
          {pas ? <PasTag {...(typeof pas === "object" ? pas : {})} /> : null}
        </div>
      ) : null}

      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}

      <span className="sr-only" aria-live="polite">
        {message}
      </span>
    </section>
  );
}
