"use client";

import { useState, type ReactNode } from "react";
import { useSession, PERMISSION_ROLES } from "@/lib/session";
import { ROLE_LABEL } from "@/lib/format";
import { errorText } from "@/lib/api";
import { Loading, Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import type { Role } from "@/lib/types";

const ROLE_JOB: Record<Role, string> = {
  histology_assistant: "Imports slides, checks the specimen hierarchy, records quality issues and routes work.",
  pathologist: "Inspects slides, labels and outlines regions, reviews suggestions, settles disagreements.",
  research_lead: "Builds and freezes datasets, runs experiments, inspects failures.",
  medical_director: "Reads everything: workflow, validation readiness, impact. Can comment.",
  admin: "Manages project membership and can reset the demo. No clinical permissions.",
};

function QuickSwitch({ roles, label }: { roles: string[]; label: string }) {
  const { demoUsers, switchUser } = useSession();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const candidates = demoUsers.filter((u) => roles.includes(u.role));
  return (
    <div className="mt-3">
      <p className="text-small font-semibold text-ink">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {candidates.map((u) => (
          <Button
            key={u.id}
            size="sm"
            variant="secondary"
            busy={busy === u.id}
            onClick={async () => {
              setBusy(u.id);
              setErr(null);
              try {
                await switchUser(u.id);
              } catch (e) {
                setErr(errorText(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            {u.display_name} · {ROLE_LABEL[u.role]}
          </Button>
        ))}
      </div>
      {err ? <p className="mt-2 text-small text-rust">{err}</p> : null}
    </div>
  );
}

export function RoleChooser() {
  const { demoUsers, switchUser, apiError } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section aria-labelledby="choose-role" className="mx-auto max-w-3xl px-4 py-10">
      <h1 id="choose-role" className="text-display font-bold tracking-tight">
        Choose a demo role
      </h1>
      <p className="mt-2 max-w-[62ch] text-lead text-graphite">
        This is a demo role switch, not authentication: anyone with access can act as any of these fictional users. Each role sees the same project
        with the permissions the backend enforces for that role.
      </p>
      {apiError ? (
        <Notice tone="error" className="mt-4" title="The API is not reachable">
          {apiError}. Start it with <code className="font-mono">cd workbench/api && .venv/bin/uvicorn dermpath.main:app --port 8000</code>.
        </Notice>
      ) : null}
      <ul className="mt-6 divide-y divide-line rounded-[var(--radius-panel)] border border-line bg-surface">
        {demoUsers.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
            <div className="min-w-[220px] flex-1">
              <p className="font-semibold text-ink">
                {u.display_name} <span className="font-normal text-graphite">· {ROLE_LABEL[u.role]}</span>
              </p>
              <p className="text-small text-graphite">{ROLE_JOB[u.role]}</p>
            </div>
            <Button
              variant="primary"
              size="sm"
              busy={busy === u.id}
              data-testid={`choose-${u.id}`}
              onClick={async () => {
                setBusy(u.id);
                setErr(null);
                try {
                  await switchUser(u.id);
                } catch (e) {
                  setErr(errorText(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Continue as {u.display_name.replace(/^Dr\. /, "Dr. ")}
            </Button>
          </li>
        ))}
      </ul>
      {err ? <p className="mt-3 text-small text-rust">{err}</p> : null}
    </section>
  );
}

/** Renders children only with a demo session, a project and (optionally) a permission. */
export function SessionGate({ permission, what, deniedMessage, children }: { permission?: string; what?: string; deniedMessage?: string; children: ReactNode }) {
  const { me, loading, projectId, can } = useSession();
  if (loading) return <Loading className="mx-auto max-w-3xl px-4" label="Loading the demo session" />;
  if (!me) return <RoleChooser />;
  if (!projectId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Notice tone="warning" title="No project">
          {me.user.display_name} is not a member of any project. Switch to another demo role.
        </Notice>
        <QuickSwitch roles={["histology_assistant", "pathologist", "research_lead", "medical_director"]} label="Switch role" />
      </div>
    );
  }
  if (permission && !can(permission)) {
    const roles = PERMISSION_ROLES[permission] ?? [];
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Notice tone="info" title={deniedMessage ?? `${ROLE_LABEL[me.user.role]} cannot ${what ?? "open this screen"}`}>
          {deniedMessage ? `You are acting as ${ROLE_LABEL[me.user.role]}. ` : `The backend allows this for: ${roles.map((r) => ROLE_LABEL[r as Role] ?? r).join(", ")}. `}
          The role is enforced by the API, not just hidden in the interface.
        </Notice>
        <QuickSwitch roles={roles} label="Switch demo role" />
      </div>
    );
  }
  return <>{children}</>;
}
