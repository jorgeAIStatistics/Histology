// Critical browser journey (master spec §12 and §13, docs/demo-script.md): the
// eight-step director demonstration on the real screens, in order, against a
// fresh synthetic demo day. Staff actions are clicks on the real screens as the
// named demo role; only world events (courier arrival, the simulated source
// sync) use the guided demo's "Run simulator events for this step" button.
// Every step checks visible text or state, not just "no error".
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  STAFF,
  actAs,
  loose,
  looseNumber,
  openGuideStep,
  openRoleContext,
  postCommandFromPage,
  re,
  recordOnPage,
  resetDemo,
  runSimulatorEvents,
  toasts,
} from "./support";

const HERO_ACCESSION = "D26-04817";
const INTAKE_A = "INT-1014-031";
const INTAKE_B = "INT-1014-032";
const UNKNOWN_OFFICE_ITEM = "INT-1014-034";
// The ids the presenter's script promises (docs/demo-script.md, "IDs used here"); the journey checks the app issues them.
const SCRIPT_IDS = { clarification: "CLR-0457", hold: "H-0090", reprint: "PJ-8842" } as const;

// Filled in as the journey creates them (shown on screen; read back from the screen).
const ids = { clarification: "", hold: "" };

/**
 * The intake decision column, with its "Also yours now" tasks in reach. In a short column that list folds to
 * its heading, a count and the task titles that fit whole (a disclosure, never a half-shown task or button);
 * when folded it says so and opens on request.
 */
