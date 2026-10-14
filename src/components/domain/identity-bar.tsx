"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { AccessionChip, IdChip, PartChip, ProvisionalChip } from "./chips";
import { DoctorChip } from "./doctor-chip";
import { HoldPill } from "./hold";
import { SyntheticTag } from "./honesty";
import { PasTag } from "./pas-tag";

/**
 * Sticky identity bar (spec §5.3): the current case or part stays visible
 * during every edit and confirmation. Sits directly under the top bar.
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

function Divider() {
  return <span aria-hidden className="h-5 w-px shrink-0 bg-line" />;
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

  return (
    <section
      aria-label="Current case"
      className={cn(
        "sticky top-[var(--hlo-chrome-h)] z-20 flex min-h-[var(--hlo-identity-h)] flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface px-6 py-2 max-xl:px-4",
        flash && "hlo-identity-flash",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        {identity.kind === "accession" ? (
          <AccessionChip accession={identity.accession} namespace={identity.namespace} href={false} />
        ) : (
          <ProvisionalChip id={identity.id} href={false} />
        )}
        {part ? <PartChip part={part.letter} description={part.description} warning={part.warning} /> : null}
      </div>

      {patient ? (
        <>
          <Divider />
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="font-medium text-ink">{patient.name}</span>
            <SyntheticTag />
            {patient.mrn ? <IdChip kind="MRN" id={patient.mrn} tenant={patient.tenant ?? undefined} /> : null}
          </div>
        </>
      ) : null}

      {office ? (
        <>
          <Divider />
          <span className="text-sm text-ink-secondary">{office}</span>
        </>
      ) : null}

      {doctor !== undefined ? (
        <>
          <Divider />
          <DoctorChip name={doctor?.name ?? null} color={doctor?.color} className="text-sm" />
        </>
      ) : null}

      {(holds && holds.length > 0) || pas ? (
        <>
          <Divider />
          <div className="flex flex-wrap items-center gap-1.5">
            {holds?.map((h) => (
              <HoldPill key={h} scope={h} />
            ))}
            {pas ? <PasTag {...(typeof pas === "object" ? pas : {})} /> : null}
          </div>
        </>
      ) : null}

      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}

      <span className="sr-only" aria-live="polite">
        {message}
      </span>
    </section>
  );
}
