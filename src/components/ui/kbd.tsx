import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Keyboard key, e.g. <Kbd>/</Kbd> or <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong bg-surface px-1 font-mono text-xs font-medium text-ink-secondary",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
