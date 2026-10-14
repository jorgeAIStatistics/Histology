"use server";

import { getDb } from "@/server/db/db";
import { resolveIntakeScan, type IntakeScanResolution } from "@/server/queries/intake";

/**
 * Read-only lookup for the intake scan target: what does a scanned or typed
 * value identify? (A scan identifies a record; it never verifies a container.)
 * State changes always go through POST /api/commands/<name>.
 */
export async function resolveIntakeScanAction(text: string): Promise<IntakeScanResolution> {
  if (typeof text !== "string" || !text.trim() || text.length > 200) {
    return { kind: "none", message: "Not recognized. Scan or type an order id, intake id or bottle label text." };
  }
  return resolveIntakeScan(getDb(), text);
}
