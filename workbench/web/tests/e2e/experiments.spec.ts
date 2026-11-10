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
    // The handcrafted technical baseline needs no weights and says what it is (not a pathology foundation model).
    const handcrafted = page.getByTestId("encoder-handcrafted-stain-texture-v1");
    await expect(handcrafted.getByTestId("encoder-status")).toHaveText("available");
    await expect(handcrafted.getByTestId("encoder-kind")).toContainText("not a pathology foundation model");
    await expect(uni.getByTestId("encoder-spec")).toContainText("input 224px");
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

    // The test split opens only through a recorded release: register the run (its inference bundle becomes the
    // declared candidate), then release with a reason. The worker scores the pinned features; the page shows the
    // stored result with its release number.
    const register = page.getByTestId("register-model");
    if (await register.isVisible()) {
      await register.click();
      await expect(page.getByTestId("registered")).toBeVisible();
    }
    await page.getByRole("tab", { name: /Test/ }).click();
    const release = page.getByTestId("release-test");
    await expect(release).toHaveAttribute("aria-disabled", "true"); // no reason yet
    await page.getByTestId("release-reason").fill("final evaluation of the registered pipeline-test candidate");
    if (await page.getByTestId("release-justification").isVisible()) {
      await page.getByTestId("release-justification").fill("end-to-end test of the release flow");
    }
    await release.click();
    await expect(page.getByTestId("evaluation-test")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("test-release-number")).toContainText(/Test release \d+ on this manifest/);
    await expect(page.getByTestId("release-history")).toContainText("final evaluation of the registered pipeline-test candidate");
  });

  test("the workflow-demo run is honest about tiny samples", async ({ page }) => {
    const runs = await api<{ items: Run[] }>(page, "/projects/proj-bcc-demo/experiments");
    const run = runs.items.find((r) => r.status === "succeeded");
    test.skip(!run, "no finished workflow-demo run in the seed");
    await page.goto(`/experiments/${run!.id}`);
    await expect(page.getByTestId("pipeline-test-banner")).toBeVisible();
    await expect(page.getByTestId("evaluation-val")).toContainText(/insufficient evidence|undefined/);
  });

  test("other roles: the director cannot release the test split; the assistant is told who can use experiments", async ({ page, context }) => {
    const runs = await api<{ items: Run[] }>(page, "/projects/proj-synthetic-cohort/experiments");
    // A run whose test split is not released yet (the release test above uses another run when it can).
    const run = runs.items.find((r) => r.status === "succeeded" && r.head === "meanpool_logreg") ?? runs.items.find((r) => r.status === "succeeded")!;
    await context.clearCookies();
    await loginAs(page, USERS.director);
    await page.goto(`/experiments/${run.id}`);
    await page.getByRole("tab", { name: /Test/ }).click();
    const release = page.getByTestId("release-test");
    if (await release.count()) {
      await expect(release).toHaveAttribute("aria-disabled", "true");
      await expect(release).toHaveAccessibleDescription(/Only the research lead may release the test split/);
      // Activating it explains the exact reason instead of doing nothing.
      await release.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "Only the research lead may release the test split" })).toBeVisible();
    } else {
      await expect(page.getByTestId("test-released-restricted")).toContainText("visible to the research lead only");
    }
    await expect(page.getByTestId("evaluation-test")).toHaveCount(0);

    await context.clearCookies();
    await loginAs(page, USERS.assistant);
    await page.goto("/experiments");
    await expect(page.getByText("Experiments are available to the research lead, pathologists and the medical director.")).toBeVisible();
  });
});
