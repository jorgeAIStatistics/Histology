"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { LABEL_STATUS_TEXT, slideTitle } from "@/lib/format";
import type { Worklist, WorklistItem } from "@/lib/types";
import { ErrorBox, Loading } from "@/components/ui/Notice";
import { ProvenanceChip, ReviewStateBadge } from "@/components/ui/Badges";
import { SlideGlyph } from "@/components/ui/SlideGlyph";

function Row({ r }: { r: WorklistItem }) {
  return (
    <li>
      <Link href={`/review/${r.slide_id}`} className="flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 hover:bg-paraffin" data-testid="review-landing-item">
        <SlideGlyph stain={r.stain} imageKind={r.image_kind} provenance={r.provenance} failed={r.ingest_status === "failed"} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink">
            {r.accession_code} · Part {r.part} · {slideTitle(r)}
          </span>
          <span className="block text-micro text-graphite">
            {r.patient_code} · {LABEL_STATUS_TEXT[r.slide_label_status]} · {r.open_qc_issues} open QC
          </span>
        </span>
        <ReviewStateBadge state={r.review_state} />
        <ProvenanceChip provenance={r.provenance} />
      </Link>
    </li>
  );
}

export function ReviewLanding() {
  const { projectId } = useSession();
  const wl = useApi<Worklist>(projectId ? `/projects/${projectId}/worklist` : null);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    try {
      setLast(window.localStorage.getItem("wb.lastSlide"));
    } catch {
      /* ignore */
    }
  }, []);
  const items = wl.data?.items ?? [];
  const pending = items.filter((r) => r.review_state === "pending_review" || r.review_state === "disputed");
  const lastItem = items.find((r) => r.slide_id === last);
  const cc0 = items.find((r) => r.provenance === "public_cc0");
  return (
    <div className="mx-auto max-w-[980px] px-4 pb-16 pt-6 md:px-6">
      <h1 className="text-display font-bold tracking-tight">Slide Review</h1>
      <p className="mt-1 max-w-[68ch] text-graphite">Choose a slide. Pending and disputed slides are listed in accession order; nothing is reordered by a model.</p>
      <ErrorBox error={wl.error} what="load the slides" className="mt-4" />
      {wl.loading && !wl.data ? <Loading /> : null}
      {lastItem ? (
        <section className="mt-6" aria-labelledby="rl-last">
          <h2 id="rl-last" className="text-small font-bold text-graphite">
            Continue where you left off
          </h2>
          <ul className="mt-1 rounded-[var(--radius-panel)] border border-line bg-sheet">
            <Row r={lastItem} />
          </ul>
        </section>
      ) : null}
      <section className="mt-6" aria-labelledby="rl-pending">
        <h2 id="rl-pending" className="text-small font-bold text-graphite">
          Pending review or disputed ({pending.length})
        </h2>
        <ul className="mt-1 divide-y divide-line rounded-[var(--radius-panel)] border border-line bg-sheet">
          {pending.map((r) => (
            <Row key={r.slide_id} r={r} />
          ))}
          {wl.data && pending.length === 0 ? <li className="px-3 py-4 text-small text-graphite">Nothing is waiting for review.</li> : null}
        </ul>
      </section>
      {cc0 ? (
        <section className="mt-6" aria-labelledby="rl-cc0">
          <h2 id="rl-cc0" className="text-small font-bold text-graphite">
            Real tissue image (public CC0 test slide, unlabeled)
          </h2>
          <ul className="mt-1 rounded-[var(--radius-panel)] border border-line bg-sheet">
            <Row r={cc0} />
          </ul>
        </section>
      ) : null}
      <p className="mt-6 text-small text-graphite">
        Every slide is also reachable from the{" "}
        <Link href="/worklist" className="font-semibold text-teal-deep underline">
          worklist
        </Link>
        .
      </p>
    </div>
  );
}
