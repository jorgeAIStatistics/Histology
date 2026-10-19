import { Instrument_Sans, JetBrains_Mono } from "next/font/google";

/**
 * Concept A type pair (scoped to this preview route).
 * - Instrument Sans: a compact grotesk with crisp terminals and a width axis.
 *   The queue uses a slightly narrower cut (wdth 88) so office names fit a
 *   narrow column; headings use the normal width at large sizes.
 * - JetBrains Mono: identifiers only (INT, ORD, CLR, REL, H, MRN). Its zero
 *   carries an inner mark, 1 has a flag and foot, l has a tail and I has
 *   serifs, so 0/O and 1/l/I never look alike when staff compare ids.
 * next/font serves both files locally after the first build.
 */
export const conceptSans = Instrument_Sans({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--a-font-sans",
  display: "swap",
});

export const conceptMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--a-font-mono",
  display: "swap",
});
