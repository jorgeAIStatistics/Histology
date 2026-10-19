import { Atkinson_Hyperlegible_Next, Atkinson_Hyperlegible_Mono } from "next/font/google";

/**
 * Atkinson Hyperlegible Next for words, Atkinson Hyperlegible Mono for every
 * identifier. The family was drawn by the Braille Institute so that look-alike
 * characters (0/O, 1/l/I, B/8, rn/m) stay distinct at a glance, which is the
 * accessioner's core task when comparing bottles, requisitions and IDs.
 * next/font downloads the files at build time and serves them locally, so the
 * running app makes no calls to Google.
 */
export const hloSans = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-hlo-sans",
  display: "swap",
});

export const hloMono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-hlo-mono",
  display: "swap",
});
