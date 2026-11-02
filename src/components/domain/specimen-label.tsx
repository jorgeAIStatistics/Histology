"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { LabelPreview } from "./label-preview";

/**
 * The specimen label: the product's signature. The part currently in hand is
 * set as its label, so identity reads the way it does on the bench.
 * - provisional: dashed outline, "Provisional INT-…", never looks like an
 *   official number (the caller adds "Official number: not issued").
 * - official: solid outline, the accession number, optionally its DataMatrix
 *   (screen preview only).
 * The part letters are large; screen readers hear "Part B." first.
 */
export interface SpecimenLabelProps {
  status: "provisional" | "official";
  /** INT-… for provisional, the accession number for official. */
  id: string;
  /** Part letters, e.g. ["B"] or ["A", "B"]. Empty = the case as a whole. */
  parts?: string[];
  /** Up to two short lines under the id (order id, namespace, block). */
  lines?: ReactNode[];
  /** Official only: the DataMatrix payload (encodeLabel). */
  payload?: string;
  size?: "lg" | "md";
  className?: string;
}

export function SpecimenLabel({ status, id, parts = [], lines = [], payload, size = "lg", className }: SpecimenLabelProps) {
  const lg = size === "lg";
  const partWord = parts.length > 1 ? `Parts ${parts.join(" and ")}. ` : parts.length ? `Part ${parts[0]}. ` : "";
  return (
    <div
      className={cn(
        "flex shrink-0 items-stretch gap-2.5 rounded-md bg-surface",
        status === "provisional" ? "border-[1.5px] border-dashed border-ink-muted" : "border-[1.5px] border-ink",
        lg ? "py-1.5 pr-3 pl-2.5" : "py-1 pr-2.5 pl-2",
        className,
      )}
    >
      {parts.length ? (
        <span
          aria-hidden
          className={cn(
            "flex items-center font-bold leading-none tracking-[-0.03em] text-ink",
            parts.length > 1 ? (lg ? "text-[1.75rem]" : "text-[1.375rem]") : lg ? "text-[2.5rem]" : "text-[1.875rem]",
          )}
        >
          {parts.join(" ")}
        </span>
      ) : null}
      {partWord ? <span className="sr-only">{partWord}</span> : null}
      {status === "official" && payload ? (
        <LabelPreview bare payload={payload} text={id} size={lg ? 36 : 30} className="self-center" />
      ) : null}
      <div className={cn("flex min-w-0 flex-col justify-center leading-5", parts.length ? "border-l border-line pl-2.5" : "")}>
        <p className="flex items-baseline gap-1.5 whitespace-nowrap">
          {status === "provisional" ? (
            <>
              <span className="text-sm font-medium text-ink-muted">Provisional</span>
              <span className="sr-only">intake item </span>
            </>
          ) : (
            <span className="sr-only">Accession </span>
          )}
          <span className={cn("id-mono font-semibold text-ink", lg ? "text-md" : "text-base")}>{id}</span>
          {status === "provisional" ? <span className="sr-only">, not an accession number</span> : null}
        </p>
        {lines.map((l, i) => (
          <p key={i} className={cn("whitespace-nowrap text-sm", i === 0 ? "text-ink-secondary" : "text-ink-muted")}>
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * The specimen label at reference size, for identifiers inside lists, tables
 * and sentences: inline, no part letter or code. Solid ink outline for an
 * official or record id, dashed for a provisional INT- id.
 */
export function LabelRef({ id, provisional, href, className }: { id: string; provisional?: boolean; href?: string; className?: string }) {
  const cls = cn(
    "id-mono inline-flex items-center rounded-[3px] bg-surface px-1.5 text-sm leading-5 font-semibold text-ink",
    provisional ? "border-[1.5px] border-dashed border-ink-muted" : "border-[1.5px] border-ink",
    href && "underline-offset-2 hover:underline",
    className,
  );
  const sr = provisional ? <span className="sr-only">Provisional intake item </span> : null;
  return href ? (
    <Link href={href} className={cls}>
      {sr}
      {id}
    </Link>
  ) : (
    <span className={cls}>
      {sr}
      {id}
    </span>
  );
}
