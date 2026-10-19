import type { Role } from "@/lib/roles";

/** Landing page by role (spec §5.1). Frontline views open on pending work and exceptions. */
export function landingPathFor(role: Role): string {
  switch (role) {
    case "accessioner":
    case "accessioning_lead":
      return "/intake";
    case "grosser":
      return "/grossing";
    case "histology_assistant":
      return "/worklist?view=grossing";
    case "histotech":
      return "/worklist?view=histotech";
    // No bench screen (src/lib/roles.ts): their one screen is the audit report, never the 403 page.
    case "lab_admin":
    case "auditor":
      return "/audit";
    default:
      return "/operations";
  }
}
