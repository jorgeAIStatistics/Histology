"use client";

import { Keyboard } from "lucide-react";
import { openShortcutHelp } from "@/lib/client/keyboard";

/** Keyboard keys for bench work, one click (or "?") from every screen. */
export function ShortcutsButton() {
  return (
    <button
      type="button"
      onClick={openShortcutHelp}
      title="Keyboard shortcuts (?)"
      aria-keyshortcuts="?"
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-shell-muted hover:bg-shell-2 hover:text-shell-fg max-xl:size-11"
    >
      <Keyboard className="size-[1.125rem]" aria-hidden />
      <span className="sr-only">Keyboard shortcuts</span>
    </button>
  );
}
