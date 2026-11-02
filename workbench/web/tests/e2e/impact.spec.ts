import { expect, test } from "@playwright/test";

// The ROI calculator updates live and shows negative results honestly (formulas unit-tested in lib/roi.test.ts).
test("@tablet the Impact calculator updates live, shows a loss honestly, and keeps the ARR multiple empty", async ({ page }) => {
  await page.goto("/impact");
  await expect(page.getByTestId("fictional-defaults")).toContainText("fictional");
  const net = page.getByTestId("roi-annual-net");
  await expect(net).toHaveText("$29,313");
  await expect(page.getByTestId("roi-payback")).toContainText("Payback: about 24.6 months");

  // Lower the pathologist minutes saved: the result turns into a loss, and payback disappears.
  await page.getByTestId("roi-minutesSavedPerCase").fill("0.5");
  await expect(net).toHaveText(/^−\$[\d,]+$/);
  await expect(page.getByTestId("roi-verdict")).toContainText("A loss every year");
  await expect(page.getByTestId("roi-payback")).toContainText("No payback");
  await expect(page.getByTestId("roi-year-one")).toHaveText(/^−\$/);

  // Realisation fraction: all released capacity as cash raises the labour line.
  const realizedBefore = await page.getByTestId("roi-realized").textContent();
  await page.getByTestId("roi-realization").fill("100");
  await expect(page.getByTestId("roi-realized")).not.toHaveText(realizedBefore ?? "");

  // Double-count guard: unticking adds repeat labour to avoided rework (and only there).
  const reworkGuarded = await page.getByTestId("roi-rework").textContent();
  await page.getByTestId("roi-double-count").uncheck();
  await expect(page.getByTestId("roi-rework")).not.toHaveText(reworkGuarded ?? "");
  await expect(page.getByTestId("roi-results")).toContainText("do not also include");

  // Out-of-range input is refused, not silently clamped.
  await page.getByTestId("roi-baselineRepeatRate").fill("140");
  await expect(page.getByTestId("roi-invalid")).toBeVisible();
  await page.getByTestId("roi-reset").click();
  await expect(net).toHaveText("$29,313");

  // Illustrative ARR arithmetic and the optional multiple (no default).
  await expect(page.getByTestId("arr-table")).toContainText("$300,000 ARR");
  await expect(page.getByTestId("arr-table")).toContainText("$2,400,000 ARR");
  await expect(page.getByTestId("arr-table")).toContainText("$9,000,000 ARR");
  await expect(page.getByTestId("arr-disclaimer")).toContainText("not a forecast");
  await expect(page.getByTestId("val-ev")).toContainText("empty");
  await page.getByTestId("val-arr").fill("1000000");
  await expect(page.getByTestId("val-ev")).toContainText("empty");
  await page.getByTestId("val-multiple").fill("3");
  await expect(page.getByTestId("val-ev")).toHaveText("$3,000,000");
});
