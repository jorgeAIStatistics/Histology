// Stage 6 Phase F: operator polish, one regression check per fixed and measured issue (docs/release/operator-ux-stage6.md).
// Synthetic data only; nothing here contacts anything but the local test server.
//
// 1. Gross queue: the filter tabs point (aria-controls) to a panel that exists (axe critical aria-valid-attr-value before).
// 2. The scan target at 1024px keeps its identifier whole ("Check block for RR-01…" before).
// 3. After a wrong retrieval scan at 200% zoom, keyboard focus moving onto the Materials tabs is not left under the scan
//    result line (all three tabs were entirely covered before; WCAG 2.4.11).
// 4. With the browser text size at 20px, the Materials decision column still shows the rows to act on (the retrieval
//    pick list and the tray's "not on the tray" items were squeezed under the "more below" cue before).
// 5. At 200% zoom, a tray in the sideways tray row reached with Tab comes fully into view (4% visible before).
//
// Starting state: the synthetic demo day after the 11:00 courier is unpacked (the guided demo's step 1 world event), as in
// accessibility.spec.ts. Only check 3 records anything (one rejected wrong-block scan); the demo is reset at the end.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { STAFF, actAs, loose, resetDemo, type StaffId } from "./support";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.use({ reducedMotion: "reduce" });

