import type { DB } from "../db/db";
import { Rng, ins, addMinutes, pad } from "./util";
import { at, DEMO_DAY, PRIOR_DAY, OFFICES, ROUTING_V3, CLINICIANS_BY_OFFICE, TENANT, ensureStorageSlot, STAFF } from "./reference";
import {
  upsertPatient, createEncounter, createOrder, orderPayload, createIntake, createRoutingDecision, createAccession,
  createPart, createBlock, createSlide, createWorkOrder, createPrintedLabel, confirmedGrossFields, grossNarrative,
  createGrossRecord, seedAudit, blockIdentifier, slideIdentifier,
} from "./builders";
import { emptyGrossFields } from "@/lib/gross";
import type { GrossFields } from "@/lib/gross";

const STAFF_NAME: Record<string, string> = Object.fromEntries(STAFF.map((x) => [x.id, x.name]));

const GIVEN = [
  "Alma", "Bennett", "Carla", "Desmond", "Elise", "Felipe", "Gloria", "Harlan", "Ines", "Joel", "Kendra", "Lionel", "Mirela", "Nolan",
  "Odette", "Pablo", "Quincy", "Rosalind", "Silas", "Tamsin", "Ulric", "Vera", "Wendell", "Ximena", "Yusuf", "Zelda", "Amos", "Bianca",
  "Cyrus", "Delia", "Emmett", "Fiona", "Gideon", "Hazel", "Ivan", "Juniper", "Kofi", "Lorna", "Milo", "Nadine", "Otis", "Petra",
  "Rafael", "Sabine", "Tobias", "Una", "Victor", "Willa", "Yara", "Zane",
];
const FAMILY = [
  "Abernathy", "Brightwater", "Calloway", "Dunmore", "Everly", "Fairbanks", "Galloway", "Hollis", "Ingram", "Jessup", "Kingsley",
  "Langford", "Merriweather", "Northcott", "Oakhurst", "Pemberton", "Quayle", "Rothwell", "Stanhope", "Thackeray", "Underhill",
  "Vantreese", "Whitcombe", "Yardley", "Ashdown", "Bramwell", "Crestwood", "Delacroix", "Elsworth", "Foxley", "Greenhalgh", "Hartigan",
  "Ivers", "Jardine", "Kettering", "Lockridge", "Marchetti", "Nettleton", "Ormsby", "Prewitt",
];
const SITES: [string, string | null][] = [
  ["Left upper back", "left"], ["Right shoulder", "right"], ["Left dorsal forearm", "left"], ["Right temple", "right"], ["Nasal tip", "midline"],
  ["Left cheek", "left"], ["Scalp, vertex", "midline"], ["Right shin", "right"], ["Left calf", "left"], ["Central chest", "midline"],
  ["Right upper arm", "right"], ["Left helix of ear", "left"], ["Left lower abdomen", "left"], ["Right dorsal hand", "right"],
  ["Right anterior thigh", "right"], ["Mid back", "midline"], ["Posterior neck", "midline"], ["Left forehead", "left"], ["Right lower back", "right"],
  ["Left shoulder", "left"], ["Right cheek", "right"], ["Left upper arm", "left"],
];
const NAIL_SITES: [string, string][] = [["Left great toenail", "left"], ["Right great toenail", "right"], ["Right fifth toenail", "right"]];
const APPEARANCE = ["tan-pink", "tan-white", "tan-brown", "pink-tan", "white-tan"];

type Proc = "shave" | "punch" | "excision" | "nail_clipping";

interface GenPart {
  designation: string;
  site: string;
  laterality: string | null;
  procedure: Proc;
  collectedAt: string;
  pas: "order" | "protocol" | null;
}

let mrnCounter = 500000;
let nailCounter = 0;
let requestCounter = 0;
let orderCounter = 75000;
let encCounter = 54000;
const usedNames = new Set<string>();

function syntheticPatient(rng: Rng, tenant: string) {
  let given = rng.pick(GIVEN);
  let family = rng.pick(FAMILY);
  let guard = 0;
  while (usedNames.has(`${given} ${family}`) && guard++ < 50) {
    given = rng.pick(GIVEN);
    family = rng.pick(FAMILY);
  }
  usedNames.add(`${given} ${family}`);
  mrnCounter += rng.int(7, 97);
  const y = rng.int(1938, 1998);
  const dob = `${y}-${pad(rng.int(1, 12), 2)}-${pad(rng.int(1, 28), 2)}`;
  return { tenant, mrn: String(mrnCounter), given, family, dob, sex: rng.pick(["F", "M"]) };
}

function genParts(rng: Rng, collectedBase: string): GenPart[] {
  const count = rng.weighted<number>([[1, 58], [2, 30], [3, 12]]);
  const parts: GenPart[] = [];
  const letters = ["A", "B", "C"];
  for (let i = 0; i < count; i++) {
    const proc = rng.weighted<Proc>([["shave", 52], ["punch", 30], ["excision", 11], ["nail_clipping", 7]]);
    const [site, lat] = proc === "nail_clipping" ? rng.pick(NAIL_SITES) : rng.pick(SITES);
    parts.push({ designation: letters[i], site, laterality: lat, procedure: proc, collectedAt: addMinutes(collectedBase, i * 4), pas: proc === "nail_clipping" ? "order" : null });
  }
  return parts;
}

function blocksFor(rng: Rng, proc: Proc): number {
  if (proc === "excision") return rng.weighted<number>([[2, 55], [3, 35], [4, 10]]);
  if (proc === "punch") return rng.weighted<number>([[1, 75], [2, 25]]);
  return 1;
}

