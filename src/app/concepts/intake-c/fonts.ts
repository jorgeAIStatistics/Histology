import { Archivo, Source_Code_Pro } from "next/font/google";

/**
 * Concept C type, scoped to this preview route.
 *
 * Archivo (variable, with a width axis) carries both the interface text and the
 * display lines. Contrast comes from width and weight inside one family (the
 * finding sentence and step names are set semi-expanded), not from a second
 * decorative face.
 *
 * Source Code Pro is used ONLY for identifiers (INT, ORD, CLR, REL, H, D26,
 * MRN) because staff compare them character by character. It was picked after
 * rendering candidates side by side: its default zero carries a clear inner
 * dot (unlike O), and 1 / l / I have distinct shapes (flag and base, tail,
 * serifs). JetBrains Mono was tried first and its zero read too close to O at
 * bench sizes.
 *
 * next/font downloads the files when the route is built and serves them
 * locally; the page makes no calls to Google at runtime.
 */
export const deskSans = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--c-sans",
  display: "swap",
});

export const deskMono = Source_Code_Pro({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--c-mono",
  display: "swap",
});
