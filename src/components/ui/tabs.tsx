"use client";

import Link from "next/link";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Tabs, URL-friendly.
 *  - Link mode (every item has `href`): a <nav> of links; the active one has
 *    aria-current="page". Use for saved filters and page tabs kept in the URL
 *    (e.g. /materials?tab=trays). Works from server components.
 *  - Button mode (no hrefs): ARIA tablist with arrow-key navigation; pair
 *    with <TabPanel idBase tabKey active>. Requires `onChange`.
 * Counts render as "To review (3)"; `count={null}` shows no count.
 */
export interface TabItem {
  key: string;
  label: ReactNode;
  count?: number | null;
  href?: string;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  /** Accessible name of the tab group, e.g. "Clarification filters". */
  label: string;
  onChange?: (key: string) => void;
  /** Prefix for tab/panel ids in button mode. */
  idBase?: string;
  className?: string;
  size?: "sm" | "md";
}

export const tabId = (idBase: string, key: string) => `${idBase}-tab-${key}`;
export const tabPanelId = (idBase: string, key: string) => `${idBase}-panel-${key}`;

function TabLabel({ item }: { item: TabItem }) {
  return (
    <>
      <span>{item.label}</span>
      {typeof item.count === "number" ? <span className="num-tabular ml-1 font-normal text-ink-muted">({item.count})</span> : null}
    </>
  );
}

const itemBase =
  "relative inline-flex shrink-0 items-center whitespace-nowrap border-b-2 px-3 font-medium transition-colors duration-[var(--hlo-duration-fast)]";

export function Tabs({ items, active, label, onChange, idBase = "tabs", className, size = "md" }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const linkMode = items.length > 0 && items.every((i) => i.href);
  const sizing = size === "md" ? "h-10 text-sm" : "h-8 text-sm";

  if (linkMode) {
    return (
      <nav aria-label={label} className={cn("border-b border-line", className)}>
        <ul className="-mb-px flex flex-wrap gap-1">
          {items.map((item) => {
            const isActive = item.key === active;
            return (
              <li key={item.key}>
                {item.disabled ? (
                  <span aria-disabled="true" className={cn(itemBase, sizing, "border-transparent text-ink-disabled")}>
                    <TabLabel item={item} />
                  </span>
                ) : (
                  <Link
                    href={item.href!}
                    scroll={false}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      itemBase,
                      sizing,
                      "rounded-t-sm",
                      isActive ? "border-brand text-ink" : "border-transparent text-ink-secondary hover:border-line-strong hover:text-ink",
                    )}
                  >
                    <TabLabel item={item} />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const pos = enabled.indexOf(index);
    let next: number | undefined;
    if (e.key === "ArrowRight") next = enabled[(pos + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange?.(items[next].key);
  };

  return (
    <div role="tablist" aria-label={label} className={cn("-mb-px flex flex-wrap gap-1 border-b border-line", className)}>
      {items.map((item, index) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idBase, item.key)}
            aria-selected={isActive}
            aria-controls={tabPanelId(idBase, item.key)}
            tabIndex={isActive ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange?.(item.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              itemBase,
              sizing,
              "rounded-t-sm disabled:cursor-not-allowed disabled:text-ink-disabled",
              isActive ? "border-brand text-ink" : "border-transparent text-ink-secondary hover:border-line-strong hover:text-ink",
            )}
          >
            <TabLabel item={item} />
          </button>
        );
      })}
    </div>
  );
}

/** Panel for button-mode Tabs. Renders only when active. */
export function TabPanel({
  idBase = "tabs",
  tabKey,
  active,
  children,
  className,
}: {
  idBase?: string;
  tabKey: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={tabPanelId(idBase, tabKey)} aria-labelledby={tabId(idBase, tabKey)} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
