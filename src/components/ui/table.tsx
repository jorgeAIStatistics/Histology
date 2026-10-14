import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Thin data-table primitives (spec §7 "Data table conventions"): native
 * <table>, <th scope>, aria-sort with a visible sort icon, a caption (hidden
 * by default), sticky header, density from Preferences (row height and text
 * size via CSS variables), selectable rows with aria-selected, hold stripe and
 * optional PAS tint. Pair with @tanstack/react-table for sorting/grouping logic.
 *
 * Scrolling: `scroll="container"` (default) scrolls inside the wrapper and the
 * header sticks to its top (set `maxHeight`). `scroll="page"` lets the page
 * scroll; the header sticks below the top bar (and identity bar with
 * `belowIdentityBar`).
 */
export interface TableProps extends Omit<ComponentProps<"table">, "children"> {
  caption: ReactNode;
  captionVisible?: boolean;
  children: ReactNode;
  scroll?: "container" | "page";
  /** Max height of the scroll container, e.g. "calc(100vh - 260px)". */
  maxHeight?: string;
  belowIdentityBar?: boolean;
  /** aria-busy while loading or refreshing. */
  busy?: boolean;
  /** Hide columns marked priority={3} (e.g. while the side panel is open). */
  hideP3?: boolean;
  /** Hide columns marked priority={2} or 3 (tablet). */
  hideP2?: boolean;
  wrapperClassName?: string;
}

export function Table({
  caption,
  captionVisible,
  children,
  scroll = "container",
  maxHeight,
  belowIdentityBar,
  busy,
  hideP3,
  hideP2,
  className,
  wrapperClassName,
  ...rest
}: TableProps) {
  const stickyTop =
    scroll === "container"
      ? "0px"
      : belowIdentityBar
        ? "calc(var(--hlo-chrome-h) + var(--hlo-identity-h))"
        : "var(--hlo-chrome-h)";
  const style = { "--hlo-th-top": stickyTop, ...(maxHeight ? { maxHeight } : {}) } as CSSProperties;
  return (
    <div
      className={cn(
        "relative w-full rounded-md border border-line bg-surface",
        scroll === "container" ? "overflow-auto" : "overflow-x-clip",
        (hideP3 || hideP2) && "[&_[data-priority='3']]:hidden",
        hideP2 && "[&_[data-priority='2']]:hidden",
        wrapperClassName,
      )}
      style={style}
    >
      <table {...rest} aria-busy={busy || undefined} className={cn("w-full border-separate border-spacing-0 text-left", className)}>
        <caption className={cn(captionVisible ? "px-3 py-2 text-left text-xs text-ink-muted" : "sr-only")}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return <thead className={className}>{children}</thead>;
}

export function TBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={className}>{children}</tbody>;
}

export type SortDirection = "asc" | "desc" | "none";

export interface THProps extends Omit<ComponentProps<"th">, "children"> {
  children?: ReactNode;
  /** Current sort of this column. Omit for non-sortable columns. */
  sort?: SortDirection;
  /** Makes the header a sort button (Enter/Space/click). */
  onSort?: () => void;
  align?: "left" | "right" | "center";
  /** Column priority for responsive hiding (1 = always shown). */
  priority?: 1 | 2 | 3;
  /** Sticky first (identity) column when the table scrolls sideways. */
  stickyFirst?: boolean;
}

export function TH({ children, sort, onSort, align = "left", priority, stickyFirst, className, scope = "col", ...rest }: THProps) {
  const ariaSort = sort === "asc" ? "ascending" : sort === "desc" ? "descending" : sort === "none" ? "none" : undefined;
  const Icon = sort === "asc" ? ArrowUp : sort === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <th
      scope={scope}
      aria-sort={ariaSort}
      data-priority={priority}
      {...rest}
      className={cn(
        "sticky top-[var(--hlo-th-top)] z-10 h-8 whitespace-nowrap border-b border-line bg-surface-subtle px-3 text-xs font-medium text-ink-secondary",
        align === "right" && "text-right",
        align === "center" && "text-center",
        stickyFirst && "left-0 z-[11]",
        className,
      )}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 font-medium hover:text-ink",
            align === "right" && "flex-row-reverse",
          )}
        >
          {children}
          <Icon className={cn("size-3.5 shrink-0", sort && sort !== "none" ? "text-ink" : "text-ink-muted")} aria-hidden />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export interface TRProps extends ComponentProps<"tr"> {
  /** Selected row: brand-50 fill and a brand left edge; sets aria-selected. */
  selected?: boolean;
  /** Hold row: 3px hold stripe on the left edge (pair with a "Hold" pill). */
  hold?: boolean;
  /** Optional pale PAS tint (never the only signal; keep the PAS tag). */
  pas?: boolean;
  /** Muted canceled row (keep it visible, say "Canceled" in words). */
  canceled?: boolean;
  /** Pointer cursor and hover background for clickable rows. */
  interactive?: boolean;
}

export function TR({ selected, hold, pas, canceled, interactive, className, children, ...rest }: TRProps) {
  return (
    <tr
      aria-selected={selected === undefined ? undefined : selected}
      {...rest}
      className={cn(
        "group/row",
        pas && !selected && "bg-pas-row",
        selected && "bg-brand-50",
        interactive && !selected && "cursor-pointer hover:bg-surface-subtle",
        interactive && selected && "cursor-pointer",
        canceled && "text-ink-muted",
        selected
          ? "[&>*:first-child]:shadow-[inset_3px_0_0_var(--hlo-brand)]"
          : hold && "hlo-hold-stripe [&>*:first-child]:shadow-[inset_3px_0_0_var(--hlo-hold-solid)]",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export interface TDProps extends ComponentProps<"td"> {
  /** Right-aligned tabular numbers. */
  numeric?: boolean;
  priority?: 1 | 2 | 3;
  stickyFirst?: boolean;
  /** Allow wrapping (default: single line). */
  wrap?: boolean;
}

export function TD({ numeric, priority, stickyFirst, wrap, className, children, ...rest }: TDProps) {
  return (
    <td
      data-priority={priority}
      {...rest}
      className={cn(
        "h-[var(--hlo-row-h)] border-b border-line px-3 align-middle text-[length:var(--hlo-cell-fs)] leading-[var(--hlo-cell-lh)] text-ink group-last/row:border-b-0",
        !wrap && "whitespace-nowrap",
        numeric && "num-tabular text-right",
        stickyFirst && "sticky left-0 z-[1] bg-inherit",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** A full-width row for empty/error states inside a table body. */
export function TableMessageRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-6 text-center text-sm text-ink-secondary">
        {children}
      </td>
    </tr>
  );
}

/** "Showing 18 of 61 cases" count line. */
export function TableCount({ shown, total, noun, className }: { shown: number; total: number; noun: string; className?: string }) {
  return (
    <p className={cn("text-sm text-ink-muted", className)} aria-live="polite">
      Showing <span className="num-tabular">{shown}</span> of <span className="num-tabular">{total}</span> {noun}
    </p>
  );
}
