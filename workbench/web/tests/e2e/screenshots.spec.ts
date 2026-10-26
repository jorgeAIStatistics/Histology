import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { api, findSlide, loginAs, USERS, waitForViewer } from "./helpers";

// Generates workbench/docs/screenshots/*.png at 1440×900 from the real stack.
// Run with: WB_SCREENSHOTS=1 npx playwright test   (a separate project; not part of the normal suite)
const OUT = path.resolve(__dirname, "../../../docs/screenshots");
async function shot(page: Page, name: string) {
  // Hide transient confirmation toasts so they do not cover the view.
  await page.addStyleTag({ content: '[data-testid="toaster"], [data-testid="dialog-messages"] { display: none !important; }' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, name), animations: "disabled" });
}

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test.setTimeout(240_000);

/** Scroll the review side panel (not the page) so a section sits at its top. */
async function scrollPanelTo(page: Page, id: string) {
  await page.getByTestId(id).evaluate((el) => {
    const scroller = el.closest(".overflow-y-auto") as HTMLElement | null;
    if (scroller) scroller.scrollTop = (el as HTMLElement).getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
  });
  await page.waitForTimeout(250);
}

async function scrollToTestId(page: Page, id: string, offset = 72) {
  await page.getByTestId(id).first().evaluate((el, off) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off }), offset);
  await page.waitForTimeout(250);
}

