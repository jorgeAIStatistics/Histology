/**
 * Worklist views, columns and filters. Pure data (no React, no database), so
 * the server query, the commands and the client table all share one
 * definition. A "view" is a saved set of columns plus a default scope; it never
 * hides a case from the shared list (the "All cases" scope shows everything).
 */
import { z } from "zod";
import type { Stage } from "@/lib/domain";

export const WORKLIST_VIEWS = ["accessioning", "grossing", "histotech", "operations"] as const;
export type WorklistView = (typeof WORKLIST_VIEWS)[number];

export const VIEW_LABEL: Record<WorklistView, string> = {
  accessioning: "Accessioning",
  grossing: "Grossing and source entry",
  histotech: "Histotech",
  operations: "Operations",
};

export const VIEW_SCOPE_TEXT: Record<WorklistView, string> = {
  accessioning: "cases received today, anything on hold, and routing exceptions",
  grossing: "parts awaiting grossing, gross records in progress, and approved records awaiting source-system entry",
  histotech: "cases from processing to tray assembly, extra work orders (PAS, levels) and material needing review",
  operations: "every active case on today's worklist",
};

export const COLUMN_KEYS = [
  "accession",
  "parts",
  "stage",
  "stains",
  "holds",
  "readiness",
  "blocks",
  "sourceEntry",
  "owner",
  "lastUpdate",
  "office",
  "clinician",
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  accession: "Case",
  parts: "Parts",
  stage: "Stage",
  stains: "Stains (work orders)",
  holds: "Holds",
  readiness: "Readiness",
  blocks: "Blocks prepared / expected",
  sourceEntry: "Source-system entry",
  owner: "Current task owner",
  lastUpdate: "Last confirmed update",
  office: "Submitting office",
  clinician: "Ordering clinician",
};

/** P1 columns stay visible when the side panel is open; P3 columns hide first. */
export const COLUMN_PRIORITY: Record<ColumnKey, 1 | 2 | 3> = {
  accession: 1,
  parts: 1,
  stage: 1,
  stains: 1,
  holds: 1,
  readiness: 1,
  blocks: 2,
  sourceEntry: 2,
  owner: 2,
  lastUpdate: 2,
  office: 3,
  clinician: 3,
};

export const VIEW_COLUMNS: Record<WorklistView, ColumnKey[]> = {
  accessioning: ["accession", "parts", "stage", "stains", "holds", "readiness", "owner", "lastUpdate", "office", "clinician"],
  grossing: ["accession", "parts", "stage", "stains", "holds", "readiness", "sourceEntry", "blocks", "owner", "lastUpdate"],
  histotech: ["accession", "parts", "stage", "stains", "holds", "readiness", "blocks", "owner", "lastUpdate"],
  operations: ["accession", "parts", "stage", "stains", "holds", "readiness", "blocks", "sourceEntry", "owner", "lastUpdate", "office"],
};

/** Stages offered in the stage filter (derived stages; see server/domain/readiness.ts). */
export const FILTER_STAGES: Stage[] = [
  "awaiting_gross",
  "gross_in_progress",
  "awaiting_processing",
  "processing",
  "embedding",
  "sectioning",
  "staining",
  "qc",
  "ready_for_tray",
  "delivered",
  "canceled",
];

export const worklistFiltersSchema = z
  .object({
    /** Assigned dermatopathologist staff id, or "unassigned" for rows outside every active doctor's group. */
    doctor: z.string().max(64).optional(),
    stage: z.string().max(40).optional(),
    pasOnly: z.boolean().optional(),
    onHold: z.boolean().optional(),
    /** Rows with an open task owned by the current user. */
    mine: z.boolean().optional(),
    /** Rows that are new, changed or canceled since the user's last acknowledgment. */
    changedOnly: z.boolean().optional(),
    /** "view" = the view's default scope; "all" = every case on today's worklist. */
    scope: z.enum(["view", "all"]).optional(),
    /**
     * Grossing view only: parts with no approved gross record yet (what the Operations tile counts), Sam's
     * source-system entry queue, or records entered (staff attested) and awaiting the simulated source's acknowledgment.
     */
    queue: z.enum(["gross_pending", "source_entry", "source_attested"]).optional(),
    /** Free-text search on accession / provisional id / office / clinician. */
    q: z.string().max(80).optional(),
  })
  .strict();
export type WorklistFilters = z.infer<typeof worklistFiltersSchema>;

export const worklistViewSchema = z.enum(WORKLIST_VIEWS);

export function isWorklistView(v: unknown): v is WorklistView {
  return typeof v === "string" && (WORKLIST_VIEWS as readonly string[]).includes(v);
}

/** Parse URL search params into filters (unknown keys ignored, bad values dropped). */
export function filtersFromSearchParams(sp: Record<string, string | string[] | undefined>): WorklistFilters {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const bool = (k: string) => (one(k) === "1" || one(k) === "true" ? true : undefined);
  const raw: WorklistFilters = {
    doctor: one("doctor") || undefined,
    stage: one("stage") || undefined,
    pasOnly: bool("pas"),
    onHold: bool("hold"),
    mine: bool("mine"),
    changedOnly: bool("changed"),
    scope: one("scope") === "all" ? "all" : undefined,
    queue: (["gross_pending", "source_entry", "source_attested"] as const).find((q) => q === one("queue")),
    q: one("q")?.slice(0, 80) || undefined,
  };
  const parsed = worklistFiltersSchema.safeParse(stripUndefined(raw));
  return parsed.success ? parsed.data : {};
}

/** Serialize filters back into URL params (only set keys). */
export function filtersToSearchParams(view: WorklistView, f: WorklistFilters): URLSearchParams {
  const p = new URLSearchParams();
  p.set("view", view);
  if (f.doctor) p.set("doctor", f.doctor);
  if (f.stage) p.set("stage", f.stage);
  if (f.pasOnly) p.set("pas", "1");
  if (f.onHold) p.set("hold", "1");
  if (f.mine) p.set("mine", "1");
  if (f.changedOnly) p.set("changed", "1");
  if (f.scope === "all") p.set("scope", "all");
  if (f.queue) p.set("queue", f.queue);
  if (f.q) p.set("q", f.q);
  return p;
}

export function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "" && v !== false) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Human description of active filters (used in snapshot headers and the count line). */
export function describeFilters(f: WorklistFilters, doctorName?: (id: string) => string | undefined): string {
  const parts: string[] = [];
  if (f.scope === "all") parts.push("all cases");
  if (f.queue === "gross_pending") parts.push("parts with no approved gross record yet");
  if (f.queue === "source_entry") parts.push("source-entry queue");
  if (f.queue === "source_attested") parts.push("entered (staff attested), awaiting source acknowledgment");
  if (f.doctor) parts.push(f.doctor === "unassigned" ? "no active assigned dermatopathologist (routing exceptions and cases without one)" : `dermatopathologist ${doctorName?.(f.doctor) ?? f.doctor}`);
  if (f.stage) parts.push(`stage ${f.stage.replace(/_/g, " ")}`);
  if (f.pasOnly) parts.push("PAS only (incl. canceled PAS awaiting review)");
  if (f.onHold) parts.push("on hold");
  if (f.mine) parts.push("my work");
  if (f.changedOnly) parts.push("changed since acknowledgment");
  if (f.q) parts.push(`search "${f.q}"`);
  return parts.length ? parts.join(", ") : "no filters";
}

/** Source freshness thresholds (demo defaults, not clinical rules). */
export const FRESHNESS_DELAYED_AFTER_MIN = 5;
export const FRESHNESS_STALE_AFTER_MIN = 15;
