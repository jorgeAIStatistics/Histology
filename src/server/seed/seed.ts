import type { DB } from "../db/db";
import { seedReference, seedFixedLocations, at, DEMO_DAY } from "./reference";
import { seedHistory, seedPriorDayEvents } from "./history";
import { seedScenario } from "./scenario";
import { resetBuilderCounters, setCounters, currentCounters } from "./builders";
import { setClock } from "../core/clock";
import { setSetting } from "../core/settings";
import { activeAuditKey, demoAuditKey, sealPending } from "../core/audit-seal";

export const SEED_VERSION = "2026-10-14.v1";

/**
 * Build the reproducible synthetic demo day. Deterministic: the same seed
 * always yields the same cases, identifiers and expected outcomes.
 */
export function seedDemo(db: DB, opts: { clockRunning?: boolean } = {}): { slides: number; cases: number } {
  let result = { slides: 0, cases: 0 };
  db.transaction(() => {
    resetBuilderCounters();
    setCounters(2140, 8200);
    seedReference(db);
    seedFixedLocations(db);
    const h = seedHistory(db);
    seedScenario(db, h);
    seedPriorDayEvents(db);

    // Worklist baseline: every open case today is "known" as of 10:50 and
    // every user has acknowledged that version, so live changes stand out.
    const openCases = db
      .prepare(
        "SELECT id, accession_number, assigned_pathologist_id, received_day FROM accession WHERE is_prior_day = 0 ORDER BY issued_at",
      )
      .all() as { id: string; accession_number: string; assigned_pathologist_id: string; received_day: string }[];
    const insChange = db.prepare(
      "INSERT INTO worklist_change (accession_id, intake_item_id, pathologist_id, change_type, summary, at) VALUES (?, NULL, ?, 'new', ?, ?)",
    );
    for (const c of openCases) insChange.run(c.id, c.assigned_pathologist_id, `${c.accession_number} added to worklist`, at("07:30", c.received_day === DEMO_DAY ? DEMO_DAY : DEMO_DAY));
    const seq = (db.prepare("SELECT COALESCE(MAX(seq),0) s FROM worklist_change").get() as { s: number }).s;
    const staff = db.prepare("SELECT id FROM staff").all() as { id: string }[];
    const insAck = db.prepare("INSERT INTO worklist_ack (staff_id, view, acked_seq, acked_at) VALUES (?, ?, ?, ?)");
    for (const s of staff) for (const v of ["accessioning", "grossing", "histotech", "operations"]) insAck.run(s.id, v, seq, at("10:50"));

    // Display-id counters continue from the seeded history.
    const seqs: [string, number][] = [
      ["display:CLR", 457],
      ["display:H", 90],
      ["display:WO", currentCounters().wo + 1],
      ["display:PJ", Math.max(8842, currentCounters().pj + 1)],
      ["display:INT-1014", 24],
      ["display:REL", 112],
      ["display:AR", 201],
      ["display:XR", 31],
      ["display:RR", 193],
      ["display:SNAP", 1],
      ["display:TRY-M", 4],
      ["display:TRY-O", 1],
      ["display:TRY-F", 2],
      ["accession_number", 4817],
    ];
    const insSeq = db.prepare("INSERT INTO id_sequence(name, next_value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET next_value = excluded.next_value");
    for (const [k, v] of seqs) insSeq.run(k, v);

    setSetting(db, "demo_day", DEMO_DAY);
    setSetting(db, "assistant_mode", "deterministic"); // deterministic | unavailable
    setSetting(db, "sound_feedback", "off");
    setSetting(db, "processing_requires_approved_gross", "1");
    setSetting(db, "seed_version", SEED_VERSION);
    // Paused by default: the demo clock moves only when the presenter moves it.
    setClock(db, at("10:52"), opts.clockRunning ?? false);

    const slides = (db.prepare("SELECT COUNT(*) n FROM slide").get() as { n: number }).n;
    const cases = (db.prepare("SELECT COUNT(*) n FROM accession WHERE is_prior_day = 0").get() as { n: number }).n;
    result = { slides, cases };
    setSetting(db, "seeded_at", new Date().toISOString());
    // The seed writes its audit rows directly (builders.ts seedAudit): seal them all, in seq order, in this
    // same transaction. The key is this process's audit key; with none configured (a locked build without
    // HLOS_AUDIT_KEY, e.g. `npm run db:reset`), the synthetic seed is sealed with the PUBLIC demo key
    // (key id "demo-not-secret"), which proves nothing and says so on every seal.
    sealPending(db, activeAuditKey() ?? demoAuditKey());
  })();
  return result;
}
