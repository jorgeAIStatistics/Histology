"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import type { ConflictField } from "@/components/ui/conflict-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useCommand, type CommandFailure } from "@/lib/client/command";
import { useConflict } from "@/lib/client/conflict";
import { useCan } from "@/lib/client/shell-context";
import { EtDateTime, etParts, etToIso } from "./form-bits";

export interface EditableContact {
  id: string;
  name: string;
  role: string;
  isPrimary: boolean;
  isEscalation: boolean;
  outUntil: string | null;
  backupId: string | null;
  version: number;
}

/** The editable values, as the form holds them. */
interface FormValues {
  out: boolean;
  outAt: { day: string; time: string };
  backup: string;
  primary: boolean;
  escalation: boolean;
}

type Key = "out_until" | "backup_contact_id" | "is_primary" | "is_escalation";
const KEYS: Key[] = ["out_until", "backup_contact_id", "is_primary", "is_escalation"];
const LABELS: Record<Key, string> = { out_until: "Out until", backup_contact_id: "Backup contact", is_primary: "Primary contact", is_escalation: "Escalation contact" };

function toForm(src: { outUntil: string | null; backupId: string | null; isPrimary: boolean; isEscalation: boolean }, now: string): FormValues {
  return {
    out: src.outUntil !== null,
    outAt: src.outUntil ? etParts(src.outUntil) : { day: etParts(now).day, time: "17:00" },
    backup: src.backupId ?? "",
    primary: src.isPrimary,
    escalation: src.isEscalation,
  };
}

/** The value of one directory column as the server stores it. */
function column(v: FormValues, key: Key): string | boolean | null {
  switch (key) {
    case "out_until":
      return v.out ? etToIso(v.outAt.day, v.outAt.time) : null;
    case "backup_contact_id":
      return v.backup || null;
    case "is_primary":
      return v.primary;
    case "is_escalation":
      return v.escalation;
  }
}

function sameColumn(key: Key, a: FormValues, b: FormValues): boolean {
  const x = column(a, key);
  const y = column(b, key);
  if (key === "out_until" && typeof x === "string" && typeof y === "string") return Date.parse(x) === Date.parse(y);
  return x === y;
}

/** The latest row from a CONFLICT error's details.current (SQLite booleans are 0/1). */
function fromRow(row: Record<string, unknown> | null): { values: { outUntil: string | null; backupId: string | null; isPrimary: boolean; isEscalation: boolean }; version: number | null } | null {
  if (!row) return null;
  return {
    values: {
      outUntil: typeof row.out_until === "string" ? row.out_until : null,
      backupId: typeof row.backup_contact_id === "string" ? row.backup_contact_id : null,
      isPrimary: row.is_primary === 1 || row.is_primary === true,
      isEscalation: row.is_escalation === 1 || row.is_escalation === true,
    },
    version: typeof row.version === "number" ? row.version : null,
  };
}

