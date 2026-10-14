import type { DB } from "../db/db";
import { ins } from "./util";
import { labLocalToIso } from "@/lib/time";

/**
 * Fictional reference data. No real organizations, people, contact details,
 * credentials or identifiers.
 */
export const DEMO_DAY = "2026-10-14";
export const PRIOR_DAY = "2026-10-13";
export const at = (hhmm: string, day = DEMO_DAY) => labLocalToIso(day, hhmm);

export const TENANT = { ema: "ten_ema", other: "ten_oth" } as const;

export const OFFICES = [
  { id: "off_hpd", code: "HPD", name: "Harbor Point Dermatology", tenant: TENANT.ema, src: "LOC-104", practice: "prc_sunrise", status: "active" },
  { id: "off_pgs", code: "PGS", name: "Palm Grove Skin Clinic", tenant: TENANT.ema, src: "LOC-117", practice: "prc_sunrise", status: "active" },
  { id: "off_cld", code: "CLD", name: "Coral Lane Dermatology", tenant: TENANT.ema, src: "LOC-122", practice: "prc_sunrise", status: "active" },
  { id: "off_mbd", code: "MBD", name: "Mangrove Bay Dermatology", tenant: TENANT.ema, src: "LOC-131", practice: "prc_sunrise", status: "active" },
  { id: "off_ckd", code: "CKD", name: "Cypress Key Dermatology", tenant: TENANT.ema, src: "LOC-140", practice: "prc_sunrise", status: "active" },
  { id: "off_lsc", code: "LSC", name: "Lighthouse Skin Center", tenant: TENANT.other, src: "SITE-7", practice: "prc_lighthouse", status: "active" },
  { id: "off_sss", code: "SSS", name: "Seagrape Skin Studio", tenant: TENANT.ema, src: "LOC-152", practice: "prc_seagrape", status: "new_unreviewed" },
] as const;

export const STAFF = [
  { id: "stf_maya", name: "Maya Torres", short: "Maya T.", role: "accessioner", initials: "MT" },
  { id: "stf_luis", name: "Luis Benitez", short: "Luis B.", role: "accessioner", initials: "LB" },
  { id: "stf_kim", name: "Kim Nguyen", short: "Kim N.", role: "accessioning_lead", initials: "KN" },
  { id: "stf_dana", name: "Dana Whitfield", short: "Dana W.", role: "grosser", initials: "DW" },
  { id: "stf_sam", name: "Sam Ortiz", short: "Sam O.", role: "histology_assistant", initials: "SR" },
  { id: "stf_priya", name: "Priya Shah", short: "Priya S.", role: "histotech", initials: "PS" },
  { id: "stf_marcus", name: "Marcus Lee", short: "Marcus L.", role: "histotech", initials: "ML" },
  { id: "stf_tanya", name: "Tanya Brooks", short: "Tanya B.", role: "supervisor", initials: "TB" },
  { id: "stf_marsh", name: "Dr. Elena Marsh", short: "Dr. Marsh", role: "pathologist", initials: "EM", color: "teal" },
  { id: "stf_okafor", name: "Dr. Samuel Okafor", short: "Dr. Okafor", role: "pathologist", initials: "SO", color: "violet" },
  { id: "stf_ferreira", name: "Dr. Nadia Ferreira", short: "Dr. Ferreira", role: "pathologist", initials: "NF", color: "amber" },
  { id: "stf_director", name: "Director of Operations (demo)", short: "Director", role: "director", initials: "DO" },
  { id: "stf_md", name: "Medical Director (demo)", short: "Med. director", role: "medical_director", initials: "MD" },
] as const;

export const ROUTING_V3: Record<string, string> = {
  off_hpd: "stf_marsh",
  off_pgs: "stf_marsh",
  off_cld: "stf_okafor",
  off_mbd: "stf_okafor",
  off_ckd: "stf_ferreira",
  off_lsc: "stf_ferreira",
};
const ROUTING_V2: Record<string, string> = {
  off_hpd: "stf_marsh",
  off_pgs: "stf_marsh",
  off_cld: "stf_okafor",
  off_mbd: "stf_okafor",
  off_ckd: "stf_okafor",
  off_lsc: "stf_ferreira",
};

