import { expect, test } from "@playwright/test";
import { api, loginAs, USERS } from "./helpers";

type Run = { id: string; head: string; status: string; synthetic: boolean; name: string };

// Experiments against the real ML router (dermpath/ml/router.py). If the API does not mount it, the
// tests are skipped with that reason rather than run against invented data.
test.describe("experiments", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, USERS.lead);
    const r = await page.request.get("/api/v1/encoders");
    test.skip(r.status() === 404, "ML router not mounted in this API (GET /api/v1/encoders returned 404): dermpath/ml/router.py is missing");
  });

  test("@tablet encoders show licence and the exact UNI dependency; the readiness ladder says engineering only", async ({ page }) => {
    await page.goto("/experiments");
    await expect(page.getByTestId("readiness-ladder")).toContainText("We are here");
    await expect(page.getByTestId("readiness-ladder")).toContainText("Clinical deployment readiness");
    const uni = page.getByTestId("encoder-uni-v1");
    await expect(uni.getByTestId("encoder-status")).toHaveText("missing weights");
    await expect(uni.getByTestId("encoder-status-detail")).toContainText("WB_UNI_WEIGHTS");
    await expect(uni.getByTestId("encoder-status-detail")).toContainText("WB_UNI_LICENSE_ACCEPTED");
    await expect(uni).toContainText("Commercial use: no");
    await expect(page.getByTestId("encoder-synthetic-deterministic-v1").getByTestId("encoder-status")).toHaveText("available");
  });

  test("a synthetic run shows the PIPELINE TEST banner, metrics with denominators, and the error gallery", async ({ page }) => {
    const runs = await api<{ items: Run[] }>(page, "/projects/proj-synthetic-cohort/experiments");
    const run = runs.items.find((r) => r.head === "abmil" && r.status === "succeeded") ?? runs.items.find((r) => r.status === "succeeded");
    expect(run, "the seeded cohort has a finished run").toBeTruthy();
    await page.goto(`/experiments/${run!.id}`);
    const banner = page.getByTestId("pipeline-test-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("PIPELINE TEST — NOT PATHOLOGY VALIDATION");
    await expect(page.getByTestId("provenance")).toContainText("Code revision");
    await expect(page.getByTestId("threshold")).toContainText("the validation split");
    const metrics = page.getByTestId("metrics-table");
    await expect(metrics.getByTestId("metric-sensitivity")).toContainText(/\d+ \/ \d+/);
    await expect(page.getByTestId("confusion-matrix")).toContainText("false negative");
    await expect(page.getByTestId("calibration-chart")).toBeVisible();
    await expect(page.getByTestId("coverage-chart")).toBeVisible();
    await expect(page.getByTestId("subgroups")).toContainText(/insufficient evidence|point estimates/);

    // Error gallery: false negatives first; cohort records have no image, so no viewer link is offered.
    await page.getByRole("tab", { name: /Errors/ }).click();
    const cards = page.getByTestId("error-card");
    await expect(cards.first()).toBeVisible();
    const types = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-error-type")));
    const firstFp = types.indexOf("false_positive");
    if (firstFp >= 0) expect(types.slice(firstFp)).not.toContain("false_negative");
    await expect(cards.first().getByTestId("error-no-image")).toBeVisible();
    await expect(page.getByTestId("error-open-slide")).toHaveCount(0);

    // The test split: research lead only, after the validation threshold; opening it is audited.
    await page.getByRole("tab", { name: /Test/ }).click();
    await page.getByTestId("open-test").click();
    await expect(page.getByTestId("evaluation-test")).toBeVisible();
  });

  test("the workflow-demo run is honest about tiny samples", async ({ page }) => {
    const runs = await api<{ items: Run[] }>(page, "/projects/proj-bcc-demo/experiments");
    const run = runs.items.find((r) => r.status === "succeeded");
    test.skip(!run, "no finished workflow-demo run in the seed");
    await page.goto(`/experiments/${run!.id}`);
    await expect(page.getByTestId("pipeline-test-banner")).toBeVisible();
    await expect(page.getByTestId("evaluation-val")).toContainText(/insufficient evidence|undefined/);
  });

  test("other roles: the director cannot open the test split; the assistant is told who can use experiments", async ({ page, context }) => {
    const runs = await api<{ items: Run[] }>(page, "/projects/proj-synthetic-cohort/experiments");
    const run = runs.items.find((r) => r.status === "succeeded")!;
    await context.clearCookies();
    await loginAs(page, USERS.director);
    await page.goto(`/experiments/${run.id}`);
    await page.getByRole("tab", { name: /Test/ }).click();
    const open = page.getByTestId("open-test");
    await expect(open).toHaveAttribute("aria-disabled", "true");
    await expect(open).toHaveAccessibleDescription(/Only the research lead may open the test split/);
    // Activating it explains the exact reason instead of doing nothing.
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Only the research lead may open the test split" })).toBeVisible();
    await expect(page.getByTestId("evaluation-test")).toHaveCount(0);

    await context.clearCookies();
    await loginAs(page, USERS.assistant);
    await page.goto("/experiments");
    await expect(page.getByText("Experiments are available to the research lead, pathologists and the medical director.")).toBeVisible();
  });
});
