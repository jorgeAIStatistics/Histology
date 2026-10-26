import { expect, test, type Page } from "@playwright/test";
import { api, findSlide, loginAs, USERS, waitForViewer } from "./helpers";

test.use({ reducedMotion: "reduce" }); // immediate zoom/rotation, so positions can be read without waiting for springs

type Pt = { x: number; y: number };
type Ann = { annotation_id: string; geometry_type: string; geometry: { coordinates: number[][][] }; transform_meta: { client: Record<string, unknown> } };

const toLevel0 = (page: Page, p: Pt) => page.evaluate(([x, y]) => (window as unknown as { __wbViewer: { toLevel0: (x: number, y: number) => Pt } }).__wbViewer.toLevel0(x, y), [p.x, p.y] as const);
const toScreen = (page: Page, p: Pt) => page.evaluate(([x, y]) => (window as unknown as { __wbViewer: { toScreen: (x: number, y: number) => Pt } }).__wbViewer.toScreen(x, y), [p.x, p.y] as const);
const rotation = (page: Page) => page.evaluate(() => (window as unknown as { __wbViewer: { rotation: () => number } }).__wbViewer.rotation());

async function overlayPoints(page: Page, id: string): Promise<Pt[]> {
  const attr = await page.locator(`polygon[data-testid="annotation-shape"][data-annotation-id="${id}"]`).getAttribute("points");
  return (attr ?? "")
    .trim()
    .split(/\s+/)
    .map((p) => {
      const [x, y] = p.split(",").map(Number);
      return { x, y };
    });
}

function openRing(a: Ann): Pt[] {
  const ring = a.geometry.coordinates[0].map(([x, y]) => ({ x, y }));
  return ring.slice(0, -1);
}

/** The overlay drawn on screen, converted back to level 0 with OpenSeadragon, must equal what the API stored. */
async function expectOverlayMatchesStored(page: Page, stored: Ann[], tolerancePx: number) {
  for (const a of stored) {
    const screen = await overlayPoints(page, a.annotation_id);
    const ring = openRing(a);
    expect(screen.length).toBe(ring.length);
    for (let i = 0; i < ring.length; i++) {
      const back = await toLevel0(page, screen[i]);
      expect(Math.abs(back.x - ring[i].x), `x of point ${i} of ${a.geometry_type}`).toBeLessThan(tolerancePx);
      expect(Math.abs(back.y - ring[i].y), `y of point ${i} of ${a.geometry_type}`).toBeLessThan(tolerancePx);
    }
  }
}

async function settle(page: Page) {
  await page.waitForTimeout(400);
}

