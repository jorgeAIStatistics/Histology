/**
 * Hex mirror of the design tokens that must be passed as JS values (Recharts
 * props, canvas, bwip-js). Components styled with CSS must use the Tailwind
 * token classes instead (bg-surface, text-ink, ...). Keep in sync with
 * src/app/globals.css; a test can compare the two.
 */
import type { PathologistColor } from "@/lib/domain";

export const DOCTOR_COLORS: Record<PathologistColor, { swatch: string; tint: string; name: string }> = {
  teal: { swatch: "#0F9485", tint: "#E3F4F1", name: "teal" },
  violet: { swatch: "#9A4BD0", tint: "#F3ECFB", name: "violet" },
  amber: { swatch: "#916A0B", tint: "#FAF1DC", name: "amber" },
};

/** Queue-age ordinal ramp: under 1 h, 1 to 4 h, 4 to 8 h, over 8 h. */
export const AGE_RAMP = ["#62AEDB", "#3B89B4", "#235E7F", "#163F56"] as const;
export const AGE_BUCKET_LABELS = ["Under 1 h", "1 to 4 h", "4 to 8 h", "Over 8 h"] as const;
/** Label color for text placed inside a bar of each age step (steps 1-2 take dark labels outside the bar). */
export const AGE_LABEL_INSIDE = [null, null, "#FFFFFF", "#FFFFFF"] as const;

export const CHART = {
  grid: "#E4E9ED",
  axis: "#7A8894",
  tick: "#56636F",
  text: "#0F1A23",
  brand: "#0D5F87",
  surface: "#FFFFFF",
} as const;

export const ALERT_SOLID = {
  info: "#2A64B0",
  success: "#016807",
  warning: "#E36A22",
  danger: "#C4232B",
  hold: "#6E2B66",
} as const;

export const PAS = { bg: "#FFE45C", fg: "#1C1700", border: "#8A7300", row: "#FFF8D6" } as const;

export const TEXT = { ink: "#0F1A23", secondary: "#3E4C59", muted: "#56636F" } as const;

/** Values mirrored from :root in globals.css, keyed by CSS custom property (for a sync test). */
export const CSS_TOKEN_MIRROR: Record<string, string> = {
  "--hlo-dr-teal": DOCTOR_COLORS.teal.swatch,
  "--hlo-dr-teal-tint": DOCTOR_COLORS.teal.tint,
  "--hlo-dr-violet": DOCTOR_COLORS.violet.swatch,
  "--hlo-dr-violet-tint": DOCTOR_COLORS.violet.tint,
  "--hlo-dr-amber": DOCTOR_COLORS.amber.swatch,
  "--hlo-dr-amber-tint": DOCTOR_COLORS.amber.tint,
  "--hlo-age-1": AGE_RAMP[0],
  "--hlo-age-2": AGE_RAMP[1],
  "--hlo-age-3": AGE_RAMP[2],
  "--hlo-age-4": AGE_RAMP[3],
  "--hlo-chart-grid": CHART.grid,
  "--hlo-chart-axis": CHART.axis,
  "--hlo-brand": CHART.brand,
  "--hlo-text-muted": CHART.tick,
  "--hlo-info-solid": ALERT_SOLID.info,
  "--hlo-success-solid": ALERT_SOLID.success,
  "--hlo-warning-solid": ALERT_SOLID.warning,
  "--hlo-danger-solid": ALERT_SOLID.danger,
  "--hlo-hold-solid": ALERT_SOLID.hold,
  "--hlo-pas-bg": PAS.bg,
  "--hlo-pas-fg": PAS.fg,
  "--hlo-pas-border": PAS.border,
  "--hlo-pas-row": PAS.row,
};
