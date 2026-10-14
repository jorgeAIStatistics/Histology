/**
 * Demo roles and the permission matrix. Enforcement happens on the server in
 * the command layer; the UI only uses this to explain why a control is
 * disabled. The demo role selector is NOT production authentication.
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
] as const;
export type Role = (typeof ROLES)[number];

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
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;


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
};

export function roleCan(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function rolesFor(permission: Permission): readonly Role[] {
  return PERMISSIONS[permission];
}
