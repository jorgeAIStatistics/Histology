"use client";

import { useId } from "react";
import { useSession } from "@/lib/session";
import { cn } from "@/components/ui/cn";

export function ProjectSwitcher({ compact = false }: { compact?: boolean }) {
  const { me, projectId, setProjectId } = useSession();
  const id = useId();
  if (!me || me.memberships.length === 0) return null;
  return (
    <div className={cn("flex items-center gap-2", compact ? "" : "w-full")}>
      <label htmlFor={id} className="text-micro font-semibold text-graphite">
        Project
      </label>
      <select
        id={id}
        data-testid="project-switcher"
        value={projectId ?? ""}
        onChange={(e) => setProjectId(e.target.value)}
        className={cn(
          "h-10 rounded-[var(--radius-control)] border border-line-strong bg-sheet pl-2 pr-7 text-small font-semibold text-ink hover:border-teal",
          compact ? "max-w-[210px]" : "w-full",
        )}
      >
        {me.memberships.map((m) => (
          <option key={m.project_id} value={m.project_id}>
            {m.project_name}
          </option>
        ))}
      </select>
    </div>
  );
}
