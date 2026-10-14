import type { DB } from "@/server/db/db";

/**
 * SIMULATED label printer driver. No real printer is contacted. The outcome
 * of a submission is decided only by the printer row's `status`, which the
 * presenter changes in Settings (printer.setStatus):
 *
 *   online            → the printer acknowledges the job; a printer that
 *                       reports completion (reports_completion = 1) also
 *                       confirms completion. Others stop at "acknowledged".
 *   offline           → nothing is submitted; the job stays queued and is
 *                       kept until someone releases it.
 *   simulate_timeout  → the job is submitted but no reply arrives within the
 *                       (simulated) 30 s timeout: the outcome is UNKNOWN. The
 *                       label may or may not have printed.
 *
 * Real printers differ: what a printer can report (acknowledgement,
 * completion, errors) must be confirmed with the lab's actual hardware.
 */
export interface SimPrinter {
  id: string;
  name: string;
  kind: string; // slide | cassette | label
  location: string;
  status: string; // online | offline | simulate_timeout
  reports_completion: number;
  is_simulated: number;
}

export type PrinterOutcome =
  | { outcome: "unavailable"; detail: string }
  | { outcome: "acknowledged"; detail: string }
  | { outcome: "completed"; detail: string }
  | { outcome: "timeout"; detail: string };

export const PRINTER_TIMEOUT_SECONDS = 30;

export function getPrinter(db: DB, printerId: string): SimPrinter | undefined {
  return db.prepare("SELECT * FROM printer WHERE id = ?").get(printerId) as SimPrinter | undefined;
}

export function listPrinters(db: DB): SimPrinter[] {
  return db.prepare("SELECT * FROM printer ORDER BY kind, id").all() as SimPrinter[];
}

/** Which printer kind a label kind needs. */
export const PRINTER_KIND_FOR: Record<string, string> = {
  slide_label: "slide",
  cassette_label: "cassette",
  requisition_label: "label",
};

export function defaultPrinterFor(db: DB, labelKind: string): SimPrinter | undefined {
  const kind = PRINTER_KIND_FOR[labelKind];
  if (!kind) return undefined;
  return db.prepare("SELECT * FROM printer WHERE kind = ? ORDER BY id LIMIT 1").get(kind) as SimPrinter | undefined;
}

/** Decide what the simulated printer does with one submission. Pure: no writes. */
export function simulateSubmit(printer: SimPrinter): PrinterOutcome {
  switch (printer.status) {
    case "offline":
      return {
        outcome: "unavailable",
        detail: `${printer.name} is unavailable (simulated). The job is kept in the queue and will not print until it is released.`,
      };
    case "simulate_timeout":
      return {
        outcome: "timeout",
        detail: `Printer did not confirm within ${PRINTER_TIMEOUT_SECONDS} s after submission (simulated timeout). The label may or may not have printed. Check the printer output before retrying.`,
      };
    default:
      return printer.reports_completion
        ? { outcome: "completed", detail: `${printer.name} acknowledged and reported completion (simulated).` }
        : {
            outcome: "acknowledged",
            detail: `${printer.name} acknowledged the job (simulated). This printer does not report completion; check the output if in doubt.`,
          };
  }
}

export const PRINTER_STATUS_LABEL: Record<string, string> = {
  online: "Ready (simulated)",
  offline: "Unavailable (simulated)",
  simulate_timeout: "Times out after submission (simulated)",
};