export const CLINICIANS = [
  { id: "cln_cole", office: "off_hpd", tenant: TENANT.ema, src: "PRV-2201", name: "Dr. Hannah Cole", cred: "MD" },
  { id: "cln_reed", office: "off_hpd", tenant: TENANT.ema, src: "PRV-2207", name: "Jamal Reed", cred: "PA-C" },
  { id: "cln_huang", office: "off_pgs", tenant: TENANT.ema, src: "PRV-2310", name: "Dr. Victor Huang", cred: "MD" },
  { id: "cln_lin", office: "off_cld", tenant: TENANT.ema, src: "PRV-2415", name: "Dr. Grace Lin", cred: "DO" },
  { id: "cln_shaw", office: "off_cld", tenant: TENANT.ema, src: "PRV-2419", name: "Erin Shaw", cred: "NP" },
  { id: "cln_reyes", office: "off_mbd", tenant: TENANT.ema, src: "PRV-2522", name: "Omar Reyes", cred: "PA-C" },
  { id: "cln_sol", office: "off_ckd", tenant: TENANT.ema, src: "PRV-2630", name: "Dr. Ingrid Sol", cred: "MD" },
  { id: "cln_arnold", office: "off_lsc", tenant: TENANT.other, src: "PROV-88", name: "Beth Arnold", cred: "NP" },
  { id: "cln_moon", office: "off_sss", tenant: TENANT.ema, src: "PRV-2744", name: "Dr. Felix Moon", cred: "MD" },
] as const;

export const CLINICIANS_BY_OFFICE: Record<string, string[]> = CLINICIANS.reduce(
  (acc, c) => {
    (acc[c.office] ??= []).push(c.id);
    return acc;
  },
  {} as Record<string, string[]>,
);

const WEEKDAY_HOURS = JSON.stringify({
  mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]], thu: [["08:00", "17:00"]], fri: [["08:00", "16:00"]],
});

