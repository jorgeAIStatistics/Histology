import { fmtTime } from "@/lib/time";
import type { TrayView } from "@/server/domain/tray";

/**
 * The tray as it sits on the bench: one slot per position on the tray's list
 * (tray_expected_slide.seq), in that order, then any material that was scanned
 * onto the tray but is not on its list. Pure and derived from the server's
 * TrayView; nothing here decides anything the server has not already decided.
 */

export interface TrayHoldView {
  displayId: string;
  scopeLabel: string;
  reason: string;
}

export type SlotState = "scanned" | "empty" | "missing" | "follows" | "canceled" | "remove";
/** Where the slot sits on the severity ladder: done is quiet, waiting is neutral, amber needs a person to act on the material. */
export type SlotTone = "done" | "waiting" | "amber" | "muted";

export interface TraySlot {
  key: string;
  /** Position on the tray's list; null for material on the tray that is not on its list. */
  position: number | null;
  slideId: string | null;
  /** Human slide label, or the raw scanned text when the label identified no slide. */
  label: string;
  isSlideLabel: boolean;
  state: SlotState;
  /** A slide is physically in this slot (drawn as a slide) rather than an empty position. */
  onTray: boolean;
  tone: SlotTone;
  /** Short visible words (the slot is narrow). */
  words: string;
  detail: string | null;
  /** The whole slot as one sentence for assistive technology. */
  sr: string;
  holds: TrayHoldView[];
  /** The same slide was scanned twice and nobody has confirmed it yet. */
  scannedTwice: boolean;
  /** Scan that put this slide on the tray (for locating the latest scan). */
  scanId: string | null;
}

/** "D26-04747 A1-1 H&E L1" -> accession, block-slide, the rest (stain and level). */
export function labelLines(label: string): { accession: string; position: string; rest: string } {
  const [accession = label, position = "", ...rest] = label.split(" ");
  return { accession, position, rest: rest.join(" ") };
}

/** "Dr. Samuel Okafor" -> "Dr. Okafor" (the slot is narrow; the full name is in the sentence). */
export function shortDoctor(name: string): string {
  const m = /^(Dr\.)\s+\S+\s+(.+)$/.exec(name.trim());
  return m ? `${m[1]} ${m[2]}` : name;
}

function holdSentence(holds: TrayHoldView[]): string {
  return holds.length ? ` On hold: ${holds.map((h) => `${h.displayId}, ${h.scopeLabel}: ${h.reason}`).join("; ")}.` : "";
}

/**
 * Position of each listed slide on its tray: 1, 2, 3... in the order of the
 * tray's list (tray_expected_slide.seq). The stored seq can start anywhere
 * (TRY-M-02's list is numbered 80 to 89); the position on the tray is its rank.
 */
export function trayPositions(view: TrayView): Map<string, number> {
  return new Map([...view.expected].sort((a, b) => a.seq - b.seq).map((e, i) => [e.slideId, i + 1]));
}

