"use client";

import { useId } from "react";
import type { ImageKind, Provenance } from "@/lib/types";

/**
 * A 3:1 glass slide drawn in miniature: frosted label end on the left, tissue on the right.
 * It encodes real attributes, not decoration: stain colour (H&E eosin/hematoxylin, PAS magenta),
 * synthetic material (hatched, no tissue), a camera field image (viewfinder) and a failed scan (dashed, no tissue).
 */
export function SlideGlyph({
  stain,
  imageKind,
  provenance,
  failed = false,
  size = 42,
  className,
}: {
  stain: string | null;
  imageKind: ImageKind;
  provenance: Provenance;
  failed?: boolean;
  size?: number;
  className?: string;
}) {
  const raw = useId();
  const pid = `h${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const isPas = (stain ?? "").toUpperCase().includes("PAS");
  const tissue = isPas ? "#a23a7a" : "#c07895";
  const nuclei = isPas ? "#5b2a6e" : "#463c78";
  const synthetic = provenance === "demo_synthetic" && imageKind !== "wsi";
  const description = failed
    ? "failed scan, no image"
    : imageKind === "field_image"
      ? "camera field image, not a whole slide"
      : synthetic
        ? "synthetic image, no histology"
        : `${stain ?? "unknown stain"} slide`;
  return (
    <svg width={size} height={size / 3} viewBox="0 0 42 14" role="img" aria-label={description} className={className}>
      <defs>
        <pattern id={pid} width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="3" fill="#e7e3f2" />
          <line x1="0" y1="0" x2="0" y2="3" stroke="#463c78" strokeWidth="1.1" />
        </pattern>
      </defs>
      <rect x="0.5" y="0.5" width="41" height="13" rx="1.6" fill={failed ? "#f8f7f3" : "#f2f5f5"} stroke={failed ? "#9a3412" : "#8f989b"} strokeDasharray={failed ? "2 1.5" : undefined} />
      <rect x="1.5" y="1.5" width="10" height="11" rx="0.8" fill="#dcd8cf" />
      <line x1="3" y1="5" x2="10" y2="5" stroke="#bab5aa" strokeWidth="0.8" />
      <line x1="3" y1="7.5" x2="9" y2="7.5" stroke="#bab5aa" strokeWidth="0.8" />
      <line x1="3" y1="10" x2="8" y2="10" stroke="#bab5aa" strokeWidth="0.8" />
      {failed ? (
        <path d="M24 4.5 L30 9.5 M30 4.5 L24 9.5" stroke="#9a3412" strokeWidth="1.3" strokeLinecap="round" />
      ) : imageKind === "field_image" ? (
        <g fill="none" stroke="#545b61" strokeWidth="1">
          <path d="M19 4 h-2 v2 M33 4 h2 v2 M19 10 h-2 v-2 M33 10 h2 v-2" />
          <circle cx="26" cy="7" r="2" fill={synthetic ? `url(#${pid})` : tissue} stroke="none" />
        </g>
      ) : synthetic ? (
        <path d="M16 7.2c0-2.6 3-4.2 7.5-4.1 4.2.1 6.4.9 9.6.6 3.4-.3 5.4 1.4 5.2 3.6-.2 2.6-2.8 3.9-7 3.8-3.6-.1-5.3.6-9.3.6C18.6 11.7 16 9.9 16 7.2z" fill={`url(#${pid})`} stroke="#463c78" strokeWidth="0.6" />
      ) : (
        <g>
          <path d="M16 7.2c0-2.6 3-4.2 7.5-4.1 4.2.1 6.4.9 9.6.6 3.4-.3 5.4 1.4 5.2 3.6-.2 2.6-2.8 3.9-7 3.8-3.6-.1-5.3.6-9.3.6C18.6 11.7 16 9.9 16 7.2z" fill={tissue} opacity="0.85" />
          <circle cx="20.5" cy="6.4" r="0.9" fill={nuclei} />
          <circle cx="24" cy="8.6" r="0.8" fill={nuclei} />
          <circle cx="28.4" cy="5.6" r="0.9" fill={nuclei} />
          <circle cx="32.5" cy="8.1" r="0.8" fill={nuclei} />
          <circle cx="35.6" cy="6" r="0.7" fill={nuclei} />
        </g>
      )}
    </svg>
  );
}
