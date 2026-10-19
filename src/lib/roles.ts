/**
 * Roles and the permission matrix. Enforcement happens on the server: every
 * command in executeCommand (src/server/commands/registry.ts) and every page
 * and read API through the one guard (src/server/auth/guard.ts, `view.*`).
 * The UI only uses this to explain why a control is disabled. The demo role
 * selector is NOT production authentication.
 *
 * Stage 6 Phase B added:
 * - roles `lab_admin` (staff, identity links, role assignment through the
 *   audited admin CLI, audit verification) and `auditor` (audit report only).
 *   Neither has any clinical permission or any bench view.
 * - permission `identity.resolve`: identity and source-conflict decisions
 *   (accessioning lead and supervisor only; never an administrator).
 * - view permissions `view.*`. Every role that existed before keeps every
 *   bench view it had (all of them), so the synthetic demo is unchanged.
 */
export const ROLES = [
  "accessioner",
  "accessioning_lead",
  "grosser",
  "histology_assistant",
  "histotech",
  "supervisor",
  "pathologist",
  "director",
  "medical_director",
  "lab_admin",
  "auditor",
] as const;
export type Role = (typeof ROLES)[number];

/** Every role that existed before Stage 6 (the synthetic demo staff): they keep every bench view. */
const BENCH_ROLES = [
  "accessioner",
  "accessioning_lead",
  "grosser",
  "histology_assistant",
  "histotech",
  "supervisor",
  "pathologist",
  "director",
  "medical_director",
] as const satisfies readonly Role[];

export const ROLE_LABEL: Record<Role, string> = {
  accessioner: "Accessioner",
  accessioning_lead: "Accessioning lead",
  grosser: "Grosser",
  histology_assistant: "Histology assistant",
  histotech: "Histotechnologist",
  supervisor: "Operations supervisor",
  pathologist: "Dermatopathologist",
  director: "Director of Operations (read-only demo)",
  medical_director: "Medical director (demo)",
  lab_admin: "Laboratory administrator",
  auditor: "Auditor",
};