/** H&E levels per block (illustrative only — not a preparation protocol). */
function heLevelsFor(rng: Rng, proc: Proc): number {
  if (proc === "excision") return 2;
  if (proc === "nail_clipping") return 1;
  return rng.weighted<number>([[3, 50], [4, 50]]);
}

function grossFor(rng: Rng, p: GenPart, blocks: number, partLetter: string): GrossFields {
  const pieces = p.procedure === "nail_clipping" ? rng.int(2, 4) : p.procedure === "excision" ? 1 : rng.weighted<number>([[1, 85], [2, 15]]);
  const dims: [number, number, number | null] =
    p.procedure === "excision"
      ? [Number((rng.int(18, 40) / 10).toFixed(1)), Number((rng.int(8, 15) / 10).toFixed(1)), Number((rng.int(4, 9) / 10).toFixed(1))]
      : p.procedure === "punch"
        ? [Number((rng.int(3, 6) / 10).toFixed(1)), Number((rng.int(3, 6) / 10).toFixed(1)), Number((rng.int(3, 7) / 10).toFixed(1))]
        : p.procedure === "nail_clipping"
          ? [Number((rng.int(6, 14) / 10).toFixed(1)), Number((rng.int(2, 6) / 10).toFixed(1)), Number((rng.int(1, 2) / 10).toFixed(1))]
          : [Number((rng.int(4, 12) / 10).toFixed(1)), Number((rng.int(3, 10) / 10).toFixed(1)), Number((rng.int(1, 2) / 10).toFixed(1))];
  const ink = p.procedure === "nail_clipping" ? "Not inked" : p.procedure === "excision" ? "Suture marks 12 o'clock; margins inked (blue: 12-6 o'clock, black: 6-12 o'clock)" : "Deep/peripheral margin inked blue";
  const sectioning =
    p.procedure === "excision" ? "Serially sectioned; representative sections submitted" : p.procedure === "nail_clipping" ? "Submitted entirely after softening" : pieces === 1 ? rng.pick(["Trisected and submitted entirely", "Bisected and submitted entirely"]) : "Submitted entirely";
  const cassettes = Array.from({ length: blocks }, (_, i) => ({
    label: `${partLetter}${i + 1}`,
    pieces: p.procedure === "excision" ? null : i === 0 ? (sectioning.startsWith("Trisected") ? 3 : sectioning.startsWith("Bisected") ? 2 : pieces) : 0,
    description: p.procedure === "excision" ? (i === 0 ? "tips" : "central sections") : "entire specimen",
  }));
  return confirmedGrossFields(p.procedure, pieces, dims, "cm", rng.pick(APPEARANCE), ink, sectioning, cassettes as never);
}

export interface HistoryResult {
  slideCount: number;
  caseCount: number;
  marshQcSlides: string[];
  okaforSlides: string[];
  archive: Record<string, { accessionId: string; blocks: Record<string, string> }>;
  accessionCounter: number;
}

type YStage = "embedded" | "sectioned" | "stained" | "coverslipped" | "qc_reviewed" | "delivered";

