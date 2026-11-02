"use client";

import { useId, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { useCommand } from "@/lib/client/command";
import { labDay, labLocalToIso } from "@/lib/time";

const hhmmFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });

/** Lab-local (America/New_York) date and time parts of an ISO instant. */
export function etParts(iso: string): { day: string; time: string } {
  const parts = hhmmFmt.formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return { day: labDay(iso), time: `${h === "24" ? "00" : h}:${m}` };
}

export function etToIso(day: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  try {
    return labLocalToIso(day, time);
  } catch {
    return null;
  }
}

/** Date + time inputs in lab time (ET), independent of the viewer's computer time zone. */
export function EtDateTime({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  disabled,
}: {
  label: string;
  value: { day: string; time: string };
  onChange: (v: { day: string; time: string }) => void;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium text-ink">
        {label} <span className="font-normal text-ink-muted">(ET{required ? ", required" : ""})</span>
      </legend>
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor={`${id}-d`}>
          {label} date
        </label>
        <Input id={`${id}-d`} type="date" size="sm" value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value })} className="w-40" invalid={Boolean(error)} />
        <label className="sr-only" htmlFor={`${id}-t`}>
          {label} time
        </label>
        <Input id={`${id}-t`} type="time" size="sm" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} className="w-28" invalid={Boolean(error)} />
      </div>
      {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
      {error ? (
        <p className="mt-1 flex items-start gap-1 text-xs font-medium text-warning-fg">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-solid" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * A command that needs a written reason: the button opens a small dialog that
 * names the object, asks for the reason, then runs the command with `{ ...input, reason }`.
 */
export function ReasonCommandButton({
  command,
  input,
  label,
  title,
  body,
  confirmLabel,
  cancelLabel = "Keep it",
  variant = "secondary",
  destructive,
  disabledReason,
  successToast,
}: {
  command: string;
  input: Record<string, unknown>;
  label: string;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  destructive?: boolean;
  disabledReason?: string | null;
  successToast?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const cmd = useCommand(command, { successToast, errorToast: false });
  const tooShort = reason.trim().length < 3;
  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Button size="sm" variant={variant} disabled={Boolean(disabledReason)} reasonId={disabledReason ? reasonId : undefined} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {disabledReason ? (
        <p id={reasonId} className="max-w-[40ch] text-xs text-ink-secondary">
          {disabledReason}
        </p>
      ) : null}
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          cmd.reset();
        }}
        title={title}
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? "destructive" : "primary"}
              loading={cmd.pending}
              loadingLabel="Saving..."
              disabled={tooShort}
              onClick={async () => {
                const out = await cmd.run({ ...input, reason: reason.trim() });
                if (out.ok) {
                  setOpen(false);
                  setReason("");
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        }
      >
        {body ? <div className="mb-3 text-sm text-ink-secondary">{body}</div> : null}
        <Field label="Reason" required hint="Recorded in the audit history with your name.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </Field>
        <CommandError error={cmd.error} className="mt-2" />
      </Dialog>
    </div>
  );
}
