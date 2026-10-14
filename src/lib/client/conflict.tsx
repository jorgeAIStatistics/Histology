"use client";

import { createContext, startTransition, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ConflictDialog, type ConflictField } from "@/components/ui/conflict-dialog";
import { useDemoNow } from "./live";
import { useStaffName } from "./shell-context";

/**
 * One global conflict dialog (spec §7 "Recover, don't overwrite"). useCommand
 * opens it automatically when a command returns CONFLICT; pages can also call
 * useConflict().open(...) directly.
 */
export interface ConflictRequest {
  /** Server message from the CONFLICT error. */
  message?: string;
  /** `details` from the CONFLICT error: { table, id, expectedVersion, currentVersion, current }. */
  details?: unknown;
  /** The input you tried to save (used to build the field table). */
  yours?: Record<string, unknown> | null;
  /** Explicit rows; when omitted they are derived from details.current vs yours. */
  fields?: ConflictField[];
  /** Labels for field names, e.g. { site_text: "Site" }. */
  fieldLabels?: Record<string, string>;
  subject?: ReactNode;
  /** "Load latest and re-apply my changes": receives the latest row (details.current). The page re-bases its form. */
  onLoadLatest?: (current: Record<string, unknown> | null) => void;
  /** "Discard my changes": the page resets its form to the latest values. */
  onDiscard?: (current: Record<string, unknown> | null) => void;
}

interface ConflictContextValue {
  open: (req: ConflictRequest) => void;
  close: () => void;
}

const ConflictContext = createContext<ConflictContextValue | null>(null);

const IGNORED_INPUT_KEYS = new Set(["id", "version", "expectedVersion", "expected_version", "idempotencyKey"]);
/** Input keys whose object value holds the edited columns (e.g. `patch`). */
const NESTED_INPUT_KEYS = new Set(["patch", "observed"]);

function toSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  try {
    return JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b);
  } catch {
    return false;
  }
}

/** Build "field / theirs / yours" rows from a CONFLICT error's details and the attempted input. */
export function deriveConflictFields(
  details: unknown,
  yours: Record<string, unknown> | null | undefined,
  labels: Record<string, string> = {},
): ConflictField[] {
  const d = (details ?? {}) as { current?: Record<string, unknown>; currentVersion?: unknown; expectedVersion?: unknown };
  const current = d.current ?? null;
  const rows: ConflictField[] = [];
  if (current && yours) {
    // Commands that edit a row usually send `{ id, expectedVersion, patch: {...} }`: compare the patched columns too.
    const entries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(yours)) {
      if (NESTED_INPUT_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) entries.push(...Object.entries(value as Record<string, unknown>));
      else entries.push([key, value]);
    }
    for (const [key, value] of entries) {
      if (IGNORED_INPUT_KEYS.has(key)) continue;
      const col: string = key in current ? key : toSnake(key);
      if (!(col in current)) continue;
      // SQLite stores booleans as 0/1.
      const theirs = typeof value === "boolean" && (current[col] === 0 || current[col] === 1) ? current[col] === 1 : current[col];
      if (same(theirs, value)) continue;
      rows.push({ field: col, label: labels[key] ?? labels[col], theirs, yours: value });
    }
  }
  if (rows.length === 0 && (d.currentVersion !== undefined || d.expectedVersion !== undefined)) {
    rows.push({
      field: "version",
      label: "Version",
      theirs: d.currentVersion !== undefined ? `v${String(d.currentVersion)}` : "Newer",
      yours: d.expectedVersion !== undefined ? `v${String(d.expectedVersion)} (the one you opened)` : "Older",
    });
  }
  return rows;
}

export function ConflictProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const now = useDemoNow();
  const staffName = useStaffName();
  const [req, setReq] = useState<ConflictRequest | null>(null);

  const open = useCallback((r: ConflictRequest) => setReq(r), []);
  const close = useCallback(() => setReq(null), []);
  const value = useMemo(() => ({ open, close }), [open, close]);

  const current = ((req?.details as { current?: Record<string, unknown> } | undefined)?.current ?? null) as Record<string, unknown> | null;
  const fields = req ? (req.fields ?? deriveConflictFields(req.details, req.yours, req.fieldLabels)) : [];
  const changedBy = current ? staffName((current.updated_by as string | undefined) ?? null) : null;
  const changedAt = current ? ((current.updated_at as string | undefined) ?? null) : null;

  return (
    <ConflictContext.Provider value={value}>
      {children}
      <ConflictDialog
        open={req !== null}
        onClose={close}
        fields={fields}
        changedBy={changedBy}
        changedAt={changedAt}
        subject={req?.subject}
        message={req?.message}
        now={now}
        onLoadLatest={() => {
          const r = req;
          setReq(null);
          startTransition(() => router.refresh());
          r?.onLoadLatest?.(current);
        }}
        onDiscard={() => {
          const r = req;
          setReq(null);
          startTransition(() => router.refresh());
          r?.onDiscard?.(current);
        }}
      />
    </ConflictContext.Provider>
  );
}

export function useConflict(): ConflictContextValue {
  return useContext(ConflictContext) ?? { open: () => {}, close: () => {} };
}