/** Edit one directory entry (supervisor). Office and contact identity stay visible in the dialog title. */
export function ContactEditButton({
  officeName,
  contact,
  colleagues,
  now,
}: {
  officeName: string;
  contact: EditableContact;
  colleagues: { id: string; name: string }[];
  now: string;
}) {
  const can = useCan("routing.editRules");
  const toast = useToast();
  const conflict = useConflict();
  const [open, setOpen] = useState(false);
  // What the dialog opened with: the version the save is based on, and the values it compares against.
  // Only fields that differ from `base` are sent, so a save never rewrites a field the user did not touch.
  const [base, setBase] = useState<{ version: number; values: FormValues }>(() => ({ version: contact.version, values: toForm(contact, now) }));
  const [form, setForm] = useState<FormValues>(base.values);
  const cmd = useCommand<{ version: number; changes: string[] }, unknown>("office.updateContact", {
    successToast: (r) => (r.changes.length ? `Directory updated: ${contact.name} — ${r.changes.join("; ")}.` : "No changes to save."),
    errorToast: false,
    conflict: false, // handled below: rows show the other person's changes and yours, field by field
  });
  const set = (patch: Partial<FormValues>) => setForm((f) => ({ ...f, ...patch }));
  const outIso = form.out ? etToIso(form.outAt.day, form.outAt.time) : null;
  // Same rule as the server: clarifications go to the primary, escalations to a separate contact.
  const bothRoles = form.primary && form.escalation;
  const changed = KEYS.filter((k) => !sameColumn(k, form, base.values));

  const begin = () => {
    const values = toForm(contact, now);
    setBase({ version: contact.version, values });
    setForm(values);
    cmd.reset();
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    cmd.reset();
  };

  const nameOf = (id: string | null) => (id ? (colleagues.find((c) => c.id === id)?.name ?? "Another contact") : "No backup");
  const show = (v: FormValues, key: Key): unknown => {
    const value = column(v, key);
    if (key === "out_until") return value ?? "Available (not out)";
    if (key === "backup_contact_id") return nameOf(value as string | null);
    return value;
  };

  const onConflict = (error: CommandFailure, opened: { version: number; values: FormValues }, mine: FormValues) => {
    const latest = fromRow(((error.details ?? {}) as { current?: Record<string, unknown> }).current ?? null);
    if (!latest) return;
    const theirs = toForm(latest.values, now);
    const fields: ConflictField[] = [];
    for (const k of KEYS) {
      const theyChanged = !sameColumn(k, theirs, opened.values);
      const iChanged = !sameColumn(k, mine, opened.values);
      if (!theyChanged && !iChanged) continue;
      fields.push({ field: k, label: LABELS[k], theirs: show(theirs, k), yours: iChanged ? show(mine, k) : "Not changed by you" });
    }
    const version = latest.version ?? opened.version;
    conflict.open({
      message: error.message,
      details: error.details,
      subject: `${contact.name} (${officeName})`,
      fields,
      // Re-base: take the latest saved values, then re-apply only the fields this user changed.
      onLoadLatest: () => {
        const merged = { ...theirs };
        if (!sameColumn("out_until", mine, opened.values)) Object.assign(merged, { out: mine.out, outAt: mine.outAt });
        if (!sameColumn("backup_contact_id", mine, opened.values)) merged.backup = mine.backup;
        if (!sameColumn("is_primary", mine, opened.values)) merged.primary = mine.primary;
        if (!sameColumn("is_escalation", mine, opened.values)) merged.escalation = mine.escalation;
        setBase({ version, values: theirs });
        setForm(merged);
        cmd.reset();
      },
      onDiscard: () => {
        setBase({ version, values: theirs });
        setForm(theirs);
        cmd.reset();
      },
    });
  };

  if (!can.allowed) {
    return (
      <span className="text-xs text-ink-muted" title={can.reason ?? undefined}>
        Supervisor edits
      </span>
    );
  }

  return (
    <>
      <Button size="sm" variant="quiet" icon={<Pencil />} onClick={begin} aria-label={`Edit ${contact.name}, ${officeName}`}>
        Edit
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={`Edit contact: ${contact.name}`}
        description={`${officeName} · ${contact.role} · fictional contact, simulated channel`}
        size="md"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Keep current values
            </Button>
            <Button
              variant="primary"
              loading={cmd.pending}
              loadingLabel="Saving..."
              disabled={(form.out && !outIso) || bothRoles}
              onClick={async () => {
                if (!changed.length) {
                  toast.show({ tone: "info", title: "No changes to save." });
                  close();
                  return;
                }
                const opened = base;
                const mine = form;
                const patch = Object.fromEntries(changed.map((k) => [k, column(mine, k)]));
                const res = await cmd.run({ contactId: contact.id, expectedVersion: opened.version, patch });
                if (res.ok) setOpen(false);
                else if (res.error.code === "CONFLICT") onConflict(res.error, opened, mine);
              }}
            >
              Save contact
            </Button>
          </div>
        }
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Checkbox
              label="Out of office (coverage gap)"
              hint="While out, new clarifications go to the backup contact. With no available backup, the simulated send is recorded as delivery failed."
              checked={form.out}
              onChange={(e) => set({ out: e.target.checked })}
            />
            {form.out ? (
              <EtDateTime label="Out until" value={form.outAt} onChange={(outAt) => set({ outAt })} required error={!outIso ? "Enter a valid date and time." : null} />
            ) : null}
          </div>
          <Field label="Backup contact" hint="Must be another contact at the same office.">
            <Select size="sm" value={form.backup} onChange={(e) => set({ backup: e.target.value })}>
              <option value="">No backup on file</option>
              {colleagues.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox
            label="Primary contact for this office"
            hint="Making this contact primary removes the primary flag from the current one (recorded)."
            checked={form.primary}
            onChange={(e) => set({ primary: e.target.checked })}
          />
          <Checkbox
            label="Escalation contact"
            hint="Receives escalations after repeated unanswered reminders. Must be a different person from the primary contact."
            checked={form.escalation}
            onChange={(e) => set({ escalation: e.target.checked })}
          />
          {bothRoles ? (
            <p role="alert" className="text-sm text-danger-fg">
              One contact cannot be both primary and escalation contact. Clarifications go to the primary; escalations go to a separate contact. Clear one of the two.
            </p>
          ) : null}
          <CommandError error={cmd.error} />
        </div>
      </Dialog>
    </>
  );
}
