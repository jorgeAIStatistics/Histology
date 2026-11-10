import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { findSlide, loginAs, USERS, waitForViewer } from "./helpers";

type Metrics = { tokenMs: number; openMs: number; firstTileMs: number; firstTileSinceNavigationMs: number; tilesLoaded: number; tilesFailed: number };

async function openAndMeasure(page: Page, slideId: string) {
  const tiles: { url: string; status: number }[] = [];
  const onResp = (r: import("@playwright/test").Response) => {
    if (r.url().includes("/slide_files/")) tiles.push({ url: r.url(), status: r.status() });
  };
  page.on("response", onResp);
  await page.goto(`/review/${slideId}`);
  await waitForViewer(page);
  await page.waitForTimeout(1200); // let the visible tiles finish
  page.off("response", onResp);
  const m = await page.evaluate(() => (window as unknown as { __wbViewer: { metrics: () => unknown } }).__wbViewer.metrics()) as Metrics;
  return { tiles, m };
}

/** Standard deviation of luminance in the centre of the OpenSeadragon canvas: > 0 means real pixels were drawn. */
async function canvasSpread(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="osd-host"]')!;
    const canvases = Array.from(host.querySelectorAll("canvas")).filter((c) => !c.closest(".navigator"));
    const c = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0] as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const w = Math.floor(c.width / 3);
    const h = Math.floor(c.height / 3);
    const d = ctx.getImageData(w, h, w, h).data;
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += y;
      sum2 += y * y;
      n++;
    }
    const mean = sum / n;
    return { mean, sd: Math.sqrt(sum2 / n - mean * mean), canvas: [c.width, c.height] };
  });
}

// Acceptance 14: the real public CC0 Aperio SVS fixture opens in the viewer and loads tiles.
test("@tablet the CMU-1-Small-Region.svs fixture opens, tiles return 200 and the canvas is drawn", async ({ page }, info) => {
  await loginAs(page, USERS.pathologist);
  const cmu = await findSlide(page, (r) => r.provenance === "public_cc0" && r.image_kind === "wsi");

  const first = await openAndMeasure(page, cmu.slide_id);
  expect(first.tiles.length, "tile requests were made").toBeGreaterThan(0);
  expect(first.tiles.filter((t) => t.status !== 200), "every tile request returned 200").toEqual([]);
  expect(first.m.tilesFailed).toBe(0);
  const spread = await canvasSpread(page);
  expect(spread.sd, `canvas luminance spread ${JSON.stringify(spread)}`).toBeGreaterThan(5);
  await expect(page.getByTestId("cc0-badge")).toHaveText("PUBLIC CC0 — unlabeled");
  await expect(page.getByTestId("synthetic-badge")).toHaveCount(0);
  // Calibration is known for this file (0.499 µm/px), so the scale bar is allowed and shown.
  await expect(page.getByTestId("scale-bar")).toBeVisible();

  // Second visit: warm tile cache in the API process.
  const second = await openAndMeasure(page, cmu.slide_id);
  expect(second.tiles.filter((t) => t.status !== 200)).toEqual([]);

  const out = {
    measured_at: new Date().toISOString(),
    project: info.project.name,
    slide: "CMU-1-Small-Region.svs (public CC0, 2220 x 2967 px, 0.499 µm/px)",
    first_visit: { ...first.m, tile_requests: first.tiles.length },
    second_visit: { ...second.m, tile_requests: second.tiles.length },
    canvas_luminance_sd: Number(spread.sd.toFixed(2)),
    note: "firstTileMs: from viewer start (before the signed-token request) to OpenSeadragon's first tile-drawn event. firstTileSinceNavigationMs: from page navigation start.",
  };
  const dir = path.resolve(__dirname, "../../test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `viewer-metrics-${info.project.name}.json`), JSON.stringify(out, null, 2));
  info.annotations.push({ type: "measurement", description: JSON.stringify(out) });
  console.log("[viewer-metrics]", JSON.stringify(out));
});

test("synthetic slides say SYNTHETIC — NO HISTOLOGY and show no scale bar", async ({ page }) => {
  await loginAs(page, USERS.director);
  const syn = await findSlide(page, (r) => r.image_kind === "synthetic_tiles" && r.accession_code === "DEMO-S26-0001");
  await page.goto(`/review/${syn.slide_id}`);
  await waitForViewer(page);
  await expect(page.getByTestId("synthetic-badge")).toHaveText("SYNTHETIC — NO HISTOLOGY");
  await expect(page.getByTestId("no-scale-bar")).toContainText("microns per pixel unknown");
  await expect(page.getByTestId("scale-bar")).toHaveCount(0);
  // The director reads but cannot draw: the tool explains why instead of failing silently.
  await page.getByTestId("vt-rect").click();
  await expect(page.getByText("Annotating needs the pathologist demo role.").first()).toBeVisible();
});
