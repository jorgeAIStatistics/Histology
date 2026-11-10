import { expect, type Locator, type Page } from "@playwright/test";

export const USERS = {
  assistant: "user-assistant",
  pathologist: "user-pathologist",
  pathologist2: "user-pathologist-2",
  lead: "user-research-lead",
  director: "user-director",
  admin: "user-admin",
} as const;

/** Demo role switch through the API (shares the browser context's cookie jar), plus the page's session hint. */
export async function loginAs(page: Page, userId: string) {
  const r = await page.request.post("/api/v1/auth/demo-login", { data: { userId } });
  expect(r.ok(), `demo-login ${userId}: ${r.status()}`).toBeTruthy();
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("wb.session-hint", "1");
    } catch {
      /* ignore */
    }
  });
}

/** Switch role through the visible role switcher (the UI path a presenter uses). */
export async function switchRole(page: Page, userId: string) {
  await page.getByTestId("role-switcher").click();
  await page.getByTestId(`demo-user-${userId}`).click();
  await expect(page.getByTestId("role-switcher")).toHaveAttribute("aria-expanded", "false");
}

export async function api<T = unknown>(page: Page, path: string): Promise<T> {
  const r = await page.request.get(`/api/v1${path}`);
  expect(r.ok(), `GET ${path} → ${r.status()}`).toBeTruthy();
  return (await r.json()) as T;
}

export type WorklistRow = { slide_id: string; accession_code: string; part: string; level_index: number | null; stain: string; review_state: string; provenance: string; image_kind: string };

export async function findSlide(page: Page, pred: (r: WorklistRow) => boolean, project = "proj-bcc-demo"): Promise<WorklistRow> {
  const wl = await api<{ items: WorklistRow[] }>(page, `/projects/${project}/worklist`);
  const row = wl.items.find(pred);
  if (!row) throw new Error("slide not found in worklist");
  return row;
}

/** Press Tab until the locator has focus (proves it is keyboard reachable). */
export async function tabTo(page: Page, target: Locator, max = 80, shift = false) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
  }
  throw new Error(`could not reach the element with ${max} Tab presses`);
}

export async function waitForViewer(page: Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as { __wbViewer?: { metrics: () => { firstTileMs: number | null } } };
    return Boolean(w.__wbViewer && w.__wbViewer.metrics().firstTileMs !== null);
  }, null, { timeout: 30_000 });
}

/** Console errors and uncaught page errors, for "no console errors" checks. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function noHorizontalOverflow(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `horizontal overflow: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
}
