import type { z } from "zod";

/**
 * One validation or refusal reason in an inbound NAK (docs/release/integration-contract.md §9).
 * `path` is a dotted path into the request ("payload.patient.birth_date", "payload.specimens.0.site",
 * "headers.x-hlos-signature"); `code` is a stable machine code; `message` is plain English and never
 * quotes a submitted value (so a NAK, a log line or a failure-queue entry cannot echo patient details).
 */
export interface ContractError {
  path: string;
  code: string;
  message: string;
}

/** A dotted path from a zod issue path, under an optional prefix ("payload"). */
export function joinPath(prefix: string, path: readonly PropertyKey[]): string {
  const tail = path.map((p) => String(p)).join(".");
  if (!prefix) return tail || "(root)";
  return tail ? `${prefix}.${tail}` : prefix;
}

/**
 * zod issues → contract errors. A missing member is `required`; every other issue keeps zod's own
 * code (invalid_type, too_small, too_big, invalid_format, invalid_value, custom, ...). Messages come
 * from the schema (never the submitted value).
 */
export function issuesToErrors(issues: readonly z.core.$ZodIssue[], prefix: string, max = 20): ContractError[] {
  return issues.slice(0, max).map((i) => {
    const missing = i.code === "invalid_type" && /received undefined/i.test(i.message);
    return {
      path: joinPath(prefix, i.path),
      code: missing ? "required" : i.code,
      message: missing ? "Required." : i.message,
    };
  });
}

/** One sentence for the failure queue: "payload.patient.birth_date: Required.; payload.specimens.0.site: …". */
export function errorsSentence(errors: readonly ContractError[], max = 4): string {
  const shown = errors.slice(0, max).map((e) => `${e.path}: ${e.message}`).join("; ");
  return errors.length > max ? `${shown}; +${errors.length - max} more` : shown;
}
