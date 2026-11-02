/**
 * Patient identifiers in audit payloads and summary screens (Stage 6 Phase C4).
 * Read docs/release/privacy-review.md before relying on any of this.
 *
 * Rule: the audit trail (audit_event.summary, before_json, after_json) does not
 * duplicate a patient's name, date of birth or MRN. The records themselves
 * (patient_ref, container labels, clarifications, tasks) keep the values, and
 * the screens that need them for positive identification read them there.
 * Audit payloads keep FIELD NAMES, RECORD IDS and FINGERPRINTS instead:
 *
 *   fingerprint = HMAC-SHA256(K, scope + "\n" + normalized value), 16 hex
 *   K           = HMAC-SHA256(audit key, "hlos-audit-fingerprint/v1")
 *
 * - The scope (for example "patient_ref:<id>" or "container:<id>:birth_date")
 *   salts the HMAC, so equal values on two records do not give equal
 *   fingerprints, and fingerprints cannot be joined across records.
 * - Two fingerprints of the same scope are equal exactly when the normalized
 *   values were equal (up to a 64-bit collision): "unchanged" stays provable.
 * - LIMITATION: a fingerprint is not encryption. Anyone holding the audit key
 *   (HLOS_AUDIT_KEY; in the demo the public demo key) can test guesses: a date
 *   of birth has only ~40,000 plausible values. It keeps identifiers out of
 *   the audit trail for people who read it without the key (auditors, exports,
 *   backups of the trail); it does not protect them from the key holder.
 * - Without any audit key (a locked build with no HLOS_AUDIT_KEY) the value is
 *   withheld with no fingerprint.
 *
 * Free text typed by people (reasons, notes, questions, answers, descriptions)
 * is the person's own words. The audit copies of clarification questions,
 * notices and answers, hold reasons and task titles are passed through
 * redactIdentifiers(), which replaces the linked patient's known identifiers;
 * that is best effort (a misspelled name or another date format is not found).
 * audit_event.reason is stored as typed (out of scope; documented).
 */
import { createHmac } from "node:crypto";
import type { DB } from "../db/db";
import { activeAuditKey } from "../core/audit-seal";

const FP_LABEL = "hlos-audit-fingerprint/v1";

/** Key -> derived fingerprint key (the derivation is cheap, but the audit key is read from the environment on every call). */
let derived: { source: Buffer; key: Buffer } | null = null;

function fingerprintKey(): Buffer | null {
  const k = activeAuditKey();
  if (!k) return null;
  if (!derived || !derived.source.equals(k.key)) derived = { source: k.key, key: createHmac("sha256", k.key).update(FP_LABEL).digest() };
  return derived.key;
}

