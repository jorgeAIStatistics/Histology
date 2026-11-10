// Builds the "Intake review" fixture used for design comparison screenshots,
// entirely through the app's own commands (no direct record edits):
//   courier arrived and unpacked · hero parts A and B on separate orders ·
//   container A verified · container B verified with a laterality mismatch ·
//   clarification raised with a hold on Part B · routing accepted on both ·
//   related-order candidate REL-0112 still waiting for the lead's review.
//
//   npx tsx scripts/fixture-intake-review.ts [db-file]   (default data/fixture-intake.db)
// Builds a synthetic fixture only: run its commands in synthetic demo mode (src/server/runtime-mode.ts).
process.env.HLOS_MODE = "demo";

import fs from "node:fs";
import { openDatabase } from "../src/server/db/db";
import { seedDemo } from "../src/server/seed/seed";
import { mustRun } from "../src/server/commands";

const file = process.argv[2] ?? "data/fixture-intake.db";
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
const db = openDatabase(file);
seedDemo(db, { clockRunning: false });

const row = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;

// World: the 11:00 courier arrives and the bag is unpacked (simulated).
mustRun(db, "stf_maya", "demo.runStep", { step: 1 }, { origin: "demo" });

type C = { id: string; version: number; order_part_id: string; item_id: string; order_id: string };
const container = (display: string) =>
  row<C>(
    `SELECT c.id, c.version, c.order_part_id, i.id AS item_id, sop.source_order_id AS order_id
       FROM container c JOIN intake_item i ON i.id = c.intake_item_id
       JOIN source_order_part sop ON sop.id = c.order_part_id
      WHERE i.display_id = ?`,
    display,
  );

const a = container("INT-1014-031");
const b = container("INT-1014-032");

// Staff (Maya): accept the suggested routing and verify both bottles.
mustRun(db, "stf_maya", "routing.confirm", { intakeItemId: a.item_id });
mustRun(db, "stf_maya", "routing.confirm", { intakeItemId: b.item_id });
mustRun(db, "stf_maya", "intake.verifyContainer", { containerId: a.id, expectedVersion: a.version, orderPartId: a.order_part_id });
mustRun(db, "stf_maya", "intake.verifyContainer", { containerId: b.id, expectedVersion: b.version, orderPartId: b.order_part_id });

// Staff (Maya): raise the laterality clarification with a hold on Part B only.
const op = row<{ site_text: string; laterality: string }>("SELECT site_text, laterality FROM source_order_part WHERE id = ?", b.order_part_id);
const observed = JSON.parse(row<{ observed_label: string }>("SELECT observed_label FROM container WHERE id = ?", b.id).observed_label) as { site_text: string };
mustRun(db, "stf_maya", "clarification.create", {
  category: "laterality",
  refs: { intakeItemId: b.item_id, sourceOrderId: b.order_id, orderPartId: b.order_part_id, containerId: b.id },
  subjectLabel: "Part B · ORD-77121",
  question: `The bottle for part B says "${observed.site_text}" but order ORD-77121 says "${op.site_text}". Which side is correct?`,
  evidence: [
    { field: "Laterality", order_value: `${op.laterality} (${op.site_text})`, observed_value: observed.site_text, requisition_value: null, source: "bottle label (staff entry)" },
  ],
  priority: "high",
  hold: { scope: { type: "order_part", id: b.order_part_id }, scopeLabel: "Part B (ORD-77121 · B)", blocks: ["gross_approval", "processing", "print", "tray_delivery"] },
});

const rel = row<{ display_id: string; status: string }>("SELECT display_id, status FROM related_order_candidate WHERE display_id = 'REL-0112'");
const hold = row<{ display_id: string; status: string }>("SELECT display_id, status FROM hold WHERE scope_id = ? AND status = 'active'", b.order_part_id);
db.close();
console.log(`Intake review fixture written to ${file}: ${rel.display_id} ${rel.status}, hold ${hold.display_id} ${hold.status}.`);
