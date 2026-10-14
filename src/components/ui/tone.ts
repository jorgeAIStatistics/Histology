import { Circle, CircleCheck, CirclePause, Info, OctagonX, TriangleAlert, type LucideIcon } from "lucide-react";

/**
 * Shared tone vocabulary (spec §3.1 alert colors). Every tone has a text
 * color, a pale tint, a border, a solid stripe/icon color and an icon shape,
 * so meaning never depends on color alone.
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
export const TONE_CLASSES: Record<Tone, { fg: string; bg: string; border: string; solidBg: string; solidText: string; stripe: string }> = {
  neutral: {
    fg: "text-ink-secondary",
    bg: "bg-surface-subtle",
    border: "border-line-strong",
    solidBg: "bg-ink-muted",
    solidText: "text-ink-muted",
    stripe: "border-l-ink-muted",
  },
  info: {
    fg: "text-info-fg",
    bg: "bg-info-bg",
    border: "border-info-border",
    solidBg: "bg-info-solid",
    solidText: "text-info-solid",
    stripe: "border-l-info-solid",
  },
  success: {
    fg: "text-success-fg",
    bg: "bg-success-bg",
    border: "border-success-border",
    solidBg: "bg-success-solid",
    solidText: "text-success-solid",
    stripe: "border-l-success-solid",
  },
  warning: {
    fg: "text-warning-fg",
    bg: "bg-warning-bg",
    border: "border-warning-border",
    solidBg: "bg-warning-solid",
    solidText: "text-warning-solid",
    stripe: "border-l-warning-solid",
  },
  danger: {
    fg: "text-danger-fg",
    bg: "bg-danger-bg",
    border: "border-danger-border",
    solidBg: "bg-danger-solid",
    solidText: "text-danger-solid",
    stripe: "border-l-danger-solid",
  },
  hold: {
    fg: "text-hold-fg",
    bg: "bg-hold-bg",
    border: "border-hold-border",
    solidBg: "bg-hold-solid",
    solidText: "text-hold-solid",
    stripe: "border-l-hold-solid",
  },
};
