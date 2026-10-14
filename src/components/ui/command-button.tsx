"use client";

import { useId, useState, type ReactNode } from "react";
import { OctagonX } from "lucide-react";
import { cn } from "@/lib/cn";
import { ERROR_TITLE, failureMessage, useCommand, type CommandFailure, type UseCommandOptions } from "@/lib/client/command";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { ConfirmDialog } from "./dialog";

/**
 * Inline command error (spec §6.0 "Permission denied", §10 errors): what
 * happened and what to do, in danger text next to the control.
 */
export function CommandError({ error, className, id }: { error: CommandFailure | null | undefined; className?: string; id?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className={cn("flex items-start gap-1.5 text-sm text-danger-fg", className)}>
      <OctagonX className="mt-0.5 size-4 shrink-0 text-danger-solid" aria-hidden />
      <span>
        <span className="font-semibold">{ERROR_TITLE[error.code] ?? "Action failed"}:</span> {failureMessage(error)}
      </span>
    </p>
  );
}

export interface CommandButtonProps<R, I> extends UseCommandOptions<R, I> {
  /** Registered command name, e.g. "clarification.send". */
  command: string;
  /** Command input, or a function evaluated at click time (reads the latest form state). */
  input: I | (() => I);
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Text while pending, e.g. "Requesting...". */
  pendingLabel?: string;
  icon?: ReactNode;
  /** Ask first (destructive or irreversible actions). Title names the action and the object. */
  confirm?: {
    title: ReactNode;
    body?: ReactNode;
    confirmLabel: string;
    cancelLabel: string;
    destructive?: boolean;
  };
  /** Disable with a visible reason (rendered below the button and linked with aria-describedby). */
  disabledReason?: ReactNode;
  disabled?: boolean;
  /** Where to show failures: inline text under the button (default), toast only, or both. */
  showError?: "inline" | "toast" | "both";
  className?: string;
  /** Classes for the wrapper (button + reason + error). */
  wrapperClassName?: string;
  "aria-label"?: string;
}

/**
 * `<CommandButton command="print.reconcile" input={{ jobId, outcome: "not_printed" }} variant="secondary" pendingLabel="Recording...">Not printed</CommandButton>`
 * Generates one idempotency key per intent, disables itself while pending,
 * refreshes the page on success, opens the conflict dialog on CONFLICT.
 */
export function CommandButton<R = unknown, I = unknown>({
  command,
  input,
  children,
  variant = "secondary",
  size = "md",
  pendingLabel = "Working...",
  icon,
  confirm,
  disabledReason,
  disabled,
  showError = "inline",
  className,
  wrapperClassName,
  errorToast,
  "aria-label": ariaLabel,
  ...options
}: CommandButtonProps<R, I>) {
  const reasonId = useId();
  const errorId = useId();
  const [confirming, setConfirming] = useState(false);
  const { run, pending, error } = useCommand<R, I>(command, {
    ...options,
    errorToast: errorToast ?? showError !== "inline",
  });

  const resolveInput = () => (typeof input === "function" ? (input as () => I)() : input);
  const execute = async () => {
    const out = await run(resolveInput());
    setConfirming(false);
    return out;
  };

  const isDisabled = Boolean(disabled || disabledReason);

  return (
    <div className={cn("inline-flex flex-col items-start gap-1", wrapperClassName)}>
      <Button
        variant={variant}
        size={size}
        icon={icon}
        className={className}
        loading={pending && !confirming}
        loadingLabel={pendingLabel}
        disabled={isDisabled}
        reasonId={disabledReason ? reasonId : undefined}
        aria-label={ariaLabel}
        aria-describedby={error && showError !== "toast" ? errorId : undefined}
        onClick={() => {
          if (confirm) setConfirming(true);
          else void execute();
        }}
      >
        {children}
      </Button>
      {disabledReason ? (
        <p id={reasonId} className="max-w-[48ch] text-xs text-ink-secondary">
          {disabledReason}
        </p>
      ) : null}
      {showError !== "toast" ? <CommandError id={errorId} error={error} className="max-w-[60ch]" /> : null}
      {confirm ? (
        <ConfirmDialog
          open={confirming}
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={confirm.cancelLabel}
          destructive={confirm.destructive}
          pending={pending}
          pendingLabel={pendingLabel}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void execute()}
        >
          {confirm.body}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
