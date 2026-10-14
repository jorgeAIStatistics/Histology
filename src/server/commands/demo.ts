// Commands for the guided demo (scenario steps). Each defineCommand() call registers itself.
import { z } from "zod";
import { defineCommand } from "./registry";
import { runDemoStep, type DemoStepNumber, type DemoStepResult } from "../domain/demoSteps";

/**
 * demo.runStep {step, autoStaffActions?}
 *
 * Performs the WORLD events of one guided-demo step (demo clock, courier
 * arrival and unpacking (recorded as Maya Torres, origin "demo"), simulated
 * office answer and simulated source sync (origin "simulator")). With
 * `autoStaffActions: true` (rehearsal and tests) it also performs that step's
 * staff actions, each through the owning slice's command, as the named staff
 * member who would do it (origin "demo"), so that person's role checks, holds
 * and audit still apply. The outer audit row names who triggered the run and
 * shares its correlation id with every nested action.
 *
 * World events are open to any demo role (`permission: null`, per the command
 * contract): they are presenter controls, not lab actions. Rehearsal acts as
 * other people, so it additionally requires the supervisor demo role (checked
 * in runDemoStep). The demo role selector is not authentication.
 */
export const runStepCommand = defineCommand({
  name: "demo.runStep",
  description: "Guided demo: run a step's simulator events (and, for rehearsal, its staff actions through the real commands).",
  permission: null,
  input: z.object({
    step: z.number().int().min(1).max(8),
    autoStaffActions: z.boolean().optional(),
  }),
  run: (ctx, input): DemoStepResult => runDemoStep(ctx, input.step as DemoStepNumber, input.autoStaffActions === true),
});

export const __demoCommands = [runStepCommand.name] as const;
