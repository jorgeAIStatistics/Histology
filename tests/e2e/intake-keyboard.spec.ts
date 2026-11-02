// Intake bench: keyboard and scanner behaviour, and the resilience of the lead's
// related-order decision (REL-0112). Ported from the 140-check review script
// (intake-r4/keys-r4.mjs); every check drives the real screen with keys, clicks
// and scans and reads behaviour back (focus, URL, recorded state, what is on
// screen), never pixels. The starting state is the synthetic demo day after the
// 11:00 courier is unpacked (the guided demo's step 1 world event).
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { STAFF, actAs, loose, resetDemo, type StaffId } from "./support";

const SEEDED = "INT-1014-022"; // seeded identity conflict, first in the exceptions lane
const MISSING = "INT-1014-027"; // a missing container; Maya's next step is its container check
const PART_A = "INT-1014-031"; // REL-0112 with INT-1014-032; Kim (accessioning lead) decides it
const PART_B = "INT-1014-032";
const NO_RULE = "INT-1014-034"; // unknown office: Kim's routing exception
const ROUTINE = "INT-1014-025"; // routine review: Maya accepts routing and checks the bottle
const UNCHECKED = "INT-1014-024"; // an unchecked bottle (scan disclaimer)
const FAILS = "INT-1014-028"; // the failed-mutation checks run on this one

// Tests are independent (each opens its own window and item); a failure does not skip the rest.
test.use({ reducedMotion: "reduce" });

