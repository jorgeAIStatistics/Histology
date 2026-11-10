// Step 3 of the director demo exactly as docs/demo-script.md tells the presenter to run it: send the
// clarification, then press the guide's "Run simulator events" so that ONE simulator run brings both the
// office's answer and amended order ORD-77121 v2; only then does the lead review, resolve and release.
// (The main journey instead uses the presenter console's "Simulate office answer" world event, so it never exercises this
// branch of the step 3 simulator.) Steps 1 and 2 are set up with the guide's rehearsal button, which the
// supervisor demo role may use; every step 3 staff action is a click on the real screens.
import { expect, test, type Page } from "@playwright/test";
import { STAFF, actAs, loose, openGuideStep, resetDemo, runSimulatorEvents, toasts } from "./support";

const INTAKE_B = "INT-1014-032";
const CLR = "CLR-0457";
const HOLD = "H-0090";

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

/** Guided demo: "Auto-perform staff actions (rehearsal)" for one step (supervisor only). */
async function rehearse(page: Page, step: number) {
  await openGuideStep(page, step);
  await page.getByRole("button", { name: "Auto-perform staff actions (rehearsal)" }).click();
  await page.getByRole("alertdialog", { name: `Perform the staff actions of step ${step} automatically?` }).getByRole("button", { name: "Perform rehearsal actions" }).click();
  const result = page.getByRole("region", { name: `Result of the last run of step ${step}` });
  await expect(result.getByText(loose("Simulator events and rehearsal actions done"))).toBeVisible();
}