/** Yesterday's accessions (in histology today) + this morning's accessions + archive. */
export function seedHistory(db: DB): HistoryResult {
  // Reset module counters so every seed in the same process is identical.
  mrnCounter = 500000;
  orderCounter = 75000;
  encCounter = 54000;
  nailCounter = 0;
  requestCounter = 0;
  usedNames.clear();
  const rng = new Rng(20261014);
  let slideCount = 0;
  const marshQcSlides: string[] = [];
  const okaforSlides: string[] = [];
  let accNo = 4740;

  const officesWeighted: [string, number][] = [["off_hpd", 22], ["off_pgs", 14], ["off_cld", 20], ["off_mbd", 14], ["off_ckd", 18], ["off_lsc", 12]];

  // Delivered trays this morning (history)
  ins(db, "tray", { id: "tray_m01", display_id: "TRY-M-01", pathologist_id: "stf_marsh", status: "delivered", opened_by: "stf_priya", opened_at: at("08:40"), closed_by: "stf_priya", closed_at: at("09:25"), close_note: "Verified complete", version: 3 });
  ins(db, "tray", { id: "tray_m02", display_id: "TRY-M-02", pathologist_id: "stf_marsh", status: "delivered", opened_by: "stf_priya", opened_at: at("09:35"), closed_by: "stf_priya", closed_at: at("10:20"), close_note: "Verified complete", version: 3 });
  ins(db, "tray", { id: "tray_f01", display_id: "TRY-F-01", pathologist_id: "stf_ferreira", status: "delivered", opened_by: "stf_marcus", opened_at: at("09:05"), closed_by: "stf_marcus", closed_at: at("09:50"), close_note: "Verified complete", version: 3 });
  let deliveredTraySeq = 0;

  // ---------------------------------------------------------------- Batch Y
  for (let n = 0; n < 44; n++) {
    accNo += 1;
    const number = `D26-0${accNo}`;
    const officeId = rng.weighted(officesWeighted);
    const office = OFFICES.find((o) => o.id === officeId)!;
    const tenant = office.tenant;
    const pathologist = ROUTING_V3[officeId];
    const clinician = rng.pick(CLINICIANS_BY_OFFICE[officeId]);
    const pat = syntheticPatient(rng, tenant);
    const issued = at(`${pad(8 + Math.floor(n / 6), 2)}:${pad((n * 7) % 60, 2)}`, PRIOR_DAY);
    const collected = addMinutes(issued, -rng.int(24 * 60, 30 * 60));
    const patientId = upsertPatient(db, pat, addMinutes(collected, 30));
    encCounter += rng.int(3, 40);
    const encSrc = `${tenant === TENANT.ema ? "ENC" : "VIS"}-${encCounter}`;
    const encId = createEncounter(db, { tenant, srcId: encSrc, patientId, officeId, clinicianId: clinician, at: addMinutes(collected, -15) });
    const parts = genParts(rng, collected);
    for (const p of parts) if (p.pas === "order" && ++nailCounter === 2) p.pas = "protocol";
    orderCounter += rng.int(2, 12);
    const srcOrderId = tenant === TENANT.ema ? `ORD-${orderCounter}` : `LSC-${5000 + n}`;
    const spec = {
      tenant, sourceId: tenant === TENANT.ema ? "src_ema" : "src_oth", srcOrderId, patientId, encounterId: encId, officeId, clinicianId: clinician,
      updatedAt: addMinutes(collected, 20), note: null,
      parts: parts.map((p) => ({ designation: p.designation, site: p.site, laterality: p.laterality, procedure: p.procedure, collectedAt: p.collectedAt, stains: p.pas === "order" ? ["PAS"] : [] })),
    };
    const { orderId, partIds } = createOrder(db, spec, orderPayload(spec, pat, encSrc, office.src, clinician));
    const intakeDisplay = `INT-1013-${pad(n + 1, 3)}`;
    const receivedAt = addMinutes(issued, -12);
    const { intakeId, containerIds } = createIntake(db, {
      display: intakeDisplay, deliveryId: null, officeId, receivedAt, receivedBy: rng.pick(["stf_maya", "stf_luis", "stf_kim"]), status: "accessioned",
      orderIds: [orderId],
      containers: parts.map((p, i) => ({
        orderPartId: partIds[i],
        observed: { patient_name: `${pat.family}, ${pat.given}`, birth_date: pat.dob, part_designation: p.designation, site_text: p.site, procedure: p.procedure },
        verified: { by: "stf_maya", at: addMinutes(receivedAt, 3) },
      })),
    });
    const rd = createRoutingDecision(db, { intakeId, officeId, pathologistId: pathologist, status: "confirmed", by: "stf_maya", at: addMinutes(receivedAt, 4), explanation: `From rule: ${office.name} → ${STAFF_NAME[pathologist]} (rule set v3, effective Sep 1)` });
    const accId = createAccession(db, { number, issuedAt: issued, patientId, officeId, clinicianId: clinician, pathologistId: pathologist, routingDecisionId: rd, day: PRIOR_DAY, priority: rng.chance(0.08) ? "rush" : "routine" });
    db.prepare("UPDATE intake_item SET accession_id = ? WHERE id = ?").run(accId, intakeId);
    seedAudit(db, { at: issued, actor: "system", role: "supervisor", origin: "simulator", action: "accession.issued", entityType: "accession", entityId: accId, accessionId: accId, intakeItemId: intakeId, summary: `Accession ${number} issued by authoritative source simulator` });

    // Stage depends on pathologist (tells a coherent story on the worklist).
    const stage: YStage =
      pathologist === "stf_marsh"
        ? rng.weighted<YStage>([["qc_reviewed", 45], ["coverslipped", 20], ["delivered", 25], ["stained", 10]])
        : pathologist === "stf_okafor"
          ? rng.weighted<YStage>([["stained", 35], ["sectioned", 35], ["coverslipped", 15], ["embedded", 15]])
          : rng.weighted<YStage>([["embedded", 40], ["sectioned", 35], ["stained", 15], ["delivered", 10]]);

    const grossTime = addMinutes(issued, rng.int(90, 300));
    const lateEntry = n % 9 === 4; // a few still waiting for source-system entry from yesterday's batch
    parts.forEach((p, i) => {
      const partId = createPart(db, {
        accessionId: accId, accessionNumber: number, designation: p.designation, orderId, orderPartId: partIds[i], originalDesignation: p.designation,
        site: p.site, laterality: p.laterality, procedure: p.procedure, containerId: containerIds[i], physical: "grossed",
      });
      const nBlocks = blocksFor(rng, p.procedure);
      const fields = grossFor(rng, p, nBlocks, p.designation);
      createGrossRecord(db, {
        partId, state: "approved_for_downstream", sourceState: lateEntry ? "pending_entry" : "entered_attested", fields,
        narrative: grossNarrative(p.designation, p.site, p.procedure, fields), grosser: "stf_dana", createdAt: grossTime,
        reviewedAt: addMinutes(grossTime, 6), approvedAt: addMinutes(grossTime, 8),
        sourceEntryAt: lateEntry ? null : at(`${rng.int(18, 20)}:${pad(rng.int(0, 59), 2)}`, PRIOR_DAY), sourceEntryBy: lateEntry ? null : "stf_sam",
      });
      const blockState = stage === "embedded" ? "embedded" : "sectioned";
      const slideState: string = stage === "embedded" ? "planned" : stage === "delivered" ? "delivered" : stage;
      let pasWo: string | null = null;
      if (p.pas === "order") {
        pasWo = createWorkOrder(db, { accessionId: accId, kind: "stain", stain: "PAS", auth: "source_order", reference: `${srcOrderId} v1 · part ${p.designation} (PAS requested on order)`, requestedByLabel: "Ordering clinician (on order)", orderId, orderVersion: 1, partId, status: stage === "embedded" ? "requested" : stage === "sectioned" ? "in_progress" : "completed", at: issued });
      } else if (p.pas === "protocol") {
        pasWo = createWorkOrder(db, { accessionId: accId, kind: "stain", stain: "PAS", auth: "standing_protocol", reference: "SP-NAIL-PAS-01 — synthetic illustrative standing order (PAS on nail specimens); confirm real local protocol", requestedByLabel: "Standing order (synthetic)", partId, status: stage === "embedded" ? "requested" : stage === "sectioned" ? "in_progress" : "completed", at: issued });
      }
      for (let b = 1; b <= nBlocks; b++) {
        const blockId = createBlock(db, { accessionId: accId, accessionNumber: number, partId, part: p.designation, seq: b, state: blockState, pieces: fields.cassettes.value?.[b - 1]?.pieces ?? null, locationId: stage === "embedded" ? "loc_bench_embed" : "loc_bench_micro1", locationAt: at("08:15"), locationBy: "stf_marcus" });
        createPrintedLabel(db, { targetType: "block", targetId: blockId, accessionId: accId, payload: blockIdentifier(number, p.designation, b), printer: "prn_c1", kind: "cassette_label", by: "stf_dana", at: grossTime, labelState: "verified" });
        const levels = heLevelsFor(rng, p.procedure);
        let seq = 0;
        const addSlide = (stain: string, level: string | null, wo: string | null) => {
          seq += 1;
          const labelState = slideState === "planned" ? (rng.chance(0.5) ? "printed" : "none") : "verified";
          const sid = createSlide(db, { accessionId: accId, accessionNumber: number, blockId, part: p.designation, block: b, seq, stain, level, workOrderId: wo, state: slideState, labelState });
          if (labelState !== "none") {
            createPrintedLabel(db, { targetType: "slide", targetId: sid, accessionId: accId, payload: slideIdentifier(number, p.designation, b, seq, stain), printer: "prn_s1", kind: "slide_label", by: rng.pick(["stf_priya", "stf_marcus"]), at: at("07:50"), labelState: labelState === "printed" ? "printed" : "verified" });
          }
          slideCount += 1;
          if (pathologist === "stf_marsh" && slideState === "qc_reviewed") marshQcSlides.push(sid);
          if (pathologist === "stf_okafor" && (slideState === "stained" || slideState === "coverslipped")) okaforSlides.push(sid);
          return sid;
        };
        for (let l = 1; l <= levels; l++) addSlide("H&E", levels > 1 ? `L${l}` : null, null);
        if (pasWo && b === 1) addSlide("PAS", null, pasWo);
      }
      // Pathologist-requested PAS / deeper levels on some delivered or QC'd cases
      if ((stage === "delivered" || stage === "qc_reviewed") && p.procedure !== "nail_clipping" && rng.chance(0.18)) {
        const blockId = `${partId}_b1`;
        const kind = requestCounter++ % 2 === 0 ? "pas" : "levels";
        const wo = createWorkOrder(db, {
          accessionId: accId, kind: kind === "pas" ? "stain" : "levels", stain: kind === "pas" ? "PAS" : "H&E",
          auth: "pathologist_request", reference: `${pathologist === "stf_marsh" ? "Dr. Marsh" : pathologist === "stf_okafor" ? "Dr. Okafor" : "Dr. Ferreira"} request after H&E review (${p.designation}1)`,
          requestedByLabel: pathologist === "stf_marsh" ? "Dr. Elena Marsh" : pathologist === "stf_okafor" ? "Dr. Samuel Okafor" : "Dr. Nadia Ferreira",
          requestedByStaff: pathologist, partId, blockId, quantity: kind === "pas" ? 1 : 2, status: "requested", at: at("09:" + pad(rng.int(10, 55), 2)),
        });
        // Planned (not yet cut) slides for the request
        const nextSeq = (db.prepare("SELECT COALESCE(MAX(slide_seq),0) m FROM slide WHERE block_id = ?").get(blockId) as { m: number }).m;
        const count = kind === "pas" ? 1 : 2;
        for (let k = 1; k <= count; k++) {
          createSlide(db, { accessionId: accId, accessionNumber: number, blockId, part: p.designation, block: 1, seq: nextSeq + k, stain: kind === "pas" ? "PAS" : "H&E", level: kind === "pas" ? null : `deeper L${k}`, workOrderId: wo, state: "planned", labelState: "none" });
          slideCount += 1;
        }
        db.prepare("UPDATE accession SET case_status = 'open' WHERE id = ?").run(accId);
      }
    });
    if (stage === "delivered") {
      deliveredTraySeq += 1;
      db.prepare("UPDATE accession SET case_status = 'delivered' WHERE id = ?").run(accId);
      const trayId = pathologist === "stf_marsh" ? (deliveredTraySeq % 2 ? "tray_m01" : "tray_m02") : "tray_f01";
      const slides = db.prepare("SELECT id FROM slide WHERE accession_id = ? AND physical_state = 'delivered'").all(accId) as { id: string }[];
      slides.forEach((s, i) => {
        ins(db, "tray_expected_slide", { tray_id: trayId, slide_id: s.id, seq: deliveredTraySeq * 20 + i, disposition: null, disposition_by: null, disposition_at: null, disposition_note: null });
        ins(db, "tray_scan", { id: `ts_${s.id}`, tray_id: trayId, scanned_payload: (db.prepare("SELECT identifier FROM slide WHERE id = ?").get(s.id) as { identifier: string }).identifier, slide_id: s.id, result: "verified_expected", scanned_by: "stf_priya", scanned_at: at("09:10"), resolution: null, resolved_by: null, resolved_at: null });
      });
    }
    seedAudit(db, { at: addMinutes(grossTime, 8), actor: "stf_dana", role: "grosser", action: "gross.approved", entityType: "accession", entityId: accId, accessionId: accId, summary: `Gross records approved for downstream use (${parts.map((p) => p.designation).join(", ")})` });
  }

  // ---------------------------------------------------------------- Batch T (this morning)
  // 07:40 and 09:15 couriers; accessioned this morning; grossing in progress.
  ins(db, "courier_delivery", { id: "cr_0740", display_id: "CR-1014-07", courier_name: "Coastline Courier (fictional)", route_label: "North route", expected_at: at("07:30"), arrived_at: at("07:40"), received_by: "stf_luis", status: "reconciled", version: 3 });
  ins(db, "courier_delivery", { id: "cr_0915", display_id: "CR-1014-09", courier_name: "Coastline Courier (fictional)", route_label: "South route", expected_at: at("09:00"), arrived_at: at("09:15"), received_by: "stf_maya", status: "reconciled", version: 3 });
  accNo = 4790;
  const tCases: { accId: string; number: string; pathologist: string; parts: string[] }[] = [];
  for (let n = 0; n < 23; n++) {
    const display = `INT-1014-${pad(n + 1, 3)}`;
    const deliveryId = n < 13 ? "cr_0740" : "cr_0915";
    const officeId = rng.weighted(officesWeighted);
    const office = OFFICES.find((o) => o.id === officeId)!;
    const tenant = office.tenant;
    const pathologist = ROUTING_V3[officeId];
    const clinician = rng.pick(CLINICIANS_BY_OFFICE[officeId]);
    const pat = syntheticPatient(rng, tenant);
    const receivedAt = deliveryId === "cr_0740" ? at(`07:${pad(45 + Math.min(n, 12), 2)}`) : at(`09:${pad(20 + (n - 13) * 3, 2)}`);
    const collected = addMinutes(receivedAt, -rng.int(20 * 60, 26 * 60));
    const patientId = upsertPatient(db, pat, addMinutes(collected, 30));
    encCounter += rng.int(3, 40);
    const encSrc = `${tenant === TENANT.ema ? "ENC" : "VIS"}-${encCounter}`;
    const encId = createEncounter(db, { tenant, srcId: encSrc, patientId, officeId, clinicianId: clinician, at: addMinutes(collected, -15) });
    const parts = genParts(rng, collected);
    orderCounter += rng.int(2, 12);
    const srcOrderId = tenant === TENANT.ema ? `ORD-${orderCounter}` : `LSC-${5100 + n}`;
    const spec = {
      tenant, sourceId: tenant === TENANT.ema ? "src_ema" : "src_oth", srcOrderId, patientId, encounterId: encId, officeId, clinicianId: clinician,
      updatedAt: addMinutes(collected, 20), note: null,
      parts: parts.map((p) => ({ designation: p.designation, site: p.site, laterality: p.laterality, procedure: p.procedure, collectedAt: p.collectedAt, stains: p.pas === "order" ? ["PAS"] : [] })),
    };
    const { orderId, partIds } = createOrder(db, spec, orderPayload(spec, pat, encSrc, office.src, clinician));
    const pendingIdentity = n === 21; // INT-1014-022 stays in review (identity conflict)
    const accessioner = deliveryId === "cr_0740" ? "stf_luis" : "stf_maya";
    const { intakeId, containerIds } = createIntake(db, {
      display, deliveryId, officeId, receivedAt, receivedBy: accessioner, status: pendingIdentity ? "in_review" : "accessioned", orderIds: [orderId],
      owner: pendingIdentity ? "stf_kim" : accessioner,
      containers: parts.map((p, i) => ({
        orderPartId: partIds[i],
        observed: {
          patient_name: `${pat.family}, ${pat.given}`,
          birth_date: pat.dob,
          part_designation: p.designation, site_text: p.site, procedure: p.procedure,
        },
        verified: pendingIdentity ? null : { by: accessioner, at: addMinutes(receivedAt, 2) },
      })),
    });
    if (pendingIdentity) {
      // Force a visible DOB transposition on the bottle for the identity-conflict example.
      const [y, mo, d] = pat.dob.split("-");
      const swapped = Number(d) <= 12 && d !== mo ? `${y}-${d}-${mo}` : `${y}-${mo}-${pad(Math.min(28, Number(d) + 1), 2)}`;
      db.prepare("UPDATE container SET observed_label = json_set(observed_label, '$.birth_date', ?), verification_state = 'discrepancy' WHERE intake_item_id = ?").run(swapped, intakeId);
      createRoutingDecision(db, { intakeId, officeId, pathologistId: pathologist, status: "suggested", by: null, at: addMinutes(receivedAt, 1), explanation: `From rule: ${office.name} → ${STAFF_NAME[pathologist]} (rule set v3, effective Sep 1)` });
      db.prepare("INSERT INTO app_setting(key,value,updated_at) VALUES ('seed_identity_intake', ?, ?)").run(intakeId, receivedAt);
      continue;
    }
    accNo += 1;
    const number = `D26-0${accNo}`;
    const rd = createRoutingDecision(db, { intakeId, officeId, pathologistId: pathologist, status: "confirmed", by: accessioner, at: addMinutes(receivedAt, 3), explanation: `From rule: ${office.name} → ${STAFF_NAME[pathologist]} (rule set v3, effective Sep 1)` });
    const issued = addMinutes(receivedAt, rng.int(8, 30));
    const accId = createAccession(db, { number, issuedAt: issued, patientId, officeId, clinicianId: clinician, pathologistId: pathologist, routingDecisionId: rd, day: DEMO_DAY });
    db.prepare("UPDATE intake_item SET accession_id = ? WHERE id = ?").run(accId, intakeId);
    seedAudit(db, { at: issued, actor: "system", role: "supervisor", origin: "simulator", action: "accession.issued", entityType: "accession", entityId: accId, accessionId: accId, intakeItemId: intakeId, summary: `Accession ${number} issued by authoritative source simulator` });
    const partRowIds: string[] = [];
    parts.forEach((p, i) => {
      const partId = createPart(db, {
        accessionId: accId, accessionNumber: number, designation: p.designation, orderId, orderPartId: partIds[i], originalDesignation: p.designation,
        site: p.site, laterality: p.laterality, procedure: p.procedure, containerId: containerIds[i], physical: "received",
      });
      partRowIds.push(partId);
      if (p.pas === "order") {
        createWorkOrder(db, { accessionId: accId, kind: "stain", stain: "PAS", auth: "source_order", reference: `${srcOrderId} v1 · part ${p.designation} (PAS requested on order)`, requestedByLabel: "Ordering clinician (on order)", orderId, orderVersion: 1, partId, status: "requested", at: issued });
      }
    });
    tCases.push({ accId, number, pathologist, parts: partRowIds });
  }

  // Grossing progress this morning across batch T parts (Dana started ~08:30).
  const tParts = tCases.flatMap((c) => c.parts.map((p) => ({ ...c, partId: p })));
  const grossPlan: ("approved_entered" | "approved_pending" | "reviewed" | "draft_clean" | "draft_ambiguous" | "none")[] = [];
  tParts.forEach((_, i) => {
    grossPlan.push(i < 4 ? "approved_entered" : i < 10 ? "approved_pending" : i < 13 ? "reviewed" : i === 13 ? "draft_ambiguous" : i === 14 ? "draft_clean" : "none");
  });
  tParts.forEach((tp, i) => {
    const plan = grossPlan[i];
    if (plan === "none") return;
    const part = db.prepare("SELECT * FROM specimen_part WHERE id = ?").get(tp.partId) as { designation: string; site_text: string; procedure: Proc };
    const gp: GenPart = { designation: part.designation, site: part.site_text, laterality: null, procedure: part.procedure, collectedAt: "", pas: null };
    const nBlocks = blocksFor(rng, part.procedure);
    const fields = grossFor(rng, gp, nBlocks, part.designation);
    const t0 = at(`${pad(8 + Math.floor((30 + i * 9) / 60), 2)}:${pad((30 + i * 9) % 60, 2)}`);
    db.prepare("UPDATE specimen_part SET physical_state = 'grossed' WHERE id = ?").run(tp.partId);
    for (let b = 1; b <= nBlocks; b++) {
      const blockId = createBlock(db, { accessionId: tp.accId, accessionNumber: tp.number, partId: tp.partId, part: part.designation, seq: b, state: "cassette_loaded", pieces: fields.cassettes.value?.[b - 1]?.pieces ?? null, locationId: "loc_proc_p1", locationAt: t0, locationBy: "stf_dana" });
      createPrintedLabel(db, { targetType: "block", targetId: blockId, accessionId: tp.accId, payload: blockIdentifier(tp.number, part.designation, b), printer: "prn_c1", kind: "cassette_label", by: "stf_dana", at: t0, labelState: "verified" });
    }
    const narrative = grossNarrative(part.designation, part.site_text, part.procedure, fields);
    if (plan === "approved_entered" || plan === "approved_pending") {
      createGrossRecord(db, {
        partId: tp.partId, state: "approved_for_downstream", sourceState: plan === "approved_entered" ? "entered_attested" : "pending_entry", fields, narrative,
        grosser: "stf_dana", createdAt: t0, reviewedAt: addMinutes(t0, 5), approvedAt: addMinutes(t0, 6),
        sourceEntryAt: plan === "approved_entered" ? addMinutes(t0, 40) : null, sourceEntryBy: plan === "approved_entered" ? "stf_sam" : null,
      });
      if (plan === "approved_pending") {
        ins(db, "task", { id: `task_se_${tp.partId}`, kind: "source_entry", entity_type: "specimen_part", entity_id: tp.partId, title: `Enter approved gross description in source system — ${tp.number} part ${part.designation}`, owner_id: "stf_sam", owner_role: "histology_assistant", status: "open", priority: "routine", due_at: null, created_at: addMinutes(t0, 6), completed_at: null, completed_by: null, accession_id: tp.accId, intake_item_id: null, detail: null, version: 1 });
      }
    } else if (plan === "reviewed") {
      createGrossRecord(db, { partId: tp.partId, state: "operator_reviewed", sourceState: "not_started", fields, narrative, grosser: "stf_dana", createdAt: t0, reviewedAt: addMinutes(t0, 5) });
    } else {
      const f = plan === "draft_ambiguous" ? { ...fields } : fields;
      if (plan === "draft_ambiguous") {
        f.dimensions = { value: { length: 0.6, width: 4, depth: null, unit: null, raw: "point six by four" }, status: "needs_review", note: "Unit not stated and the second dimension may be a missed decimal (4 vs 0.4)" };
        f.piece_count = { value: null, status: "missing", note: "Dictation says \"a couple of fragments\" — count not stated" };
      }
      createGrossRecord(db, { partId: tp.partId, state: "draft", sourceState: "not_started", fields: f, narrative: plan === "draft_ambiguous" ? `Part ${part.designation}: received in formalin, a couple of tan fragments, point six by four, submitted entirely.` : narrative, grosser: "stf_dana", createdAt: t0, extractor: plan === "draft_ambiguous" ? "deterministic-demo-extractor v1" : null });
    }
  });

  // ---------------------------------------------------------------- Archive (stored blocks for retrieval)
  const archive: HistoryResult["archive"] = {};
  const archiveSpecs: { number: string; day: string; office: string; parts: number; loc: [number, number, number, number][]; custody?: ("stored" | "checked_out" | "sent_out")[] }[] = [
    { number: "D26-03895", day: "2026-09-22", office: "off_hpd", parts: 1, loc: [[2, 1, 3, 2]] },
    { number: "D26-03901", day: "2026-09-22", office: "off_ckd", parts: 1, loc: [[2, 1, 3, 5]] },
    { number: "D26-03909", day: "2026-09-23", office: "off_mbd", parts: 1, loc: [[2, 1, 3, 9]] },
    { number: "D26-03912", day: "2026-09-23", office: "off_cld", parts: 1, loc: [[2, 1, 3, 12]], custody: ["checked_out"] },
    { number: "D26-03930", day: "2026-09-24", office: "off_pgs", parts: 2, loc: [[2, 2, 6, 1], [2, 2, 6, 2]] },
    { number: "D26-03944", day: "2026-09-25", office: "off_lsc", parts: 1, loc: [[2, 2, 7, 4]] },
    { number: "D26-03958", day: "2026-09-28", office: "off_hpd", parts: 1, loc: [[2, 3, 8, 7]] },
    { number: "D26-03966", day: "2026-09-29", office: "off_cld", parts: 1, loc: [[2, 3, 9, 3]] },
    { number: "D26-03971", day: "2026-09-29", office: "off_mbd", parts: 2, loc: [[2, 4, 10, 1], [2, 4, 10, 2]] },
    { number: "D26-03983", day: "2026-09-30", office: "off_ckd", parts: 1, loc: [[2, 4, 11, 6]] },
    { number: "D26-03990", day: "2026-09-30", office: "off_cld", parts: 2, loc: [[2, 4, 11, 14], [2, 4, 11, 15]] },
    { number: "D26-03991", day: "2026-09-30", office: "off_mbd", parts: 1, loc: [[2, 4, 11, 16]], custody: ["sent_out"] },
    { number: "D26-03995", day: "2026-10-01", office: "off_hpd", parts: 1, loc: [[2, 4, 12, 3]] },
  ];
  for (const a of archiveSpecs) {
    const office = OFFICES.find((o) => o.id === a.office)!;
    const pat = syntheticPatient(rng, office.tenant);
    const patientId = upsertPatient(db, pat, at("09:00", a.day));
    const clinician = CLINICIANS_BY_OFFICE[a.office][0];
    encCounter += 5;
    const encSrc = `${office.tenant === TENANT.ema ? "ENC" : "VIS"}-${encCounter}`;
    const encId = createEncounter(db, { tenant: office.tenant, srcId: encSrc, patientId, officeId: a.office, clinicianId: clinician, at: at("08:00", a.day) });
    orderCounter += 3;
    const srcOrderId = office.tenant === TENANT.ema ? `ORD-${orderCounter}` : `LSC-${4800 + orderCounter % 100}`;
    const letters = ["A", "B"].slice(0, a.parts);
    const spec = {
      tenant: office.tenant, sourceId: office.tenant === TENANT.ema ? "src_ema" : "src_oth", srcOrderId, patientId, encounterId: encId, officeId: a.office, clinicianId: clinician,
      updatedAt: at("08:20", a.day), note: null,
      parts: letters.map((d) => { const [site, lat] = rng.pick(SITES); return { designation: d, site, laterality: lat, procedure: "shave" as const, collectedAt: at("08:10", a.day) }; }),
    };
    const { orderId, partIds } = createOrder(db, spec, orderPayload(spec, pat, encSrc, office.src, clinician));
    const pathologist = ROUTING_V3[a.office];
    const accId = createAccession(db, { number: a.number, issuedAt: at("10:00", a.day), patientId, officeId: a.office, clinicianId: clinician, pathologistId: pathologist, routingDecisionId: null, day: a.day, prior: true, status: "delivered" });
    archive[a.number] = { accessionId: accId, blocks: {} };
    letters.forEach((d, i) => {
      const partId = createPart(db, { accessionId: accId, accessionNumber: a.number, designation: d, orderId, orderPartId: partIds[i], originalDesignation: d, site: spec.parts[i].site, laterality: spec.parts[i].laterality, procedure: "shave", containerId: null, physical: "grossed" });
      const [cab, dr, bx, sl] = a.loc[i];
      const locId = ensureStorageSlot(db, cab, dr, bx, sl);
      const custody = a.custody?.[i] ?? "stored";
      const blockId = createBlock(db, {
        accessionId: accId, accessionNumber: a.number, partId, part: d, seq: 1, state: "stored", pieces: 1,
        locationId: custody === "sent_out" ? "loc_outside" : locId, locationAt: custody === "stored" ? at("15:20", "2026-10-09") : at("11:00", "2026-10-10"), locationBy: "stf_marcus",
        custody, holder: custody === "checked_out" ? "stf_marcus" : null,
      });
      archive[a.number].blocks[d + "1"] = blockId;
      for (let s = 1; s <= 3; s++) {
        createSlide(db, { accessionId: accId, accessionNumber: a.number, blockId, part: d, block: 1, seq: s, stain: "H&E", level: `L${s}`, state: "delivered", labelState: "verified" });
        slideCount += 1;
      }
      // Custody history
      ins(db, "custody_event", { id: `ce_${blockId}_1`, material_type: "block", material_id: blockId, event: "stored", location_id: locId, holder_id: null, destination: null, actor_id: "stf_marcus", at: at("16:30", nextDay(a.day, 3)), note: "Filed after sign-out", request_id: null });
      if (a.number === "D26-03990" && d === "A") {
        ins(db, "custody_event", { id: `ce_${blockId}_2`, material_type: "block", material_id: blockId, event: "checked_out", location_id: locId, holder_id: "stf_priya", destination: "Microtomy bench 1 (deeper levels)", actor_id: "stf_priya", at: at("10:05", "2026-10-08"), note: "RR-0178", request_id: null });
        ins(db, "custody_event", { id: `ce_${blockId}_3`, material_type: "block", material_id: blockId, event: "returned", location_id: locId, holder_id: null, destination: null, actor_id: "stf_marcus", at: at("15:20", "2026-10-09"), note: "Returned and slot scanned", request_id: null });
      }
      if (custody === "checked_out") {
        ins(db, "custody_event", { id: `ce_${blockId}_co`, material_type: "block", material_id: blockId, event: "checked_out", location_id: locId, holder_id: "stf_marcus", destination: "Microtomy bench 2 (recut)", actor_id: "stf_marcus", at: at("11:00", "2026-10-10"), note: "Return expected same day — overdue", request_id: null });
      }
      if (custody === "sent_out") {
        ins(db, "custody_event", { id: `ce_${blockId}_so`, material_type: "block", material_id: blockId, event: "sent_out", location_id: "loc_outside", holder_id: null, destination: "Outside consultation — Northgate Reference Lab (fictional)", actor_id: "stf_tanya", at: at("11:00", "2026-10-10"), note: "Expected return by 2026-10-24", request_id: null });
      }
    });
  }

  // Jordan Pike's earlier encounter (Oct 7) — accessioned Oct 8, still a separate case.
  // (Created in scenario.ts with today's order; nothing here.)

  return { slideCount, caseCount: 44 + 22, marshQcSlides, okaforSlides, archive, accessionCounter: accNo };
}

