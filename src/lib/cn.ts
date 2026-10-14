import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge that knows the Histology Lab OS theme additions (shadow-1..3, rounded-pill, text-md). */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ["1", "2", "3"],
      radius: ["pill"],
      text: ["md"],
    },
  },
});

/** Compose class names; later Tailwind classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