/** A command as a demo role, the way the screen sends it (the demo role cookie stands in for the role switch). */
async function command(request: APIRequestContext, actor: StaffId, name: string, input: unknown): Promise<unknown> {
  const res = await request.post(`/api/commands/${name}`, {
    headers: { Cookie: `hlos_actor=${actor}` },
    data: { input, idempotencyKey: `e2e-intake-keys-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const body = (await res.json()) as { ok: boolean; result?: unknown; error?: { message: string } };
  expect(body.ok, `${name} failed: ${body.error?.message}`).toBe(true);
  return body.result;
}

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await resetDemo(request);
  // World event: the 11:00 courier arrives and its bag is unpacked (simulated), as in the guided demo's step 1.
  await command(request, STAFF.maya, "demo.runStep", { step: 1 });
  await request.dispose();
});

/** Uncaught page errors and console errors, for the "no page errors" check of each sequence. */
function watchErrors(page: Page, { console: withConsole = true } = {}): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (withConsole) page.on("console", (m) => void (m.type() === "error" && errors.push(m.text())));
  return errors;
}

const scanField = (page: Page) => page.locator("#scan-field");
const itemOf = (page: Page) => new URL(page.url()).searchParams.get("item");
const decision = (page: Page) => page.getByRole("complementary", { name: "Decision" });
const workspace = (page: Page) => page.getByRole("region", { name: "REL-0112 side by side" });

/** Open an item and wait until the bench is interactive (the scan field takes focus on load). */
async function openItem(page: Page, item: string | null): Promise<void> {
  await page.goto(item ? `/intake?item=${item}` : "/intake");
  if (item) await expect(page.getByRole("heading", { level: 2, name: new RegExp(`intake item ${item}`) })).toBeAttached();
  await expect(scanField(page)).toBeFocused();
}

async function waitItem(page: Page, item: string): Promise<void> {
  await expect.poll(() => itemOf(page)).toBe(item);
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(`intake item ${item}`) })).toBeAttached();
  await expect(page.locator(`[data-queue-item="${item}"]`)).toHaveAttribute("aria-current", "true");
}

/** Open items in working order, as the queue lists them (exceptions, then routine review). */
async function openOrder(page: Page): Promise<string[]> {
  return page
    .locator("section[aria-labelledby='lane-exceptions'] [data-queue-item], section[aria-labelledby='lane-review'] [data-queue-item]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-queue-item") ?? ""));
}

/** A second window at another size (and pixel density) acting as a demo role. Closed by the test. */
async function openAt(browser: Browser, staff: StaffId, size: { width: number; height: number; dpr?: number }): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr ?? 1,
    reducedMotion: "reduce",
  });
  await actAs(context, staff);
  const page = await context.newPage();
  return { context, page, errors: watchErrors(page) };
}

/** Let layout that follows a resize settle (the decision column measures itself in a ResizeObserver and a frame). */
async function settleLayout(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.waitForTimeout(150);
}

async function unfoldAlsoYours(page: Page): Promise<void> {
  const fold = decision(page).getByRole("button", { name: /^Show (it|all \d+)$/ });
  if (await fold.isVisible()) await fold.click();
}

test.describe("intake bench keyboard and scanner", () => {
  test("scan field has focus on load; J/K and the arrow keys move the queue, a typed K still types, Esc goes to the queue, 1 to 5 jump to the steps", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.maya);
    await openItem(page, SEEDED);
    const order = await openOrder(page);
    const next = order[order.indexOf(SEEDED) + 1];
    expect(next, `queue order: ${order.join(", ")}`).toBeTruthy();

    // J and K from the empty scan field.
    await page.keyboard.press("j");
    await waitItem(page, next);
    await expect(scanField(page)).toBeFocused();
    await page.keyboard.press("k");
    await waitItem(page, SEEDED);
    // Arrow keys from the scan field.
    await scanField(page).focus();
    await page.keyboard.press("ArrowDown");
    await waitItem(page, next);
    await scanField(page).focus();
    await page.keyboard.press("ArrowUp");
    await waitItem(page, SEEDED);

    // A capital K types (labels and scanned values start with any letter); so does a value that starts with K.
    await scanField(page).focus();
    await page.keyboard.type("K");
    await expect(scanField(page)).toHaveValue("K");
    await page.keyboard.type("12");
    await expect(scanField(page)).toHaveValue("K12");
    await page.waitForTimeout(300);
    expect(itemOf(page)).toBe(SEEDED);

    // Esc on the empty scan field goes to the selected queue row.
    await scanField(page).fill("");
    await page.keyboard.press("Escape");
    await expect(page.locator(`[data-queue-item="${SEEDED}"]`)).toBeFocused();

    // 1 to 5 jump to the steps (focus is on the queue row, not in a field).
    await page.keyboard.press("1");
    await expect(page.locator("#evidence")).toBeFocused();
    await page.keyboard.press("4");
    await expect(page.locator("#routing")).toBeFocused();
    await page.keyboard.press("2");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#evidence"))).toBe(true);
    await page.keyboard.press("5");
    await expect(page.locator("#accession-request")).toBeFocused();
    await page.keyboard.press("3");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#evidence, #related-orders"))).toBe(true);
    // Exactly one step of the rail is the current one.
    await expect(page.getByRole("navigation", { name: "Path to accession" }).locator("[aria-current='step']")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("Ctrl+Enter and Cmd+Enter never record a container check: they only focus the check button and say why", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.maya);
    await openItem(page, MISSING);
    const container = page.getByRole("region", { name: /^Container 1 of Part A/ });
    await expect(container).toContainText(loose("Not yet verified"));
    const check = decision(page).getByRole("button", { name: "Record: I checked this bottle against the order" });

    await page.keyboard.press("Control+Enter");
    await expect(check).toBeFocused();
    await expect(page.getByText(/Ctrl\+Enter never records a container check/).first()).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    // Even with the check button itself focused, the shortcut records nothing.
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(500);
    await expect(container).toContainText(loose("Not yet verified"));

    // Nothing was recorded on the server either.
    await page.reload();
    await expect(scanField(page)).toBeFocused();
    await expect(container).toContainText(loose("Not yet verified"));
    await expect(page.getByRole("region", { name: "History" }).first()).not.toContainText(/staff verified/i);
    expect(errors).toEqual([]);
  });

  test("Ctrl+Enter runs only the step with the Ctrl badge; its dialog takes focus and gives it back on Esc", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.kim);
    await openItem(page, NO_RULE);
    const badged = page.locator("[data-intake-primary]");
    await expect(badged).toHaveCount(1);
    await expect(badged).toContainText("Choose the dermatopathologist");

    await page.keyboard.press("Control+Enter");
    const dialog = page.getByRole("dialog", { name: "Resolve routing exception" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("dialog[open]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(decision(page).getByRole("button", { name: /^Choose the dermatopathologist/ })).toBeFocused();
    // The container check that is also Kim's was not recorded, and nothing was assigned.
    await expect(page.getByRole("region", { name: /^Container 1 of Part A/ })).toContainText(loose("Not yet verified"));
    await expect(page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ })).toContainText(loose("Routing exception: no approved rule applies"));
    expect(errors).toEqual([]);
  });

  test("after each action the scan field has focus again, and a scanned INT id opens that item", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.maya);
    await openItem(page, ROUTINE);
    await unfoldAlsoYours(page);
    await decision(page).getByRole("button", { name: /^Accept routing to / }).click();
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText(/Routing accepted/);
    await expect(scanField(page)).toBeFocused();
    await decision(page).getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText(/your check is recorded/);
    await expect(scanField(page)).toBeFocused();
    // Scanner path: the value and Enter, as a scanner types it.
    await scanField(page).fill("INT-1014-026");
    await page.keyboard.press("Enter");
    await waitItem(page, "INT-1014-026");
    expect(errors).toEqual([]);
  });

  test("a failed mutation shows an accessible error and changes nothing", async ({ page, context }) => {
    const errors = watchErrors(page, { console: false }); // the aborted request logs a network error on purpose
    await actAs(context, STAFF.maya);
    await openItem(page, FAILS);
    const container = page.getByRole("region", { name: /^Container 1 of Part A/ });
    const check = () => decision(page).getByRole("button", { name: "Record: I checked this bottle against the order" });

    // The request never reaches the server: an inline alert says so; the check is not shown as recorded.
    await page.route("**/api/commands/intake.verifyContainer", (route) => route.abort("internetdisconnected"));
    await check().click();
    const alert = decision(page).getByRole("alert");
    await expect(alert).toContainText("Could not reach the local server");
    await expect(container).toContainText(loose("Not yet verified"));
    await page.unroute("**/api/commands/intake.verifyContainer");

    // The server refuses a stale request (the record changed since the page was loaded): it says so and keeps the record.
    await page.reload();
    await expect(scanField(page)).toBeFocused();
    await page.route("**/api/commands/intake.verifyContainer", async (route) => {
      const body = route.request().postDataJSON() as { input: { expectedVersion: number } };
      body.input.expectedVersion += 100;
      await route.continue({ postData: JSON.stringify(body) });
    });
    await check().click();
    const conflict = page.getByRole("dialog", { name: "Someone else changed this item" });
    await expect(conflict).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(conflict).toBeHidden();
    await page.unroute("**/api/commands/intake.verifyContainer");

    await page.reload();
    await expect(scanField(page)).toBeFocused();
    await expect(container).toContainText(loose("Not yet verified"));
    await expect(page.getByRole("region", { name: "History" }).first()).not.toContainText(/staff verified/i);
    expect(errors).toEqual([]);
  });

  test("bench tablet (1024): the queue drawer takes focus on the selected row, Esc closes it and returns focus; touch targets and no sideways scroll", async ({ browser }) => {
    const { context, page, errors } = await openAt(browser, STAFF.maya, { width: 1024, height: 768 });
    try {
      await openItem(page, MISSING);
      const queue = page.locator("#intake-queue");
      const toggle = page.getByRole("button", { name: /^Queue/ }).first();
      await toggle.click();
      await expect(page.locator(`[data-queue-item="${MISSING}"]`)).toBeFocused();
      await expect(queue).toBeVisible();
      // Touch targets: the step buttons and the queue rows are at least 44px tall at this size.
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("nav[aria-label='Path to accession'] button, [data-queue-item]")]
          .map((el) => el.getBoundingClientRect().height)
          .filter((h) => h > 0 && h < 44),
      );
      expect(small).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(queue).toBeHidden();
      await expect(page.locator("[aria-controls='intake-queue']").first()).toBeFocused();
      // Esc from the empty scan field opens the drawer on the selected row.
      await scanField(page).focus();
      await page.keyboard.press("Escape");
      await expect(page.locator(`[data-queue-item="${MISSING}"]`)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(queue).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "sideways scroll at 1024").toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const [width, height] of [
    [720, 450],
    [683, 384],
  ] as const) {
    test(`200% zoom (${width}x${height} at 2x): one page-scrolling column in reading order; keys and scans unchanged`, async ({ browser }) => {
      const { context, page, errors } = await openAt(browser, STAFF.maya, { width, height, dpr: 2 });
      try {
        await openItem(page, MISSING);
        const geo = await page.evaluate(() => {
          const top = (sel: string) => (document.querySelector(sel)?.getBoundingClientRect().top ?? NaN) + window.scrollY;
          return {
            sideways: document.documentElement.scrollWidth - window.innerWidth,
            bar: document.querySelector("header[data-shell-chrome]")!.getBoundingClientRect().height,
            vh: window.innerHeight,
            pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 50,
            order: ["[aria-label='Current case']", "[aria-label='Current finding']", "[aria-label='Your next step']", "[data-intake-verify]", "#evidence"].map(top),
          };
        });
        expect(geo.sideways).toBeLessThanOrEqual(0);
        expect(geo.bar).toBeLessThanOrEqual(geo.vh / 3 + 1);
        expect(geo.pageScrolls).toBe(true);
        // Identity, finding, next step (with its action), then the evidence.
        expect(geo.order).toEqual([...geo.order].sort((a, b) => a - b));
        // The focused primary action is wholly visible below the top bar.
        await page.locator("[data-intake-verify]").focus();
        const r = await page.evaluate(() => {
          const b = document.activeElement!.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, right: b.right, bar: document.querySelector("header[data-shell-chrome]")!.getBoundingClientRect().bottom, vh: innerHeight, vw: innerWidth };
        });
        expect(r.top).toBeGreaterThanOrEqual(r.bar - 1);
        expect(r.bottom).toBeLessThanOrEqual(r.vh + 1);
        expect(r.right).toBeLessThanOrEqual(r.vw + 1);

        const order = await openOrder(page);
        const next = order[order.indexOf(MISSING) + 1];
        await scanField(page).focus();
        await page.keyboard.press("j");
        await waitItem(page, next);
        // Esc from the empty scan field opens the queue drawer on the selected row; Esc closes it.
        await scanField(page).focus();
        await page.keyboard.press("Escape");
        await expect(page.locator(`[data-queue-item="${next}"]`)).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#intake-queue")).toBeHidden();
        // Key 1 brings the evidence just below the top bar.
        await page.keyboard.press("1");
        await expect(page.locator("#evidence")).toBeFocused();
        await expect
          .poll(() =>
            page.evaluate(() => {
              const e = document.getElementById("evidence")!.getBoundingClientRect().top;
              const bar = document.querySelector("header[data-shell-chrome]")!.getBoundingClientRect().bottom;
              return e >= bar - 1 && e <= bar + 40;
            }),
          )
          .toBe(true);
        // A scan still opens the item.
        await scanField(page).fill(MISSING);
        await page.keyboard.press("Enter");
        await waitItem(page, MISSING);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test("visible focus: every keyboard stop on the bench shows the focus ring and is not covered", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.kim);
    await openItem(page, PART_A);
    const stops: { what: string; ring: boolean; covered: boolean }[] = [];
    for (let i = 0; i < 90; i++) {
      await page.keyboard.press("Tab");
      const s = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest("#main")) return null;
        const cs = getComputedStyle(el);
        const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) || /rgb/.test(cs.boxShadow);
        const r = el.getBoundingClientRect();
        const x = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width / 2, 12)));
        const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
        const hit = document.elementFromPoint(x, y);
        const covered = !hit || !(el === hit || el.contains(hit) || hit.closest("label")?.contains(el));
        const what = `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}`;
        return { what, ring, covered, decisionReason: el.tagName === "TEXTAREA" && !!el.closest("[data-intake-decision]") };
      });
      if (!s) continue;
      stops.push({ what: s.what, ring: s.ring, covered: s.covered });
      if (s.decisionReason) break; // through the queue, the identity band, the steps, the decision column and the decision's evidence and choices
    }
    expect(stops.length).toBeGreaterThan(10);
    expect(stops.filter((s) => !s.ring).map((s) => s.what)).toEqual([]);
    expect(stops.filter((s) => s.covered).map((s) => s.what)).toEqual([]);
    expect(stops.some((s) => /^input/.test(s.what))).toBe(true); // reached the choices
    expect(errors).toEqual([]);
  });

  test("the scan disclaimer is said once, on a sheet whose bottle still needs its check", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.maya);
    await openItem(page, UNCHECKED);
    await expect(page.getByText("A scan identifies the record; it does not verify the tissue.")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("the empty bench has no presenter controls; the next item opens with J or its button", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.maya);
    await openItem(page, null);
    const bench = page.locator("#main");
    await expect(bench.getByText(/Presenter controls/)).toHaveCount(0);
    await expect(bench.getByRole("button", { name: /Unpack|Simulate a colleague/ })).toHaveCount(0);
    await expect(bench.getByText(/still in the bag/)).toHaveCount(0);
    const open = page.getByRole("button", { name: /^Open INT-1014-/ });
    await expect(open).toHaveAttribute("aria-keyshortcuts", /Control\+Enter/);
    const first = (await open.innerText()).match(/INT-\d{4}-\d{3}/)![0];
    await page.keyboard.press("j");
    await waitItem(page, first);
    // An open item has none either (the simulated colleague edit lives in the presenter console).
    await expect(bench.getByText(/Presenter controls/)).toHaveCount(0);
    await expect(bench.getByRole("button", { name: /Simulate a colleague/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("REL-0112: the lead decides one case or two", () => {
  for (const [width, height] of [
    [1366, 768],
    [1440, 900],
  ] as const) {
    test(`${width}x${height}: evidence first and pinned, choices after it, Record decision pinned in the column; keys and the early press record nothing`, async ({ browser }) => {
      const { context, page, errors } = await openAt(browser, STAFF.kim, { width, height });
      try {
        await openItem(page, PART_A);
        const ws = workspace(page);
        await expect(ws).toBeVisible();
        // The workspace leads the centre, above the evidence sheet.
        expect(await page.evaluate(() => document.querySelector("[data-intake-decision]")!.getBoundingClientRect().top < document.getElementById("evidence")!.getBoundingClientRect().top)).toBe(true);
        await expect(ws.getByRole("columnheader", { name: new RegExp(`^Part A\\s*Provisional intake item ${PART_A}`) })).toBeVisible();
        await expect(ws.getByRole("columnheader", { name: new RegExp(`^Part B\\s*Provisional intake item ${PART_B}`) })).toBeVisible();
        // Differences first: what keeps them apart, then the six reasons they share; seven aligned rows.
        const rows = ws.locator("tbody tr");
        await expect(rows).toHaveCount(7);
        await expect(rows.first()).toHaveAccessibleName(/^Separate source orders/);
        await expect(ws.getByRole("row", { name: /^Separate source orders / })).toContainText(loose("ORD-77120 ORD-77121"));

        // Evidence before the choices, in reading and in tab order.
        const radios = ws.getByRole("radio");
        await expect(radios).toHaveCount(4);
        expect(await page.evaluate(() => {
          const ws = document.querySelector("[data-intake-decision]")!;
          const firstRow = ws.querySelector("tbody tr")!;
          const firstRadio = ws.querySelector("input[type=radio]")!;
          return !!(firstRow.compareDocumentPosition(firstRadio) & Node.DOCUMENT_POSITION_FOLLOWING);
        })).toBe(true);
        await ws.getByRole("link", { name: new RegExp(PART_B) }).focus();
        await page.keyboard.press("Tab");
        await expect(radios.first()).toBeFocused();

        // At the bench size everything the decision needs is in view without scrolling.
        for (let i = 0; i < 4; i++) await expect(radios.nth(i)).toBeInViewport({ ratio: 1 });
        await expect(ws.getByLabel(/^Reason/)).toBeInViewport({ ratio: 1 });
        const record = decision(page).getByRole("button", { name: /^Record decision/ });
        await expect(record).toBeInViewport({ ratio: 1 });
        await expect(page.locator("[data-intake-primary]")).toHaveCount(1);
        await expect(page.locator("[data-intake-primary]")).toContainText("Record decision");
        await expect(decision(page)).toContainText(loose("Review, not merge. Both orders and both provisional ids are kept."));

        // Ctrl+Enter with nothing chosen says why and records nothing.
        await scanField(page).focus();
        await page.keyboard.press("Control+Enter");
        await expect.poll(() => page.getByText("Choose a decision and give a reason.").count()).toBeGreaterThanOrEqual(2);
        // Choosing shows its effect beside the choices, in view, without scrolling the centre.
        await radios.first().check();
        const effect = ws.getByRole("status").filter({ hasText: "If recorded" });
        await expect(effect).toBeInViewport({ ratio: 1 });
        expect(await page.evaluate(() => document.querySelector("[data-intake-decision]")!.parentElement!.scrollTop)).toBe(0);
        // Ctrl+Enter inside the empty reason field still runs the badged step, which says the reason is missing.
        await ws.getByLabel(/^Reason/).focus();
        await page.keyboard.press("Control+Enter");
        await expect.poll(() => page.getByText("Give a reason; it is recorded with your name.").count()).toBeGreaterThanOrEqual(2);
        // Pressing Record decision early (it is aria-disabled, not disabled, so a press can say why): the reason
        // field says what is missing and takes focus; nothing is recorded. Pressed from the keyboard here.
        await record.focus();
        await page.keyboard.press("Enter");
        const reason = ws.getByLabel(/^Reason/);
        await expect(reason).toBeFocused();
        await expect(reason).toHaveAttribute("aria-invalid", "true");
        await expect(ws.getByText("A reason is required: say why. It is recorded with your name.")).toBeVisible();
        await expect(page.getByText(/Decision by Kim Nguyen/)).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: "Path to accession" }).getByRole("button", { name: /^Step 3, Related orders, yours now/ })).toBeVisible();

        // Keys 2 and 3: the bottle evidence below, and back to the decision.
        await scanField(page).focus();
        await scanField(page).fill("");
        await page.keyboard.press("Escape");
        await expect(page.locator(`[data-queue-item="${PART_A}"]`)).toBeFocused();
        await page.keyboard.press("2");
        await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#evidence"))).toBe(true);
        await page.keyboard.press("3");
        await expect(ws).toBeFocused();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test("an accessioner on the same item gets her own step, never the lead's choices", async ({ page, context }) => {
    const errors = watchErrors(page);
    await actAs(context, STAFF.maya);
    await openItem(page, PART_B);
    await expect(page.locator("[data-intake-decision]")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: /^Link as related/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Record decision/ })).toHaveCount(0);
    await expect(page.locator("[data-intake-verify]")).toHaveCount(1);
    await expect(decision(page)).toContainText(loose("Kim Nguyen to decide REL-0112: one case or two?"));
    await expect(page.getByRole("region", { name: "Related orders" })).toContainText(loose("Your demo role can view the candidate but not decide"));
    expect(errors).toEqual([]);
  });

  // C3: the decision stays usable with larger text, a validation message, a narrower bench and 200% zoom.
  const conditions = [
    { name: "1366x768", width: 1366, height: 768 },
    { name: "1366x768, root font-size 125%", width: 1366, height: 768, css: "html { font-size: 125% !important; }" },
    { name: "1366x768, Record decision pressed without a reason", width: 1366, height: 768, press: true },
    { name: "1024x768", width: 1024, height: 768 },
    { name: "200% zoom (720x450 at 2x)", width: 720, height: 450, dpr: 2 },
  ];
  for (const c of conditions) {
    test(`resilience at ${c.name}: nothing clipped out of reach, Record decision reachable, no sideways overflow, the conflict on screen with any choice`, async ({ browser }) => {
      const { context, page, errors } = await openAt(browser, STAFF.kim, { width: c.width, height: c.height, dpr: c.dpr });
      try {
        await openItem(page, PART_A);
        if (c.css) await page.addStyleTag({ content: c.css });
        await settleLayout(page);
        const ws = workspace(page);
        await expect(ws).toBeVisible();
        if (c.press) {
          await ws.getByRole("radio", { name: /^Link as related/ }).check();
          // A pointer press on the aria-disabled button (Playwright treats aria-disabled as not clickable, hence force).
          await page.getByRole("button", { name: /^Record decision/ }).click({ force: true });
          await expect(ws.getByLabel(/^Reason/)).toBeFocused();
          await expect(ws.getByText("A reason is required: say why. It is recorded with your name.")).toBeVisible();
          await settleLayout(page);
        }
        const report = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const vh = window.innerHeight;
          const clippers = (el: Element) => {
            const out: Element[] = [];
            for (let p = el.parentElement; p; p = p.parentElement) {
              const cs = getComputedStyle(p);
              if (cs.overflowX !== "visible" || cs.overflowY !== "visible") out.push(p);
            }
            return out;
          };
          const shown = (el: Element) => {
            const r = el.getBoundingClientRect();
            if (r.height < 1 || r.top < -1 || r.bottom > vh + 1 || r.left < -1 || r.right > vw + 1) return false;
            for (const p of clippers(el)) {
              const pr = p.getBoundingClientRect();
              if (r.top < pr.top - 1 || r.bottom > pr.bottom + 1 || r.left < pr.left - 1 || r.right > pr.right + 1) return false;
            }
            const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + Math.min(r.width / 2, 24))), Math.min(vh - 1, Math.max(0, r.top + Math.min(r.height / 2, 10))));
            return !!hit && (el === hit || el.contains(hit) || !!hit.closest("label")?.contains(el));
          };
          // Reachable: scrolled into view (centre, end or start), it is wholly on screen and not under pinned chrome.
          const reachable = (el: Element) =>
            (["center", "end", "start"] as const).some((block) => {
              el.scrollIntoView({ block, inline: "nearest" });
              return shown(el);
            });
          const ws = document.querySelector("[data-intake-decision]")!;
          const record = [...document.querySelectorAll("button")].find((b) => /^Record decision/.test((b.textContent ?? "").trim()))!;
          const targets: [string, Element][] = [
            ...[...ws.querySelectorAll("thead th, tbody tr")].filter((e) => !e.closest(".sr-only")).map((e, i) => [`evidence ${i}`, e] as [string, Element]),
            ...[...ws.querySelectorAll("input[type=radio]")].map((e) => [`choice ${(e as HTMLInputElement).value}`, e.closest("label") ?? e] as [string, Element]),
            ["reason", ws.querySelector("textarea")!],
            ["effect", ws.querySelector("[role=status]")!],
            ...[...ws.querySelectorAll("[id$='-error']")].map((e) => ["validation message", e] as [string, Element]),
            ["Record decision", record],
            ["decision step heading", document.querySelector("aside[aria-label='Decision'] h3")!],
            ["accession request", document.getElementById("accession-request")!],
          ];
          const unreachable = targets.filter(([, el]) => !reachable(el)).map(([n]) => n);
          // With any choice on screen (scrolled to the top or the bottom of the view), what keeps the two apart is on screen too.
          const conflictShown = () => [...document.querySelectorAll("[data-rel-pinned] tbody tr, [data-rel-recap] p")].some(shown);
          const choiceWithoutConflict: string[] = [];
          for (const radio of ws.querySelectorAll("input[type=radio]")) {
            for (const block of ["start", "end"] as const) {
              radio.scrollIntoView({ block });
              if (shown(radio.closest("label") ?? radio) && !conflictShown()) choiceWithoutConflict.push(`${(radio as HTMLInputElement).value} at ${block}`);
            }
          }
          // Record decision can take keyboard focus and is then in view.
          record.focus();
          const rr = record.getBoundingClientRect();
          const main = document.getElementById("main")!;
          return {
            unreachable,
            choiceWithoutConflict,
            recordFocused: document.activeElement === record && rr.top >= 0 && rr.bottom <= vh,
            evidenceBeforeChoices: !!(ws.querySelector("tbody tr")!.compareDocumentPosition(ws.querySelector("input[type=radio]")!) & Node.DOCUMENT_POSITION_FOLLOWING),
            // What is drawn past the right edge (content that a parent clips on purpose, such as folded titles, is not drawn).
            sidewaysInBench: Math.max(
              0,
              ...[...main.querySelectorAll("*")].map((e) => {
                let right = e.getBoundingClientRect().right;
                for (const p of clippers(e)) right = Math.min(right, p.getBoundingClientRect().right);
                return right - vw;
              }),
            ),
            sidewaysScrollers: [...main.querySelectorAll("*")].filter((e) => {
              const cs = getComputedStyle(e);
              return (cs.overflowX === "auto" || cs.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 1;
            }).length,
            sidewaysPage: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(report.evidenceBeforeChoices).toBe(true);
        expect(report.unreachable, "elements clipped with no way to scroll to them").toEqual([]);
        expect(report.recordFocused, "Record decision reachable by keyboard and in view").toBe(true);
        expect(report.choiceWithoutConflict, "a choice on screen without what keeps the two apart").toEqual([]);
        expect(report.sidewaysInBench, "horizontal overflow inside the bench").toBeLessThanOrEqual(1);
        expect(report.sidewaysScrollers).toBe(0);
        expect(errors).toEqual([]);
        expect(report.sidewaysPage, "horizontal page scroll (top bar or bench)").toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }
});
