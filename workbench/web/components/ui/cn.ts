import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the custom type scale (globals.css @theme --text-*), otherwise it reads
// `text-small` as a colour and drops a later `text-white`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["micro", "small", "body", "lead", "title", "display"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
