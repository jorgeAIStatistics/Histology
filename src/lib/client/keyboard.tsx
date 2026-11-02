"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { PREFS } from "./pref-keys";
import { readPreference, usePref } from "./preferences";
import { useScan } from "./scan";

/**
 * Global keyboard model (spec §8):
 *   /  or Ctrl/Cmd+K   focus the scan field (/ is ignored while typing in a field)
 *   ?                  keyboard shortcut help
 *   G then I/C/W/G/M/O go to Intake / Clarifications / Worklist / Grossing / Materials / Operations
 * Single-key shortcuts (?, G-sequences, and page-level J/K, A, P) can be
 * turned off in Settings > Preferences (WCAG 2.1.4). Ctrl/Cmd+K always works.
 */

const GO_TO: Record<string, string> = {
  i: "/intake",
  c: "/clarifications",
  w: "/worklist",
  g: "/grossing",
  m: "/materials",
  o: "/operations",
};

const OPEN_HELP_EVENT = "hlos:open-shortcut-help";

/** True when the event target is a text field, select, or contenteditable (shortcuts must not fire there). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}

/** True while any modal <dialog> is open (page shortcuts should pause). */
export function isDialogOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector("dialog[open]") !== null;
}

/** Whether single-key shortcuts are on (read at event time). */
export function singleKeyShortcutsOn(): boolean {
  return readPreference(PREFS.singleKeyShortcuts.key, PREFS.singleKeyShortcuts.default);
}

/** Open the keyboard help dialog from anywhere (e.g. a nav button). */
export function openShortcutHelp(): void {
  window.dispatchEvent(new Event(OPEN_HELP_EVENT));
}

/**
 * Page-level single-key shortcut helper (J/K, A, P...). Ignored while typing,
 * while a dialog is open, with modifier keys, or when single-key shortcuts are off.
 *   useSingleKey({ j: next, k: prev, Enter: open })
 */
export function useSingleKey(map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isEditableTarget(e.target) || isDialogOpen()) return;
      const isSingleChar = e.key.length === 1;
      if (isSingleChar && !singleKeyShortcutsOn()) return;
      const fn = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (!fn) return;
      fn(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export function GlobalShortcuts() {
  const router = useRouter();
  const scan = useScan();
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingG = useRef(0);
  const focusScan = scan.focus;

  useEffect(() => {
    const onOpen = () => setHelpOpen(true);
    window.addEventListener(OPEN_HELP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_HELP_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focusScan();
        return;
      }
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (isEditableTarget(e.target) || isDialogOpen()) return;
      if (e.key === "/") {
        e.preventDefault();
        focusScan();
        return;
      }
      if (!singleKeyShortcutsOn()) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      const k = e.key.toLowerCase();
      if (pendingG.current && Date.now() - pendingG.current < 1500) {
        pendingG.current = 0;
        const href = GO_TO[k];
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      if (k === "g" && !e.shiftKey) pendingG.current = Date.now();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, focusScan]);

  return <ShortcutHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />;
}

const ROWS: { keys: ReactNode; action: string; note?: string; singleKey?: boolean }[] = [
  {
    keys: (
      <>
        <Kbd>/</Kbd> or <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd> + <Kbd>K</Kbd>
      </>
    ),
    action: "Focus the scan field",
    note: "/ is not active while typing in a text field",
  },
  { keys: <Kbd>Enter</Kbd>, action: "Submit a scan; open the focused row; confirm a proposed value" },
  {
    keys: <Kbd>Esc</Kbd>,
    action: "Close the panel or dialog; clear the scan field (twice: reset the target to Find record)",
    note: "On Intake, Esc in an empty scan field moves to the selected queue item.",
  },
  {
    keys: (
      <>
        <Kbd>J</Kbd> / <Kbd>K</Kbd>
      </>
    ),
    action: "Next / previous row or queue item",
    note: "On Intake, Up / Down also move the queue from the scan field.",
    singleKey: true,
  },
  {
    keys: (
      <>
        <Kbd>1</Kbd> to <Kbd>5</Kbd>
      </>
    ),
    action: "Intake: jump to a step (container check, differences, related orders, routing, accession)",
    singleKey: true,
  },
  {
    keys: (
      <>
        <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd> + <Kbd>Enter</Kbd>
      </>
    ),
    action: "Run the step that shows the Ctrl badge (asks first, like a click)",
    note: "Never records a container check: that is always a deliberate click or Enter on its own button.",
  },
  {
    keys: (
      <>
        <Kbd>Alt</Kbd> + <Kbd>Down</Kbd>
      </>
    ),
    action: "Next unconfirmed or invalid field (grossing, intake)",
  },
  {
    keys: (
      <>
        <Kbd>G</Kbd> then <Kbd>I</Kbd> <Kbd>C</Kbd> <Kbd>W</Kbd> <Kbd>G</Kbd> <Kbd>M</Kbd> <Kbd>O</Kbd>
      </>
    ),
    action: "Go to Intake, Clarifications, Worklist, Grossing, Materials, Operations",
    singleKey: true,
  },
  { keys: <Kbd>?</Kbd>, action: "Show this help", singleKey: true },
];

export function ShortcutHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [singleKey, setSingleKey] = usePref(PREFS.singleKeyShortcuts);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Keyboard shortcuts available on every screen</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-secondary">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Keys
            </th>
            <th scope="col" className="py-1.5 font-medium">
              Action
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r, i) => (
            <tr key={i} className="border-b border-line align-top last:border-b-0">
              <td className="whitespace-nowrap py-2 pr-3">{r.keys}</td>
              <td className="py-2 text-ink">
                {r.action}
                {r.note ? <span className="block text-xs text-ink-muted">{r.note}</span> : null}
                {r.singleKey && !singleKey ? <span className="block text-xs text-ink-muted">Off: single-key shortcuts are turned off.</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="mt-4 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4 accent-[var(--hlo-brand)]"
          checked={singleKey}
          onChange={(e) => setSingleKey(e.target.checked)}
        />
        Single-key shortcuts (J/K, G-sequences, ?) on
      </label>
      <p className="mt-1 text-xs text-ink-muted">Saved in this browser. Scanners act as keyboards: they type the code and press Enter (or Tab, set in Settings).</p>
    </Dialog>
  );
}
