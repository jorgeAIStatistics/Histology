"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * Per-browser preferences in localStorage (spec §6.9 Preferences). Every read
 * and write is wrapped in try/catch; when storage is blocked, values live in
 * memory for this tab only and the app still renders correctly.
 */

import { PREFS, type Density } from "./pref-keys";

export { PREFS, DENSITY_BOOT_SCRIPT, type Density, type ScannerSuffix } from "./pref-keys";

const CHANGE_EVENT = "hlos:preference";
const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    /* storage blocked */
  }
  return memory.get(key) ?? null;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Read a preference outside React (event handlers, sound, keyboard). */
export function readPreference<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  return parse(readRaw(key), fallback);
}

export function writePreference<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    /* storage blocked: memory only */
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key } }));
  } catch {
    /* ignore */
  }
}

/**
 * `const [density, setDensity] = usePreference("hlos.pref.density", "auto")`.
 * Server render and hydration use the default; the stored value applies right after.
 */
export function usePreference<T>(key: string, defaultValue: T): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === key) onChange();
      };
      const onLocal = (e: Event) => {
        const detail = (e as CustomEvent<{ key?: string }>).detail;
        if (!detail || detail.key === key) onChange();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(CHANGE_EVENT, onLocal);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(CHANGE_EVENT, onLocal);
      };
    },
    [key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => parse(raw, defaultValue), [raw]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = parse(readRaw(key), defaultValue);
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      writePreference(key, v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

/** Typed shorthand: `usePref(PREFS.sound)`. */
export function usePref<T>(pref: { key: string; default: T }): [T, (next: T | ((prev: T) => T)) => void] {
  return usePreference<T>(pref.key, pref.default);
}

export function useSingleKeyShortcutsEnabled(): boolean {
  return usePref(PREFS.singleKeyShortcuts)[0];
}

/** Whether the comfortable (touch) density applies for a given preference. */
export function resolveComfortable(pref: Density): boolean {
  if (pref === "comfortable") return true;
  if (pref === "compact") return false;
  try {
    return window.innerWidth < 1280 || window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** Keeps the `density-comfortable` class on <html> in sync with the preference and viewport. Mounted once in the shell. */
export function DensitySync(): null {
  const [density] = usePref(PREFS.density);
  useEffect(() => {
    const apply = () => {
      try {
        document.documentElement.classList.toggle("density-comfortable", resolveComfortable(density));
      } catch {
        /* ignore */
      }
    };
    apply();
    if (density !== "auto") return;
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [density]);
  return null;
}
