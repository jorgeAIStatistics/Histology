import localFont from "next/font/local";

/**
 * Atkinson Hyperlegible Next for words, Atkinson Hyperlegible Mono for every
 * identifier. The family was drawn so that look-alike characters (0/O, 1/l/I,
 * B/8, rn/m) stay distinct at a glance, which is the accessioner's core task
 * when comparing bottles, requisitions and IDs.
 *
 * Self-hosted (src/app/font-files, SIL OFL 1.1, see LICENSE-NOTICE.md): the
 * build makes no network request, so it is deterministic offline. Variable
 * weight 200–800, Latin subset. No metric-adjusted fallback face: these
 * families are not in the build's metrics table, so the fallback stacks in
 * globals.css (--font-sans, --font-mono) are used as written while loading.
 * Turbopack still logs "Failed to find font override values" for both
 * families; the warning is benign (no fallback face is generated either way).
 */
export const hloSans = localFont({
  src: [{ path: "./font-files/AtkinsonHyperlegibleNext-Latin-wght200-800.woff2", weight: "200 800", style: "normal" }],
  variable: "--font-hlo-sans",
  display: "swap",
  adjustFontFallback: false,
});

export const hloMono = localFont({
  src: [{ path: "./font-files/AtkinsonHyperlegibleMono-Latin-wght200-800.woff2", weight: "200 800", style: "normal" }],
  variable: "--font-hlo-mono",
  display: "swap",
  adjustFontFallback: false,
});
