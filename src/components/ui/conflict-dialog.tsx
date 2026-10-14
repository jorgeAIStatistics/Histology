"use client";

import type { ReactNode } from "react";
import { fmtDateTime, fmtFull, fmtSmart } from "@/lib/time";
import { Button } from "./button";
import { Dialog } from "./dialog";

/**
 * Conflict dialog (spec §7). Shown when a save was based on an older version
 * of the record. Lists each field: their value (who, when) and your value.
 * Actions: "Load latest and re-apply my changes" / "Discard my changes".
 * There is NO overwrite option. Esc = "Keep editing" (closes; your edits stay
 * in the form, which is still stale).
 */
export interface ConflictField {
  /** Machine field name (e.g. "site_text"). */
  field: string;
  /** Human label (e.g. "Site"). Defaults to the field name in sentence case. */
  label?: string;
  theirs: unknown;
  yours: unknown;
}

export interface ConflictDialogProps {
  open: boolean;
  /** Esc / "Keep editing". */
  onClose: () => void;
  onLoadLatest: () => void;
  onDiscard: () => void;
  fields: ConflictField[];
  /** Display name of who saved the newer version, if known. */
  changedBy?: string | null;
  /** When they saved it (ISO). */
  changedAt?: string | null;
  /** Record identity, e.g. "INT-1014-031". */
  subject?: ReactNode;
  /** Server message, shown when who/when is unknown. */
  message?: string;
  /** Demo now (ISO) for "10:58 ET" formatting. */
  now?: string;
}

export function humanizeField(name: string): string {
  const spaced = name
    .replace(/_json$|_id$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : name;
}

export function formatConflictValue(v: unknown): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-ink-muted">None</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  // Timestamps (UTC ISO) read in lab time.
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) return `${fmtDateTime(v)} ET`;
  if (typeof v === "object") {
    try {
      return <code className="id-mono whitespace-pre-wrap break-all text-xs">{JSON.stringify(v)}</code>;
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function ConflictDialog({
  open,
  onClose,
  onLoadLatest,
  onDiscard,
  fields,
  changedBy,
  changedAt,
  subject,
  message,
  now,
}: ConflictDialogProps) {
  const when = changedAt ? (now ? `${fmtSmart(changedAt, now)} ET` : fmtFull(changedAt)) : null;
  const lead =
    changedBy && when ? (
      <>
        {changedBy} saved changes{subject ? <> to {subject}</> : null} at {when} after you opened it.
      </>
    ) : changedBy ? (
      <>
        {changedBy} saved changes{subject ? <> to {subject}</> : null} after you opened it.
      </>
    ) : (
      (message ?? "This item was changed after you opened it.")
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Someone else changed this item"
      description={
        <>
          {lead} Your changes were not saved yet. Compare the values below; press Esc to keep editing.
        </>
      }
      size="lg"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Keep editing
          </Button>
          <Button variant="secondary" onClick={onDiscard}>
            Discard my changes
          </Button>
          <Button variant="primary" onClick={onLoadLatest}>
            Load latest and re-apply my changes
          </Button>
        </>
      }
    >
      {fields.length > 0 ? (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Fields that differ between the saved version and your edits</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-secondary">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Field
              </th>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Their value{changedBy ? ` (${changedBy}${when ? `, ${when}` : ""})` : ""}
              </th>
              <th scope="col" className="py-1.5 font-medium">
                Your value
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field} className="border-b border-line align-top last:border-b-0">
                <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
                  {f.label ?? humanizeField(f.field)}
                </th>
                <td className="py-2 pr-3 text-ink">{formatConflictValue(f.theirs)}</td>
                <td className="py-2 text-ink">{formatConflictValue(f.yours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-ink-secondary">The record has a newer version. Load the latest version to see what changed.</p>
      )}
    </Dialog>
  );
}
