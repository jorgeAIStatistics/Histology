import { expect, test } from "@playwright/test";
import { api, loginAs, tabTo, USERS, waitForViewer } from "./helpers";

test.use({ reducedMotion: "reduce" });

// Acceptance 13, keyboard half: the main review journey works with the keyboard alone
// (after the page loads, every step below is a key press; Tab proves each control is reachable).
test("@tablet keyboard-only: worklist navigation, outline, label, shortcuts, visible focus", async ({ page }, info) => {
  const tablet = info.project.name.startsWith("tablet");
  // An unlabelled, imported synthetic slide; each viewport acts as a different pathologist, and both choose
  // "indeterminate", so no disagreement is created in the shared database.
  const accession = "DEMO-S26-0006";
  await loginAs(page, tablet ? USERS.pathologist : USERS.pathologist2);
  await page.goto("/worklist");
  await expect(page.getByTestId("worklist-table")).toBeVisible();

  // Search with "/", then reach the slide list with Tab and move with j / k.
  await page.keyboard.press("/");
  await page.keyboard.type(accession);
  const firstRow = page.getByTestId("worklist-row").first();
  await tabTo(page, firstRow);
  const outline = await firstRow.evaluate((el) => getComputedStyle(el).boxShadow + "|" + getComputedStyle(el).backgroundColor);
  expect(outline, "the focused row is visibly marked").not.toBe("none|rgba(0, 0, 0, 0)");
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await expect(firstRow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/review\//);
  const slideId = page.url().split("/review/")[1];
  await waitForViewer(page);

  // Viewer shortcuts.
  const rot0 = await page.evaluate(() => (window as unknown as { __wbViewer: { rotation: () => number } }).__wbViewer.rotation());
  await page.keyboard.press("]");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wbViewer: { rotation: () => number } }).__wbViewer.rotation())).toBe((rot0 + 90) % 360);
  const z0 = await page.evaluate(() => (window as unknown as { __wbViewer: { zoom: () => number } }).__wbViewer.zoom());
  await page.keyboard.press("=");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wbViewer: { zoom: () => number } }).__wbViewer.zoom())).toBeGreaterThan(z0);

  // The shortcut legend opens with "?" and closes with Escape.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();

  // An outline without a mouse: Outlines panel (3), "Outline the view centre", save.
  const before = (await api<{ items: unknown[] }>(page, `/slides/${slideId}/annotations`)).items.length;
  await page.keyboard.press("3");
  const centre = page.getByTestId("centre-rect");
  await tabTo(page, centre);
  await page.keyboard.press("Enter");
  const save = page.getByTestId("save-annotation");
  await expect(save).toBeVisible();
  await tabTo(page, save);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, `/slides/${slideId}/annotations`)).items.length).toBe(before + 1);

  // A label with the keyboard: Labels panel (1), choose a value with Space, save with Enter.
  await page.keyboard.press("1");
  // A radio group is one Tab stop; the arrow keys choose within it (native radio behaviour).
  await tabTo(page, page.getByTestId("expert-bcc_present"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const radio = page.getByTestId("expert-indeterminate");
  await expect(radio).toBeChecked();
  await expect(radio).toBeFocused();
  const saveLabel = page.getByTestId("save-label");
  await tabTo(page, saveLabel);
  const ring = await saveLabel.evaluate((el) => getComputedStyle(el).outlineStyle + " " + getComputedStyle(el).outlineWidth);
  expect(ring, "visible focus ring on the save button").toMatch(/solid 3px/);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("labels-panel")).toContainText("Last saved");

  // j moves to the next slide in the worklist.
  await page.locator("body").press("j");
  await expect(page).not.toHaveURL(new RegExp(slideId));
});