export function traySlots(view: TrayView, holds: Record<string, TrayHoldView[]> = {}): TraySlot[] {
  const twice = new Set(view.unresolved.filter((s) => s.result === "duplicate" && s.slideId).map((s) => s.slideId as string));
  const listed = [...view.expected].sort((a, b) => a.seq - b.seq).map((e, i): TraySlot => {
    const h = holds[e.slideId] ?? [];
    const position = i + 1;
    const base = { key: e.slideId, position, slideId: e.slideId, label: e.label, isSlideLabel: true, holds: h, scannedTwice: twice.has(e.slideId), scanId: e.scanId };
    const at = `Position ${position}: ${e.label}.`;
    const tail = `${holdSentence(h)}${twice.has(e.slideId) ? " Scanned twice: confirm it was the same slide or remove the second one." : ""}`;
    if (e.canceledOnTray) {
      return { ...base, state: "remove", onTray: true, tone: "amber", words: "Canceled", detail: "Take it off", sr: `${at} Canceled, still on the tray: take it off. ${e.canceledReason ?? ""}${tail}` };
    }
    switch (e.state) {
      case "scanned":
        return {
          ...base,
          state: "scanned",
          onTray: true,
          tone: "done",
          words: "Scanned",
          detail: e.scannedAt ? fmtTime(e.scannedAt) : null,
          sr: `${at} Scanned, matches${e.scannedAt ? `, ${fmtTime(e.scannedAt)} ET` : ""}${e.scannedBy ? ` by ${e.scannedBy}` : ""}.${tail}`,
        };
      case "missing":
        return { ...base, state: "missing", onTray: false, tone: "amber", words: "Missing", detail: "Investigation open", sr: `${at} Missing: investigation open${e.dispositionNote ? `. ${e.dispositionNote}` : ""}.${tail}` };
      case "follows_separately":
        return {
          ...base,
          state: "follows",
          onTray: false,
          tone: "waiting",
          words: "Follows separately",
          detail: null,
          sr: `${at} Follows separately${e.dispositionBy ? `, recorded by ${e.dispositionBy}` : ""}${e.dispositionNote ? `: ${e.dispositionNote}` : ""}.${tail}`,
        };
      case "canceled":
        return { ...base, state: "canceled", onTray: false, tone: "muted", words: "Canceled", detail: null, sr: `${at} Canceled, not needed on this tray${e.canceledReason ? `: ${e.canceledReason}` : ""}.${tail}` };
      default:
        return { ...base, state: "empty", onTray: false, tone: "waiting", words: "Not scanned", detail: null, sr: `${at} Expected, not scanned yet.${tail}` };
    }
  });
  const extras = view.unresolved
    .filter((s) => s.result !== "duplicate")
    .map((s): TraySlot => {
      const label = s.slideLabel ?? s.payload;
      const words = s.result === "unexpected" ? "Unexpected" : s.result === "canceled_material" ? "Canceled" : "Unknown label";
      const detail = s.result === "unexpected" ? (s.belongsTo ? `${shortDoctor(s.belongsTo)}'s case` : "Not on the list") : "Take it off";
      return {
        key: s.id,
        position: null,
        slideId: s.slideId,
        label,
        isSlideLabel: !!s.slideLabel,
        state: "remove",
        onTray: true,
        tone: "amber",
        words,
        detail,
        sr: `Not on this tray's list: ${label}. ${s.resultLabel}${s.belongsTo ? `, ${s.belongsTo}'s case` : ""}, scanned ${fmtTime(s.scannedAt)} ET${s.scannedBy ? ` by ${s.scannedBy}` : ""}: take it off the tray.`,
        holds: [],
        scannedTwice: false,
        scanId: s.id,
      };
    });
  return [...listed, ...extras];
}

/** "Cannot complete: 1 not scanned, 1 unexpected." The slides themselves are named in the lists below it. */
export function blockedHeadline(view: TrayView): string | null {
  if (!view.isActive || !view.completeBlockers.length) return null;
  const live = view.expected.filter((e) => e.state !== "canceled");
  const n = (count: number, word: string) => (count ? `${count} ${word}` : null);
  const kind = (k: string) => view.unresolved.filter((u) => u.result === k).length;
  const parts = [
    n(live.filter((e) => e.state === "expected").length, "not scanned"),
    n(live.filter((e) => e.state === "missing").length, "missing"),
    n(live.filter((e) => e.state === "follows_separately").length, "follows separately"),
    n(view.counts.canceledOnTray + kind("canceled_material"), "canceled on the tray"),
    n(kind("unexpected"), "unexpected"),
    n(kind("duplicate"), "scanned twice"),
    n(kind("unknown_identifier"), kind("unknown_identifier") === 1 ? "unknown label" : "unknown labels"),
  ].filter(Boolean);
  return parts.length ? `Cannot complete: ${parts.join(", ")}.` : "Cannot complete yet.";
}

/** The slot the newest scan landed in (for the scan-locates-it highlight). */
export function slotForScan(slots: TraySlot[], scan: { id: string; slideId: string | null } | undefined): string | null {
  if (!scan) return null;
  const hit = slots.find((s) => s.scanId === scan.id) ?? (scan.slideId ? slots.find((s) => s.slideId === scan.slideId && s.position !== null) : undefined);
  return hit?.key ?? null;
}
