> **Status (Stage 5, 2026-10-19): built.** The console exists at `/demo` with tabs Guide, Role and clock, World events, and Outages and reset. It returns 404 in a locked build (`src/app/demo/gate.ts`). The rest of this document is the original proposal.

# Proposal: a separate director presentation surface

*Proposed, not built. Today the guided demo lives at `/demo` beside the bench screens, and the presenter controls (role switch, demo clock, guided demo) sit in the top bar's presenter menu.*

## Problem
The bench screens are built for people holding a bottle and a scanner. A director watching a demonstration needs something else: the story in order, the evidence for each claim, and what real deployment would require. When both share one surface, either the bench screens gain presenter controls (noise at the bench) or the director has to read a working screen cold.

## Proposal
A presentation route (for example `/present`) that runs **beside** the real application rather than replacing it:

- **Left, about 60%:** the real screen for the current step, live and unmodified (Intake, Clarify, Grossing, Worklist, Materials, Operations), driven by the same synthetic data and commands.
- **Right, about 40%:** a narrow story column with:
  - the step title and one sentence on what to notice;
  - the records that prove it (links to the audit entries the step created);
  - "what is simulated here" for this step;
  - "what production would need", taken from the production backlog.
- **Step rail at the foot:** the eight guided-demo steps, each one read as done from the records (as `/demo` already does), never from a click on "next".
- **Presenter-only controls** (run simulator events, demo clock, role switch) live only on this surface, so the bench screens carry none of them.

## What it must not do
- No invented outcomes, savings, rates or endorsements; no "AI confidence".
- No live systems.
- No auto-advance animation.

The surface would show, labelled, the illustrative scenario calculator that already exists in Insights, and nothing measured.

## Cost and order
- Reuse `/demo`'s step model and simulator.
- New work: the split layout, deep links into each screen's state, and moving the remaining presenter controls off bench screens.
- Build it after the bench screens settle.