async function decisionWithAlsoYours(page: Page) {
  const decision = page.getByRole("complementary", { name: "Decision" });
  const also = decision.getByRole("region", { name: /^Also yours now/ });
  await expect(also).toBeVisible();
  const fold = also.getByRole("button", { name: /^Show (it|all \d+)$/ });
  if (await fold.isVisible()) {
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await fold.click();
    await expect(also.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
  }
  return decision;
}

test.describe.configure({ mode: "serial" });

test.describe("director journey: one synthetic multipart case, eight steps on the real screens", () => {
  test.beforeAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await resetDemo(request);
    await request.dispose();
  });

  // Extra windows (other demo roles) opened by a step are closed even when the step fails.
  const extraContexts: BrowserContext[] = [];
  test.afterEach(async () => {
    for (const c of extraContexts.splice(0)) await c.close().catch(() => undefined);
  });

  test("1. courier arrival: expected vs received per office, rule-based routing, unknown office goes to exceptions", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openGuideStep(page, 1);
    await expect(page.getByText(looseNumber("0 of 8 steps done (read from the records)"))).toBeVisible();

    // World event: the 11:00 courier arrives and is unpacked (simulated scan, received by Maya Torres).
    const { actions: step1Actions } = await runSimulatorEvents(page, 1);
    await expect(step1Actions.filter({ hasText: loose("Done: Courier arrives: record arrival of CR-1014-11 (received by Maya Torres)") })).toHaveCount(1);
    await expect(page.getByText(loose("Demo clock 11:00 AM ET, paused"))).toBeVisible();

    // Intake bench: the manifest strip reconciles expected vs received per office.
    await page.goto("/intake");
    const manifest = page.getByRole("region", { name: "Courier manifest" });
    await expect(manifest.getByRole("button", { name: /^CR-1014-11/ })).toHaveAttribute("aria-pressed", "true");
    await expect(manifest).toContainText(loose("Received 11 · Expected Unknown (2 offices sent no manifest; 10 on manifests)"));
    const office = (name: string) => manifest.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
    await expect(office("Harbor Point Dermatology")).toContainText(loose("Expected 4 · Received 4 · Missing 0"));
    await expect(office("Coral Lane Dermatology")).toContainText(loose("Expected 3 · Received 2 · Missing 1"));
    // A missing manifest is "Unknown", never 0.
    await expect(office("Mangrove Bay Dermatology")).toContainText(loose("Expected Unknown (no source manifest) · Received 1"));
    await expect(office("Seagrape Skin Studio")).toContainText(loose("Expected Unknown (no source manifest) · Received 1"));
    await expect(office("Seagrape Skin Studio")).toContainText(loose("Office not in the routing directory"));
    await expect(manifest).toContainText(loose("A delivery with an unknown expectation is never shown as complete."));

    // Hero item: the routing suggestion names the approved, versioned rule.
    await page.goto(`/intake?item=${INTAKE_A}`);
    await expect(page.getByRole("heading", { level: 2, name: `Provisional intake item ${INTAKE_A}` })).toBeVisible();
    const routingA = page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ });
    await expect(routingA).toContainText(loose("Suggested dermatopathologist Dr. Elena Marsh"));
    await expect(routingA).toContainText(loose("From rule: Harbor Point Dermatology → Dr. Elena Marsh (rule set v3, effective Sep 1)."));
    // Accepting the suggestion is an action of the person at the bench: it lives in the decision column, never next to the rule.
    await expect(routingA.getByRole("button", { name: /^Accept routing/ })).toHaveCount(0);
    await (await decisionWithAlsoYours(page)).getByRole("button", { name: "Accept routing to Dr. Elena Marsh" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /Rule applied · confirmed/ })).toBeVisible();
    await expect(routingA).toContainText(loose("Decided by Maya Torres"));

    // Part B's item is routed by the same rule (needed before the accession in step 4).
    await page.goto(`/intake?item=${INTAKE_B}`);
    const routingB = page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ });
    await expect(routingB).toContainText(loose("rule set v3"));
    await (await decisionWithAlsoYours(page)).getByRole("button", { name: "Accept routing to Dr. Elena Marsh" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /Rule applied · confirmed/ })).toBeVisible();

    // Unknown office: routing exception lane, no doctor guessed.
    await page.goto(`/intake?item=${UNKNOWN_OFFICE_ITEM}`);
    // The item sits in the Exceptions lane of the queue, selected, with its reason.
    const unknownRow = page.getByRole("region", { name: /^Exceptions/ }).getByRole("link", { name: new RegExp(`^Provisional intake item ${UNKNOWN_OFFICE_ITEM}`) });
    await expect(unknownRow).toHaveAttribute("aria-current", "true");
    // A routing exception waits for a named person (neutral rung), it is not shown as a source disagreement.
    await expect(unknownRow).toContainText(loose("Needs routing · Kim Nguyen"));
    await expect(page.getByRole("region", { name: "Current finding" })).toContainText(loose("Seagrape Skin Studio has no routing rule, so no dermatopathologist is suggested."));
    const routingX = page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ });
    await expect(routingX).toContainText(loose("Routing exception: no approved rule applies"));
    await expect(routingX).toContainText(loose("No dermatopathologist is suggested"));
    await expect(routingX).toContainText(loose("Assigned dermatopathologist Unassigned: routing exception"));
    await expect(routingX).not.toContainText(loose("Dr. "));
    await expect(routingX.getByRole("button", { name: "Accept routing" })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Decision" }).getByRole("button", { name: /^Accept routing/ })).toHaveCount(0);
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity).toContainText(loose("Seagrape Skin Studio"));
    // No dermatopathologist is guessed: "Routed to" names nobody (the ordering clinician is a different person and is shown as such).
    await expect(identity).toContainText(loose("Routed to Unassigned: routing exception"));
    await expect(identity).not.toContainText(/Routed to\s*Dr\./);
    await expect(identity).toContainText(loose("Ordered by Dr. Felix Moon"));
  });

  test("2. related orders: verify A, verify B shows the laterality discrepancy, the lead decides (one accession, nothing merged)", async ({ page, context }) => {
    await actAs(context, STAFF.maya);

    // Container A: staff verified against the physical container; every compared field agrees.
    await page.goto(`/intake?item=${INTAKE_A}`);
    const containerA = page.getByRole("region", { name: /^Container 1 of Part A Order ORD-77120/ });
    await expect(containerA).toContainText(loose("Not yet verified"));
    await page.getByRole("complementary", { name: "Decision" }).getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77120 Staff verified$/ })).toBeVisible();
    await expect(containerA).toContainText(loose("Last check by Maya Torres"));
    await expect(containerA).toContainText(loose("against ORD-77120 v1: all compared fields agree"));

    // An accessioner can see the related-order candidate but not decide it.
    const relatedA = page.getByRole("region", { name: "Related orders" });
    await expect(relatedA).toContainText(loose("Needs review"));
    await expect(relatedA).toContainText(loose("Same encounter: ENC-55031"));
    await expect(relatedA).toContainText(loose("Your demo role can view the candidate but not decide"));
    await expect(relatedA.getByRole("button", { name: "Record decision" })).toHaveCount(0);
    // Hiding the button is not the protection: a decision sent by hand as the accessioner is refused by the server (check 12).
    const candidate = await recordOnPage(page, "rel", "REL-0112");
    const forged = await postCommandFromPage(page, "related.review", {
      candidateId: candidate.id,
      expectedVersion: candidate.version,
      decision: "single_accession_approved",
      reason: "Sent by hand as an accessioner.",
    });
    expect(forged.status).toBe(403);
    expect(forged.body.ok).toBe(false);
    expect(forged.body.error?.code).toBe("FORBIDDEN");
    expect(forged.body.error?.message).toBe("Not allowed: Accessioner cannot decide on related orders. Allowed: Accessioning lead, Operations supervisor.");
    await page.reload();
    await expect(relatedA).toContainText(loose("Needs review"));
    await expect(relatedA).not.toContainText(loose("Decision by"));
    await expect(relatedA).not.toContainText(loose("Sent by hand"));

    // Container B: the laterality differs; both values are kept and shown.
    await page.goto(`/intake?item=${INTAKE_B}`);
    const containerB = page.getByRole("region", { name: /^Container 1 of Part B Order ORD-77121/ });
    await page.getByRole("complementary", { name: "Decision" }).getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part B Order ORD-77121 Discrepancy recorded$/ })).toBeVisible();
    // The finding says it once, in words; the differing row comes first and keeps both values.
    await expect(page.getByRole("region", { name: "Current finding" })).toContainText(loose("Laterality differs: the bottle says left; the order and the requisition say right."));
    await expect(containerB.getByRole("row").nth(1)).toHaveAccessibleName(/^Laterality /);
    await expect(containerB).toContainText(loose("Both values are kept; nothing is corrected automatically."));
    const lateralityRow = containerB.getByRole("row", { name: /^Laterality / });
    await expect(lateralityRow.getByRole("cell").nth(0)).toHaveText("Right");
    await expect(lateralityRow.getByRole("cell").nth(1)).toContainText(loose('L from site text "L dorsal forearm"'));
    await expect(lateralityRow).toContainText(loose("Differs"));
    // The identity band names the side in question only; who says what is said once, in the finding.
    const identityB = page.getByRole("region", { name: "Current case" });
    await expect(identityB).toContainText(loose("Side: right or left?"));
    await expect(identityB).not.toContainText(loose("bottle says"));

    // The accessioning lead decides the candidate, with a reason.
    await actAs(context, STAFF.kim);
    await page.goto(`/intake?item=${INTAKE_A}`);
    // Her decision leads the centre at the bench size: both submissions side by side, each reason and the conflict
    // read from both records in aligned columns, then the four choices, the chosen one's effect and the reason.
    // "Record decision" stays pinned in the decision column, under the step heading and the review-not-merge rule.
    const workspace = page.getByRole("region", { name: "REL-0112 side by side" });
    await expect(workspace.getByRole("columnheader", { name: new RegExp(`^Part A\\s*Provisional intake item ${INTAKE_A}`) })).toBeVisible();
    await expect(workspace.getByRole("columnheader", { name: new RegExp(`^Part B\\s*Provisional intake item ${INTAKE_B}`) })).toBeVisible();
    await expect(workspace.getByRole("row", { name: /^Same encounter / })).toContainText(loose("ENC-55031 ENC-55031"));
    await expect(workspace.getByRole("row", { name: /^Same submitting office / })).toContainText(loose("Harbor Point Dermatology Harbor Point Dermatology"));
    await expect(workspace.getByRole("row", { name: /^Separate source orders / })).toContainText(loose("ORD-77120 ORD-77121"));
    const kimDecision = page.getByRole("complementary", { name: "Decision" });
    await expect(kimDecision.getByRole("heading", { level: 3, name: "Decide REL-0112: one case or two?" })).toBeVisible();
    await expect(kimDecision).toContainText(loose("Review, not merge. Both orders and both provisional ids are kept."));
    // Everything the decision needs is in view at 1366x768, without scrolling: the four choices, the reason and the action.
    for (const name of [/^Link as related/, /^Keep separate/, /^Not related/, /^Ask the office first/]) {
      await expect(workspace.getByRole("radio", { name })).toBeInViewport({ ratio: 1 });
    }
    await expect(workspace.getByLabel(/^Reason/)).toBeInViewport({ ratio: 1 });
    await expect(kimDecision.getByRole("button", { name: "Record decision" })).toBeInViewport({ ratio: 1 });
    // Choosing shows its effect beside the choices before anything is recorded.
    await workspace.getByRole("radio", { name: /^Link as related: one accession, parts kept with their original orders/ }).check();
    const effect = workspace.getByRole("status").filter({ hasText: "If recorded" });
    await expect(effect).toContainText(
      loose(`If recorded: ${INTAKE_A} and ${INTAKE_B} are requested together as one accession. Parts keep their original orders (ORD-77120 and ORD-77121) and both provisional ids stay on record. Nothing is merged.`),
    );
    await expect(effect).toBeInViewport({ ratio: 1 });
    await workspace.getByLabel(/^Reason/).fill("Same patient reference, encounter ENC-55031, office and collection day. Parts A and B keep ORD-77120 and ORD-77121.");
    await kimDecision.getByRole("button", { name: "Record decision" }).click();
    const related = page.getByRole("region", { name: "Related orders" });
    await expect(related).toContainText(loose("REL-0112"));
    await expect(related).toContainText(loose("Decision by Kim Nguyen"));
    await expect(related).toContainText(loose("Approved: one accession, parts kept with original orders"));
    await expect(related).toContainText(loose("Reason: Same patient reference, encounter ENC-55031"));
    // Nothing is merged: both source orders and both intake items are kept.
    await expect(related).toContainText(loose("Order ORD-77120"));
    await expect(related).toContainText(loose("Order ORD-77121"));
    await expect(related).toContainText(loose("ORD-77121 and ORD-77120 stay separate source records (both kept)"));
    await expect(related.getByRole("link", { name: new RegExp(`^Provisional intake item ${INTAKE_B}`) })).toBeVisible();
    await expect(page.getByRole("region", { name: "History" }).first()).toContainText(loose("approved as one accession (parts kept with their original orders; nothing merged) by Kim Nguyen"));
  });

  test("3. part B clarification: scoped hold, simulated send and answer, lead review and resolution, hold kept until the amended order arrives", async ({ page, context }) => {
    // The accessioner raises the clarification from the differing laterality row, with a hold on Part B only.
    await actAs(context, STAFF.maya);
    await page.goto(`/intake?item=${INTAKE_B}`);
    await page.getByRole("button", { name: "Raise clarification for laterality on container 1" }).click();
    const raise = page.getByRole("dialog", { name: "Raise clarification" });
    await expect(raise.getByLabel("Category")).toHaveValue("laterality");
    await expect(raise.getByLabel("Question for the office")).toHaveValue(/order ORD-77121 says "Right"/);
    await expect(raise.getByRole("row", { name: /^Laterality / })).toContainText(loose("Right"));
    const holdBox = raise.getByRole("checkbox", { name: /Place a scoped hold Hold: Part B \(ORD-77121 · B\)/ });
    await expect(holdBox).toBeChecked();
    await expect(raise).toContainText(loose("Blocks gross approval, processing, label printing, tray delivery for Part B (ORD-77121 · B) only. Accession is not blocked"));
    await raise.getByRole("button", { name: "Raise clarification", exact: true }).click();
    const openLink = raise.getByRole("link", { name: /^Open CLR-\d+ in Clarifications$/ });
    await expect(openLink).toBeVisible();
    ids.clarification = (await openLink.innerText()).match(/CLR-\d+/)![0];
    expect(ids.clarification, "the clarification id the demo script tells the presenter to open").toBe(SCRIPT_IDS.clarification);
    await raise.getByRole("button", { name: "Done" }).click();

    // The hold is visible and names its scope; Part A is not held.
    const holds = page.getByRole("region", { name: "Holds, questions and tasks" });
    await expect(holds).toContainText(loose("Hold: Part B (ORD-77121 · B)"));
    await expect(holds).toContainText(loose("Accession is not blocked"));
    ids.hold = (await holds.innerText()).match(/\bH-\d{4}\b/)![0];
    expect(ids.hold, "the hold id the demo script names").toBe(SCRIPT_IDS.hold);
    // The hold leads the hold line as the hatched chip naming its scope (Part B), then its id and what it stops; Part A is free.
    const finding = page.getByRole("region", { name: "Current finding" });
    // Said once: the step rail names the question and its state; the differing row keeps both values without repeating it.
    await expect(finding.getByRole("button", { name: /^Step 2, Differences/ })).toContainText(loose(`${ids.clarification} · not sent`));
    const evidenceB = page.getByRole("region", { name: /^Container 1 of Part B Order ORD-77121/ });
    await expect(evidenceB).toContainText(loose("Both values are kept; nothing is corrected automatically."));
    await expect(evidenceB).not.toContainText(loose("drafted, not sent"));
    await expect(finding).toContainText(loose(`Hold: Part B ${ids.hold} stops gross approval`));
    await expect(finding).toContainText(loose("stops gross approval, processing, label printing and tray delivery. Accession is not held. Part A can continue."));

    // Clarifications screen, as the accessioning lead.
    await actAs(context, STAFF.kim);
    await page.goto(`/clarifications?selected=${ids.clarification}`);
    // The open question is one region: the material as its label, the conversation, and the docked decision.
    const panel = page.getByRole("region", { name: /^Laterality question: INT-1014-032 · ORD-77121 Part B/ });
    const decision = panel.getByRole("complementary", { name: "Decision" });
    await expect(panel).toContainText(loose("Drafted"));
    // The material in hand is its provisional label (dashed), never an accession number; drafted never reads as sent.
    await expect(panel).toContainText(loose("Provisional intake item INT-1014-032, not an accession number"));
    await expect(panel).toContainText(loose("Drafted, not sent."));
    await expect(panel).toContainText(loose("Hold applies to Part B only. Part A (ORD-77120) can continue."));
    const release = panel.getByRole("button", { name: `Release ${ids.hold}` });
    await expect(release).toBeDisabled();
    await expect(panel).toContainText(loose(`Resolve ${ids.clarification} first.`));

    // Send (simulated notification). The notice is generic: it points to the secure case view and carries no patient details.
    const NOT_IN_NOTICE = /Quinlan|Avery|448210|1961|03-22|dorsal forearm|Right|ORD-77121/; // patient identifiers and the question itself
    const notice = panel.getByLabel("Notification text (generic)");
    await expect(notice).toHaveValue(new RegExp(`has a specimen question \\(${ids.clarification}\\)\\. Please open the secure case view to respond`));
    await expect(notice).not.toHaveValue(NOT_IN_NOTICE);
    await expect(decision.getByRole("heading", { level: 3, name: `Send ${ids.clarification} to Harbor Point Dermatology` })).toBeVisible();
    await decision.getByRole("button", { name: "Send (simulated)" }).click();
    await expect(decision.getByRole("heading", { level: 3, name: "Record the answer from Harbor Point Dermatology" })).toBeVisible();
    await expect(panel).toContainText(loose("Delivered"));
    // The message that went out (simulated) is the generic notice, nothing more.
    const sent = panel.getByRole("list", { name: /^Conversation with Harbor Point Dermatology/ }).getByRole("listitem").filter({ hasText: loose("Initial notice") });
    await expect(sent).toHaveCount(1);
    await expect(sent).toContainText(loose(`has a specimen question (${ids.clarification}). Please open the secure case view to respond. [SIMULATED — not sent]`));
    await expect(sent).toContainText(loose("Delivered (simulated)"));
    await expect(sent).not.toContainText(NOT_IN_NOTICE);

    // Simulated office answer (a presenter control, kept apart from the bench actions): it does not resolve anything by itself.
    await panel.getByText("Presenter controls (demo)").click();
    await panel.getByRole("button", { name: "Simulate office answer (demo)" }).click();
    await expect(decision.getByRole("heading", { level: 3, name: "Review the answer from Harbor Point Dermatology" })).toBeVisible();
    await expect(panel).toContainText(loose("Simulated office reply: The container is correct. Part B was taken from the LEFT dorsal forearm."));
    await expect(panel).toContainText(loose("Not resolved: a lead or supervisor must review this answer."));
    await expect(release).toBeDisabled();

    // Review, then resolve, keeping the hold. The review note is written where the review belongs (the conversation's
    // review slot, under the office answer); its commit is docked. An empty note never marks the answer reviewed:
    // until a note exists the dock's primary is "Write review note" (it takes you to the slot), never the commit.
    const conversation = panel.getByRole("list", { name: /^Conversation with Harbor Point Dermatology/ });
    const reviewSlot = conversation.getByRole("listitem").filter({ hasText: loose("Review by Kim Nguyen") });
    const reviewNote = reviewSlot.getByLabel("Review note");
    await expect(decision.getByLabel("Review note")).toHaveCount(0);
    await expect(decision.getByRole("button", { name: "Mark answer reviewed" })).toHaveCount(0);
    await decision.getByRole("button", { name: "Write review note" }).click();
    await expect(reviewNote).toBeFocused();
    // Ctrl+Enter on an empty note records nothing; sending the answer back with an empty note says what is missing.
    await reviewNote.press("Control+Enter");
    await expect(reviewNote).toBeFocused();
    await decision.getByRole("button", { name: "Answer is insufficient" }).click();
    await expect(reviewSlot).toContainText(loose("Say what is missing from the answer before sending it back."));
    await expect(decision.getByRole("heading", { level: 3, name: "Review the answer from Harbor Point Dermatology" })).toBeVisible();
    await reviewNote.fill("Office says the bottle (left dorsal forearm) is correct and will amend ORD-77121.");
    await expect(decision.getByRole("button", { name: "Write review note" })).toHaveCount(0);
    await decision.getByRole("button", { name: "Mark answer reviewed" }).click();
    await expect(decision.getByRole("heading", { level: 3, name: `Resolve ${ids.clarification}` })).toBeVisible();
    await decision.getByRole("button", { name: "Resolve", exact: true }).click();
    const resolve = page.getByRole("dialog", { name: `Resolve ${ids.clarification}?` });
    await expect(resolve).toContainText(loose("It does not release any hold by itself."));
    await expect(resolve.getByRole("combobox", { name: /^Resolution/ })).toHaveValue("confirmed_observed");
    await resolve.getByRole("textbox", { name: /^Resolution note/ }).fill("Left side confirmed by the office. Hold on Part B stays until the amended order arrives.");
    await expect(resolve.getByRole("checkbox", { name: new RegExp(`^Also release ${ids.hold}`) })).not.toBeChecked();
    await resolve.getByRole("button", { name: "Resolve, keep hold" }).click();
    await expect(resolve).toBeHidden();
    await expect(panel).toContainText(loose("Resolved by Kim Nguyen: Office confirmed what we observed (container is correct)."));

    // Resolved, but the hold is still active and the order is still version 1.
    await expect(panel.getByRole("heading", { level: 3, name: /^Part B on hold:/ })).toBeVisible();
    await expect(panel).toContainText(loose(`${ids.hold}. Not released by sending, an answer, or resolution alone`));
    await expect(panel).not.toContainText(loose("The source order was amended"));
    await page.goto(`/intake?item=${INTAKE_B}`);
    await expect(page.getByRole("region", { name: "Holds, questions and tasks" })).toContainText(loose(`Hold ${ids.hold}`));
    await expect(page.getByRole("region", { name: /^Source order/ })).toContainText(loose("v1 · active"));

    // World event: the guided demo's step 3 simulator. The office answer is already in (and reviewed), so it only
    // delivers amended order ORD-77121 v2 from the simulated source, and says what is still left for the lead.
    const { result, actions } = await runSimulatorEvents(page, 3);
    await expect(actions.filter({ hasText: loose(`Already done: Simulated office answer for ${ids.clarification}`) })).toHaveCount(1);
    await expect(actions.filter({ hasText: loose("Done: Simulated source sync: deliver amended order ORD-77121 v2 (laterality left)") })).toHaveCount(1);
    await expect(result).toContainText(
      loose(
        `The office answer was already handled (${ids.clarification} is resolved). Amended order ORD-77121 v2 has arrived from the simulated source. ${ids.hold} stays active until a lead releases it with a reason on the Clarifications screen.`,
      ),
    );
    await expect(result).not.toContainText(loose("review the answer"));
    await expect(page.getByRole("list").filter({ hasText: loose("Hold released after the amended order arrived") })).toContainText(loose("Not yet: Hold released after the amended order arrived"));

    // The amended order is in; the hold is still active until the lead releases it.
    await page.goto(`/intake?item=${INTAKE_B}`);
    const source = page.getByRole("region", { name: /^Source order/ });
    await expect(source).toContainText(loose("v2 · amended"));
    await expect(source.getByRole("row", { name: /^B Left dorsal forearm Left Punch/ })).toBeVisible();
    const holdsB = page.getByRole("region", { name: "Holds, questions and tasks" });
    await expect(holdsB).toContainText(loose(`Hold ${ids.hold}`));
    await expect(holdsB).toContainText(loose(`Amended order received — review and release ${ids.hold}`));

    // Everything is in place for the release now, yet an accessioner's hand-made release is refused by the server (check 12).
    await actAs(context, STAFF.maya);
    await page.goto(`/clarifications?selected=${ids.clarification}`);
    await expect(panel.getByRole("heading", { level: 3, name: /^Part B on hold:/ })).toBeVisible();
    const hold = await recordOnPage(page, "hold", ids.hold);
    const forged = await postCommandFromPage(page, "hold.release", { holdId: hold.id, expectedVersion: hold.version, reason: "Sent by hand as an accessioner." });
    expect(forged.status).toBe(403);
    expect(forged.body.error?.code).toBe("FORBIDDEN");
    expect(forged.body.error?.message).toBe("Not allowed: Accessioner cannot release holds. Allowed: Accessioning lead, Operations supervisor.");
    await page.reload();
    await expect(panel.getByRole("heading", { level: 3, name: /^Part B on hold:/ })).toBeVisible();
    await expect(panel).not.toContainText(loose(`${ids.hold} on Part B (ORD-77121 · B) released`));
    // On screen the accessioner sees the release as the next step, disabled with the reason in words.
    await expect(decision.getByRole("button", { name: `Release ${ids.hold}` })).toBeDisabled();
    await expect(decision).toContainText(loose("Not allowed for Accessioner. Allowed: Accessioning lead, Operations supervisor."));

    // The lead releases the hold with a reason.
    await actAs(context, STAFF.kim);
    await page.goto(`/clarifications?selected=${ids.clarification}`);
    await expect(panel).toContainText(loose("The source order was amended: ORD-77121 v2 received from the simulated source"));
    await expect(panel).toContainText(loose("Superseded by ORD-77121 v2"));
    await expect(decision.getByRole("heading", { level: 3, name: `Release ${ids.hold} on Part B` })).toBeVisible();
    await decision.getByRole("button", { name: `Release ${ids.hold}` }).click();
    const releaseDialog = page.getByRole("alertdialog", { name: `Release ${ids.hold} on Part B?` });
    await releaseDialog.getByLabel("Release reason").fill("Amended order ORD-77121 v2 received (laterality left), matching the bottle.");
    await releaseDialog.getByRole("button", { name: "Release hold" }).click();
    await expect(toasts(page)).toContainText(loose(`${ids.hold} released. The release and its reason are in History.`));
    await expect(panel).toContainText(new RegExp(`${ids.hold} on Part B \\(ORD-77121 · B\\) released .* by Kim Nguyen\\. Reason: Amended order ORD-77121 v2 received`));
    await expect(panel.getByRole("heading", { level: 3, name: /^Part B on hold:/ })).toHaveCount(0);

    await openGuideStep(page, 3);
    await expect(page.getByText(loose("Done: Hold released after the amended order arrived"))).toBeVisible();
  });

  test("4. accession: the simulated source issues D26-04817; the case keeps parts A and B on their original orders", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await page.goto(`/intake?item=${INTAKE_A}`);
    await expect(page.getByRole("region", { name: "Current case" })).toContainText(loose(`Provisional intake item ${INTAKE_A}, not an accession number`));
    await expect(page.getByText(loose("Ready: every check passed. The number is issued by the simulated source, never typed here."))).toBeVisible();
    // A double click (the demo script's "a double click creates nothing extra") still yields one accession.
    await page.getByRole("button", { name: new RegExp(`^Request accession for (${INTAKE_A} \\+ ${INTAKE_B}|${INTAKE_B} \\+ ${INTAKE_A}) together \\(simulated source\\)$`) }).dblclick();
    await expect(toasts(page)).toContainText(loose(`Accession ${HERO_ACCESSION} issued by EMA-SIM (simulated)`));

    // The official number is shown as an accession, distinct from the provisional intake id that stays on record.
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity).toContainText(loose(`Accession ${HERO_ACCESSION}`));
    await expect(identity).toContainText("EMA-SIM DERM");
    await expect(identity).not.toContainText(loose("Provisional"));
    await expect(page.getByRole("link", { name: `Open case ${HERO_ACCESSION}` })).toBeVisible();
    await expect(page.getByText(loose("Issued by EMA-SIM (simulated)"))).toBeVisible();
    await expect(page.getByText(loose(`provisional ${INTAKE_A} stays on record`))).toBeVisible();
    // The item now in hand is done, so the Done lane is open on it.
    await expect(page.getByRole("button", { name: /^Done today/ })).toHaveAttribute("aria-expanded", "true");
    const done = page.getByRole("region", { name: "Done today" });
    await expect(done.getByRole("link", { name: new RegExp(`^Accession ${HERO_ACCESSION} , namespace EMA-SIM DERM Accessioned .*Avery Quinlan .* From provisional ${INTAKE_A}`) })).toBeVisible();
    await expect(done.getByRole("link", { name: new RegExp(`^Accession ${HERO_ACCESSION} , namespace EMA-SIM DERM Accessioned .*Avery Quinlan .* From provisional ${INTAKE_B}`) })).toBeVisible();
    // Nothing extra from the double click: exactly the two Quinlan items, both on D26-04817, and no further number issued.
    await expect(done.getByRole("link", { name: new RegExp(`^Accession ${HERO_ACCESSION} `) })).toHaveCount(2);
    await expect(done.getByRole("link", { name: /^Accession D26-04818 / })).toHaveCount(0);

    // Case page: parts A and B, each on its own source order.
    await page.goto(`/cases/${HERO_ACCESSION}`);
    await expect(page.getByRole("heading", { level: 1, name: `Case ${HERO_ACCESSION}` })).toBeVisible();
    await expect(page.getByText(looseNumber("2 parts from 2 source orders"))).toBeVisible();
    const partA = page.getByRole("region", { name: "Part A", exact: true });
    const partB = page.getByRole("region", { name: "Part B", exact: true });
    await expect(partA.getByRole("link", { name: /^Order ORD-77120/ })).toBeVisible();
    await expect(partA).toContainText(loose("Left upper back, shave"));
    await expect(partB.getByRole("link", { name: /^Order ORD-77121/ })).toBeVisible();
    await expect(partB).toContainText(loose("Left dorsal forearm, punch"));
    await expect(page.getByText(loose("Not complete: 0 of 2 parts delivered."))).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Case sections" }).getByRole("link", { name: /^Source documents \(2\)/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Operational summary" })).toContainText(loose("Not merged: ORD-77120 and ORD-77121 both stay attached to their parts."));

    // History: who did what, once each (one accession request, one issued number), with the lead's decision and release.
    await page.getByRole("navigation", { name: "Case sections" }).getByRole("link", { name: /^History/ }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${HERO_ACCESSION}\\?tab=history`));
    const history = page.getByRole("region", { name: "History" });
    const event = (text: string | RegExp) => history.getByRole("listitem").filter({ hasText: typeof text === "string" ? loose(text) : text });
    const requested = event(new RegExp(`Maya Torres requested an accession from the simulated source for (${INTAKE_A} \\+ ${INTAKE_B}|${INTAKE_B} \\+ ${INTAKE_A}) \\(request AR-\\d+\\)`));
    await expect(requested).toHaveCount(1);
    await expect(requested).toContainText(loose("Maya Torres, Accessioner"));
    await expect(event(`Accession ${HERO_ACCESSION} (EMA-SIM DERM) issued by EMA-SIM (simulated) for request AR-`)).toHaveCount(1);
    const decision = event("REL-0112 (ORD-77120 + ORD-77121) approved as one accession (parts kept with their original orders; nothing merged) by Kim Nguyen.");
    await expect(decision).toHaveCount(1);
    await expect(decision).toContainText(loose("Kim Nguyen, Accessioning lead"));
    const released = event(`${ids.hold} released on Part B (ORD-77121 · B)`);
    await expect(released).toContainText(loose("Kim Nguyen, Accessioning lead"));
    await expect(released).toContainText(loose("Reason: Amended order ORD-77121 v2 received (laterality left), matching the bottle."));

    // The double click did not issue a second number.
    await page.goto("/cases/D26-04818");
    await expect(page.getByRole("heading", { level: 1, name: "Case not found" })).toBeVisible();
  });

  test("5. gross record for part A: proposals need explicit confirmation; approval opens downstream work while part B stays incomplete", async ({ page, context, browser }) => {
    await actAs(context, STAFF.dana);

    // A second window keeps the worklist open throughout (a second screen at the bench). It is never reloaded or
    // navigated: the approval below must reach it through the live refresh alone (spec §12 step 5, check 7).
    const watcherContext = await openRoleContext(browser, STAFF.dana);
    extraContexts.push(watcherContext);
    const watcher = await watcherContext.newPage();
    await watcher.goto("/worklist");
    // The doctor band's toggle names the doctor and the colour in words ("Dr. Elena Marsh (teal)"), never the colour alone.
    const marsh = watcher.getByRole("rowgroup").filter({ has: watcher.getByRole("button", { name: /^Dr\. Elena Marsh \(teal\)$/ }) });
    const row = marsh.getByRole("row", { name: new RegExp(`^${HERO_ACCESSION},`) });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText(loose("A ready for processing"));
    await expect(row).not.toContainText(loose("Entry pending"));
    await watcher.evaluate(() => {
      (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
    });
    const watcherUrl = watcher.url();

    await page.goto(`/grossing?part=${HERO_ACCESSION}-A`);
    await expect(page.getByRole("heading", { level: 1, name: `Gross record for ${HERO_ACCESSION} Part A` })).toBeVisible();
    // The case action in the identity bar is named in words with the accession (icon only below 1280px).
    await expect(page.getByRole("region", { name: "Current case" }).getByRole("link", { name: `Open case ${HERO_ACCESSION}` })).toBeVisible();

    // Load the synthetic dictation: values are proposed, never confirmed by the extractor.
    await expect(page.getByLabel("Synthetic dictation")).toHaveValue("quinlan-A");
    await page.getByRole("button", { name: "Attach transcript and extract" }).click();
    await expect(page.getByText(loose("Proposed from transcript, not confirmed"))).toHaveCount(9);
    await expect(page.getByText(loose("Confirmed by Dana Whitfield"))).toHaveCount(0);
    const next = page.getByRole("region", { name: `Next step for ${HERO_ACCESSION} Part A` });
    await expect(next.getByRole("button", { name: "Mark operator reviewed" })).toBeDisabled();
    await expect(next.getByRole("button", { name: "Approve for downstream use" })).toBeDisabled();
    await expect(page.getByText(loose("Cannot approve yet: 7 items need attention"))).toBeVisible();

    const confirm = async (field: string) => {
      const button = page.getByRole("button", { name: `Confirm: ${field}`, exact: true });
      await button.click();
      await expect(button).toHaveCount(0);
    };
    // Confirm the descriptive values first: the numbers, units and counts still block review.
    for (const field of ["Specimen type", "Received in", "Container label matches part", "Appearance", "Ink / orientation", "Sectioning"]) await confirm(field);
    const blockers = page.getByRole("status").filter({ hasText: loose("Cannot approve yet") });
    await expect(blockers).toContainText(loose("Proposed, not yet confirmed:"));
    for (const field of ["Piece count", "Dimensions", "Cassette allocation"]) await expect(blockers.getByRole("button", { name: field, exact: true })).toBeVisible();
    await expect(next.getByRole("button", { name: "Mark operator reviewed" })).toBeDisabled();
    // Each number, unit and count is confirmed explicitly, as dictated.
    await expect(page.getByRole("group", { name: "Dimensions (required)" }).getByLabel("Unit (required)")).toHaveValue("cm");
    for (const field of ["Piece count", "Dimensions", "Cassette allocation"]) await confirm(field);
    await expect(page.getByText(loose("Confirmed by Dana Whitfield"))).toHaveCount(9);
    await expect(page.getByText(loose("Proposed from transcript, not confirmed"))).toHaveCount(0);

    // Narrative from confirmed values only; approval is refused while it is empty.
    await expect(next).toContainText(loose("Narrative is empty. Compose it from the confirmed values or type it, then save."));
    await page.getByRole("button", { name: "Compose from confirmed values" }).click();
    await expect(page.getByLabel(`Narrative for ${HERO_ACCESSION} Part A`)).toHaveValue(/one tan-pink shave specimen measuring 0\.8 x 0\.6 x 0\.1 cm/);
    await next.getByRole("button", { name: "Save draft" }).click();
    await expect(next).toContainText(loose("Ready to mark operator reviewed. Approval comes after review."));
    await next.getByRole("button", { name: "Mark operator reviewed" }).click();
    await expect(next).toContainText(loose("Operator reviewed. Ready to approve for downstream use."));
    await next.getByRole("button", { name: "Approve for downstream use" }).click();

    // Downstream: A1 eligible for processing and a source-entry task for Sam; part B still awaiting grossing.
    const approved = page.getByRole("status").filter({ has: page.getByRole("heading", { name: `${HERO_ACCESSION} Part A approved for downstream use` }) });
    await expect(approved).toBeVisible();
    await expect(approved).toContainText(loose(`Enter approved gross description in source system — ${HERO_ACCESSION} part A Owner: Sam Ortiz`));
    await expect(approved).toContainText(loose(`${HERO_ACCESSION} A1 eligible for the next processing run`));
    await expect(approved).toContainText(loose("part B still awaiting grossing"));
    await expect(approved).toContainText(loose("The case is not complete. Source-system entry is pending; nothing was written to the source system."));
    await expect(page.getByRole("link", { name: /^Part B: Awaiting grossing/ })).toBeVisible();
    // The rail step says it is the current step (in words and aria-current) and who it waits on.
    const pendingStep = page.getByRole("navigation", { name: "Gross record status" }).getByRole("listitem").filter({ hasText: loose("Source update pending") });
    await expect(pendingStep).toHaveAttribute("aria-current", "step");
    await expect(pendingStep).toContainText(loose("Source update pending (current step) Waiting on Sam Ortiz"));

    // Worklist, still open in the other window: without a reload, the hero case under Dr. Elena Marsh now shows
    // part A moving on and part B still awaiting grossing (live refresh polls every 2.5 s).
    await expect(row).toContainText(loose("A ready for processing · B awaiting gross"));
    await expect(row).toContainText(loose("Eligible: A1 for processing; Part B for grossing"));
    await expect(row).toContainText(loose("Entry pending: A"));
    await expect(row).toContainText(loose("New since your last acknowledgment"));
    await expect(row).not.toContainText(loose("Delivered"));
    expect(watcher.url()).toBe(watcherUrl);
    expect(await watcher.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), "the worklist window was not reloaded").toBe(true);

    // Case page: the case is not complete; part A now has block A1 and Sam Ortiz owns the source entry.
    await page.goto(`/cases/${HERO_ACCESSION}`);
    await expect(page.getByText(loose("Not complete: 0 of 2 parts delivered."))).toBeVisible();
    await expect(page.getByRole("region", { name: "Part B", exact: true })).toContainText(loose("Awaiting grossing"));
    // Part A's own row names its next step and who it waits on, headed by the step it belongs to (not the physical stage).
    await expect(page.getByRole("region", { name: "Part A", exact: true })).toContainText(loose("Source-system entry"));
    await expect(page.getByRole("region", { name: "Part A", exact: true })).toContainText(loose("Enter approved gross description in source system"));
    await expect(page.getByRole("region", { name: "Part A", exact: true })).toContainText(loose("Sam Ortiz"));
    await page.goto(`/cases/${HERO_ACCESSION}?tab=material`);
    // Each part's material is a region named by the part; its counts are one aligned row (expected, prepared, labels scanned).
    const material = (part: string) => page.getByRole("region", { name: part, exact: true });
    await expect(material("Part A").getByRole("row", { name: /^Blocks 1 1( |$)/ })).toBeVisible();
    await expect(material("Part A").getByRole("row", { name: new RegExp(`^${HERO_ACCESSION} A1 Cassette loaded \\(grossed\\)`) })).toBeVisible();
    await expect(material("Part B")).toContainText(loose("No cassettes yet."));
    await page.goto(`/cases/${HERO_ACCESSION}?tab=tasks`);
    const entryTask = page.getByRole("row", { name: new RegExp(`^Enter approved gross description in source system — ${HERO_ACCESSION} part A`) });
    await expect(entryTask).toHaveCount(1);
    await expect(entryTask.getByRole("cell").nth(1)).toHaveText("Part A");
    await expect(entryTask.getByRole("cell").nth(2)).toHaveText("Sam Ortiz");
    await expect(entryTask.getByRole("cell").nth(3)).toContainText(loose("Open"));
  });

  test("6. tray and printer: an unexpected slide is flagged, completion is refused with reasons, an unknown print outcome is reconciled before any reprint", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await page.goto("/materials?tab=trays&selected=TRY-M-03");
    const tray = page.getByRole("region", { name: "Current tray" });
    await expect(tray).toContainText(loose("Tray TRY-M-03"));
    await expect(tray).toContainText(loose("Assigned dermatopathologist: Dr. Elena Marsh"));
    await expect(tray).toContainText(looseNumber("8 of 10 expected slides scanned"));

    // The 9th expected slide matches.
    await page.getByRole("button", { name: "Scan D26-04747 A1-1 H&E L1", exact: true }).click();
    await expect(tray).toContainText(looseNumber("9 of 10 expected slides scanned"));
    // The tray is drawn as its positions; each slot reads as one sentence (position, slide label, state).
    const expected = page.getByRole("region", { name: "Expected slides" });
    await expect(expected.getByRole("listitem").filter({ hasText: loose("Position 9: D26-04747 A1-1 H&E L1. Scanned, matches") })).toBeVisible();

    // A Dr. Okafor slide mixed into the stack is flagged and not accepted.
    await page.getByRole("button", { name: "Scan D26-04745 A1-1 H&E L1", exact: true }).click();
    const unexpected = page.getByRole("region", { name: "Scanned material that does not belong (1)" });
    await expect(unexpected).toContainText(loose("Unexpected D26-04745 A1-1 H&E L1 scanned"));
    await expect(unexpected).toContainText(loose("it belongs to Dr. Samuel Okafor's case). Not accepted."));
    await expect(tray).toContainText(looseNumber("9 of 10 expected slides scanned"));
    // The header separates progress from exceptions: 1 left to scan (neutral), 1 exception (amber).
    await expect(tray.getByText(/\d+ left to scan$/)).toHaveText("1 left to scan");
    await expect(tray.getByText(/\d+ exceptions?$/)).toHaveText("1 exception");
    await expect(expected.getByRole("listitem").filter({ hasText: loose("Position 10: D26-04747 A1-2 H&E L2. Expected, not scanned yet.") })).toBeVisible();
    // The unexpected slide is drawn on the tray, off its list, in words.
    await expect(expected.getByRole("listitem").filter({ hasText: loose("Not on this tray's list: D26-04745 A1-1 H&E L1. Unexpected, Dr. Samuel Okafor's case") })).toBeVisible();

    // "Mark tray complete" is blocked, and says why: the count in the column's heading, the slides in its lists, the server's full reason on the button.
    const reason = "Cannot complete: 1 not scanned (D26-04747 A1-2), 1 unexpected (D26-04745 A1-1).";
    const complete = page.getByRole("button", { name: "Mark tray complete" });
    await expect(complete).toBeDisabled();
    await expect(page.getByRole("heading", { level: 2, name: "Cannot complete: 1 not scanned, 1 unexpected.", exact: true })).toBeVisible();
    await expect(complete).toHaveAccessibleDescription(reason);
    await expect(page.getByRole("region", { name: "Not on the tray yet (1)" })).toContainText(loose("D26-04747 A1-2 H&E L2 Position 10: expected, not scanned yet."));
    await expect(tray).not.toContainText(loose("Verified complete"));

    // PJ-8841: the printer never confirmed. A reprint is refused until the outcome is reconciled.
    await page.goto("/materials?tab=print&selected=PJ-8841");
    // The queue says the outcome in words, with the next step.
    await expect(page.getByRole("row", { name: /^PJ-8841 / }).getByRole("cell").nth(3)).toHaveText(/^Unknown outcome\s*Reconcile before reprint$/);
    const job = page.getByRole("complementary", { name: "D26-04783 A1-5 H&E deeper L1" });
    await expect(job).toContainText(loose("Print job PJ-8841 Unknown outcome"));
    await expect(job.getByRole("img", { name: /^DataMatrix label encoding D26-04783 A1-5 H&E deeper L1/ })).toBeVisible();
    await expect(job).toContainText(loose("PJ-8841: printer did not confirm after 30 s (simulated timeout). Outcome unknown."));
    await expect(job.getByRole("button", { name: "Reprint with reason" })).toBeDisabled();
    await expect(job).toContainText(loose("Reprint: Reconcile the unknown outcome first (check the printer)."));

    await job.getByLabel(/^What you checked/).fill("Output tray empty; no label for D26-04783 A1-5.");
    await job.getByRole("button", { name: "Not printed" }).click();
    await expect(job).toContainText(loose("Recorded as not printed. A reprint with a reason is now allowed."));
    await expect(job).toContainText(loose("Checked at the printer: not printed, by Priya Shah at"));
    await job.getByRole("button", { name: "Reprint with reason" }).click();
    const reprint = page.getByRole("dialog", { name: "Reprint label D26-04783 A1-5 H&E deeper L1" });
    await expect(reprint).toContainText(loose("Creates a new print job linked to PJ-8841 for the same record. No new slide, block or specimen is created."));
    await reprint.getByLabel("Reason for reprint").fill("Not printed after the simulated timeout; reprint after checking the printer.");
    // Submitted with a double click: still exactly one new job (check 8: no uncontrolled duplicate jobs).
    await reprint.getByRole("button", { name: "Reprint with reason" }).dblclick();
    await expect(reprint).toBeHidden();
    const reprintRows = page.getByRole("row", { name: /^PJ-\d+ D26-04783 A1-5 H&E Reprint .*\(of PJ-8841\)/ });
    await expect(reprintRows).toHaveCount(1);
    await expect(reprintRows).toContainText(loose(`${SCRIPT_IDS.reprint} D26-04783 A1-5 H&E Reprint after unknown outcome (not printed) (of PJ-8841)`));
    await expect(page.getByRole("row", { name: /\(of PJ-\d+\)/ })).toHaveCount(1);
    // The original job stays on record, reconciled as not printed (failed) and pointing to its replacement.
    const original = page.getByRole("row", { name: /^PJ-8841 / });
    await expect(original.getByRole("cell").nth(3)).toHaveText(new RegExp(`^Failed\\s*Replaced by ${SCRIPT_IDS.reprint}$`));
    await page.goto("/materials?tab=print&selected=PJ-8841");
    await expect(job).toContainText(loose(`Replaced by ${SCRIPT_IDS.reprint}`));
    await expect(job).toContainText(loose("Checked at the printer: not printed, by Priya Shah at"));
    await expect(job.getByRole("link", { name: `Open ${SCRIPT_IDS.reprint}` })).toBeVisible();
  });

  test("7. block retrieval RR-0192: last confirmed location, the wrong block is rejected and nothing changes", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await page.goto("/materials?tab=retrieval&selected=RR-0192");
    const request = page.getByRole("region", { name: "Current retrieval request" });
    await expect(request).toContainText(loose("Retrieval request RR-0192"));
    // The count is its own element; compare it exactly ("0 of 3" must not pass as "10 of 3").
    const pickedCount = request.getByText(/^\d+ of \d+ picked/);
    await expect(pickedCount).toHaveText("0 of 3 picked");
    const requested = page.getByRole("region", { name: "Requested blocks" });
    // The location reads as the walk to it: cabinet, drawer, box, then the slot, and who last confirmed it when.
    await expect(requested).toContainText(loose("Cabinet 2 Drawer 4 Box 11"));
    // Each stop on the walk is its own region named by the box; the block sits in it, in its slot (CAB-2/DR-4/BX-11/S-14), and the stop says once that locations are last confirmed.
    const box11 = requested.getByRole("region", { name: "Cabinet 2, Drawer 4, Box 11", exact: true });
    await expect(box11).toContainText(loose("Last confirmed location, not live tracking. The block may have moved since."));
    const blockA1 = box11.getByRole("listitem").filter({ hasText: loose("Pick 2 of 3 D26-03990 A1") });
    await expect(blockA1).toContainText(loose("Slot 14"));
    await expect(blockA1).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));
    await expect(blockA1).toContainText(loose("Custody now In storage (last confirmed)"));
    const overdue = requested.getByRole("listitem").filter({ hasText: loose("Pick 3 of 3 D26-03912 A1") });
    await expect(overdue).toContainText(loose("Overdue return"));
    await expect(overdue).toContainText(loose("Checked out to Marcus Lee since Oct 10, 11:00 AM ET"));

    // Wrong block: a mismatch, not accepted, nothing changes.
    await page.getByRole("button", { name: "Scan D26-03909 A1" }).click();
    // The scan field's result line carries the server's full sentence, with what the request still needs.
    await expect(page.locator("#scan-field")).toHaveAccessibleDescription(
      new RegExp(`^${loose("Mismatch. Scanned D26-03909 A1. RR-0192 needs D26-03990 B1, D26-03990 A1, D26-03912 A1. Not accepted.").source}`),
    );
    // The scan check names the wrong block in words (amber: rejected, nothing changes) without repeating that sentence.
    const mismatch = page.getByRole("status").filter({ hasText: loose("Wrong block: not accepted") });
    await expect(mismatch).toContainText(loose("D26-03909 A1 is not on RR-0192. Nothing was changed."));
    await expect(pickedCount).toHaveText("0 of 3 picked");
    const rejected = request.getByText(/^\d+ wrong scans? rejected$/);
    await expect(rejected).toHaveText("1 wrong scan rejected");
    // The scan check lists what is still to pick, in walking order with the next block first: the wrong scan changed nothing.
    await expect(page.getByRole("heading", { level: 2, name: "Next: D26-03990 A1", exact: true })).toBeVisible();
    const toPick = page.getByRole("list", { name: /^Still to pick \(\d+\)$/ });
    await expect(toPick).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Still to pick (3)", exact: true })).toBeVisible();
    await expect(toPick.getByRole("listitem")).toHaveText([/^D26-03990 A1\s*Scan\b/, /^D26-03990 B1\s*Scan\b/, /^D26-03912 A1\s*Scan\b/]);
    await expect(page.getByRole("button", { name: "Deliver to Microtomy bench 2" })).toBeDisabled();
    await expect(page.getByRole("listitem").filter({ hasText: loose("Wrong block scanned (not accepted): D26-03909 A1 (Priya Shah)") })).toBeVisible();
    await expect(blockA1).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));
    await expect(blockA1).toContainText(loose("Slot 14"));

    // The requested block matches (pick 1 of 3).
    await page.getByRole("button", { name: "Scan D26-03990 B1" }).click();
    await expect(pickedCount).toHaveText("1 of 3 picked");
    await expect(rejected).toHaveText("1 wrong scan rejected");
    await expect(page.getByRole("heading", { level: 3, name: "Still to pick (2)", exact: true })).toBeVisible();
    await expect(toPick.getByRole("listitem")).toHaveText([/^D26-03990 A1\s*Scan\b/, /^D26-03912 A1\s*Scan\b/]);
  });

  test("8. operations: what is still blocked, with owners and evidence; every guide step reads as done from the records", async ({ page, context }) => {
    await actAs(context, STAFF.tanya);
    const { result } = await runSimulatorEvents(page, 8);
    await expect(result).toContainText(loose("11:50 AM ET"));
    await expect(page.getByText(looseNumber("8 of 8 steps done (read from the records)"))).toBeVisible();

    await page.goto("/operations");
    await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: loose("Computed from synthetic demo data") })).toContainText(loose("Not observed lab performance."));
    // Exceptions ("Blocked now") and routine source-system entry are two tables; together they list every blocked item.
    const blocked = page.getByRole("table", { name: /^Blocked now/ });
    const routine = page.getByRole("table", { name: /^Source-system entry/ });
    const sourceEntry = routine.getByRole("row", { name: new RegExp(`^${HERO_ACCESSION} part A`) });
    await expect(sourceEntry).toBeVisible();
    // One line per record: the owner and the shared status are said once, in the heading of the record's group.
    // (`has` is evaluated inside each row group, so the inner locator is not scoped to the table again.)
    const entryGroup = routine.getByRole("rowgroup").filter({ has: page.getByRole("row", { name: new RegExp(`^${HERO_ACCESSION} part A`) }) });
    await expect(entryGroup).toHaveCount(1);
    await expect(entryGroup.getByRole("row").first()).toContainText(loose("Sam Ortiz holds the entry task"));
    await expect(entryGroup.getByRole("row").first()).toContainText("Approved; not yet entered in the source system (manual entry)");
    await expect(sourceEntry).not.toContainText("Sam Ortiz");
    await expect(sourceEntry.getByRole("cell")).toHaveCount(3);
    // Waiting since the approval (11:08 on the paused demo clock, set by the step 3 simulator) and its age at 11:50.
    await expect(sourceEntry.getByRole("cell").nth(1)).toHaveText(/^42 min\s*since 11:08 AM ET$/);
    await expect(sourceEntry.getByRole("link", { name: new RegExp(`^${HERO_ACCESSION} part A`) })).toBeVisible();
    // Routine entry is not mixed into the exceptions.
    await expect(blocked.getByRole("row", { name: new RegExp(`^Source-system entry`) })).toHaveCount(0);
    const trayRow = blocked.getByRole("row", { name: /^Tray exception TRY-M-03/ });
    await expect(trayRow).toContainText(loose("Cannot be verified complete."));
    await expect(trayRow.getByRole("cell").nth(2)).toHaveText("Priya Shah");
    // The provisional intake id is announced as provisional (dashed label reference), never as an official number.
    const exceptionRow = blocked.getByRole("row", { name: new RegExp(`^Routing exception Provisional intake item ${UNKNOWN_OFFICE_ITEM}`) });
    await expect(exceptionRow.getByRole("cell").nth(2)).toHaveText("Kim Nguyen");
    // The released Part B hold is no longer listed as blocking anything, nor hatched on the bench path.
    await expect(page.getByRole("row", { name: new RegExp(re(ids.hold)) })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Bench path" }).getByRole("link", { name: new RegExp(re(ids.hold)) })).toHaveCount(0);
    // The reconciled print job no longer counts as an unknown outcome: no row, and the zero is said in the "Clear now" line.
    await expect(blocked.getByRole("row", { name: /^Print outcome unknown/ })).toHaveCount(0);
    await expect(page.getByRole("list", { name: /^Clear now/ }).getByRole("listitem").filter({ hasText: "no print jobs with unknown outcome" })).toBeVisible();

    // The evidence link opens the record that shows it: the case's tasks, with Sam Ortiz's open source-entry task.
    await sourceEntry.getByRole("cell").nth(2).getByRole("link", { name: `Entry task for ${HERO_ACCESSION} part A`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${HERO_ACCESSION}\\?tab=tasks$`));
    await expect(page.getByRole("heading", { level: 1, name: `Case ${HERO_ACCESSION}` })).toBeVisible();
    const entryTask = page.getByRole("row", { name: new RegExp(`^Enter approved gross description in source system — ${HERO_ACCESSION} part A`) });
    await expect(entryTask.getByRole("cell").nth(2)).toHaveText("Sam Ortiz");
    await expect(entryTask.getByRole("cell").nth(3)).toContainText(loose("Open"));
  });
});