export function seedReference(db: DB): void {
  ins(db, "source_tenant", { id: TENANT.ema, code: "EMA-SIM", name: "EMA-SIM Sunrise Coast", system_kind: "EMA (simulated)", is_simulated: 1 });
  ins(db, "source_tenant", { id: TENANT.other, code: "OTHER-EHR-SIM", name: "OTHER-EHR-SIM Gulf", system_kind: "Other EHR (simulated)", is_simulated: 1 });

  ins(db, "practice", { id: "prc_sunrise", name: "Sunrise Coast Dermatology Partners (fictional)", tenant_id: TENANT.ema });
  ins(db, "practice", { id: "prc_lighthouse", name: "Lighthouse Skin Center (fictional)", tenant_id: TENANT.other });
  ins(db, "practice", { id: "prc_seagrape", name: "Seagrape Skin Studio (fictional)", tenant_id: TENANT.ema });

  for (const o of OFFICES) {
    ins(db, "office", {
      id: o.id, practice_id: o.practice, tenant_id: o.tenant, source_office_id: o.src, code: o.code, name: o.name,
      working_hours: o.code === "LSC" ? JSON.stringify({ mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "13:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] }) : WEEKDAY_HOURS,
      timezone: "America/New_York", status: o.status,
    });
  }

  for (const s of STAFF) {
    ins(db, "staff", {
      id: s.id, display_name: s.name, short_name: s.short, role: s.role, initials: s.initials,
      color_token: "color" in s ? s.color : null, active: 1,
    });
  }

  // Office contact / coverage directory (fictional people; simulated channels).
  const contacts: [string, string, string, string, number, number, string | null][] = [
    // id, office, name, role, primary, escalation, out_until
    ["oc_hpd_1", "off_hpd", "Rita Gomez", "Biopsy coordinator (MA lead)", 1, 0, null],
    ["oc_hpd_2", "off_hpd", "Owen Hart", "Clinic manager", 0, 1, null],
    ["oc_pgs_1", "off_pgs", "Lena Price", "Biopsy coordinator (MA lead)", 1, 0, null],
    ["oc_pgs_2", "off_pgs", "Marco Ruiz", "Practice administrator", 0, 1, null],
    ["oc_cld_1", "off_cld", "Tess Monroe", "Biopsy coordinator (MA lead)", 1, 0, at("17:00")],
    ["oc_cld_3", "off_cld", "Jade Kim", "Medical assistant (coverage)", 0, 0, null],
    ["oc_cld_2", "off_cld", "Paul Vance", "Clinic manager", 0, 1, null],
    ["oc_mbd_1", "off_mbd", "Ana Silva", "Front desk / pathology liaison", 1, 0, null],
    ["oc_mbd_2", "off_mbd", "Grant Ellis", "Clinic manager", 0, 1, null],
    ["oc_ckd_1", "off_ckd", "Ivy Chen", "Biopsy coordinator (MA lead)", 1, 0, null],
    ["oc_ckd_2", "off_ckd", "Ray Dunn", "Clinic manager", 0, 1, null],
    ["oc_lsc_1", "off_lsc", "Nora Webb", "Lab liaison", 1, 0, null],
    ["oc_lsc_2", "off_lsc", "Sean Park", "Office manager", 0, 1, null],
    ["oc_sss_1", "off_sss", "(not yet on file)", "Unverified contact — new office", 1, 0, null],
  ];
  for (const [id, office, name, role, primary, esc, out] of contacts) {
    ins(db, "office_contact", {
      id, office_id: office, display_name: name, contact_role: role,
      channel: office === "off_lsc" ? "simulated_portal" : office === "off_sss" ? "simulated_phone" : "simulated_ema_message",
      is_primary: primary, is_escalation: esc, covers_categories: "[]", out_until: out, backup_contact_id: null,
    });
  }
  db.prepare("UPDATE office_contact SET backup_contact_id = 'oc_cld_3' WHERE id = 'oc_cld_1'").run();

  for (const c of CLINICIANS) {
    ins(db, "clinician", { id: c.id, tenant_id: c.tenant, source_provider_id: c.src, display_name: c.name, credential: c.cred, office_id: c.office });
  }

  // Versioned routing rules.
  ins(db, "routing_rule_set", {
    id: "rrs_v2", version: 2, status: "draft", effective_from: at("00:00", "2026-03-01"), effective_to: at("23:59", "2026-08-31"),
    approved_by: "stf_md", approved_at: at("09:00", "2026-02-20"), notes: "Cypress Key routed to Dr. Okafor (superseded).",
  });
  ins(db, "routing_rule_set", {
    id: "rrs_v3", version: 3, status: "draft", effective_from: at("00:00", "2026-09-01"), effective_to: null,
    approved_by: "stf_md", approved_at: at("10:00", "2026-08-25"), notes: "Cypress Key moved to Dr. Ferreira. Seagrape Skin Studio not yet reviewed.",
  });
  for (const [office, path] of Object.entries(ROUTING_V2)) ins(db, "routing_rule", { id: `rr_v2_${office}`, rule_set_id: "rrs_v2", office_id: office, pathologist_id: path });
  for (const [office, path] of Object.entries(ROUTING_V3)) ins(db, "routing_rule", { id: `rr_v3_${office}`, rule_set_id: "rrs_v3", office_id: office, pathologist_id: path });
  // Rules are written while the sets are drafts, then the sets are approved/retired (which freezes them).
  db.prepare("UPDATE routing_rule_set SET status = 'retired' WHERE id = 'rrs_v2'").run();
  db.prepare("UPDATE routing_rule_set SET status = 'approved' WHERE id = 'rrs_v3'").run();
  ins(db, "coverage_exception", {
    id: "cov_okafor_1016", pathologist_id: "stf_okafor", covering_pathologist_id: "stf_marsh",
    starts_at: at("00:00", "2026-10-16"), ends_at: at("23:59", "2026-10-17"), reason: "Planned leave (synthetic)", status: "approved", approved_by: "stf_md",
  });

  // Simulated printers.
  ins(db, "printer", { id: "prn_s1", name: "Slide printer 1 (simulated)", kind: "slide", location: "Microtomy bench", status: "online", reports_completion: 0, is_simulated: 1 });
  ins(db, "printer", { id: "prn_c1", name: "Cassette printer (simulated)", kind: "cassette", location: "Grossing station", status: "online", reports_completion: 1, is_simulated: 1 });
  ins(db, "printer", { id: "prn_l1", name: "Requisition sticker printer (simulated)", kind: "label", location: "Accessioning bench", status: "online", reports_completion: 0, is_simulated: 1 });

  // Simulated integration sources with capability discovery results.
  const cap = (o: Record<string, string>) => JSON.stringify(o);
  ins(db, "integration_source", {
    id: "src_ema", name: "EMA-SIM Sunrise Coast (simulated source adapter)", adapter: "simulated_ema", tenant_id: TENANT.ema, rollout_mode: "A_local_demo", status: "connected",
    last_success_at: null, last_attempt_at: null, last_error: null,
    capabilities: cap({
      "orders.read": "simulated", "orders.changes": "simulated (poll)", "accession.issue": "simulated — real path unknown",
      "gross_text.write": "not available — manual entry in source system", "notifications.send": "not available", "printer.control": "not available",
    }),
  });
  ins(db, "integration_source", {
    id: "src_oth", name: "OTHER-EHR-SIM Gulf (simulated source adapter)", adapter: "simulated_other_ehr", tenant_id: TENANT.other, rollout_mode: "A_local_demo", status: "connected",
    last_success_at: null, last_attempt_at: null, last_error: null,
    capabilities: cap({ "orders.read": "simulated", "orders.changes": "simulated (poll)", "accession.issue": "not applicable" }),
  });
  ins(db, "integration_source", {
    id: "src_print", name: "Label printers (simulated driver)", adapter: "simulated_printer", tenant_id: null, rollout_mode: "A_local_demo", status: "connected",
    last_success_at: null, last_attempt_at: null, last_error: null,
    capabilities: cap({ "job.submit": "simulated", "job.acknowledge": "simulated", "job.completion": "only cassette printer reports completion (simulated)" }),
  });
  ins(db, "integration_source", {
    id: "src_notify", name: "Office notifications (simulated)", adapter: "simulated_notifications", tenant_id: null, rollout_mode: "A_local_demo", status: "connected",
    last_success_at: null, last_attempt_at: null, last_error: null,
    capabilities: cap({ "message.send": "simulated — never contacts a real office", "delivery.receipt": "simulated, sometimes unknown" }),
  });
  ins(db, "integration_source", {
    id: "src_assist", name: "Drafting/extraction assistant (deterministic demo)", adapter: "deterministic_assistant", tenant_id: null, rollout_mode: "A_local_demo", status: "connected",
    last_success_at: null, last_attempt_at: null, last_error: null,
    capabilities: cap({ "extract.gross_fields": "deterministic rules", "draft.clarification": "template", "summarize.case": "computed from events" }),
  });
}

/** Storage addresses are created on demand: cabinet → drawer → box → slot. */
export function ensureStorageSlot(db: DB, cab: number, drawer: number, box: number, slot: number): string {
  const codes = [
    { code: `CAB-${cab}`, kind: "cabinet", label: `Cabinet ${cab}` },
    { code: `CAB-${cab}/DR-${drawer}`, kind: "drawer", label: `Drawer ${drawer}` },
    { code: `CAB-${cab}/DR-${drawer}/BX-${String(box).padStart(2, "0")}`, kind: "box", label: `Box ${String(box).padStart(2, "0")}` },
    { code: `CAB-${cab}/DR-${drawer}/BX-${String(box).padStart(2, "0")}/S-${String(slot).padStart(2, "0")}`, kind: "slot", label: `Slot ${String(slot).padStart(2, "0")}` },
  ];
  let parent: string | null = null;
  let id = "";
  for (const c of codes) {
    const existing = db.prepare("SELECT id FROM storage_location WHERE code = ?").get(c.code) as { id: string } | undefined;
    if (existing) {
      id = existing.id;
    } else {
      id = "loc_" + c.code.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      ins(db, "storage_location", { id, code: c.code, kind: c.kind, parent_id: parent, label: c.label, sort_key: c.code });
    }
    parent = id;
  }
  return id;
}

export function seedFixedLocations(db: DB): void {
  const fixed = [
    { id: "loc_bench_micro1", code: "BENCH/MICROTOMY-1", kind: "bench", label: "Microtomy bench 1" },
    { id: "loc_bench_micro2", code: "BENCH/MICROTOMY-2", kind: "bench", label: "Microtomy bench 2" },
    { id: "loc_bench_embed", code: "BENCH/EMBEDDING", kind: "bench", label: "Embedding center" },
    { id: "loc_proc_p1", code: "PROCESSOR/P1", kind: "bench", label: "Tissue processor P1" },
    { id: "loc_outside", code: "OUTSIDE", kind: "outside", label: "Outside the lab (send-out)" },
  ];
  for (const f of fixed) ins(db, "storage_location", { ...f, parent_id: null, sort_key: "ZZ-" + f.code });
}
