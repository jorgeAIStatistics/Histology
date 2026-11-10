"use client";

import { Fragment, useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Label preview (spec §6.5, §7): bwip-js DataMatrix rendered as SVG plus the
 * human-readable text. Screen preview only — not a validated label format.
 * The image's accessible name gives the encoded content.
 */
export interface LabelPreviewProps {
  /** Machine-readable payload, e.g. encodeLabel({...}) -> "HL1:S:EMS:D26-04817:A:1:2:PAS:7". */
  payload: string;
  /** Human-readable text printed next to the code, e.g. "D26-04817 A1-2 PAS". */
  text: string;
  /** Rendered code size in px (square). */
  size?: number;
  /** Show the encoded payload in small mono text (handy for typing a scan in the demo). */
  showPayload?: boolean;
  /** Show the "Screen preview only" caption (default true). */
  caption?: boolean;
  /** Only the code, no frame, text or caption (for a label that prints its own text). */
  bare?: boolean;
  className?: string;
}

export function LabelPreview({ payload, text, size = 88, showPayload = true, caption = true, bare = false, className }: LabelPreviewProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    import("bwip-js/browser")
      .then(({ datamatrix, drawingSVG }) => {
        const out = datamatrix({ bcid: "datamatrix", text: payload, scale: 3, paddingwidth: 0, paddingheight: 0 }, drawingSVG());
        if (!cancelled) setSvg(out);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (bare) {
    return svg ? (
      <div
        role="img"
        aria-label={`DataMatrix label encoding ${text} (screen preview only)`}
        className={cn("shrink-0 [&>svg]:block [&>svg]:size-full", className)}
        style={{ width: size, height: size }}
        // bwip-js output: an SVG of paths generated from the payload (no markup from user input).
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    ) : (
      <span aria-hidden className={cn("block shrink-0 rounded-sm bg-surface-sunken", className)} style={{ width: size, height: size }} />
    );
  }

  return (
    <figure className={cn("inline-flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-3 rounded-sm border border-line-strong bg-white p-2">
        {svg ? (
          <div
            role="img"
            aria-label={`DataMatrix label encoding ${text}`}
            className="shrink-0 [&>svg]:block [&>svg]:size-full"
            style={{ width: size, height: size }}
            // bwip-js output: an SVG of paths generated from the payload (no markup from user input).
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error ? (
          <div
            role="img"
            aria-label={`DataMatrix preview unavailable for ${text}`}
            className="flex shrink-0 items-center justify-center border border-dashed border-line-strong text-center text-xs text-ink-muted"
            style={{ width: size, height: size }}
          >
            Preview unavailable
          </div>
        ) : (
          <span aria-hidden className="block shrink-0 rounded-sm bg-surface-sunken motion-safe:animate-pulse" style={{ width: size, height: size }} />
        )}
        <div className="min-w-0 max-w-[16rem]">
          <p className="id-mono text-base font-semibold whitespace-normal text-black">
            {/* Wrap only between tokens, never after a hyphen inside "A1-5" or "D26-04783". */}
            {text.split(" ").map((t, i) => (
              <Fragment key={i}>
                {i > 0 ? " " : null}
                <span className="whitespace-nowrap">{t}</span>
              </Fragment>
            ))}
          </p>
          {showPayload ? (
            <p className="mt-0.5 break-all font-mono text-xs text-ink-muted">
              <span className="sr-only">Encoded: </span>
              {payload}
            </p>
          ) : null}
        </div>
      </div>
      {caption ? (
        <figcaption className="max-w-[44ch] text-xs text-ink-muted">
          Screen preview only. Not validated for scanners, solvents, processors or stainers.
        </figcaption>
      ) : null}
      {error ? <p className="text-xs text-danger-fg">Could not draw the code: {error}</p> : null}
    </figure>
  );
}
