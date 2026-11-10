import crypto from "node:crypto";
import type { DB } from "./db/db";
import type { SimulatedOrder, SourceMessage } from "./domain/sourceImport";
import { isDemoMode } from "./runtime-mode";

/**
 * Test-only source-message fixtures (synthetic data only).
 *
 * Some states can only be reached through the importer (importSourceMessage):
 * a patient-level or order-level source conflict, for example. Browser tests
 * need those states, so this module keeps a FIXED catalog of named, synthetic
 * source messages that POST /api/test/fixtures can import. There is no way to
 * send an arbitrary payload: a caller names a fixture, and the message is built
 * here from records the seed already holds.
 *
 * The endpoint exists only when ALL of these hold (read on every call):
 *   - the synthetic demo mode (isDemoMode());
 *   - HLOS_TEST_FIXTURES=1;
 *   - HLOS_TEST_FIXTURE_TOKEN set, at least 32 characters long;
 * and each request must carry that token in the x-hlos-fixture-token header
 * (compared in constant time). A locked build never runs a fixture.
 *
 * Every fixture is deterministic: the same seed gives the same message, with a
 * stable message id, so importing it twice is a duplicate (duplicate_ignored).
 */

export const FIXTURE_TOKEN_HEADER = "x-hlos-fixture-token";
export const MIN_FIXTURE_TOKEN_LENGTH = 32;

/** True only in synthetic demo mode, with HLOS_TEST_FIXTURES=1 and a token of at least 32 characters. */
export function testFixturesEnabled(): boolean {
  return isDemoMode() && process.env.HLOS_TEST_FIXTURES === "1" && (process.env.HLOS_TEST_FIXTURE_TOKEN ?? "").length >= MIN_FIXTURE_TOKEN_LENGTH;
}

/**
 * Whether a presented token equals HLOS_TEST_FIXTURE_TOKEN. Both sides are hashed
 * first, so the comparison takes the same time whatever the presented length is.
 */
export function fixtureTokenMatches(presented: string | null | undefined): boolean {
  const expected = process.env.HLOS_TEST_FIXTURE_TOKEN ?? "";
  const given = typeof presented === "string" ? presented : "";
  const a = crypto.createHash("sha256").update(given, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  const same = crypto.timingSafeEqual(a, b);
  return same && given.length > 0 && expected.length >= MIN_FIXTURE_TOKEN_LENGTH;
}

/** The fixed catalog. Nothing else can be imported through the test endpoint. */
export const TEST_FIXTURE_NAMES = ["source-conflict-patient", "source-conflict-order-amend"] as const;
export type TestFixtureName = (typeof TEST_FIXTURE_NAMES)[number];

export function isTestFixtureName(name: unknown): name is TestFixtureName {
  return typeof name === "string" && (TEST_FIXTURE_NAMES as readonly string[]).includes(name);
}

/** A fixture cannot be built from this database (the seed record it starts from is missing). */
export class FixtureUnavailableError extends Error {}

export interface BuiltFixture {
  name: TestFixtureName;
  /** The simulated source the message comes from. */
  sourceId: string;
  /** One sentence: what the message is and what the importer should do with it. */
  description: string;
  message: SourceMessage & { payload: SimulatedOrder };
}

/** The seeded EMA-SIM order the fixtures start from: Theo Barnes (synthetic), MRN 447902, Harbor Point. */
const BASE = { sourceId: "src_ema", tenantId: "ten_ema", orderId: "ORD-77118" } as const;
/** The new order that names the MRN on file with other details (source-conflict-patient). */
const CONFLICTING_ORDER_ID = "ORD-77990";

/** The seed's version 1 of the base order, exactly as the source sent it. */
function baseOrderV1(db: DB): SimulatedOrder {
  const row = db
    .prepare(
      `SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id
        WHERE o.tenant_id = ? AND o.source_order_id = ? AND v.source_version = 1`,
    )
    .get(BASE.tenantId, BASE.orderId) as { payload: string } | undefined;
  if (!row) throw new FixtureUnavailableError(`Seed order ${BASE.orderId} v1 is not in this database; reset the synthetic demo day first.`);
  return JSON.parse(row.payload) as SimulatedOrder;
}

/** A fixed time after the base order's own update time (deterministic: derived from the seed record only). */
function laterThan(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

const BUILDERS: Record<TestFixtureName, (db: DB) => BuiltFixture> = {
  /**
   * A NEW order from the simulated source naming the MRN on file (447902) with a
   * different name and date of birth. The importer links it by MRN, keeps the
   * patient on file and opens one patient-level source_conflict review, which
   * blocks accession of that patient's items (source_conflict_open).
   */
  "source-conflict-patient": (db) => {
    const v1 = baseOrderV1(db);
    const payload: SimulatedOrder = {
      ...v1,
      order_id: CONFLICTING_ORDER_ID,
      version: 1,
      updated_at: laterThan(v1.updated_at, 60),
      status: "active",
      patient: { mrn: v1.patient.mrn, name: "Barnes, Thea", birth_date: "1927-06-14" },
      // A separate visit: the new order shares no encounter with the order on file.
      encounter_id: null,
      amendment_note: null,
    };
    return {
      name: "source-conflict-patient",
      sourceId: BASE.sourceId,
      description: `New order ${CONFLICTING_ORDER_ID} names MRN ${v1.patient.mrn} with a different name and date of birth: a patient-level source conflict.`,
      message: { messageId: `fixture/source-conflict-patient/${CONFLICTING_ORDER_ID}#v1`, messageType: "order.upsert", payload },
    };
  },
  /**
   * Version 2 of the base order with the patient's date of birth changed. The
   * importer keeps the order's patient as it is and opens one order-level
   * source_conflict review on the order (it blocks accession too).
   */
  "source-conflict-order-amend": (db) => {
    const v1 = baseOrderV1(db);
    const payload: SimulatedOrder = {
      ...v1,
      version: 2,
      updated_at: laterThan(v1.updated_at, 60),
      status: "amended",
      patient: { ...v1.patient, birth_date: "1972-06-15" },
      amendment_note: "Synthetic test fixture: date of birth changed at source",
    };
    return {
      name: "source-conflict-order-amend",
      sourceId: BASE.sourceId,
      description: `${BASE.orderId} v2 changes the patient's date of birth: an order-level source conflict.`,
      message: { messageId: `fixture/source-conflict-order-amend/${BASE.orderId}#v2`, messageType: "order.upsert", payload },
    };
  },
};

/** Build one catalog fixture from this database's seed records. Throws FixtureUnavailableError when the seed record is missing. */
export function buildTestFixture(db: DB, name: TestFixtureName): BuiltFixture {
  return BUILDERS[name](db);
}
