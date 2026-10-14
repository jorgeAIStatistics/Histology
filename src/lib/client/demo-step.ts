"use client";

import { useEffect, useState } from "react";

/**
 * The guided-demo step the presenter last looked at (per browser tab). The
 * guide records it; the side nav shows it on the real screens so the presenter
 * can return to the same step in one click. Session storage only: it is a
 * presenter convenience, never demo state (that is read from the records).
 */
const KEY = "hlos.demo.lastStep";
const EVENT = "hlos:demo-step";

export interface LastDemoStep {
  step: number;
  short: string;
  total: number;
}

export function rememberDemoStep(value: LastDemoStep): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: the nav simply links to the guide */
  }
  window.dispatchEvent(new Event(EVENT));
}

function read(): LastDemoStep | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastDemoStep>;
    return typeof v.step === "number" && typeof v.short === "string" && typeof v.total === "number" ? (v as LastDemoStep) : null;
  } catch {
    return null;
  }
}

/** Last guided-demo step seen in this tab, or null (always null during server render). */
export function useLastDemoStep(): LastDemoStep | null {
  const [value, setValue] = useState<LastDemoStep | null>(null);
  useEffect(() => {
    const update = () => setValue(read());
    update();
    window.addEventListener(EVENT, update);
    return () => window.removeEventListener(EVENT, update);
  }, []);
  return value;
}
