import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Button (spec §7). Verb-first labels ("Request accession"). One primary per
 * region. Loading keeps the width, shows the loading label and disables the
 * button (prevents double submits). Disabled stays legible (muted ink on a
 * subtle fill, AA contrast): the label still says what the action is. When disabled for a reason, render the
 * reason as visible text and pass its id as `reasonId` (aria-describedby).
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "quiet";
/** "block": full width, the label may wrap (docked decision columns); never splits an identifier. */
export type ButtonSize = "sm" | "md" | "lg" | "block";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white hover:bg-brand-hover active:bg-brand-hover disabled:border disabled:border-line disabled:bg-surface-subtle disabled:text-ink-muted",
  secondary:
    "border border-line-strong bg-surface text-ink hover:bg-surface-subtle active:bg-surface-sunken disabled:border-line disabled:bg-surface-subtle disabled:text-ink-muted",
  ghost: "text-brand hover:bg-brand-50 active:bg-brand-100 disabled:text-ink-muted disabled:bg-transparent",
  destructive:
    "bg-danger-solid text-white hover:bg-danger-fg active:bg-danger-fg disabled:border disabled:border-line disabled:bg-surface-subtle disabled:text-ink-muted",
  quiet:
    "text-ink-secondary hover:bg-surface-subtle hover:text-ink active:bg-surface-sunken disabled:text-ink-muted disabled:bg-transparent",
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
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-semibold transition-[background-color,border-color,color,transform] duration-[var(--hlo-duration-fast)] ease-[var(--hlo-ease)] enabled:active:translate-y-px disabled:cursor-not-allowed",
    VARIANT[variant],
    SIZE[size],
    variant === "quiet" && size === "sm" && "px-2",
    className,
  );
}

export interface ButtonProps extends Omit<ComponentProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows `loadingLabel` with a spinner, keeps the width and disables the button. */
  loading?: boolean;
  /** Text while loading, e.g. "Requesting..." (default "Working..."). */
  loadingLabel?: string;
  /** Optional leading icon (decorative; aria-hidden). */
  icon?: ReactNode;
  /** id of the visible element that explains why the button is disabled. */
  reasonId?: string;
  children: ReactNode;
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
  ...rest
}: ButtonProps) {
  const describedBy = [rest["aria-describedby"], reasonId].filter(Boolean).join(" ") || undefined;
  return (
    <button
      type={type}
      {...rest}
      aria-describedby={describedBy}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
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
