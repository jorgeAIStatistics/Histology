"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/roles";
import { hasUnsavedChanges, unsavedLabels } from "@/lib/client/unsaved";
import { isReadOnlyRole } from "@/lib/client/shell-context";
import type { ShellActor, ShellStaff } from "@/lib/client/types";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ReadOnlyTag } from "@/components/domain/honesty";

/** Short role names for the selector ("Maya Torres, Accessioner"); the option groups carry the full role name. */
export const ROLE_SHORT: Record<Role, string> = {
  ...ROLE_LABEL,
  histotech: "Histotech",
  supervisor: "Supervisor",
  director: "Director (demo)",
  medical_director: "Medical director (demo)",
};

/** "Maya Torres, Accessioner"; demo-only people whose name already is the role ("Director of Operations (demo)") are not repeated. */
export function optionText(s: { name: string; role: Role }): string {
  return /\(demo\)$/.test(s.name) ? s.name : `${s.name}, ${ROLE_SHORT[s.role]}`;
}

/**
 * "Acting as" role selector (spec §5.1), on the presenter console (Role and
 * clock), never on a bench screen: a native <select>. Demo role switch, not a sign-in. The server checks permissions on every action whatever this
 * says. Switching with unsaved edits asks first.
 */
export function ActingAs({ actor, staff }: { actor: ShellActor; staff: ShellStaff[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);

  const options = staff.length ? staff : [{ id: actor.id, name: actor.name, role: actor.role }];
  const groups = ROLES.map((role) => ({ role, people: options.filter((s) => s.role === role) })).filter((g) => g.people.length);

  const switchTo = async (staffId: string) => {
    setConfirmFor(null);
    setPending(true);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; actor?: ShellActor; error?: { message: string } } | null;
      if (!res.ok || !body?.ok || !body.actor) {
        toast.show({ tone: "warning", title: "Could not switch role", body: body?.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      toast.show({
        tone: "info",
        title: `Acting as ${optionText(body.actor)}`,
        body: "Demo role switch. Not a sign-in.",
      });
      startTransition(() => router.refresh());
    } catch {
      toast.show({ tone: "warning", title: "Could not switch role", body: "The local demo server did not respond. Try again." });
    } finally {
      setPending(false);
    }
  };

  const target = confirmFor ? options.find((s) => s.id === confirmFor) : null;
  const readOnly = isReadOnlyRole(actor.role);

  return (
    <div className="flex items-center gap-2">
      <div className="flex w-full flex-col gap-1 leading-tight">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <label htmlFor="acting-as" title="Demo role switch. Not a sign-in.">
            Acting as<span className="sr-only"> (demo role switch, not a sign-in)</span>
          </label>
          {readOnly ? (
            <span id="acting-as-readonly">
              <ReadOnlyTag className="h-4 py-0 leading-none" />
            </span>
          ) : null}
        </span>
        <Select
          id="acting-as"
          value={actor.id}
          disabled={pending}
          aria-busy={pending || undefined}
          aria-describedby={readOnly ? "acting-as-readonly" : undefined}
          onChange={(e) => {
            const id = e.target.value;
            if (id === actor.id) return;
            if (hasUnsavedChanges()) setConfirmFor(id);
            else void switchTo(id);
          }}
          className="font-medium"
        >
          {groups.map((g) => (
            <optgroup key={g.role} label={ROLE_LABEL[g.role]}>
              {g.people.map((s) => (
                <option key={s.id} value={s.id}>
                  {optionText(s)}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
      <ConfirmDialog
        open={confirmFor !== null}
        title={`Switch to ${target?.name ?? "another role"} with unsaved changes?`}
        confirmLabel="Switch role and discard changes"
        cancelLabel={`Stay as ${actor.name}`}
        destructive
        onCancel={() => setConfirmFor(null)}
        onConfirm={() => confirmFor && void switchTo(confirmFor)}
      >
        <p>
          Unsaved changes for {unsavedLabels().join(", ") || "this form"} will be lost. Values never carry over to another role or case.
        </p>
      </ConfirmDialog>
    </div>
  );
}
