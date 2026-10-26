"use client";

import { formatBytes, formatDate, formatDateTime } from "@/lib/format";
import type { Slide } from "@/lib/types";
import { Notice } from "@/components/ui/Notice";
import { ProvenanceChip } from "@/components/ui/Badges";
import type { ViewerMetrics } from "./SlideViewer";
import { PanelSection } from "./shared";

function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-graphite">{k}</dt>
      <dd className={mono ? "break-all font-mono text-micro" : "text-ink"}>{v}</dd>
    </>
  );
}

export function DetailsPanel({ slide, metrics }: { slide: Slide; metrics: ViewerMetrics | null }) {
  const l = slide.lineage;
  return (
    <div data-testid="details-panel">
      <PanelSection title="Provenance">
        <ProvenanceChip provenance={slide.provenance} long />
        {slide.synthetic_notice ? <p className="mt-2 text-small font-semibold text-hema">{slide.synthetic_notice}: procedurally generated tiles. Nothing on screen is tissue.</p> : null}
        {slide.provenance === "public_cc0" ? (
          <p className="mt-2 text-small text-graphite">
            Public CC0 OpenSlide test data (CMU-1-Small-Region.svs). Unlabeled: no diagnosis may be inferred from its name or appearance.
          </p>
        ) : null}
      </PanelSection>
      <PanelSection title="Hierarchy">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          <Row k="Coded patient" v={l.patient_code ?? "unassigned"} />
          <Row k="Case" v={l.accession_code ?? "unassigned"} />
          <Row k="Collected" v={formatDate(l.collected_on)} />
          <Row k="Site" v={l.site_id ?? "not recorded"} />
          <Row k="Part" v={`${l.part ?? "?"}${l.anatomic_site_text ? `, ${l.anatomic_site_text}` : ""}`} />
          <Row k="Block" v={l.block ?? "?"} />
          <Row k="Level" v={slide.level_index ?? "none"} />
          <Row k="Stain" v={slide.stain ?? "not recorded"} />
          <Row k="Scanner" v={slide.scanner_id ?? "not recorded"} />
        </dl>
      </PanelSection>
      <PanelSection title="Image">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          <Row k="Kind" v={slide.image_kind === "wsi" ? "Whole-slide image" : slide.image_kind === "field_image" ? "Camera field image (not a whole slide)" : "Synthetic tiles"} />
          <Row k="Format" v={`${slide.format ?? "?"}${slide.vendor ? ` (${slide.vendor})` : ""}`} />
          <Row k="Level-0 size" v={slide.width ? `${slide.width.toLocaleString()} × ${slide.height?.toLocaleString()} px` : "unknown"} />
          <Row k="Pyramid levels" v={slide.levels ?? "?"} />
          <Row k="Calibration" v={slide.mpp_x ? `${slide.mpp_x} × ${slide.mpp_y} µm/px` : "unknown (no scale bar)"} />
          <Row k="Objective" v={slide.objective_power ? `${slide.objective_power}×` : "not recorded"} />
          <Row k="File size" v={formatBytes(slide.bytes)} />
          <Row k="SHA-256" v={slide.sha256} mono />
          <Row k="Processing" v={slide.processing_version ?? "n/a"} mono />
          <Row k="Ingested" v={formatDateTime(slide.ingested_at)} />
        </dl>
        <p className="mt-1 text-micro text-graphite">{slide.sha256_note}</p>
      </PanelSection>
      {slide.identifier_risk.length || slide.associated_images_present_not_served.length ? (
        <PanelSection title="Identifier risk">
          <Notice tone="warning" title="Possible identifier sources">
            <ul className="list-disc space-y-1 pl-4">
              {slide.identifier_risk.map((f) => (
                <li key={f.code}>
                  {f.detail}
                  {f.property_keys?.length ? <span className="block font-mono text-[11px]">{f.property_keys.join(", ")}</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-1">{slide.identifier_notice}</p>
          </Notice>
          {slide.associated_images_present_not_served.length ? (
            <p className="mt-2 text-small text-graphite">Associated images in the file, never served: {slide.associated_images_present_not_served.join(", ")}.</p>
          ) : null}
        </PanelSection>
      ) : null}
      <PanelSection title="Measured in this browser">
        {metrics?.firstTileMs != null ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small" data-testid="viewer-metrics">
            <Row k="Signed token" v={`${metrics.tokenMs} ms`} />
            <Row k="Viewer open" v={`${metrics.openMs ?? "?"} ms`} />
            <Row k="First tile drawn" v={`${metrics.firstTileMs} ms after the viewer started (${metrics.firstTileSinceNavigationMs} ms after page navigation)`} />
          </dl>
        ) : (
          <p className="text-small text-graphite">Waiting for the first tile…</p>
        )}
        <p className="mt-1 text-micro text-graphite">Real timings on this machine, not targets.</p>
      </PanelSection>
    </div>
  );
}
