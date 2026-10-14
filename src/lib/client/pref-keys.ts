/**
 * Preference keys and the pre-paint density script. Plain module (no
 * "use client") so server components such as the root layout can import it.
 */
export type Density = "auto" | "compact" | "comfortable";
export type ScannerSuffix = "enter" | "tab";

export const PREFS = {
  density: { key: "hlos.pref.density", default: "auto" as Density },
  sound: { key: "hlos.pref.sound", default: false as boolean },
  soundVolume: { key: "hlos.pref.soundVolume", default: 0.5 as number },
  singleKeyShortcuts: { key: "hlos.pref.singleKeyShortcuts", default: true as boolean },
  scannerSuffix: { key: "hlos.pref.scannerSuffix", default: "enter" as ScannerSuffix },
  navCollapsed: { key: "hlos.pref.navCollapsed", default: false as boolean },
} as const;

/** Inline script for <head>: applies the density class before first paint (no flash). */
export const DENSITY_BOOT_SCRIPT = `(function(){try{var p="auto";try{var r=localStorage.getItem(${JSON.stringify(
  PREFS.density.key,
)});if(r)p=JSON.parse(r)}catch(e){}var c=p==="comfortable"||(p!=="compact"&&(window.innerWidth<1280||window.matchMedia("(pointer: coarse)").matches));if(c)document.documentElement.classList.add("density-comfortable")}catch(e){}})();`;
