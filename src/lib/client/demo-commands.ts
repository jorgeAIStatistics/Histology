/**
 * Command the shell's demo-clock control calls (registered by the admin slice
 * in src/server/commands/admin.ts). One command covers every clock action:
 *
 *   { advanceMinutes: 5 }            Advance 5 min
 *   { iso: "<UTC ISO>" }             Jump forward to a time (never backwards)
 *   { running: false | true }        Pause / resume
 *   { iso: "<10:52 ISO>", reset: true }  Explicit rewind to the scenario start
 */
export const DEMO_CLOCK_COMMAND = "demo.setClock" as const;

export interface DemoClockInput {
  iso?: string;
  running?: boolean;
  advanceMinutes?: number;
  reset?: boolean;
}
