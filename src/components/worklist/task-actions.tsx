"use client";

import { useId, useState } from "react";
import { Button, CommandButton, DisabledReason, Input } from "@/components/ui";
import type { Role } from "@/lib/roles";
import { checkClaim, checkRelease } from "./task-rules";

export interface TaskForActions {
  id: string;
  title: string;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
  ownerRole: string | null;
  version: number;
}

/**
 * Claim / take over / release controls for one task. The same rules as the
 * server (components/worklist/task-rules.ts) decide which controls show and
 * why one is unavailable; the server still checks every action. Taking over or
 * releasing someone else's task asks for a reason, recorded in the audit log.
 */
export function TaskActions({ task, actor, size = "sm" }: { task: TaskForActions; actor: { id: string; role: Role }; size?: "sm" | "md" }) {
  const reasonId = useId();
  const [mode, setMode] = useState<null | "takeover" | "release">(null);
  const [reason, setReason] = useState("");
  const open = task.status === "open" || task.status === "in_progress";
  if (!open) return null;
  const rulesTask = { ownerId: task.ownerId, ownerName: task.ownerName, ownerRole: task.ownerRole, status: task.status };
  const claim = checkClaim(actor, rulesTask);
  const release = checkRelease(actor, rulesTask);
  const mine = task.ownerId === actor.id;
  const reasonOk = reason.trim().length >= 3;

  if (mode) {
    const takeover = mode === "takeover";
    return (
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={reasonId} className="flex min-w-48 flex-1 flex-col gap-0.5 text-xs text-ink-muted">
          {takeover ? `Reason for taking over from ${task.ownerName ?? "the current owner"}` : `Reason for releasing ${task.ownerName ?? "this person"}'s task`}
          <Input id={reasonId} size="sm" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the audit log" autoFocus />
        </label>
        <CommandButton
          command={takeover ? "task.claim" : "task.release"}
          input={() => (takeover ? { taskId: task.id, expectedVersion: task.version, reason: reason.trim() } : { taskId: task.id, expectedVersion: task.version, reason: reason.trim() })}
          size={size}
          variant="primary"
          pendingLabel={takeover ? "Taking over..." : "Releasing..."}
          successToast={takeover ? `You now own: ${task.title}` : "Task returned to the queue."}
          conflict={{ subject: `Task: ${task.title}` }}
          disabled={!reasonOk}
          disabledReason={!reasonOk ? "Enter a reason (at least 3 characters)." : undefined}
          onSuccess={() => {
            setMode(null);
            setReason("");
          }}
        >
          {takeover ? "Take over task" : "Release task"}
        </CommandButton>
        <Button
          type="button"
          size={size}
          variant="quiet"
          onClick={() => {
            setMode(null);
            setReason("");
          }}
        >
          Cancel
        </Button>
      </form>
    );
  }

  const blockedReason = !claim.ok ? claim.reason : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {claim.ok && !claim.unchanged && !claim.takeover ? (
          <CommandButton
            command="task.claim"
            input={{ taskId: task.id, expectedVersion: task.version }}
            size={size}
            variant="secondary"
            pendingLabel="Claiming..."
            successToast={`You now own: ${task.title}`}
            conflict={{ subject: `Task: ${task.title}` }}
          >
            {mine ? "Start task" : "Claim task"}
          </CommandButton>
        ) : null}
        {claim.ok && claim.takeover ? (
          <Button type="button" size={size} variant="secondary" onClick={() => setMode("takeover")}>
            Take over from {task.ownerName ?? "current owner"}...
          </Button>
        ) : null}
        {mine && release.ok ? (
          <CommandButton
            command="task.release"
            input={{ taskId: task.id, expectedVersion: task.version }}
            size={size}
            variant="quiet"
            pendingLabel="Releasing..."
            successToast="Task returned to the queue."
            conflict={{ subject: `Task: ${task.title}` }}
          >
            Release to queue
          </CommandButton>
        ) : null}
        {!mine && task.ownerId && release.ok && !release.unchanged ? (
          <Button type="button" size={size} variant="quiet" onClick={() => setMode("release")}>
            Release to queue...
          </Button>
        ) : null}
      </div>
      {blockedReason ? <DisabledReason id={`task-why-${task.id}`}>{blockedReason}</DisabledReason> : null}
    </div>
  );
}