test("key views", async ({ page, context }) => {
  // 1. Overview, before any role is chosen.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  await shot(page, "01-overview.png");
  // 13. The slide journey at the patch step: the prototype's own tissue mask and 41-patch grid on the CC0 slide.
  await page.locator('[data-step="4"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - window.innerHeight / 2);
  });
  await page.waitForTimeout(400);
  await shot(page, "13-overview-slide-journey.png");

  // 2. Worklist as the histology assistant.
  await loginAs(page, USERS.assistant);
  await page.goto("/worklist");
  await expect(page.getByTestId("worklist-table")).toBeVisible();
  await page.getByTestId("worklist-row").nth(4).focus();
  await shot(page, "02-worklist.png");

  // 3–4. Slide Review on the real public CC0 slide: outlines, the labels panel, then QC with the tissue mask.
  await context.clearCookies();
  await loginAs(page, USERS.pathologist);
  const cmu = await findSlide(page, (r) => r.provenance === "public_cc0");
  await page.goto(`/review/${cmu.slide_id}`);
  await waitForViewer(page);
  const slide = await api<{ width: number; height: number }>(page, `/slides/${cmu.slide_id}`);
  const box = (await page.getByTestId("annotation-overlay").boundingBox())!;
  const scr = (fx: number, fy: number) =>
    page.evaluate(([x, y]) => (window as unknown as { __wbViewer: { toScreen: (a: number, b: number) => { x: number; y: number } } }).__wbViewer.toScreen(x, y), [slide.width * fx, slide.height * fy] as const);
  // Polygon around a region of epithelium; a rectangle on a fold-like area.
  await page.keyboard.press("p");
  for (const [fx, fy] of [
    [0.42, 0.5],
    [0.62, 0.47],
    [0.7, 0.6],
    [0.58, 0.72],
    [0.44, 0.66],
  ]) {
    const p = await scr(fx, fy);
    await page.mouse.click(box.x + p.x, box.y + p.y);
  }
  await page.keyboard.press("Enter");
  await page.getByTestId("draft-form").getByLabel("Comment (optional)").fill("Epithelium reviewed for the label (fictional note)");
  await page.getByTestId("save-annotation").click();
  await expect(page.getByTestId("annotation-item")).toHaveCount(1);
  await page.keyboard.press("r");
  const a = await scr(0.18, 0.22);
  const b = await scr(0.33, 0.34);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId("draft-form").getByLabel("Label").selectOption("artifact");
  await page.getByTestId("save-annotation").click();
  await expect(page.getByTestId("annotation-item")).toHaveCount(2);
  await page.getByTestId("annotation-item").first().locator("button").first().click();
  await page.keyboard.press("1");
  await page.getByTestId("expert-indeterminate").check();
  await page.getByTestId("labels-panel").evaluate((el) => el.closest(".overflow-y-auto")?.scrollTo({ top: 0 }));
  await page.waitForTimeout(400);
  await shot(page, "03-slide-review-labels.png");

  // QC: record a fold with the rectangle as its region, review it and suggest an action; tissue mask on.
  await page.keyboard.press("3");
  await page.getByTestId("annotation-item").nth(1).locator("button").first().click();
  await page.keyboard.press("2");
  await page.getByTestId("new-issue").click();
  await page.getByTestId("new-issue-form").getByLabel("Category").selectOption("fold");
  await page.getByTestId("new-issue-form").getByLabel("What did you see?").fill("Fold across the upper left edge (fictional)");
  await page.getByTestId("save-issue").click();
  const issue = page.getByTestId("qc-issue").filter({ hasText: "Fold across the upper left edge" });
  await issue.getByTestId("issue-review").click();
  await issue.getByTestId("issue-submit").click();
  await expect(issue).toHaveAttribute("data-status", "reviewed");
  await issue.getByTestId("issue-suggest").click();
  await issue.getByTestId("suggest-select").selectOption("exclude_region_from_training");
  await issue.getByTestId("issue-submit").click();
  await expect(issue).toHaveAttribute("data-status", "action_suggested");
  await page.getByTestId("toggle-mask").click();
  await page.waitForTimeout(1200);
  await scrollPanelTo(page, "qc-screen");
  await shot(page, "04-slide-review-qc.png");

  // 5. A disputed slide: two readers disagree; the suggestion stays separate from expert truth.
  const disputed = await findSlide(page, (r) => r.review_state === "disputed");
  await page.goto(`/review/${disputed.slide_id}`);
  await waitForViewer(page);
  await scrollPanelTo(page, "disagreements");
  await shot(page, "05-slide-review-disagreement.png");

  // 6–7. Dataset: a draft summary, then freeze and the immutable manifest.
  await context.clearCookies();
  await loginAs(page, USERS.lead);
  await page.goto("/dataset");
  await page.getByTestId("new-dataset").click();
  await page.getByTestId("create-dataset").getByLabel("Name").fill("BCC slide-level research set");
  await page.getByTestId("create-dataset-confirm").click();
  await expect(page.getByTestId("dataset-title")).toContainText("BCC slide-level research set");
  await expect(page.getByTestId("dataset-summary")).toBeVisible();
  await shot(page, "06-dataset-summary.png");
  await page.getByTestId("freeze-open").click();
  const freeze = page.getByTestId("freeze-dialog");
  await expect(freeze).toBeVisible();
  await expect(freeze.getByTestId("freeze-warnings").or(freeze.getByTestId("freeze-clear"))).toBeVisible();
  if (await freeze.getByTestId("freeze-warnings").isVisible()) {
    // 14. Open items found before freezing: acknowledged with a reason that goes into the manifest.
    await freeze.getByTestId("freeze-acknowledge").check();
    await freeze.getByTestId("freeze-reason").fill("demo slides keep their open issues on purpose; recorded for the pipeline test");
    await shot(page, "14-freeze-acknowledgement.png");
  } else {
    await freeze.getByTestId("freeze-reason").fill("first research set for the pipeline test");
  }
  await page.getByTestId("freeze-confirm").click();
  await expect(page.getByTestId("manifest-verified")).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, "07-dataset-frozen-manifest.png");

  // 8. Experiments: readiness ladder and encoders (UNI shows exactly what is missing).
  await page.goto("/experiments");
  await expect(page.getByTestId("encoder-table")).toBeVisible();
  await shot(page, "08-experiments-encoders.png");

  // 9–11. The synthetic cohort run: banner and provenance, evaluation, error gallery.
  const runs = await api<{ items: { id: string; head: string; status: string }[] }>(page, "/projects/proj-synthetic-cohort/experiments");
  const run = runs.items.find((r) => r.head === "abmil" && r.status === "succeeded") ?? runs.items[0];
  await page.goto(`/experiments/${run.id}`);
  await expect(page.getByTestId("pipeline-test-banner")).toBeVisible();
  await expect(page.getByTestId("metrics-table")).toBeVisible();
  await shot(page, "09-experiment-synthetic-banner.png");
  await scrollToTestId(page, "confusion-matrix", 150);
  await shot(page, "10-experiment-evaluation.png");
  await page.getByRole("tab", { name: /Errors/ }).click();
  await expect(page.getByTestId("error-card").first()).toBeVisible();
  await page.waitForTimeout(500);
  await scrollToTestId(page, "error-gallery", 140);
  await shot(page, "11-error-gallery.png");

  // 12. Impact: the live calculator, pushed into a loss to show it is reported honestly.
  await page.goto("/impact");
  await page.getByTestId("roi-minutesSavedPerCase").fill("1");
  await expect(page.getByTestId("roi-verdict")).toContainText("A loss");
  await scrollToTestId(page, "fictional-defaults", 130);
  await shot(page, "12-impact-calculator.png");
});