function nextDay(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Illustrative prior-day operational events for example queue charts. */
export function seedPriorDayEvents(db: DB): void {
  const rng = new Rng(777);
  const days = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"];
  const offices = ["off_hpd", "off_pgs", "off_cld", "off_mbd", "off_ckd", "off_lsc"];
  const stmt = db.prepare("INSERT INTO ops_event (day, case_ref, pathologist_id, office_id, event, at, illustrative) VALUES (?, ?, ?, ?, ?, ?, 1)");
  days.forEach((day, di) => {
    const n = rng.int(52, 71);
    for (let i = 0; i < n; i++) {
      const office = rng.pick(offices);
      const path = ROUTING_V3[office];
      const ref = `ILL-${day.slice(5).replace("-", "")}-${pad(i + 1, 3)}`;
      const courier = rng.weighted<string>([["07:40", 35], ["11:00", 45], ["14:30", 20]]);
      const received = addMinutes(at(courier, day), rng.int(0, 25));
      stmt.run(day, ref, path, office, "received", received);
      const accessioned = addMinutes(received, rng.int(6, 70));
      stmt.run(day, ref, path, office, "accessioned", accessioned);
      if (rng.chance(0.12)) {
        const sent = addMinutes(received, rng.int(5, 40));
        stmt.run(day, ref, path, office, "clarification_sent", sent);
        if (rng.chance(0.85)) {
          const answered = addMinutes(sent, rng.weighted<number>([[rng.int(15, 90), 50], [rng.int(90, 300), 35], [rng.int(300, 1400), 15]]));
          stmt.run(day, ref, path, office, "clarification_answered", answered);
          stmt.run(day, ref, path, office, "clarification_resolved", addMinutes(answered, rng.int(5, 60)));
        }
      }
      const grossDone = addMinutes(accessioned, rng.int(60, 360));
      stmt.run(day, ref, path, office, "gross_completed", grossDone);
      stmt.run(day, ref, path, office, "gross_approved", addMinutes(grossDone, rng.int(2, 25)));
      // Observation being illustrated: source-system entry happens as an evening batch.
      const entry = at(`${rng.weighted<number>([[18, 20], [19, 40], [20, 35], [21, 5]])}:${pad(rng.int(0, 59), 2)}`, day);
      if (Date.parse(entry) > Date.parse(grossDone)) stmt.run(day, ref, path, office, "source_entered", entry);
      else stmt.run(day, ref, path, office, "source_entered", addMinutes(grossDone, rng.int(30, 120)));
      if (di < days.length - 1) stmt.run(day, ref, path, office, "tray_delivered", at(`${pad(rng.int(9, 15), 2)}:${pad(rng.int(0, 59), 2)}`, days[di + 1]));
    }
  });
}