export const PERMISSIONS = {
  // Intake & routing
  "intake.receive": ["accessioner", "accessioning_lead", "supervisor"],
  "intake.edit": ["accessioner", "accessioning_lead", "supervisor"],
  "intake.verifyContainer": ["accessioner", "accessioning_lead", "supervisor"],
  "routing.confirm": ["accessioner", "accessioning_lead", "supervisor"],
  "routing.override": ["accessioning_lead", "supervisor"],
  "routing.resolveException": ["accessioning_lead", "supervisor"],
  "related.review": ["accessioning_lead", "supervisor"],
  "accession.request": ["accessioner", "accessioning_lead", "supervisor"],
  "correction.open": ["accessioner", "accessioning_lead", "supervisor", "grosser", "histology_assistant", "histotech"],
  "correction.close": ["accessioning_lead", "supervisor"],
  // Clarifications & holds
  "clarification.create": ["accessioner", "accessioning_lead", "supervisor", "grosser", "histology_assistant", "histotech"],
  "clarification.send": ["accessioner", "accessioning_lead", "supervisor", "grosser", "histology_assistant", "histotech"],
  "clarification.record": ["accessioner", "accessioning_lead", "supervisor", "grosser", "histology_assistant", "histotech"],
  "clarification.review": ["accessioning_lead", "supervisor"],
  "clarification.resolve": ["accessioning_lead", "supervisor"],
  "hold.place": ["accessioner", "accessioning_lead", "supervisor", "grosser", "histology_assistant", "histotech"],
  "hold.release": ["accessioning_lead", "supervisor"],
  // Grossing
  "gross.edit": ["grosser", "histology_assistant", "supervisor"],
  "gross.review": ["grosser", "histology_assistant", "supervisor"],
  "gross.approve": ["grosser", "supervisor", "pathologist"],
  "gross.recordSourceEntry": ["histology_assistant", "supervisor"],
  "gross.confirmCassettes": ["grosser", "supervisor"],
  // Materials
  "material.advance": ["histotech", "histology_assistant", "supervisor"],
  "print.request": ["accessioner", "accessioning_lead", "histotech", "histology_assistant", "grosser", "supervisor"],
  "print.reconcile": ["histotech", "histology_assistant", "supervisor"],
  "label.apply": ["accessioner", "accessioning_lead", "histotech", "histology_assistant", "grosser", "supervisor"],
  "label.retire": ["histotech", "supervisor"],
  "tray.assemble": ["histotech", "histology_assistant", "supervisor"],
  "tray.releaseWithExceptions": ["supervisor"],
  "retrieval.request": ["histotech", "histology_assistant", "supervisor", "pathologist"],
  "retrieval.pick": ["histotech", "histology_assistant", "supervisor"],
  "workorder.review": ["histotech", "supervisor", "pathologist"],
  // Worklist
  "worklist.ack": ["accessioner", "accessioning_lead", "grosser", "histology_assistant", "histotech", "supervisor", "pathologist", "director", "medical_director"],
  "worklist.snapshot": ["accessioner", "accessioning_lead", "grosser", "histology_assistant", "histotech", "supervisor", "pathologist", "director", "medical_director"],
  // Configuration
  "routing.editRules": ["supervisor"],
  "routing.approveRules": ["medical_director", "supervisor"],
  "integration.manage": ["supervisor"],
  // Identity and source-conflict decisions (sourceConflict.review; resolving an identity clarification).
  "identity.resolve": ["accessioning_lead", "supervisor"],
  // Views: pages and read APIs (checked by src/server/auth/guard.ts).
  "view.intake": BENCH_ROLES,
  "view.clarifications": BENCH_ROLES,
  "view.grossing": BENCH_ROLES,
  "view.worklist": BENCH_ROLES,
  "view.materials": BENCH_ROLES,
  "view.operations": BENCH_ROLES,
  "view.cases": BENCH_ROLES,
  "view.insights": BENCH_ROLES,
  "view.settings": BENCH_ROLES,
  "view.audit": ["lab_admin", "auditor"],
  "view.admin": ["lab_admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** The view permissions (one per screen family). */
export const VIEW_PERMISSIONS = [
  "view.intake",
  "view.clarifications",
  "view.grossing",
  "view.worklist",
  "view.materials",
  "view.operations",
  "view.cases",
  "view.insights",
  "view.settings",
  "view.audit",
  "view.admin",
] as const satisfies readonly Permission[];
export type ViewPermission = (typeof VIEW_PERMISSIONS)[number];

/** Bench (clinical) views: never granted to lab_admin or auditor. */
export const BENCH_VIEWS = [
  "view.intake",
  "view.clarifications",
  "view.grossing",
  "view.worklist",
  "view.materials",
  "view.operations",
  "view.cases",
  "view.insights",
  "view.settings",
] as const satisfies readonly ViewPermission[];

export function isViewPermission(p: string): p is ViewPermission {
  return (VIEW_PERMISSIONS as readonly string[]).includes(p);
}


/** Plain-language names for permissions, used in "not allowed" messages. */
export const PERMISSION_LABEL: Record<Permission, string> = {
  "intake.receive": "receive deliveries and intake items",
  "intake.edit": "edit intake items",
  "intake.verifyContainer": "verify containers against the physical bottle",
  "routing.confirm": "accept a routing suggestion",
  "routing.override": "override routing",
  "routing.resolveException": "assign a dermatopathologist for a routing exception",
  "related.review": "decide on related orders",
  "accession.request": "request an accession",
  "correction.open": "open a correction review",
  "correction.close": "close a correction review",
  "clarification.create": "raise clarifications",
  "clarification.send": "send clarifications",
  "clarification.record": "record clarification outcomes and answers",
  "clarification.review": "review office answers",
  "clarification.resolve": "resolve clarifications",
  "hold.place": "place holds",
  "hold.release": "release holds",
  "gross.edit": "edit gross records",
  "gross.review": "mark gross records reviewed",
  "gross.approve": "approve gross records for downstream use",
  "gross.recordSourceEntry": "attest source-system entry of gross descriptions",
  "gross.confirmCassettes": "confirm cassette allocation",
  "material.advance": "record bench progress on blocks and slides",
  "print.request": "request label printing",
  "print.reconcile": "reconcile print outcomes",
  "label.apply": "record label application",
  "label.retire": "retire labels",
  "tray.assemble": "assemble trays",
  "tray.releaseWithExceptions": "release a tray with documented exceptions",
  "retrieval.request": "request block retrieval",
  "retrieval.pick": "pick and scan blocks for retrieval",
  "workorder.review": "review work orders changed at the source",
  "worklist.ack": "acknowledge worklist changes",
  "worklist.snapshot": "print or export worklist snapshots",
  "routing.editRules": "draft routing rule versions",
  "routing.approveRules": "approve routing rule versions",
  "integration.manage": "manage simulated integrations",
  "identity.resolve": "decide patient identity and source-conflict questions",
  "view.intake": "view the intake bench",
  "view.clarifications": "view clarifications",
  "view.grossing": "view grossing",
  "view.worklist": "view the worklist",
  "view.materials": "view materials",
  "view.operations": "view operations",
  "view.cases": "view cases",
  "view.insights": "view insights",
  "view.settings": "view settings",
  "view.audit": "view the audit report",
  "view.admin": "view laboratory administration",
};

export function roleCan(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** Whether the role may open at least one bench screen (the laboratory administrator and the auditor may not). */
export function hasBenchView(role: Role): boolean {
  return BENCH_VIEWS.some((v) => roleCan(role, v));
}

export function rolesFor(permission: Permission): readonly Role[] {
  return PERMISSIONS[permission];
}