// Acceptance 3, browser half: draw a rectangle and a polygon, zoom, rotate, reload: the outlines stay on the
// same level-0 coordinates, and the overlay positions convert back to exactly what the API stored.
test("rectangle and polygon stay at the same level-0 coordinates through zoom, rotation and reload", async ({ page }) => {
  await loginAs(page, USERS.pathologist);
  const cmu = await findSlide(page, (r) => r.provenance === "public_cc0");
  await page.goto(`/review/${cmu.slide_id}`);
  await waitForViewer(page);
  const overlay = page.getByTestId("annotation-overlay");
  const box = (await overlay.boundingBox())!;
  const slide = await api<{ width: number; height: number }>(page, `/slides/${cmu.slide_id}`);
  // Draw inside the image: map level-0 fractions of the slide to screen pixels.
  const at = async (fx: number, fy: number) => toScreen(page, { x: slide.width * fx, y: slide.height * fy });

  // Rectangle by dragging.
  const a = await at(0.36, 0.36);
  const b = await at(0.47, 0.44);
  const expectedA = await toLevel0(page, a);
  const expectedB = await toLevel0(page, b);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + (a.x + b.x) / 2, box.y + (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 4 });
  await page.mouse.up();
  const rectResp = page.waitForResponse((r) => r.url().endsWith(`/slides/${cmu.slide_id}/annotations`) && r.request().method() === "POST");
  await page.getByTestId("save-annotation").click();
  const rect = (await (await rectResp).json()) as Ann;
  expect(rect.geometry_type).toBe("rectangle");
  const rr = openRing(rect);
  expect(rr[0].x).toBeCloseTo(Math.min(expectedA.x, expectedB.x), 2);
  expect(rr[0].y).toBeCloseTo(Math.min(expectedA.y, expectedB.y), 2);
  expect(rr[2].x).toBeCloseTo(Math.max(expectedA.x, expectedB.x), 2);
  expect(rr[2].y).toBeCloseTo(Math.max(expectedA.y, expectedB.y), 2);
  expect(rect.transform_meta.client.rotation_deg).toBe(0);

  // Polygon by clicks, closed with Enter.
  const polyFr = [
    [0.55, 0.55],
    [0.66, 0.57],
    [0.64, 0.66],
    [0.56, 0.64],
  ];
  const clicks: Pt[] = [];
  for (const [fx, fy] of polyFr) clicks.push(await at(fx, fy));
  const expectedPoly: Pt[] = [];
  for (const c of clicks) expectedPoly.push(await toLevel0(page, c));
  await page.keyboard.press("p");
  for (const c of clicks) await page.mouse.click(box.x + c.x, box.y + c.y);
  await page.keyboard.press("Enter");
  const polyResp = page.waitForResponse((r) => r.url().endsWith(`/slides/${cmu.slide_id}/annotations`) && r.request().method() === "POST");
  await page.getByTestId("save-annotation").click();
  const poly = (await (await polyResp).json()) as Ann;
  expect(poly.geometry_type).toBe("polygon");
  openRing(poly).forEach((p, i) => {
    expect(p.x).toBeCloseTo(expectedPoly[i].x, 2);
    expect(p.y).toBeCloseTo(expectedPoly[i].y, 2);
  });

  const ids = [rect.annotation_id, poly.annotation_id];
  const storedNow = async () => (await api<{ items: Ann[] }>(page, `/slides/${cmu.slide_id}/annotations`)).items.filter((x) => ids.includes(x.annotation_id));
  const stored = await storedNow();
  expect(stored).toHaveLength(2);
  await settle(page);
  await expectOverlayMatchesStored(page, stored, 0.5);
  const screenBefore = await overlayPoints(page, rect.annotation_id);

  // Rotate 90°: the shapes move on screen, but still convert back to the same level-0 points.
  await page.keyboard.press("]");
  await settle(page);
  expect(await rotation(page)).toBe(90);
  const screenAfter = await overlayPoints(page, rect.annotation_id);
  expect(Math.abs(screenAfter[0].x - screenBefore[0].x) + Math.abs(screenAfter[0].y - screenBefore[0].y)).toBeGreaterThan(5);
  await expectOverlayMatchesStored(page, stored, 0.5);

  // A rectangle drawn on the rotated view is still an axis-aligned level-0 rectangle (multiples of 90°).
  const c = await at(0.4, 0.45);
  const d = await at(0.5, 0.52);
  const ec = await toLevel0(page, c);
  const ed = await toLevel0(page, d);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + c.x, box.y + c.y);
  await page.mouse.down();
  await page.mouse.move(box.x + d.x, box.y + d.y, { steps: 6 });
  await page.mouse.up();
  const rotResp = page.waitForResponse((r) => r.url().endsWith(`/slides/${cmu.slide_id}/annotations`) && r.request().method() === "POST");
  await page.getByTestId("save-annotation").click();
  const rotRect = (await (await rotResp).json()) as Ann;
  expect(rotRect.geometry_type).toBe("rectangle");
  expect(rotRect.transform_meta.client.rotation_deg).toBe(90);
  const rrr = openRing(rotRect);
  expect(rrr[0].x).toBeCloseTo(Math.min(ec.x, ed.x), 2);
  expect(rrr[0].y).toBeCloseTo(Math.min(ec.y, ed.y), 2);
  expect(rrr[2].x).toBeCloseTo(Math.max(ec.x, ed.x), 2);
  expect(rrr[2].y).toBeCloseTo(Math.max(ec.y, ed.y), 2);
  ids.push(rotRect.annotation_id);

  // Zoom in twice on the rotated view: every outline still converts back to its stored level-0 points.
  await page.keyboard.press("=");
  await page.keyboard.press("=");
  await settle(page);
  await expectOverlayMatchesStored(page, [...stored, rotRect], 0.5);

  // Reload: the viewer starts unrotated at the home zoom; the outlines are where the API says.
  await page.reload();
  await waitForViewer(page);
  await settle(page);
  const afterReload = await storedNow();
  expect(afterReload.map((x) => x.geometry.coordinates)).toEqual([...stored, rotRect].map((x) => x.geometry.coordinates));
  await expectOverlayMatchesStored(page, afterReload, 0.5);

  // And again after rotating 180° and zooming out.
  await page.keyboard.press("]");
  await page.keyboard.press("]");
  await page.keyboard.press("-");
  await settle(page);
  expect(await rotation(page)).toBe(180);
  await expectOverlayMatchesStored(page, afterReload, 0.5);
});
