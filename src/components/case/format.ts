/**
 * Pure display helpers shared by the case read model (server) and the case
 * components (client). No React, no database.
 */

/** "accession.issued" → "Accession issued"; "related.reviewed" → "Related orders reviewed". Plain words for audit actions. */
export function actionLabel(action: string): string {
  const words = action
    .replace(/^related\./, "related_orders.")
    .split(/[._]/)
    .filter(Boolean)
    .join(" ")
    .replace(/\bgross\b/, "gross record");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
