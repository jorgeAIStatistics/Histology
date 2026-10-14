import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

/**
 * IBM Plex Sans for interface text, IBM Plex Mono for every identifier
 * (design spec §4). next/font downloads the files at build time and serves
 * them locally, so the running app makes no calls to Google.
 */
export const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});
