"use client";

import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Simple tooltip (Radix). Shows on hover and keyboard focus. A tooltip is
 * never the only way to read a value or a reason: put the essentials in
 * visible text and use the tooltip for extra detail (full date + UTC, namespace).
 * The child must be a single focusable element (button, link) or pass `focusable`.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </T.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = "top",
  focusable,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Wrap a non-focusable child (text, chip) in a focusable span so keyboard users can reach the tooltip. */
  focusable?: boolean;
  className?: string;
}) {
  return (
    <T.Root>
      <T.Trigger asChild>
        {focusable ? (
          <span tabIndex={0} className="inline-flex rounded-sm">
            {children}
          </span>
        ) : (
          children
        )}
      </T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn("animate-fade-in z-50 max-w-xs rounded-sm bg-ink px-2 py-1 text-xs leading-4 text-white shadow-2", className)}
        >
          {content}
          <T.Arrow className="fill-ink" width={10} height={5} />
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
