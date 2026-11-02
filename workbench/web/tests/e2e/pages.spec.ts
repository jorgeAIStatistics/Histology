import { expect, test } from "@playwright/test";
import { api, findSlide, loginAs, noHorizontalOverflow, trackErrors, USERS, waitForViewer } from "./helpers";

const WIDTHS = [1366, 1440, 1024];

// No console errors on the main pages, and no horizontal page overflow at 1366, 1440 and 1024 px.
test("main pages: no console errors and no horizontal overflow at 1366, 1440 and 1024", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  // The overview must also load cleanly before anyone chooses a role.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/impact");
  await expect(page.getByTestId("roi-results")).toBeVisible();
  expect(errors, "console errors without a session").toEqual([]);

  await loginAs(page, USERS.lead);
  const synthetic = await findSlide(page, (r) => r.accession_code === "DEMO-S26-0004" && r.level_index === 1);
  const cmu = await findSlide(page, (r) => r.provenance === "public_cc0");
  const datasets = await api<{ items: { id: string; status: string }[] }>(page, "/projects/proj-bcc-demo/datasets");
  const enc = await page.request.get("/api/v1/encoders");
  const runs = enc.ok() ? await api<{ items: { id: string; status: string }[] }>(page, "/projects/proj-synthetic-cohort/experiments") : { items: [] };
  const run = runs.items.find((r) => r.status === "succeeded");

  const pages: { path: string; ready: () => Promise<void> }[] = [
    { path: "/", ready: async () => void (await expect(page.getByRole("heading", { level: 1 })).toBeVisible()) },
    { path: "/worklist", ready: async () => void (await expect(page.getByTestId("worklist-table")).toBeVisible()) },
    { path: "/review", ready: async () => void (await expect(page.getByRole("heading", { name: "Slide Review" })).toBeVisible()) },
    { path: `/review/${synthetic.slide_id}`, ready: () => waitForViewer(page) },
    { path: `/review/${cmu.slide_id}`, ready: () => waitForViewer(page) },
    { path: "/dataset", ready: async () => void (await expect(page.getByTestId(datasets.items.length ? "dataset-summary" : "new-dataset")).toBeVisible()) },
    { path: "/experiments", ready: async () => void (await expect(page.getByTestId("readiness-ladder")).toBeVisible()) },
    ...(run ? [{ path: `/experiments/${run.id}`, ready: async () => void (await expect(page.getByTestId("metrics-table")).toBeVisible()) }] : []),
    { path: "/impact", ready: async () => void (await expect(page.getByTestId("roi-results")).toBeVisible()) },
  ];

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 1366 ? 900 : 768 });
    for (const p of pages) {
      await page.goto(p.path);
      await p.ready();
      await noHorizontalOverflow(page);
    }
  }
  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

test("a phone gets status review only, said plainly", async ({ page }) => {
  await loginAs(page, USERS.pathologist);
  const s = await findSlide(page, (r) => r.accession_code === "DEMO-S26-0001");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/review/${s.slide_id}`);
  await expect(page.getByTestId("mobile-status")).toContainText("Status review only on a phone");
  await expect(page.getByTestId("viewer-stage")).toHaveCount(0);
  await noHorizontalOverflow(page);
});
