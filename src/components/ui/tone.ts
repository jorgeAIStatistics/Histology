import { Circle, CircleCheck, CirclePause, Info, OctagonX, TriangleAlert, type LucideIcon } from "lucide-react";

/**
 * Shared tone vocabulary, mapped to the severity ladder: danger = patient
 * identity only; warning = sources disagree, data may be wrong, a failure or
 * missing material; hold = hatched ink; neutral = waiting on a person;
 * success = done (a quiet check). Every tone has an icon shape and words, so
 * meaning never depends on color alone.
 */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "hold";
export type AlertTone = Exclude<Tone, "neutral" | "hold">;

export const TONE_ICON: Record<Tone, LucideIcon> = {
  neutral: Circle,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonX,
  hold: CirclePause,
};

/** Static class strings (Tailwind needs complete class names in source). */
export const TONE_CLASSES: Record<Tone, { fg: string; bg: string; border: string; solidBg: string; solidText: string }> = {
  neutral: {
    fg: "text-ink-secondary",
    bg: "bg-surface-subtle",
    border: "border-line-strong",
    solidBg: "bg-ink-muted",
    solidText: "text-ink-muted",
  },
  info: {
    fg: "text-info-fg",
    bg: "bg-info-bg",
    border: "border-info-border",
    solidBg: "bg-info-solid",
    solidText: "text-info-solid",
  },
  // Done rung (docs/redesign/visual-system.md): a quiet check in muted ink, never celebratory green.
  success: {
    fg: "text-ink-secondary",
    bg: "bg-surface-subtle",
    border: "border-line",
    solidBg: "bg-ink-muted",
    solidText: "text-ink-muted",
  },
  warning: {
    fg: "text-warning-fg",
    bg: "bg-warning-bg",
    border: "border-warning-border",
    solidBg: "bg-warning-solid",
    solidText: "text-warning-solid",
  },
  danger: {
    fg: "text-danger-fg",
    bg: "bg-danger-bg",
    border: "border-danger-border",
    solidBg: "bg-danger-solid",
    solidText: "text-danger-solid",
  },
  hold: {
    fg: "text-hold-fg",
    bg: "bg-hold-bg",
    border: "border-hold-border",
    solidBg: "bg-hold-solid",
    solidText: "text-hold-solid",
  },
};