/** Case, width and spacing do not change a fingerprint ("BARNES,  Theo" = "barnes, theo"). */
export function normalizeForFingerprint(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

/**
 * 16 hex characters, or null for an empty value, or "" when no audit key is
 * configured (the value is then withheld without a fingerprint).
 */
export function fingerprint(scope: string, value: unknown): string | null {
  if (isBlank(value)) return null;
  const key = fingerprintKey();
  if (!key) return "";
  return createHmac("sha256", key).update(`${scope}\n${normalizeForFingerprint(String(value))}`).digest("hex").slice(0, 16);
}

/** Prefix of every withheld value in an audit payload. */
export const WITHHELD = "withheld";

/** The audit form of an identifier value: "withheld (fingerprint 0123456789abcdef)", or null when there was no value. */
export function withheld(scope: string, value: unknown): string | null {
  const fp = fingerprint(scope, value);
  if (fp === null) return null;
  return fp ? `${WITHHELD} (fingerprint ${fp})` : WITHHELD;
}

/** Observation keys and comparison fields that carry a patient identifier. */
export const IDENTITY_KEYS: readonly string[] = ["patient_name", "birth_date", "mrn"];

/**
 * Whether an observation key, comparison field or evidence label names a patient identifier
 * ("patient_name", "Date of birth", "MRN", "Patient name", "Medical record number"...).
 */
export function isIdentityField(field: string | null | undefined): boolean {
  if (!field) return false;
  if (IDENTITY_KEYS.includes(field)) return true;
  return /patient|\bname\b|birth|\bdob\b|\bmrn\b|medical record|identifier/i.test(field.replace(/_/g, " "));
}

// ------------------------------------------------------------------ patient references and their details

interface PatientRow {
  id: string;
  tenant_id: string;
  source_mrn: string;
  family_name: string;
  given_name: string;
  birth_date: string;
}

function patientRow(db: DB, id: string): PatientRow | undefined {
  return db.prepare("SELECT id, tenant_id, source_mrn, family_name, given_name, birth_date FROM patient_ref WHERE id = ?").get(id) as PatientRow | undefined;
}

function detailsFingerprint(p: PatientRow): string | null {
  return fingerprint(`patient_ref:${p.id}`, JSON.stringify([p.tenant_id, p.source_mrn, p.family_name, p.given_name, p.birth_date].map((v) => normalizeForFingerprint(v ?? ""))));
}

/** A patient reference as the audit trail records it: its id and a fingerprint of its details (tenant, MRN, name, birth date). */
export interface AuditedPatientRef {
  id: string;
  fingerprint: string | null;
}

export function auditedPatientRef(db: DB, patientRefId: string | null | undefined): AuditedPatientRef | null {
  if (!patientRefId) return null;
  const p = patientRow(db, patientRefId);
  return p ? { id: p.id, fingerprint: detailsFingerprint(p) } : { id: patientRefId, fingerprint: null };
}

/** Patient references reachable from a record: the reference itself, a source order, an accession, an intake item, a clarification. */
export function patientRefIdsFor(
  db: DB,
  refs: { patientRefId?: string | null; sourceOrderId?: string | null; accessionId?: string | null; intakeItemId?: string | null; clarificationId?: string | null },
): string[] {
  const ids = new Set<string>();
  const add = (v: { p: string | null } | undefined) => {
    if (v?.p) ids.add(v.p);
  };
  if (refs.patientRefId) ids.add(refs.patientRefId);
  if (refs.sourceOrderId) add(db.prepare("SELECT patient_ref_id p FROM source_order WHERE id = ?").get(refs.sourceOrderId) as { p: string | null } | undefined);
  if (refs.accessionId) add(db.prepare("SELECT patient_ref_id p FROM accession WHERE id = ?").get(refs.accessionId) as { p: string | null } | undefined);
  if (refs.intakeItemId) {
    for (const r of db
      .prepare("SELECT so.patient_ref_id p FROM intake_order_link l JOIN source_order so ON so.id = l.source_order_id WHERE l.intake_item_id = ?")
      .all(refs.intakeItemId) as { p: string | null }[]) add(r);
  }
  if (refs.clarificationId) {
    const c = db.prepare("SELECT source_order_id, accession_id, intake_item_id FROM clarification WHERE id = ?").get(refs.clarificationId) as
      | { source_order_id: string | null; accession_id: string | null; intake_item_id: string | null }
      | undefined;
    if (c) for (const id of patientRefIdsFor(db, { sourceOrderId: c.source_order_id, accessionId: c.accession_id, intakeItemId: c.intake_item_id })) ids.add(id);
  }
  return [...ids];
}

// ------------------------------------------------------------------ redaction of free text

export interface KnownIdentifiers {
  names: string[];
  dates: string[];
  mrns: string[];
}

const NAME_TOKEN = "[patient name]";
const DATE_TOKEN = "[date of birth]";
const MRN_TOKEN = "[MRN]";

function dateVariants(raw: string): string[] {
  const s = raw.trim();
  const out = new Set<string>([s]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    out.add(`${Number(m)}/${Number(d)}/${y}`);
    out.add(`${m}/${d}/${y}`);
    out.add(`${m}-${d}-${y}`);
    out.add(`${Number(m)}/${Number(d)}/${y.slice(2)}`);
    out.add(`${m}/${d}/${y.slice(2)}`);
  }
  return [...out].filter((v) => v.length >= 6);
}

function nameVariants(family: string, given: string): string[] {
  const f = family.trim();
  const g = given.trim();
  const out: string[] = [];
  if (f && g) out.push(`${f}, ${g}`, `${f},${g}`, `${g} ${f}`);
  if (f.length >= 2) out.push(f);
  if (g.length >= 3) out.push(g);
  return out;
}

function addPatientValues(acc: { names: Set<string>; dates: Set<string>; mrns: Set<string> }, v: { name?: unknown; family?: unknown; given?: unknown; birth_date?: unknown; mrn?: unknown }, singleTokens: boolean): void {
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const full = str(v.name);
  const family = str(v.family);
  const given = str(v.given);
  if (family || given) for (const n of nameVariants(family, given)) if (singleTokens || n.includes(" ") || n.includes(",")) acc.names.add(n);
  if (full) {
    acc.names.add(full);
    if (full.includes(",")) {
      const [f, g] = full.split(",").map((x) => x.trim());
      if (f && g) acc.names.add(`${g} ${f}`);
    }
    if (singleTokens) for (const t of full.split(/[\s,.]+/)) if (t.length >= 3) acc.names.add(t);
  }
  const dob = str(v.birth_date);
  if (dob) for (const d of dateVariants(dob)) acc.dates.add(d);
  const mrn = str(v.mrn);
  if (mrn.length >= 4) acc.mrns.add(mrn);
}

/** Patient details as each imported version of the patient's orders gave them (a conflicting order can name the patient differently). */
function orderPayloadPatients(db: DB, patientRefIds: readonly string[] | null): { name?: unknown; birth_date?: unknown; mrn?: unknown }[] {
  const rows = (
    patientRefIds === null
      ? db.prepare("SELECT v.payload FROM source_order_version v").all()
      : patientRefIds.length
        ? db
            .prepare(`SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.patient_ref_id IN (${patientRefIds.map(() => "?").join(",")})`)
            .all(...patientRefIds)
        : []
  ) as { payload: string | null }[];
  const out: { name?: unknown; birth_date?: unknown; mrn?: unknown }[] = [];
  for (const r of rows) {
    try {
      const p = r.payload ? (JSON.parse(r.payload) as { patient?: { name?: unknown; birth_date?: unknown; mrn?: unknown } }) : null;
      if (p?.patient && typeof p.patient === "object") out.push(p.patient);
    } catch {
      /* an unreadable payload names nobody */
    }
  }
  return out;
}

/**
 * The identifiers to look for: the linked patients' names, birth dates and MRNs, what each imported
 * version of their orders said about them (a conflicting order may name the patient differently), and
 * what the bottles of the given intake items say (an observed label may too).
 */
export function knownIdentifiers(db: DB, patientRefIds: readonly string[], opts: { intakeItemIds?: readonly string[] } = {}): KnownIdentifiers {
  const acc = { names: new Set<string>(), dates: new Set<string>(), mrns: new Set<string>() };
  for (const id of patientRefIds) {
    const p = patientRow(db, id);
    if (p) addPatientValues(acc, { family: p.family_name, given: p.given_name, birth_date: p.birth_date, mrn: p.source_mrn }, true);
  }
  for (const v of orderPayloadPatients(db, patientRefIds)) addPatientValues(acc, v, true);
  for (const itemId of opts.intakeItemIds ?? []) {
    for (const c of db.prepare("SELECT observed_label FROM container WHERE intake_item_id = ?").all(itemId) as { observed_label: string | null }[]) {
      let label: { patient_name?: string | null; birth_date?: string | null; mrn?: string | null } = {};
      try {
        label = c.observed_label ? JSON.parse(c.observed_label) : {};
      } catch {
        label = {};
      }
      addPatientValues(acc, { name: label.patient_name, birth_date: label.birth_date, mrn: label.mrn }, true);
    }
  }
  return { names: [...acc.names], dates: [...acc.dates], mrns: [...acc.mrns] };
}

/**
 * Every patient in this database, for screens that show no patient at all (Operations): birth dates,
 * MRNs and FULL names only. Single name tokens are left out here, because a lone given or family name
 * can also be a staff member's or contact's name (the synthetic seed has such pairs); a screen applies
 * the linked patient's single tokens per row (knownIdentifiers).
 */
export function labWideIdentifiers(db: DB): KnownIdentifiers {
  const acc = { names: new Set<string>(), dates: new Set<string>(), mrns: new Set<string>() };
  for (const p of db.prepare("SELECT family_name, given_name, birth_date, source_mrn FROM patient_ref").all() as { family_name: string; given_name: string; birth_date: string; source_mrn: string }[]) {
    addPatientValues(acc, { family: p.family_name, given: p.given_name, birth_date: p.birth_date, mrn: p.source_mrn }, false);
  }
  for (const v of orderPayloadPatients(db, null)) addPatientValues(acc, v, false);
  for (const c of db.prepare("SELECT observed_label FROM container WHERE observed_label IS NOT NULL").all() as { observed_label: string }[]) {
    try {
      const l = JSON.parse(c.observed_label) as { patient_name?: string | null; birth_date?: string | null; mrn?: string | null };
      addPatientValues(acc, { name: l.patient_name, birth_date: l.birth_date, mrn: l.mrn }, false);
    } catch {
      /* unreadable label */
    }
  }
  return { names: [...acc.names], dates: [...acc.dates], mrns: [...acc.mrns] };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function alternation(values: readonly string[]): string | null {
  const v = [...new Set(values.filter((x) => x.length > 0))].sort((a, b) => b.length - a.length).map(esc);
  return v.length ? v.join("|") : null;
}

/** One compiled pass per kind (longest first, so "Barnes, Theo" becomes one token rather than two). */
export function compileRedactor(ids: KnownIdentifiers): (text: string) => string {
  const d = alternation(ids.dates);
  const m = alternation(ids.mrns);
  const n = alternation(ids.names);
  const dates = d ? new RegExp(`(?<![0-9])(?:${d})(?![0-9])`, "g") : null;
  const mrns = m ? new RegExp(`(?<![A-Za-z0-9])(?:${m})(?![A-Za-z0-9])`, "g") : null;
  const names = n ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${n})(?![\\p{L}\\p{N}])`, "giu") : null;
  return (text: string) => {
    if (!text) return text;
    let out = text;
    if (dates) out = out.replace(dates, DATE_TOKEN);
    if (mrns) out = out.replace(mrns, MRN_TOKEN);
    if (names) out = out.replace(names, NAME_TOKEN);
    return out;
  };
}

/** Replaces every known identifier in `text` with "[patient name]", "[date of birth]" or "[MRN]". */
export function redactIdentifiers(text: string, ids: KnownIdentifiers): string {
  return compileRedactor(ids)(text);
}

/** Redacts the identifiers of the patients linked to a record from a piece of text (convenience for audit summaries). */
export function redactForRecord(
  db: DB,
  text: string,
  refs: { patientRefId?: string | null; sourceOrderId?: string | null; accessionId?: string | null; intakeItemId?: string | null; clarificationId?: string | null },
): string {
  if (!text) return text;
  const intakeItemIds: string[] = [];
  if (refs.intakeItemId) intakeItemIds.push(refs.intakeItemId);
  if (refs.clarificationId) {
    const c = db.prepare("SELECT intake_item_id FROM clarification WHERE id = ?").get(refs.clarificationId) as { intake_item_id: string | null } | undefined;
    if (c?.intake_item_id) intakeItemIds.push(c.intake_item_id);
  }
  return redactIdentifiers(text, knownIdentifiers(db, patientRefIdsFor(db, refs), { intakeItemIds }));
}

/** A task title for the audit trail: the identifiers of the task's patient replaced (the task record keeps its title). */
export function auditTaskTitle(db: DB, t: { id: string; title: string; accession_id: string | null; intake_item_id: string | null }): string {
  const e = db.prepare("SELECT entity_type, entity_id FROM task WHERE id = ?").get(t.id) as { entity_type: string; entity_id: string } | undefined;
  return redactForRecord(db, t.title, {
    patientRefId: e?.entity_type === "patient_ref" ? e.entity_id : null,
    sourceOrderId: e?.entity_type === "source_order" ? e.entity_id : null,
    clarificationId: e?.entity_type === "clarification" ? e.entity_id : null,
    accessionId: t.accession_id,
    intakeItemId: t.intake_item_id,
  });
}

// ------------------------------------------------------------------ History: values from the records themselves

function isAuditedPatientRef(v: unknown): v is AuditedPatientRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && typeof (v as AuditedPatientRef).id === "string" && "fingerprint" in v;
}

/**
 * For the History screens (intake item and case), which show an event's before and after values:
 * a patient reference recorded as { id, fingerprint } is shown with the details from the patient
 * record ITSELF, and only while the record still matches the audited fingerprint (otherwise the
 * details are not shown, and the screen says why). The audit row is never changed; this is a read
 * model. Any other payload is returned unchanged.
 */
export function historyPayload(db: DB, json: string | null): string | null {
  if (!json || !json.includes('"patientRef"')) return json;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return json;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return json;
  const obj = v as Record<string, unknown>;
  if (!isAuditedPatientRef(obj.patientRef)) return json;
  const ref = obj.patientRef;
  const p = patientRow(db, ref.id);
  const current = p ? detailsFingerprint(p) : null;
  const shown =
    p && ref.fingerprint && current === ref.fingerprint
      ? {
          id: p.id,
          tenant_id: p.tenant_id,
          source_mrn: p.source_mrn,
          family_name: p.family_name,
          given_name: p.given_name,
          birth_date: p.birth_date,
          fingerprint: ref.fingerprint,
          shown: "from the patient record, which matches the audited fingerprint",
        }
      : { id: ref.id, fingerprint: ref.fingerprint, shown: "details not shown: the patient record no longer matches the audited fingerprint" };
  return JSON.stringify({ ...obj, patientRef: shown });
}
