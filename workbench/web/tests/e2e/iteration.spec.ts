import { expect, test } from "@playwright/test";
import { api, findSlide, loginAs, USERS, waitForViewer } from "./helpers";

// Behaviour added in the frontend iteration after the demo dry run: the freeze gate in the UI, the project switcher on
// slide pages, where messages appear on the review page, and the Overview's slide journey.

test("freezing lists open QC issues, needs an acknowledgement and a reason, and the manifest records both", async ({ page, context }) => {
  // A person-raised QC issue on an approved slide that the dataset will include.
  await loginAs(page, USERS.assistant);
  const slide = await findSlide(page, (r) => r.accession_code === "DEMO-S26-0001" && r.part === "A" && r.level_index === 1);
  const issue = await page.request.post(`/api/v1/slides/${slide.slide_id}/qc/issues`, { data: { category: "fold", note: "fold near the edge (e2e)" } });
  expect(issue.ok(), await issue.text()).toBeTruthy();

  await context.clearCookies();
  await loginAs(page, USERS.lead);
  const created = await page.request.post("/api/v1/projects/proj-bcc-demo/datasets", { data: { name: "Freeze gate (e2e)", config: { split: { partition: "random", seed: 4 } } } });
  expect(created.status(), await created.text()).toBe(201);
  const ds = (await created.json()) as { id: string };

  await page.goto(`/dataset?id=${ds.id}`);
  await page.getByTestId("freeze-open").click();
  const dialog = page.getByTestId("freeze-dialog");
  const warnings = dialog.getByTestId("freeze-warnings");
  await expect(warnings).toContainText("DEMO-S26-0001");
  await expect(warnings).toContainText("Fold");

  // Not yet acknowledged: the button explains itself inside the dialog (a modal would hide a page-level message).
  // force: the button is aria-disabled on purpose (it stays focusable and explains why), which Playwright will not click.
  await dialog.getByTestId("freeze-confirm").click({ force: true });
  await expect(dialog.getByTestId("dialog-messages")).toContainText("Resolve the open items first");
  await dialog.getByTestId("freeze-acknowledge").check();
  await dialog.getByTestId("freeze-confirm").click({ force: true });
  await expect(dialog.getByTestId("dialog-messages")).toContainText("Give a reason");
  expect((await api<{ status: string }>(page, `/datasets/${ds.id}`)).status).toBe("draft");

  await dialog.getByTestId("freeze-reason").fill("the fold is outside the tissue used in this study");
  await dialog.getByTestId("freeze-confirm").click();
  await expect(dialog).toBeHidden();
  const ack = page.getByTestId("manifest-acknowledged");
  await expect(ack).toContainText("the fold is outside the tissue used in this study");
  await expect(ack).toContainText("DEMO-S26-0001");
  const manifest = await api<{ manifest: { acknowledged_warnings?: { reason: string } } }>(page, `/datasets/${ds.id}/manifest`);
  expect(manifest.manifest.acknowledged_warnings?.reason).toBe("the fold is outside the tissue used in this study");
});

test("@tablet choosing another project on a slide page opens that project's slides instead of snapping back", async ({ page }) => {
  await loginAs(page, USERS.pathologist);
  const cmu = await findSlide(page, (r) => r.provenance === "public_cc0");
  await page.goto(`/review/${cmu.slide_id}`);
  await waitForViewer(page);
  // The header has one switcher per layout; only one is visible at a given width.
  const switcher = page.getByTestId("project-switcher").filter({ visible: true });
  await expect(switcher).toHaveValue("proj-bcc-demo");
  await switcher.selectOption("proj-synthetic-cohort");
  await expect(page).toHaveURL(/\/review$/);
  await page.waitForTimeout(800);
  await expect(switcher).toHaveValue("proj-synthetic-cohort");
});

test("@tablet on the review page, messages sit over the slide stage and never over the review panel", async ({ page }) => {
  await loginAs(page, USERS.director);
  const cmu = await findSlide(page, (r) => r.provenance === "public_cc0");
  await page.goto(`/review/${cmu.slide_id}`);
  await waitForViewer(page);
  const panel = page.getByRole("complementary", { name: "Review panels" });
  // Any action the director cannot take explains itself with a message.
  await panel.locator('button[aria-disabled="true"]:not([disabled])').first().click({ force: true });
  const toaster = page.getByTestId("toaster");
  await expect(toaster).toHaveAttribute("data-zone", "anchored");
  const message = toaster.locator(".wb-toast").first();
  await expect(message).toBeVisible();
  const m = (await message.boundingBox())!;
  const p = (await panel.boundingBox())!;
  const stage = (await page.getByTestId("viewer-focus").boundingBox())!;
  expect(m.x + m.width, "the message ends before the review panel starts").toBeLessThanOrEqual(p.x);
  expect(m.x).toBeGreaterThanOrEqual(stage.x);
});

test("Overview: the slide journey steps through the slide with the prototype's own tissue mask and patch grid", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("More time for the cases");
  await expect(page.locator("[data-step]")).toHaveCount(6);
  const patches = page.locator('[data-testid="journey-stage"] svg rect');
  await expect(patches).toHaveCount(41);
  await expect(patches.first()).toHaveCSS("opacity", "0");

  // Bring step 4 (patches) to the middle of the viewport.
  await page.locator('[data-step="4"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - window.innerHeight / 2);
  });
  await expect(patches.last()).toHaveCSS("opacity", "1", { timeout: 5000 });
  await expect(page.getByText("Public CC0 test slide CMU-1-Small-Region")).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("Overview shows the slide at once and switches overlays without movement", async ({ page }) => {
    await page.goto("/");
    const cover = page.locator(".wb-scan-cover");
    // The sweep is over immediately: the cover has left the slide.
    await expect.poll(() => cover.evaluate((el) => el.getAnimations().every((a) => a.playState === "finished"))).toBe(true);
    await page.locator('[data-step="2"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
    const stage = page.getByTestId("journey-stage");
    await expect(stage).toHaveCSS("transform", /none|matrix\(1, 0, 0, 1, 0, 0\)/);
  });
});
