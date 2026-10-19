"use client";

import { TriangleAlert } from "lucide-react";
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Form fields (spec §9 Understandable): every input has a visible label (not
 * a placeholder); units go in the label ("Length (mm)") or an explicit
 * selector; required fields say "(required)"; errors name the field, the
 * problem and the fix, linked with aria-describedby and aria-invalid.
 *
 *   <Field label="Length" unit="mm" required error={errors.length}>
 *     <Input inputMode="decimal" value={...} onChange={...} />
 *   </Field>
 */

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
}

const FieldContext = createContext<FieldCtx | null>(null);

export function Label({
  htmlFor,
  children,
  required,
  unit,
  className,
  id,
}: {
  htmlFor?: string;
  children: ReactNode;
  required?: boolean;
  unit?: string;
  className?: string;
  id?: string;
}) {
  return (
    <label id={id} htmlFor={htmlFor} className={cn("text-sm font-medium text-ink-secondary", className)}>
      {children}
      {unit ? <span> ({unit})</span> : null}
      {required ? <span className="font-normal text-ink-muted"> (required)</span> : null}
    </label>
  );
}

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text (what is wrong and how to fix it). Sets aria-invalid on the control. */
  error?: ReactNode;
  required?: boolean;
  /** Unit shown in the label: "Length (mm)". */
  unit?: string;
  /** Optional explicit id for the control. */
  id?: string;
  className?: string;
  /** Visually hide the label (still read by screen readers). Use sparingly. */
  labelHidden?: boolean;
}

export function Field({ label, children, hint, error, required, unit, id, className, labelHidden }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Label htmlFor={controlId} required={required} unit={unit} className={labelHidden ? "sr-only" : undefined}>
        {label}
      </Label>
      <FieldContext.Provider value={{ id: controlId, describedBy, invalid: Boolean(error), required }}>{children}</FieldContext.Provider>
      {hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1 text-xs font-medium text-warning-fg">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-solid" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

function useFieldProps<T extends { id?: string; required?: boolean; "aria-describedby"?: string; "aria-invalid"?: unknown }>(
  props: T,
  invalidProp?: boolean,
) {
  const ctx = useContext(FieldContext);
  const describedBy = [ctx?.describedBy, props["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  const invalid = invalidProp ?? ctx?.invalid ?? false;
  return {
    id: props.id ?? ctx?.id,
    required: props.required ?? ctx?.required,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
  };
}

const controlBase =
  "w-full rounded-sm border border-line-strong bg-surface text-ink placeholder:text-ink-muted transition-colors duration-[var(--hlo-duration-fast)] hover:border-ink-secondary disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-sunken disabled:text-ink-disabled aria-[invalid=true]:border-warning-solid aria-[invalid=true]:bg-warning-bg";

const controlSize = {
  sm: "h-8 min-h-[max(2rem,var(--hlo-target-min))] px-2 text-sm",
  md: "h-10 min-h-[max(2.5rem,var(--hlo-target-min))] px-2.5 text-base",
};

export interface InputProps extends Omit<ComponentProps<"input">, "size"> {
  invalid?: boolean;
  /** Monospace for identifiers. */
  mono?: boolean;
  size?: "sm" | "md";
}

export function Input({ invalid, mono, size = "md", className, ...rest }: InputProps) {
  const field = useFieldProps(rest, invalid);
  return <input {...rest} {...field} className={cn(controlBase, controlSize[size], mono && "id-mono", className)} />;
}

export interface SelectProps extends Omit<ComponentProps<"select">, "size"> {
  invalid?: boolean;
  size?: "sm" | "md";
}

export function Select({ invalid, size = "md", className, children, ...rest }: SelectProps) {
  const field = useFieldProps(rest, invalid);
  return (
    <select
      {...rest}
      {...field}
      className={cn(
        controlBase,
        controlSize[size],
        // Drawn chevron in muted ink instead of the OS default; native appearance returns in forced colors.
        "select-chevron appearance-none pr-8 forced-colors:appearance-auto",
        className,
      )}
    >
      {children}
    </select>
  );
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, rows = 3, ...rest }: TextareaProps) {
  const field = useFieldProps(rest, invalid);
  return <textarea rows={rows} {...rest} {...field} className={cn(controlBase, "px-2.5 py-2 text-base", className)} />;
}

/** Checkbox with its label to the right (whole row is clickable). */
export function Checkbox({
  label,
  hint,
  className,
  ...rest
}: Omit<ComponentProps<"input">, "type"> & { label: ReactNode; hint?: ReactNode }) {
  const auto = useId();
  const id = rest.id ?? `cb${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("flex min-h-[var(--hlo-target-min)] items-start gap-2 py-0.5", className)}>
      <input
        type="checkbox"
        {...rest}
        id={id}
        aria-describedby={[rest["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined}
        className="mt-0.5 size-[1.125rem] shrink-0 accent-[var(--hlo-brand)] disabled:cursor-not-allowed"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="inline-block py-0.5 text-sm text-ink">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-xs text-ink-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
