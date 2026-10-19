import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Button (spec §7). Verb-first labels ("Request accession"). One primary per
 * region. Loading keeps the width, shows the loading label and ignores presses
 * (prevents double submits) while keeping keyboard focus. Disabled stays legible (muted ink on a
 * subtle fill, AA contrast): the label still says what the action is. When disabled for a reason, render the
 * reason as visible text and pass its id as `reasonId` (aria-describedby).
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "quiet";
/** "block": full width, the label may wrap (docked decision columns); never splits an identifier. */
export type ButtonSize = "sm" | "md" | "lg" | "block";

// aria-disabled reads exactly like disabled: a loading button keeps keyboard focus (it is aria-disabled, not
// disabled, while its request runs), and a few steps stay pressable so a press can say what is missing.
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white hover:bg-brand-hover active:bg-brand-hover disabled:border disabled:border-line disabled:bg-surface-subtle disabled:text-ink-muted aria-disabled:border aria-disabled:border-line aria-disabled:bg-surface-subtle aria-disabled:text-ink-muted aria-disabled:hover:bg-surface-subtle",
  secondary:
    "border border-line-strong bg-surface text-ink hover:bg-surface-subtle active:bg-surface-sunken disabled:border-line disabled:bg-surface-subtle disabled:text-ink-muted aria-disabled:border-line aria-disabled:bg-surface-subtle aria-disabled:text-ink-muted aria-disabled:hover:bg-surface-subtle",
  ghost:
    "text-brand hover:bg-brand-50 active:bg-brand-100 disabled:text-ink-muted disabled:bg-transparent aria-disabled:text-ink-muted aria-disabled:bg-transparent aria-disabled:hover:bg-transparent",
  destructive:
    "bg-danger-solid text-white hover:bg-danger-fg active:bg-danger-fg disabled:border disabled:border-line disabled:bg-surface-subtle disabled:text-ink-muted aria-disabled:border aria-disabled:border-line aria-disabled:bg-surface-subtle aria-disabled:text-ink-muted aria-disabled:hover:bg-surface-subtle",
  quiet:
    "text-ink-secondary hover:bg-surface-subtle hover:text-ink active:bg-surface-sunken disabled:text-ink-muted disabled:bg-transparent aria-disabled:text-ink-muted aria-disabled:bg-transparent aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-muted",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 min-h-[max(2rem,var(--hlo-target-min))] gap-1.5 px-3 text-sm",
  md: "h-10 min-h-[max(2.5rem,var(--hlo-target-min))] gap-2 px-4 text-sm",
  lg: "h-12 min-h-12 gap-2 px-5 text-base",
  block: "h-auto min-h-[max(2.75rem,var(--hlo-target-min))] w-full gap-2 whitespace-normal px-4 py-2 text-sm leading-5 text-balance",
};

export function buttonClasses({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-semibold transition-[background-color,border-color,color,transform] duration-[var(--hlo-duration-fast)] ease-[var(--hlo-ease)] enabled:not-aria-disabled:active:translate-y-px disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
    VARIANT[variant],
    SIZE[size],
    variant === "quiet" && size === "sm" && "px-2",
    className,
  );
}

export interface ButtonProps extends Omit<ComponentProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows `loadingLabel` with a spinner, keeps the width and ignores presses (aria-disabled; focus stays on it). */
  loading?: boolean;
  /** Text while loading, e.g. "Requesting..." (default "Working..."). */
  loadingLabel?: string;
  /** Optional leading icon (decorative; aria-hidden). */
  icon?: ReactNode;
  /** id of the visible element that explains why the button is disabled. */
  reasonId?: string;
  children: ReactNode;
}

/** A press on a loading button: no handler runs and a submit button does not submit its form. */
function ignorePress(e: MouseEvent<HTMLButtonElement>) {
  e.preventDefault();
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel = "Working...",
  icon,
  reasonId,
  disabled,
  className,
  children,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const describedBy = [rest["aria-describedby"], reasonId].filter(Boolean).join(" ") || undefined;
  // While its request runs a button is aria-disabled, not disabled: the browser would otherwise move keyboard
  // focus to <body> when the focused button turns disabled (WCAG 2.4.3), and after a failed request focus is still
  // here, beside its error. A press while loading does nothing, as on a disabled button (no second request, no
  // form submission).
  const busy = loading && !disabled;
  return (
    <button
      type={type}
      {...rest}
      aria-describedby={describedBy}
      aria-busy={loading || undefined}
      aria-disabled={busy ? true : rest["aria-disabled"]}
      disabled={disabled}
      onClick={busy ? ignorePress : onClick}
      className={buttonClasses({ variant, size, className })}
    >
      {/* Both labels share one grid cell so the width never jumps while loading. */}
      <span className="grid">
        <span className={cn("col-start-1 row-start-1 inline-flex items-center justify-center", size === "sm" ? "gap-1.5" : "gap-2", loading && "invisible")}>
          {icon ? <span className="inline-flex shrink-0 [&>svg]:size-4" aria-hidden>{icon}</span> : null}
          {children}
        </span>
        {loading ? (
          <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5" role="status">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            {loadingLabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export interface ButtonLinkProps extends Omit<ComponentProps<typeof Link>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  className?: string;
}

/** A Next.js link styled as a button (navigation, not an action). */
export function ButtonLink({ variant = "secondary", size = "md", icon, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link {...rest} className={buttonClasses({ variant, size, className })}>
      {icon ? <span className="inline-flex shrink-0 [&>svg]:size-4" aria-hidden>{icon}</span> : null}
      {children}
    </Link>
  );
}

/** Visible reason next to a disabled control ("Cannot approve yet: 2 values need confirmation."). */
export function DisabledReason({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={cn("text-sm text-ink-secondary", className)}>
      {children}
    </p>
  );
}
