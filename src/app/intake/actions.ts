"use server";

import { getDb } from "@/server/db/db";
import { resolveIntakeScan, type IntakeScanResolution } from "@/server/queries/intake";
import { currentViewer } from "@/server/auth/guard";

/**
 * Read-only lookup for the intake scan target: what does a scanned or typed
 * value identify? (A scan identifies a record; it never verifies a container.)
 * State changes always go through POST /api/commands/<name>.
 * Goes through the one guard (view.intake) like the page: without a signed-in,
 * unlocked session (or in a locked build) it answers "not recognized" and reads nothing.
 */
export async function resolveIntakeScanAction(text: string): Promise<IntakeScanResolution> {
  const viewer = await currentViewer({ touch: true, view: "view.intake" });
  if (!viewer.ok) return { kind: "none", message: "Sign in again to look this up. Nothing was read." };
  if (typeof text !== "string" || !text.trim() || text.length > 200) {
    return { kind: "none", message: "Not recognized. Scan or type an order id, intake id or bottle label text." };
  }
  return resolveIntakeScan(getDb(), text);
}
