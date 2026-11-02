import { expect, test } from "@playwright/test";
import { api, loginAs, switchRole, USERS } from "./helpers";

// Acceptance 13: the main journey at desktop (1440) and tablet (1024) widths.
// Worklist → slide → QC issue through its whole lifecycle → expert label → approve → the dataset summary changes.
test("@tablet main journey: worklist, slide, QC lifecycle, label, approval, dataset summary", async ({ page }, info) => {
  const tablet = info.project.name.startsWith("tablet");
  // Each viewport works on its own slide so the two runs share one seeded database safely.
  // Desktop: patient P-0002 already has an approved slide in the set. Tablet: patient P-0003 has none yet.
  const target = tablet
    ? { accession: "DEMO-S26-0003", level: 1, stain: "H&E", label: "bcc_present" as const, newPatient: 1 }
    : { accession: "DEMO-S26-0002", level: 2, stain: "PAS", label: "bcc_absent_not_benign" as const, newPatient: 0 };
  const datasetName = `Journey draft (${info.project.name})`;

  // ---- research lead: a draft dataset first, to see its summary change later
  await loginAs(page, USERS.lead);
  await page.goto("/dataset");
  await page.getByTestId("new-dataset").click();
  const dlg = page.getByTestId("create-dataset");
  await dlg.getByLabel("Name").fill(datasetName);
  await dlg.getByTestId("create-dataset-confirm").click();
  await expect(page.getByTestId("dataset-title")).toContainText(datasetName);
  const draftUrl = page.url();
  const slidesBefore = Number(await page.getByTestId("count-slides").textContent());
  const patientsBefore = Number(await page.getByTestId("count-patients").textContent());
  expect(slidesBefore).toBeGreaterThan(0);

  // ---- histology assistant: open the worklist and the slide (keyboard: / to search, j to move, Enter to open)
  await page.goto("/worklist");
  await switchRole(page, USERS.assistant);
  await expect(page.getByTestId("worklist-table")).toBeVisible();
  await page.keyboard.press("/");
  await page.keyboard.type(target.accession);
  await page.getByRole("heading", { name: "Worklist" }).click();
  await page.keyboard.press("j");
  const wanted = `Level ${target.level}, ${target.stain}`;
  for (let i = 0; i < 6; i++) {
    const label = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    if (label.includes(wanted)) break;
    await page.keyboard.press("j");
  }
  await expect(page.locator(":focus")).toHaveAttribute("aria-label", new RegExp(wanted));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/review\//);
  const slideId = page.url().split("/review/")[1].split("?")[0];
  await expect(page.getByTestId("review-title")).toContainText(target.accession);

  // ---- QC issue: open → reviewed → action suggested → resolved (with its dataset eligibility effect)
  await page.keyboard.press("2");
  await page.getByTestId("new-issue").click();
  const form = page.getByTestId("new-issue-form");
  await form.getByLabel("Category").selectOption("chatter");
  await form.getByLabel("What did you see?").fill(`chatter lines across the section (fictional, ${info.project.name})`);
  await form.getByTestId("save-issue").click();
  const issue = page.getByTestId("qc-issue").filter({ hasText: `fictional, ${info.project.name}` });
  await expect(issue).toHaveAttribute("data-status", "open");

  await issue.getByTestId("issue-review").click();
  await issue.getByTestId("issue-reason").fill("seen at full resolution");
  await issue.getByTestId("issue-submit").click();
  await expect(issue).toHaveAttribute("data-status", "reviewed");

  await issue.getByTestId("issue-suggest").click();
  await issue.getByTestId("suggest-select").selectOption("consider_restain");
  await issue.getByTestId("issue-submit").click();
  await expect(issue).toHaveAttribute("data-status", "action_suggested");
  await expect(issue).toContainText("Consider restain");

  await issue.getByTestId("issue-resolve").click();
  await issue.getByTestId("resolution-text").fill("lead decided the chatter does not affect the research label (fictional)");
  await issue.getByTestId("effect-select").selectOption("none");
  await issue.getByTestId("issue-submit").click();
  await expect(issue).toHaveAttribute("data-status", "resolved");
  await expect(issue.getByTestId("eligibility-effect")).toHaveText("No effect on dataset eligibility");

  // ---- pathologist: expert label, then approve
  await switchRole(page, USERS.pathologist);
  await page.keyboard.press("1");
  const labels = page.getByTestId("labels-panel");
  await labels.getByTestId(`expert-${target.label}`).check();
  await labels.getByTestId("save-label").click();
  await expect(labels.getByTestId("reference-slide")).toContainText(target.label === "bcc_present" ? "BCC present" : "BCC absent");
  await labels.getByTestId("state-approved").click();
  await labels.getByTestId("confirm-state").click();
  // The confirmation box itself says "Confirm: Approved", so wait until it closes (only after the POST succeeds).
  await expect(labels.getByTestId("confirm-state")).toHaveCount(0);
  await expect(page.getByTestId("review-decision")).toContainText("Approved");
  const slide = await api<{ review_state: string }>(page, `/slides/${slideId}`);
  expect(slide.review_state).toBe("approved");

  // ---- research lead: refresh the draft; the approved slide now counts
  await switchRole(page, USERS.lead);
  await page.goto(draftUrl);
  await expect(page.getByTestId("dataset-title")).toContainText(datasetName);
  await page.getByTestId("refresh-dataset").click();
  await expect(page.getByTestId("count-slides")).toHaveText(String(slidesBefore + 1));
  // Unique patients change only when the slide's patient was not in the set yet: patients ≠ slides.
  await expect(page.getByTestId("count-patients")).toHaveText(String(patientsBefore + target.newPatient));
});
