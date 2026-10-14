import { ROLE_LABEL, ROLES, type Role } from "@/lib/roles";
import { cn } from "@/lib/cn";

/**
 * Role-qualified person name (spec §10 "Name the role every time"):
 * "Ordering clinician: Dr. Hannah Cole (Harbor Point Dermatology)".
 * Never "doctor" alone, never "user" or "assignee".
 */
export type PersonRole =
  | "ordering_clinician"
  | "assigned_dermatopathologist"
  | "accessioner"
  | "owner"
  | "office_contact"
  | "reviewer"
  | "requester"
  | Role;

export const PERSON_ROLE_LABEL: Record<string, string> = {
  ordering_clinician: "Ordering clinician",
  assigned_dermatopathologist: "Assigned dermatopathologist",
  accessioner: "Accessioner",
  owner: "Owner",
  office_contact: "Office contact role",
  reviewer: "Reviewer",
  requester: "Requested by",
};

export function personRoleLabel(role: PersonRole): string {
  if (role in PERSON_ROLE_LABEL) return PERSON_ROLE_LABEL[role];
  return (ROLES as readonly string[]).includes(role) ? ROLE_LABEL[role as Role] : role;
}

export function PersonName({
  role,
  name,
  org,
  className,
  inline,
}: {
  role: PersonRole;
  /** Null renders "Unknown" (never blank). */
  name: string | null | undefined;
  /** Office or organization, shown in parentheses. */
  org?: string | null;
  className?: string;
  /** Name only with the role as a muted prefix on one line (default true). */
  inline?: boolean;
}) {
  const label = personRoleLabel(role);
  if (inline === false) {
    return (
      <span className={cn("inline-flex flex-col", className)}>
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="text-ink">
          {name ?? "Unknown"}
          {org ? <span className="text-ink-secondary"> ({org})</span> : null}
        </span>
      </span>
    );
  }
  return (
    <span className={cn("text-ink", className)}>
      <span className="text-ink-muted">{label}: </span>
      {name ?? "Unknown"}
      {org ? <span className="text-ink-secondary"> ({org})</span> : null}
    </span>
  );
}
