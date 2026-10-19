import localFont from "next/font/local";

/**
 * Concept B type pair (scoped to this preview route): Atkinson Hyperlegible
 * Next and Mono, the same self-hosted files the app uses (src/app/font-files,
 * SIL OFL 1.1). Local files keep the build offline and deterministic.
 */
export const atkSans = localFont({
  src: [{ path: "../../font-files/AtkinsonHyperlegibleNext-Latin-wght200-800.woff2", weight: "200 800", style: "normal" }],
  variable: "--b-font-sans",
  display: "swap",
  adjustFontFallback: false,
});

export const atkMono = localFont({
  src: [{ path: "../../font-files/AtkinsonHyperlegibleMono-Latin-wght200-800.woff2", weight: "200 800", style: "normal" }],
  variable: "--b-font-mono",
  display: "swap",
  adjustFontFallback: false,
});
