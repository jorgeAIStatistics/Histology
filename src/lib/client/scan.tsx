"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import { decodeLabel, humanLabel } from "@/lib/identifiers";
import { playScanFeedback } from "./sound";

/**
 * Global scan context (spec §1 "Scan first", §5.1 Scan field). One scan field
 * in the top bar. A page registers what a scan will do right now with
 * useScanTarget("Add to tray TRY-M-03", handler); the field shows that label
 * as a prefix chip. When nothing is registered, or after a second Esc, the
 * target is "Find record" (navigate to the record).
 *
 * Copy rule: a scan identifies a record; it never "verifies" anything.
 */

export interface ScanOutcome {
  tone: "success" | "info" | "warning" | "danger";
  /** Shown in the result line and announced (e.g. "Scanned D26-04817 A1. Matched request RR-0192."). */
  message: string;
  /** Blocking mismatch: announced with role="alert" (e.g. wrong block, unexpected slide). */
  alert?: boolean;
  /** Optional sound (only plays if the user turned sound on). Default: success→match, danger→mismatch. */
  sound?: "match" | "mismatch" | null;
  /** Keep the scanned text in the field (default: cleared after a result). */
  keepValue?: boolean;
}

export interface ScanHandlerContext {
  navigate: (href: string) => void;
}

export type ScanHandler = (value: string, ctx: ScanHandlerContext) => ScanOutcome | void | Promise<ScanOutcome | void>;

export interface ScanTarget {
  id: string;
  label: string;
  placeholder?: string;
  handler: ScanHandler;
}

export interface ScanResult extends ScanOutcome {
  value: string;
  at: number;
}

interface ScanContextValue {
  /** The effective target (the page's, or "Find record"). */
  target: ScanTarget;
  isDefault: boolean;
  register: (t: ScanTarget) => () => void;
  /** Second Esc: go back to "Find record" until the page registers a new target. */
  resetTarget: () => void;
  /** Run the current target's handler on a value (what Enter in the field does). */
  submit: (value: string) => Promise<ScanOutcome | null>;
  result: ScanResult | null;
  /** Show a result line from outside the field (e.g. after a page action). */
  setResult: (outcome: ScanOutcome | null, value?: string) => void;
  focus: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  pending: boolean;
}

const ScanContext = createContext<ScanContextValue | null>(null);

/* ------------------------------------------------------------------ */
/* Default target: "Find record"                                       */
/* ------------------------------------------------------------------ */

/**
 * Patterns understood by "Find record". Pages should accept these URL params:
 *   /cases/<accession>            e.g. /cases/D26-04817 (?part=A when a block/slide label was scanned)
 *   /intake?item=<INT id>         e.g. /intake?item=INT-1014-031
 *   /clarifications?selected=<CLR id>
 *   /materials?tab=print&selected=<PJ id> | ?tab=trays&selected=<TRY id> | ?tab=retrieval&selected=<RR id>
 */
export function resolveFindRecord(raw: string): { href: string; message: string } | { outcome: ScanOutcome } {
  const value = raw.trim().toUpperCase();
  if (!value) return { outcome: { tone: "info", message: "Scan or type an ID." } };

  if (value.startsWith("HL1:")) {
    const decoded = decodeLabel(value);
    if (!decoded.ok) {
      return {
        outcome: {
          tone: "danger",
          alert: true,
          message: `Not accepted: ${decoded.reason}. Rescan the label or type the full ID.`,
        },
      };
    }
    const id = decoded.identity;
    const part = id.part ? `?part=${encodeURIComponent(id.part)}` : "";
    return { href: `/cases/${encodeURIComponent(id.accession)}${part}`, message: `Scanned ${humanLabel(id)}. Opening case ${id.accession}.` };
  }

  const accession = /^(D\d{2}-\d{5})(?:\s+([A-Z])(\d+)?(?:-\d+)?(?:\s+\S+)?)?$/.exec(value);
  if (accession) {
    const part = accession[2] ? `?part=${accession[2]}` : "";
    return { href: `/cases/${accession[1]}${part}`, message: `Opening case ${accession[1]}.` };
  }
  if (/^INT-\d{4}-\d{3}$/.test(value)) return { href: `/intake?item=${value}`, message: `Opening provisional intake item ${value}.` };
  if (/^CLR-\d+$/.test(value)) return { href: `/clarifications?selected=${value}`, message: `Opening clarification ${value}.` };
  if (/^PJ-\d+$/.test(value)) return { href: `/materials?tab=print&selected=${value}`, message: `Opening print job ${value}.` };
  if (/^TRY-[A-Z0-9-]+$/.test(value)) return { href: `/materials?tab=trays&selected=${value}`, message: `Opening tray ${value}.` };
  if (/^RR-\d+$/.test(value)) return { href: `/materials?tab=retrieval&selected=${value}`, message: `Opening retrieval request ${value}.` };

  return {
    outcome: {
      tone: "warning",
      message: `Not recognized: "${raw.trim()}". Check the label or type the full ID.`,
    },
  };
}

