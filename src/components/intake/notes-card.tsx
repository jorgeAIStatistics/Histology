"use client";

import { useState } from "react";
import { Users } from "lucide-react";
import type { ItemDetail, BenchPermissions } from "@/server/queries/intake";
import { Button } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Field, Select, Textarea } from "@/components/ui/field";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useConflict } from "@/lib/client/conflict";
import { useStaff } from "@/lib/client/shell-context";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { RecordSection, useBackToScan } from "./bits";

interface Draft {
  baseVersion: number;
  ownerId: string;
  notes: string;
}

/**
 * Presenter control (demo): a simulated colleague (Luis Benitez) saves a change
 * to this item, so the stale-save protection can be shown. Lives in the
 * "Presenter controls (demo)" disclosure, not on the bench surface; the server
 * still checks the role (the read-only director is refused inline).
 */
export function ColleagueEditControl({ item }: { item: ItemDetail }) {
  return (
    <CommandButton
      command="intake.simulateColleagueEdit"
      input={{ intakeItemId: item.id }}
      size="sm"
      variant="secondary"
      pendingLabel="Simulating..."
      successToast="Demo: Luis Benitez (simulated colleague) edited this item"
      disabled={item.status === "canceled"}
    >
      Simulate a colleague editing this item (demo control)
    </CommandButton>
  );
}

/**
 * Owner and working note for the intake item. Saving sends the version the
 * user started from (expectedVersion); if a colleague saved first, the server
 * returns CONFLICT and the conflict dialog shows both values. No overwrite.
 */
export function NotesSection({ item, permissions, now }: { item: ItemDetail; permissions: BenchPermissions; now: string }) {
  const staff = useStaff();
  const backToScan = useBackToScan();
  const conflict = useConflict();
  const [draft, setDraft] = useState<Draft | null>(null);
  const owners = staff.filter((s) => s.role === "accessioner" || s.role === "accessioning_lead" || s.role === "supervisor");
  const dirty = !!draft && (draft.notes !== (item.notes ?? "") || draft.ownerId !== (item.ownerId ?? ""));
  useUnsavedChanges(dirty, `${item.displayId} owner and note`);

  const save = useCommand<{ version: number }, { intakeItemId: string; expectedVersion: number; patch: { currentOwnerId?: string | null; notes?: string | null } }>(
    "intake.updateItem",
    {
      successToast: "Owner and note saved",
      conflict: false,
      errorToast: false,
      onSuccess: () => {
        setDraft(null);
        backToScan();
      },
      onError: (err) => {
        if (err.code !== "CONFLICT" || !draft) return;
        const current = ((err.details as { current?: Record<string, unknown> } | undefined)?.current ?? {}) as Record<string, unknown>;
        const name = (id: unknown) => (typeof id === "string" ? staff.find((s) => s.id === id)?.name ?? id : null);
        const changedBy = name(current.updated_by);
        conflict.open({
          message: `${changedBy ?? "Someone"} saved changes to ${item.displayId} after you started editing (you had version ${draft.baseVersion}, current is ${String(current.version ?? "?")}).`,
          details: err.details,
          subject: `Provisional intake item ${item.displayId}`,
          // Only the fields where their saved value differs from yours; an unchanged row is noise in a conflict.
          fields: (() => {
            const all = [
              { field: "notes", label: "Note", theirs: (current.notes as string | null | undefined) ?? null, yours: draft.notes || null },
              { field: "current_owner_id", label: "Owner", theirs: name(current.current_owner_id), yours: name(draft.ownerId) },
            ];
            const differ = all.filter((f) => (f.theirs ?? "") !== (f.yours ?? ""));
            return differ.length ? differ : all;
          })(),
          onLoadLatest: (latest) => {
            // Re-base on the latest version and keep my edits in the form so I can re-apply them deliberately.
            const v = Number((latest ?? current).version);
            setDraft((d) => (d ? { ...d, baseVersion: Number.isFinite(v) ? v : d.baseVersion } : d));
          },
          onDiscard: () => setDraft(null),
        });
      },
    },
  );

  const startEdit = () => setDraft({ baseVersion: item.version, ownerId: item.ownerId ?? "", notes: item.notes ?? "" });
  const staleSinceStart = draft && item.version !== draft.baseVersion;

  return (
    <RecordSection
      id="owner-note"
      title={
        <span className="inline-flex items-center gap-2">
          <Users className="size-4 text-ink-muted" aria-hidden />
          Owner and working note
        </span>
      }
      description="Two accessioners can open the same item. A stale save is detected and shown, never applied over a colleague's work."
    >
      {draft ? (
        <div className="space-y-2">
          {staleSinceStart ? (
            <AlertBanner tone="warning" title={`This item changed after you started editing (version ${draft.baseVersion} → ${item.version})`}>
              Last saved by {item.updatedByName ?? "Unknown"} at <Timestamp iso={item.updatedAt} now={now} />. Saving will show the conflict instead of overwriting.
            </AlertBanner>
          ) : null}
          <div className="grid grid-cols-[220px_1fr] gap-3 max-lg:grid-cols-1">
            <Field label="Current task owner">
              <Select size="sm" value={draft.ownerId} onChange={(e) => setDraft({ ...draft, ownerId: e.target.value })}>
                <option value="">Unassigned</option>
                {owners.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Working note">
              <Textarea rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={save.pending}
              loadingLabel="Saving..."
              disabled={!dirty}
              onClick={() =>
                void save.run({
                  intakeItemId: item.id,
                  expectedVersion: draft.baseVersion,
                  patch: { currentOwnerId: draft.ownerId || null, notes: draft.notes },
                })
              }
            >
              Save owner and note
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
              Discard my edits
            </Button>
            <span className="text-sm text-ink-muted">Editing from version {draft.baseVersion}</span>
          </div>
          <CommandError error={save.error && save.error.code !== "CONFLICT" ? save.error : null} />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-1 text-sm">
          <p>
            <span className="text-ink-muted">Current task owner: </span>
            {item.ownerName ?? "Unassigned"}
          </p>
          <p className="min-w-0 flex-1 whitespace-pre-line">
            <span className="text-ink-muted">Note: </span>
            {item.notes ?? <span className="text-ink-muted">None</span>}
          </p>
          <p className="text-sm text-ink-muted">
            Version {item.version} · last saved by {item.updatedByName ?? "Unknown"} at <Timestamp iso={item.updatedAt} now={now} />
          </p>
          {permissions.edit && item.status !== "canceled" ? (
            <Button size="sm" variant="secondary" onClick={startEdit}>
              Edit owner or note
            </Button>
          ) : null}
        </div>
      )}
    </RecordSection>
  );
}