test("guided demo step 3 as scripted: one simulator run brings the office answer and amended order v2; the hold waits for the lead", async ({ page, context }) => {
  // Setup: steps 1 (courier, routing) and 2 (container A, related-order decision) rehearsed by the guide.
  await actAs(context, STAFF.tanya);
  await rehearse(page, 1);
  await rehearse(page, 2);
  await expect(page.getByText(/^2 of 8 steps done \(read from the records\)/)).toBeVisible();

  // Maya verifies container B: the laterality differs. She raises the clarification with a hold on Part B only.
  await actAs(context, STAFF.maya);
  await page.goto(`/intake?item=${INTAKE_B}`);
  await expect(page.getByRole("region", { name: /^Container 1 of Part B Order ORD-77121/ })).toContainText("Not yet verified");
  await page.getByRole("complementary", { name: "Decision" }).getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
  await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part B Order ORD-77121 Discrepancy recorded$/ })).toBeVisible();
  await page.getByRole("button", { name: "Raise clarification for laterality on container 1" }).click();
  const raise = page.getByRole("dialog", { name: "Raise clarification" });
  await expect(raise.getByRole("checkbox", { name: /Place a scoped hold Hold: Part B \(ORD-77121 · B\)/ })).toBeChecked();
  await raise.getByRole("button", { name: "Raise clarification", exact: true }).click();
  await expect(raise.getByRole("link", { name: `Open ${CLR} in Clarifications` })).toBeVisible();
  await raise.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Holds, questions and tasks" })).toContainText(loose(`Hold ${HOLD}`));

  // On Clarifications, Maya sends it (simulated notification).
  await page.goto(`/clarifications?selected=${CLR}`);
  const panel = page.getByRole("region", { name: /^Laterality question: INT-1014-032 · ORD-77121 Part B/ });
  const decision = panel.getByRole("complementary", { name: "Decision" });
  await expect(panel).toContainText(loose("Drafted"));
  await expect(panel).toContainText(loose("Drafted, not sent."));
  await decision.getByRole("button", { name: "Send (simulated)" }).click();
  await expect(decision.getByRole("heading", { level: 3, name: "Record the answer from Harbor Point Dermatology" })).toBeVisible();

  // Back on the guide: one simulator run delivers the office's answer AND the amended order.
  const { result, actions } = await runSimulatorEvents(page, 3);
  await expect(actions.filter({ hasText: loose(`Done: Simulated office answer for ${CLR}: the bottle (left) is correct; the office will amend the order`) })).toHaveCount(1);
  await expect(actions.filter({ hasText: loose("Done: Simulated source sync: deliver amended order ORD-77121 v2 (laterality left)") })).toHaveCount(1);
  await expect(actions.filter({ hasText: /Staff action/ })).toHaveCount(0);
  await expect(result).toContainText(
    loose(
      "The simulated office answer has arrived. Amended order ORD-77121 v2 has arrived from the simulated source. Neither resolves the clarification or releases the hold: review the answer on the Clarifications screen.",
    ),
  );
  await expect(page.getByRole("list").filter({ hasText: loose("Hold released after the amended order arrived") })).toContainText(loose("Not yet: Hold released after the amended order arrived"));

  // Before any review: the order is already v2, but the answer waits for review and the hold is still on.
  await page.goto(`/intake?item=${INTAKE_B}`);
  const source = page.getByRole("region", { name: /^Source order/ });
  await expect(source).toContainText(loose("v2 · amended"));
  await expect(source.getByRole("row", { name: /^B Left dorsal forearm Left Punch/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Holds, questions and tasks" })).toContainText(loose(`Hold ${HOLD}`));

  await actAs(context, STAFF.kim);
  await page.goto(`/clarifications?selected=${CLR}`);
  await expect(decision.getByRole("heading", { level: 3, name: "Review the answer from Harbor Point Dermatology" })).toBeVisible();
  await expect(panel).toContainText(loose("Simulated office reply: The container is correct. Part B was taken from the LEFT dorsal forearm."));
  await expect(panel).toContainText(loose("Not resolved: a lead or supervisor must review this answer."));
  await expect(panel).toContainText(loose("The source order was amended: ORD-77121 v2 received from the simulated source"));
  await expect(panel.getByRole("heading", { level: 3, name: /^Part B on hold:/ })).toBeVisible();
  const release = panel.getByRole("button", { name: `Release ${HOLD}` });
  await expect(release).toBeDisabled();
  await expect(panel).toContainText(loose(`Resolve ${CLR} first.`));

  // Kim reviews, resolves (keeping the hold), then releases it with a reason: three separate steps.
  // The review note is written in the conversation's review slot, under the office answer; the commit is docked.
  const reviewSlot = panel
    .getByRole("list", { name: /^Conversation with Harbor Point Dermatology/ })
    .getByRole("listitem")
    .filter({ hasText: loose("Review by Kim Nguyen") });
  await expect(decision.getByLabel("Review note")).toHaveCount(0);
  // With no note yet, the dock's primary takes Kim to the note; it never names a commit that cannot run.
  await expect(decision.getByRole("button", { name: "Write review note" })).toBeVisible();
  await expect(decision.getByRole("button", { name: "Mark answer reviewed" })).toHaveCount(0);
  await reviewSlot.getByLabel("Review note").fill("Office says the bottle (left dorsal forearm) is correct; amended order ORD-77121 v2 is already in.");
  await decision.getByRole("button", { name: "Mark answer reviewed" }).click();
  await expect(decision.getByRole("heading", { level: 3, name: `Resolve ${CLR}` })).toBeVisible();
  await decision.getByRole("button", { name: "Resolve", exact: true }).click();
  const resolve = page.getByRole("dialog", { name: `Resolve ${CLR}?` });
  await resolve.getByRole("textbox", { name: /^Resolution note/ }).fill("Left side confirmed by the office.");
  await expect(resolve.getByRole("checkbox", { name: new RegExp(`^Also release ${HOLD}`) })).not.toBeChecked();
  await resolve.getByRole("button", { name: "Resolve, keep hold" }).click();
  await expect(resolve).toBeHidden();
  await expect(panel).toContainText(loose("Resolved by Kim Nguyen: Office confirmed what we observed (container is correct)."));
  await expect(panel.getByRole("heading", { level: 3, name: /^Part B on hold:/ })).toBeVisible();
  // Resolved with the hold kept, it stays in Kim's queue as a hold she still has to release.
  const queue = page.getByRole("complementary", { name: "Clarification queue" });
  const heldRow = queue.getByRole("link", { name: new RegExp(`^${CLR}, .*Hold to release · Kim Nguyen, on hold: Part B, Resolved$`) });
  await expect(heldRow).toBeVisible();

  // Once resolved, releasing the hold is the docked next step.
  await expect(decision.getByRole("heading", { level: 3, name: `Release ${HOLD} on Part B` })).toBeVisible();
  await release.click();
  const releaseDialog = page.getByRole("alertdialog", { name: `Release ${HOLD} on Part B?` });
  await releaseDialog.getByLabel("Release reason").fill("Amended order ORD-77121 v2 received (laterality left), matching the bottle.");
  await releaseDialog.getByRole("button", { name: "Release hold" }).click();
  await expect(toasts(page)).toContainText(loose(`${HOLD} released. The release and its reason are in History.`));
  await expect(panel.getByRole("heading", { level: 3, name: /^Part B on hold:/ })).toHaveCount(0);
  await expect(heldRow).toHaveCount(0);

  await openGuideStep(page, 3);
  await expect(page.getByText(loose("Done: Hold released after the amended order arrived"))).toBeVisible();
});
