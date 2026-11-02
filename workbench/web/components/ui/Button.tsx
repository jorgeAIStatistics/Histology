"use client";

import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { useToast } from "./Toaster";

type Variant = "primary" | "secondary" | "quiet" | "danger" | "review";
type Size = "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** When set, the button stays focusable but does nothing except explain this exact missing dependency. */
  unavailable?: string | null;
  busy?: boolean;
};

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] font-semibold transition-colors select-none";

const variants: Record<Variant, string> = {
  primary: "bg-teal text-white hover:bg-teal-deep border border-teal-deep/40",
  secondary: "bg-sheet text-ink border border-line-strong hover:border-teal hover:text-teal-deep",
  quiet: "bg-transparent text-teal-deep hover:bg-teal-tint border border-transparent",
  danger: "bg-sheet text-rust border border-rust/50 hover:bg-rust-tint",
  review: "bg-amber-tint text-amber-ink border border-amber/60 hover:bg-[#f2d9a5]",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-small",
  md: "h-10 px-3.5 text-body",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, unavailable, busy, className, children, onClick, disabled, type, title, "aria-describedby": describedBy, ...rest },
  ref,
) {
  const toast = useToast();
  const reasonId = useId();
  const isUnavailable = Boolean(unavailable);
  return (
    <>
      <button
        ref={ref}
        type={type ?? "button"}
        aria-disabled={isUnavailable || disabled || busy ? true : undefined}
        aria-describedby={isUnavailable ? reasonId : describedBy}
        disabled={disabled}
        title={isUnavailable ? unavailable ?? undefined : title}
        className={cn(
          base,
          variants[variant],
          sizes[size],
          (isUnavailable || disabled) && "cursor-not-allowed border-line bg-paraffin text-graphite hover:border-line hover:bg-paraffin hover:text-graphite",
          busy && "opacity-80",
          className,
        )}
        onClick={(e) => {
          if (isUnavailable) {
            e.preventDefault();
            toast.show({ tone: "info", title: "Not available here", body: unavailable ?? undefined });
            return;
          }
          if (busy) {
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
        {...rest}
      >
        {busy ? <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" /> : icon}
        {children}
      </button>
      {isUnavailable ? (
        <span id={reasonId} className="sr-only">
          Unavailable: {unavailable}
        </span>
      ) : null}
    </>
  );
});
