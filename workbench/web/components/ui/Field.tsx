"use client";

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

const control =
  "w-full rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2.5 text-body text-ink placeholder:text-graphite/80 focus:border-teal focus:outline-none focus-visible:outline-2 focus-visible:outline-teal disabled:bg-paraffin disabled:text-graphite";

type Common = { label: ReactNode; hint?: ReactNode; error?: string | null; className?: string; required?: boolean };

export function TextField({ label, hint, error, className, required, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={id} className="block text-small font-semibold text-ink">
        {label}
        {required ? <span className="text-graphite"> (required)</span> : null}
      </label>
      <input id={id} aria-describedby={hint || error ? `${id}-hint` : undefined} aria-invalid={error ? true : undefined} required={required} className={cn(control, "h-10")} {...rest} />
      {hint || error ? (
        <p id={`${id}-hint`} className={cn("text-micro", error ? "text-rust" : "text-graphite")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextArea({ label, hint, error, className, required, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={id} className="block text-small font-semibold text-ink">
        {label}
        {required ? <span className="text-graphite"> (required)</span> : null}
      </label>
      <textarea id={id} aria-describedby={hint || error ? `${id}-hint` : undefined} required={required} className={cn(control, "min-h-[72px] py-2")} {...rest} />
      {hint || error ? (
        <p id={`${id}-hint`} className={cn("text-micro", error ? "text-rust" : "text-graphite")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  className,
  required,
  options,
  ...rest
}: Common & SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string; disabled?: boolean }[] }) {
  const id = useId();
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={id} className="block text-small font-semibold text-ink">
        {label}
        {required ? <span className="text-graphite"> (required)</span> : null}
      </label>
      <select id={id} aria-describedby={hint || error ? `${id}-hint` : undefined} required={required} className={cn(control, "h-10 pr-8")} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {hint || error ? (
        <p id={`${id}-hint`} className={cn("text-micro", error ? "text-rust" : "text-graphite")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, hint, className, ...rest }: { label: ReactNode; hint?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <input id={id} type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-teal)]" aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      <div>
        <label htmlFor={id} className="text-small font-semibold text-ink">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-micro text-graphite">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
