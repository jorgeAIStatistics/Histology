import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next } from "next/font/google";

/**
 * Concept B type: Atkinson Hyperlegible Next for text and display, Atkinson
 * Hyperlegible Mono for identifiers. The family was drawn (Braille Institute)
 * to keep look-alike characters apart: I/l/1 and 0/O differ in shape, not
 * just in width, which is the job an accessioner does all day with INT, ORD,
 * CLR and MRN strings. One superfamily keeps the contrast in weight and tone
 * rather than in a second decorative face. Scoped to this route only.
 */
export const atkSans = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--b-font-sans",
  display: "swap",
  adjustFontFallback: false,
});

export const atkMono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--b-font-mono",
  display: "swap",
  adjustFontFallback: false,
});