const findRecordHandler: ScanHandler = (value, ctx) => {
  const r = resolveFindRecord(value);
  if ("outcome" in r) return r.outcome;
  ctx.navigate(r.href);
  return { tone: "info", message: r.message, sound: null };
};

export const FIND_RECORD_TARGET: ScanTarget = {
  id: "find-record",
  label: "Find record",
  placeholder: "Scan or type an ID",
  handler: findRecordHandler,
};

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export function ScanProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [stack, setStack] = useState<ScanTarget[]>([]);
  const [suppressed, setSuppressed] = useState<string | null>(null);
  const [result, setResultState] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const top = stack.length ? stack[stack.length - 1] : null;
  const target = top && top.id !== suppressed ? top : FIND_RECORD_TARGET;
  const isDefault = target === FIND_RECORD_TARGET;
  const targetRef = useRef(target);
  targetRef.current = target;

  const register = useCallback((t: ScanTarget) => {
    setStack((s) => [...s.filter((x) => x.id !== t.id), t]);
    setSuppressed(null);
    return () => setStack((s) => s.filter((x) => x.id !== t.id));
  }, []);

  const resetTarget = useCallback(() => {
    if (top) setSuppressed(top.id);
  }, [top]);

  const setResult = useCallback((outcome: ScanOutcome | null, value = "") => {
    setResultState(outcome ? { ...outcome, value, at: Date.now() } : null);
  }, []);

  const submit = useCallback(
    async (raw: string): Promise<ScanOutcome | null> => {
      const value = raw.trim();
      if (!value) return null;
      const t = targetRef.current;
      setPending(true);
      try {
        const out = (await t.handler(value, { navigate: (href) => router.push(href) })) ?? null;
        if (out) {
          setResultState({ ...out, value, at: Date.now() });
          const sound = out.sound === undefined ? (out.tone === "success" ? "match" : out.tone === "danger" ? "mismatch" : null) : out.sound;
          if (sound) playScanFeedback(sound);
        }
        return out;
      } catch (e) {
        const out: ScanOutcome = {
          tone: "danger",
          alert: true,
          message: `Scan could not be processed: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`,
        };
        setResultState({ ...out, value, at: Date.now() });
        return out;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  const focus = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const value = useMemo<ScanContextValue>(
    () => ({ target, isDefault, register, resetTarget, submit, result, setResult, focus, inputRef, pending }),
    [target, isDefault, register, resetTarget, submit, result, setResult, focus, pending],
  );

  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>;
}

/** Scan field state and controls: { target, focus(), setResult(), resetTarget(), submit(), result }. */
export function useScan(): ScanContextValue {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error("useScan must be used inside <ScanProvider> (mounted by the app shell)");
  return ctx;
}

/**
 * Register what a scan does on this page while the component is mounted:
 *   useScanTarget(tray ? `Add to tray ${tray.displayId}` : null, async (value) => { ... return { tone: "success", message: "Scanned D26-04817 A1-2. Matches tray TRY-M-03." } })
 * Pass `null` as label to register nothing (the target stays "Find record").
 * The handler can change between renders without re-registering.
 */
export function useScanTarget(label: string | null, handler: ScanHandler, opts: { placeholder?: string } = {}): void {
  const ctx = useContext(ScanContext);
  const uid = useId();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const register = ctx?.register;
  const placeholder = opts.placeholder;
  useEffect(() => {
    if (!register || !label) return;
    return register({
      id: `${uid}:${label}`,
      label,
      placeholder,
      handler: (value, c) => handlerRef.current(value, c),
    });
  }, [register, label, placeholder, uid]);
}
