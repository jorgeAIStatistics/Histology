import "@/server/commands"; // registers every command
import { executeCommand } from "@/server/commands/registry";
import { httpStatusFor, type DomainErrorCode } from "@/server/core/errors";
import type { DB } from "@/server/db/db";
import { buildWorklistCsv, getWorklist } from "@/server/queries/worklist";
import { describeFilters, isWorklistView, worklistFiltersSchema } from "@/components/worklist/views";

export type ExportResult =
  | { ok: true; csv: string; filename: string; snapshot: SnapshotResult; replayed: boolean; rowCount: number }
  | { ok: false; status: number; error: { code: DomainErrorCode | "VALIDATION"; message: string; details?: unknown } };

export interface SnapshotResult {
  snapshotId: string;
  displayId: string;
  seq: number;
  generatedAt: string;
  generatedBy: string;
  rowCount: number;
  dataAsOf: string | null;
  stale: boolean;
}

/**
 * CSV downtime/transition fallback, independent of HTTP so it can be tested
 * against the in-memory demo database. Records the snapshot through the
 * command layer (worklist.snapshot: audited, idempotent per key, refuses a
 * list that moved on), then renders the rows of exactly that version.
 */
export function exportWorklistCsv(
  db: DB,
  actorId: string,
  body: { view?: unknown; filters?: unknown; expectedSeq?: unknown; idempotencyKey?: unknown },
): ExportResult {
  if (!isWorklistView(body.view)) return { ok: false, status: 400, error: { code: "VALIDATION", message: "Unknown worklist view." } };
  const parsedFilters = worklistFiltersSchema.safeParse(body.filters ?? {});
  if (!parsedFilters.success) return { ok: false, status: 400, error: { code: "VALIDATION", message: "Some filters are invalid." } };
  const view = body.view;
  const filters = parsedFilters.data;
  const expectedSeq = typeof body.expectedSeq === "number" && Number.isInteger(body.expectedSeq) ? body.expectedSeq : undefined;
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : undefined;

  const res = executeCommand<SnapshotResult>(db, actorId, "worklist.snapshot", { view, filters, format: "csv", expectedSeq }, { idempotencyKey });
  if (!res.ok) return { ok: false, status: httpStatusFor[res.error.code] ?? 400, error: res.error };

  // Same synchronous request: the rows below are the version the snapshot recorded. A replayed key
  // (double click, retry) re-renders the same snapshot only while the list is still at that version.
  const data = getWorklist(db, { staffId: actorId, view, filters });
  if (data.seq !== res.result.seq) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `The worklist changed since snapshot ${res.result.displayId} was recorded (v${res.result.seq} → v${data.seq}). Refresh, then download again.`,
      },
    };
  }
  const doctorName = (id: string) => data.doctors.find((d) => d.id === id)?.name;
  const csv = buildWorklistCsv(
    data,
    { displayId: res.result.displayId, generatedAt: res.result.generatedAt, generatedBy: res.result.generatedBy, seq: res.result.seq, dataAsOf: res.result.dataAsOf, stale: res.result.stale },
    describeFilters(filters, doctorName),
  );
  const rowCount = data.groups.reduce((n, g) => n + g.rows.length, 0);
  return {
    ok: true,
    csv,
    filename: `worklist-${view}-v${res.result.seq}-${res.result.displayId}.csv`,
    snapshot: res.result,
    replayed: res.replayed === true,
    rowCount,
  };
}