async function command(request: APIRequestContext, actor: StaffId, name: string, input: unknown): Promise<void> {
  const res = await request.post(`/api/commands/${name}`, {
    headers: { Cookie: `hlos_actor=${actor}` },
    data: { input, idempotencyKey: `e2e-polish-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const body = (await res.json()) as { ok: boolean; error?: { message: string } };
  expect(body.ok, `${name} failed: ${body.error?.message}`).toBe(true);
}

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await resetDemo(request);
  await command(request, STAFF.maya, "demo.runStep", { step: 1 });
  await request.dispose();
});

test.afterAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await resetDemo(request);
  await request.dispose();
});

/** A window at a given size, pixel density and browser text size (Chrome's font-size setting, through CDP), acting as a demo role. */
async function openAt(
  browser: Browser,
  staff: StaffId,
  size: { width: number; height: number; dpr?: number; fontPx?: number },
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr ?? 1,
    reducedMotion: "reduce",
  });
  await actAs(context, staff);
  const page = await context.newPage();
  if (size.fontPx) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: size.fontPx, fixed: size.fontPx } });
  }
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { context, page, errors };
}

/** Open a screen and wait until it is interactive (the top bar's scan field is hydrated) and its layout has settled. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => Object.keys(document.getElementById("scan-field") ?? {}).some((k) => k.startsWith("__reactProps"))), { message: "the page is interactive" })
    .toBe(true);
  await settle(page);
}

async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.waitForTimeout(150);
}

/** Whether the element is what a person sees at its centre and near two corners (nothing covers it), and it is inside the view. */
async function uncovered(target: Locator): Promise<{ ok: boolean; what: string }> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
    const hits = [
      [0.5, 0.5],
      [0.15, 0.25],
      [0.85, 0.75],
    ].map(([fx, fy]) => {
      const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      return !!hit && (hit === el || el.contains(hit));
    });
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: inView && hits.every(Boolean), what: `in view ${inView}, hits ${hits.join("/")}, at the centre: ${top?.tagName.toLowerCase()} "${(top?.textContent ?? "").trim().slice(0, 40)}"` };
  });
}

test("Gross queue: the filter tabs control the queue panel (no invalid aria-controls), axe clean", async ({ page, context }) => {
  await actAs(context, STAFF.dana);
  await open(page, "/grossing");
  const tab = page.getByRole("tablist", { name: "Queue filter" }).getByRole("tab", { selected: true });
  const controls = await tab.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  const panel = page.locator(`[id="${controls}"]`);
  await expect(panel).toHaveAttribute("role", "tabpanel");
  await expect(panel.getByRole("table")).toBeVisible();
  // Another filter: the panel follows the selected tab.
  await page.getByRole("tab", { name: /^All parts/ }).click();
  await expect(page.getByRole("tab", { name: /^All parts/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`[id="${await page.getByRole("tab", { name: /^All parts/ }).getAttribute("aria-controls")}"]`)).toHaveAttribute("role", "tabpanel");
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
});

test("At 1024px the scan target keeps its identifier whole (a second line, never an ellipsis)", async ({ browser }) => {
  const { context, page, errors } = await openAt(browser, STAFF.priya, { width: 1024, height: 768 });
  for (const [url, label, id] of [
    ["/materials?tab=retrieval&selected=RR-0192", "Check block for RR-0192", "RR-0192"],
    ["/materials?tab=trays&selected=TRY-M-03", "Add to tray TRY-M-03", "TRY-M-03"],
  ] as const) {
    await open(page, url);
    await expect(page.getByRole("textbox", { name: `Scan target: ${label}` })).toBeVisible();
    const shown = await page.locator('label[for="scan-field"]').evaluate((labelEl, id) => {
      const text = [...labelEl.querySelectorAll("span")].find((s) => s.textContent === labelEl.textContent?.replace(/^Scan target: /, ""));
      const idSpan = [...labelEl.querySelectorAll("span")].find((s) => s.textContent === id);
      if (!text || !idSpan) return { found: false } as const;
      const box = text.getBoundingClientRect();
      const r = idSpan.getBoundingClientRect();
      return {
        found: true,
        clipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1,
        idLines: idSpan.getClientRects().length,
        idInside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
      } as const;
    }, id);
    expect(shown, `${url}: the scan target`).toEqual({ found: true, clipped: false, idLines: 1, idInside: true });
  }
  expect(errors).toEqual([]);
  await context.close();
});

test("200% zoom: after a wrong retrieval scan, Tab onto the Materials tabs never leaves focus under the scan result line", async ({ browser }) => {
  const { context, page, errors } = await openAt(browser, STAFF.priya, { width: 720, height: 450, dpr: 2 });
  await open(page, "/materials?tab=retrieval&selected=RR-0192");
  // The simulated scanner's Scan for a block that is not on the request (nothing changes; the result line says why).
  await page.getByRole("button", { name: "Scan D26-03909 A1" }).click();
  await expect(page.getByRole("status").filter({ hasText: loose("Wrong block: not accepted") })).toBeVisible();
  const scanField = page.locator("#scan-field");
  await expect(scanField).toBeFocused();
  await expect(scanField).toHaveAttribute("aria-describedby", /\S/);
  const lineId = await scanField.getAttribute("aria-describedby");
  const line = page.locator(`[id="${lineId}"]`);
  await expect(line).toContainText(loose("Mismatch. Scanned D26-03909 A1."));
  // From the scan field, Tab to each Materials tab in turn: each one is in view and not covered when it has focus.
  for (const name of [/^Print labels/, /^Assemble trays/, /^Retrieve blocks/]) {
    const link = page.locator("#main").getByRole("link", { name }).first();
    for (let i = 0; i < 20 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await settle(page);
    const seen = await uncovered(link);
    expect(seen.ok, `${name}: ${seen.what}`).toBe(true);
  }
  // The line closed (as Esc or its X would); the wrong scan is still said on the bench itself.
  await expect(line).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Current retrieval request" })).toContainText(/wrong scans? rejected/);
  expect(errors).toEqual([]);
  await context.close();
});

test("Browser text at 20px: the Materials decision column still shows the rows to act on (retrieval picks, tray items)", async ({ browser }) => {
  const { context, page, errors } = await openAt(browser, STAFF.priya, { width: 1366, height: 768, fontPx: 20 });
  await open(page, "/materials?tab=retrieval&selected=RR-0192");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), "the browser text size applies").toBe("20px");
  const column = page.getByRole("region", { name: /^Next: D26-03990 A1/ });
  for (const label of ["D26-03990 A1", "D26-03990 B1"]) {
    const scan = column.getByRole("button", { name: `Scan ${label}` });
    await scan.focus();
    await settle(page);
    const seen = await uncovered(scan);
    expect(seen.ok, `retrieval, Scan ${label}: ${seen.what}`).toBe(true);
  }

  await open(page, "/materials?tab=trays&selected=TRY-M-03");
  const tray = page.getByRole("region", { name: "What the tray needs" });
  await expect(tray.getByRole("heading", { name: /^Not on the tray yet/ })).toBeVisible();
  const decisions = tray.getByRole("button", { name: /^Record as not on tray/ });
  await expect(decisions).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await decisions.nth(i).focus();
    await settle(page);
    const seen = await uncovered(decisions.nth(i));
    expect(seen.ok, `tray, Record as not on tray (${i + 1}): ${seen.what}`).toBe(true);
  }
  expect(errors).toEqual([]);
  await context.close();
});

test("200% zoom: a tray reached with Tab in the sideways tray row comes fully into view", async ({ browser }) => {
  const { context, page, errors } = await openAt(browser, STAFF.priya, { width: 720, height: 450, dpr: 2 });
  await open(page, "/materials?tab=trays&selected=TRY-M-03");
  const row = page.getByRole("navigation", { name: "Trays" }).getByRole("list");
  const links = row.getByRole("link");
  const count = await links.count();
  expect(count, "enough trays to scroll sideways").toBeGreaterThan(3);
  expect(await row.evaluate((ul) => ul.scrollWidth > ul.clientWidth + 1), "the row scrolls sideways at 200% zoom").toBe(true);
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    for (let n = 0; n < 40 && !(await link.evaluate((el) => el === document.activeElement)); n++) await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await settle(page);
    const inside = await link.evaluate((el) => {
      const ul = el.closest("ul")!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.left >= ul.left - 0.5 && r.right <= ul.right + 0.5;
    });
    expect(inside, `${await link.textContent()}: fully inside the tray row when focused`).toBe(true);
  }
  expect(errors).toEqual([]);
  await context.close();
});
