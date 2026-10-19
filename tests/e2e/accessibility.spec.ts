// Stage 6 (A2): automated accessibility checks on the real screens, and keyboard-only checks with a failed
// mutation. Synthetic data only; nothing here contacts anything but the local test server.
//
// 1. axe-core (@axe-core/playwright) with the WCAG 2.0/2.1 A and AA rules and the WCAG 2.2 AA rules
//    (tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) on Intake (an open item as the lead, and the empty
//    bench), the Worklist (histotech and operations views), Materials (print, trays, retrieval), Operations,
//    Clarify (a selected record) and the presenter console (guide, role, world, outages); plus the states that
//    only exist after a press: a validation message, an open dialog, a side panel, a scan result, a failed action.
//    No rule is disabled. While a modal dialog is open only the dialog is checked, because the page behind it is
//    inert (see MODAL); the same page is checked without the dialog. axe finds a subset of WCAG failures only; it
//    does not replace the human screen-reader pass (docs/release/screen-reader-checklist.md).
// 2. Keyboard only, on Worklist, Materials (tray scan and retrieval scan), Clarify and Operations (Intake is
//    covered by intake-keyboard.spec.ts and is not repeated here): every main action is reached with Tab and
//    shows the focus ring without being covered; after a failed mutation (its POST answered HTTP 500 by
//    page.route) the error is announced (role="alert"), focus is on or next to it, and focus is never lost to
//    the page body.
//
// Starting state: the synthetic demo day after the 11:00 courier is unpacked (the guided demo's step 1 world
// event), as in intake-keyboard.spec.ts. Only the retrieval test records anything (two blocks picked), which no later
// test here looks at; the demo is reset again at the end, so later spec files start from the same state either way.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { STAFF, actAs, loose, resetDemo, type StaffId } from "./support";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** The text of an HTTP 500 that is not JSON, as the screens report it (src/lib/client/command.ts). */
const HTTP_500 = loose("Unexpected response from the local server (HTTP 500).");

test.use({ reducedMotion: "reduce" });

/** A command as a demo role, the way the screen sends it (the demo role cookie stands in for the role switch). */
async function command(request: APIRequestContext, actor: StaffId, name: string, input: unknown): Promise<void> {
  const res = await request.post(`/api/commands/${name}`, {
    headers: { Cookie: `hlos_actor=${actor}` },
    data: { input, idempotencyKey: `e2e-a11y-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const body = (await res.json()) as { ok: boolean; error?: { message: string } };
  expect(body.ok, `${name} failed: ${body.error?.message}`).toBe(true);
}

async function startingState(request: APIRequestContext): Promise<void> {
  await resetDemo(request);
  // World event: the 11:00 courier arrives and its bag is unpacked (simulated), as in the guided demo's step 1.
  await command(request, STAFF.maya, "demo.runStep", { step: 1 });
}

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await startingState(request);
  await request.dispose();
});

test.afterAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await resetDemo(request);
  await request.dispose();
});

/** Uncaught page errors, for the "no page errors" check (console errors are expected from the forced HTTP 500s). */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** Open a screen as a demo role and wait until it is interactive (the top bar's scan field is hydrated). */
async function openScreen(page: Page, context: BrowserContext, actor: StaffId, url: string): Promise<void> {
  await actAs(context, actor);
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => Object.keys(document.getElementById("scan-field") ?? {}).some((k) => k.startsWith("__reactProps"))), { message: "the page is interactive" })
    .toBe(true);
  await settle(page);
}

/** Two animation frames and a short pause: layout that follows a render or a resize has settled. */
async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.waitForTimeout(150);
}

/** Where axe looks: the whole page, or only an open modal dialog (see MODAL below). */
type AxeScope = "page" | typeof MODAL;

/**
 * While a modal dialog is open (showModal), everything behind it is inert: not operable and not in the accessibility
 * tree, so no WCAG check applies to it in that state. axe-core 4.13 still measures pointer targets behind a native
 * modal <dialog> against the dialog's own controls; with the retrieval "not found" dialog open it intermittently
 * reported the "Not at last location…" button behind the dialog under target-size. That is a false positive of the
 * modal state, so in a state with an open modal dialog only the dialog is checked. The page behind it is checked in
 * its own state, before the dialog opens, by the same tests. No rule is disabled. (Listed in the Stage 6 gaps.)
 */
const MODAL = "dialog[open]";

/**
 * axe with the WCAG 2.x A/AA and 2.2 AA rules; every violation is listed with its nodes. It runs once the document
 * has its title: one of several runs saw axe report a missing <title> right after recorded actions (the cause is not
 * established). Waiting for the title keeps a passing moment out of the check; a title that never comes still fails.
 */
async function expectNoAxeViolations(page: Page, where: string, scope: AxeScope = "page"): Promise<void> {
  await expect(page, `${where}: the page has its title`).toHaveTitle(/\S/);
  const builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  if (scope !== "page") builder.include(scope);
  const results = await builder.analyze();
  const found = results.violations.map((v) => `${v.id} [${v.impact}] ${v.help}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(found, `axe violations on ${where}`).toEqual([]);
  // The run checked something: a page that did not render would pass vacuously.
  expect(results.passes.length, `axe rules that passed on ${where}`).toBeGreaterThan(scope === "page" ? 10 : 3);
}

const scanField = (page: Page) => page.locator("#scan-field");

// =====================================================================================================================
// 1. axe
// =====================================================================================================================

test.describe("axe: WCAG 2.x A/AA and 2.2 AA rules on each screen", () => {
  const screens: { name: string; actor: StaffId; url: string }[] = [
    { name: "Intake, INT-1014-031 open as the accessioning lead (REL-0112)", actor: STAFF.kim, url: "/intake?item=INT-1014-031" },
    { name: "Intake, the empty bench", actor: STAFF.maya, url: "/intake" },
    { name: "Worklist, histotech view", actor: STAFF.priya, url: "/worklist?view=histotech" },
    { name: "Worklist, operations view", actor: STAFF.tanya, url: "/worklist?view=operations" },
    { name: "Materials, print tab (PJ-8841)", actor: STAFF.priya, url: "/materials?tab=print&selected=PJ-8841" },
    { name: "Materials, trays tab (TRY-M-03)", actor: STAFF.priya, url: "/materials?tab=trays&selected=TRY-M-03" },
    { name: "Materials, retrieval tab (RR-0192)", actor: STAFF.priya, url: "/materials?tab=retrieval&selected=RR-0192" },
    { name: "Operations", actor: STAFF.tanya, url: "/operations" },
    { name: "Clarify, CLR-0455 selected", actor: STAFF.kim, url: "/clarifications?selected=CLR-0455" },
    { name: "Presenter console, guide (step 1)", actor: STAFF.maya, url: "/demo?tab=guide&step=1" },
    { name: "Presenter console, role and clock", actor: STAFF.maya, url: "/demo?tab=role" },
    { name: "Presenter console, world events", actor: STAFF.maya, url: "/demo?tab=world" },
    { name: "Presenter console, outages and reset", actor: STAFF.maya, url: "/demo?tab=outages" },
  ];
  for (const s of screens) {
    test(s.name, async ({ page, context }) => {
      const errors = watchPageErrors(page);
      await openScreen(page, context, s.actor, s.url);
      await expectNoAxeViolations(page, s.name);
      expect(errors).toEqual([]);
    });
  }

  test("states after a press: the REL-0112 reason message, a worklist side panel, the acknowledge dialog, a wrong-block scan, the not-found dialog", async ({ page, context }) => {
    const errors = watchPageErrors(page);
    // Intake: Record decision pressed with a choice and no reason (the field says what is missing).
    await openScreen(page, context, STAFF.kim, "/intake?item=INT-1014-031");
    const ws = page.getByRole("region", { name: "REL-0112 side by side" });
    await ws.getByRole("radio", { name: /^Link as related/ }).check();
    await page.getByRole("button", { name: /^Record decision/ }).click({ force: true }); // aria-disabled until a reason is given
    await expect(ws.getByText("A reason is required: say why. It is recorded with your name.")).toBeVisible();
    await expectNoAxeViolations(page, "Intake with the REL-0112 reason message");

    // Worklist: a row's side panel, then the acknowledge confirmation (a modal alert dialog).
    await openScreen(page, context, STAFF.tanya, "/worklist?view=operations&selected=D26-04804");
    await expect(page.getByRole("complementary").getByRole("heading", { name: /D26-04804/ }).first()).toBeVisible();
    await expectNoAxeViolations(page, "Worklist with the side panel open");
    await page.getByRole("region", { name: "Changes since your last acknowledgment" }).getByRole("button", { name: /^Acknowledge/ }).click();
    await expect(page.getByRole("alertdialog", { name: /^Acknowledge changes up to v\d+\?$/ })).toBeVisible();
    await expectNoAxeViolations(page, "Worklist with the acknowledge dialog open", MODAL);
    await page.keyboard.press("Escape");

    // Materials, retrieval: a wrong block scanned (nothing changes), then the "not with the recorded holder" dialog.
    await openScreen(page, context, STAFF.priya, "/materials?tab=retrieval&selected=RR-0192");
    await page.getByRole("button", { name: "Scan D26-03909 A1" }).click();
    await expect(page.getByRole("status").filter({ hasText: loose("Wrong block: not accepted") })).toBeVisible();
    await expectNoAxeViolations(page, "Materials retrieval after a wrong-block scan");
    await page.getByRole("button", { name: "Not with the recorded holder…" }).click();
    await expect(page.getByRole("dialog", { name: "D26-03912 A1 is not with Marcus Lee?" })).toBeVisible();
    await expectNoAxeViolations(page, "Materials retrieval with the not-found dialog open", MODAL);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
});

// =====================================================================================================================
// 2. Keyboard only
// =====================================================================================================================

interface TabStop {
  what: string;
  ring: boolean;
  covered: boolean;
}

/**
 * Press Tab up to `max` times from where focus is, and record every stop inside `#main` (the bench) and the top
 * bar's scan field: whether the focus ring shows (an outline of 2px or more, or a box-shadow ring, on the element or,
 * for the scan field, on its frame) and whether something else covers it near its top-left corner, three frames
 * after the key press. Each element reached is marked with data-e2e-tab-reached so a test can then ask whether a
 * given action was reached. Stops when focus returns to a stop already seen after leaving the bench (one full
 * cycle) or after `max` presses.
 */
async function tabThrough(page: Page, max: number): Promise<TabStop[]> {
  const stops: TabStop[] = [];
  let leftBench = false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    // A pinned column brings the focused control out from under its "more below" cover in the next frame
    // (src/components/materials/shared.tsx useCutBelow); judge what the person sees once that has happened.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))));
    const s = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { body: true } as const;
      const inBench = !!el.closest("#main") || el.id === "scan-field";
      if (!inBench) return { body: false, inBench: false } as const;
      const again = el.hasAttribute("data-e2e-tab-reached");
      el.setAttribute("data-e2e-tab-reached", "");
      const ringOf = (e: Element) => {
        const cs = getComputedStyle(e);
        return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) || /rgb/.test(cs.boxShadow);
      };
      // The scan field draws its ring on its frame (focus-within), so the mono input stays clean.
      const ring = ringOf(el) || (el.id === "scan-field" && !!el.parentElement && ringOf(el.parentElement));
      const r = el.getBoundingClientRect();
      const x = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width / 2, 12)));
      const y = Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 12)));
      const hit = document.elementFromPoint(x, y);
      const covered = !hit || !(el === hit || el.contains(hit) || !!hit.closest("label")?.contains(el));
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 50);
      return { body: false, inBench: true, again, what: `${el.tagName.toLowerCase()} ${el.id ? "#" + el.id + " " : ""}${name}`, ring, covered };
    });
    if (s.body || !s.inBench) {
      if (stops.length) leftBench = true;
      continue;
    }
    if (s.again && leftBench) break;
    if (!s.again) stops.push({ what: s.what, ring: s.ring, covered: s.covered });
  }
  return stops;
}

/** Every stop shows the focus ring and is not covered; the actions listed were all reached by Tab. */
async function expectReachedWithVisibleFocus(stops: TabStop[], actions: Locator[], where: string): Promise<void> {
  expect(stops.length, `${where}: keyboard stops on the bench`).toBeGreaterThan(5);
  expect(stops.filter((s) => !s.ring).map((s) => s.what), `${where}: stops without a visible focus ring`).toEqual([]);
  expect(stops.filter((s) => s.covered).map((s) => s.what), `${where}: stops covered by other content`).toEqual([]);
  for (const action of actions) {
    await expect(action, `${where}: reached with Tab`).toHaveCount(1);
    await expect(action, `${where}: reached with Tab`).toHaveAttribute("data-e2e-tab-reached", "");
  }
}

/** Answer one command with HTTP 500 (a plain-text server error), until unrouted. */
async function fail500(page: Page, name: string): Promise<() => Promise<void>> {
  const pattern = `**/api/commands/${name}`;
  await page.route(pattern, (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" }));
  return () => page.unroute(pattern);
}

/**
 * After a failed mutation: the error is announced (`announced` is a role="alert" region with the error), it is shown
 * (`shown`, the visible message; the alert itself unless the screen keeps its live region off screen, as the scan
 * field does), focus is not on the page body, and focus is on or next to the shown error: the focused element is
 * the message or inside it, points to it (aria-describedby), or sits within 120 CSS px of it.
 */
async function expectFocusAtError(page: Page, announced: Locator, where: string, shown: Locator = announced): Promise<void> {
  await expect(announced, `${where}: the error is announced`).toHaveAttribute("role", "alert");
  await expect(announced, `${where}: the error is announced`).toHaveCount(1);
  await expect(shown, `${where}: the error is shown`).toBeVisible();
  const r = await shown.evaluate((a) => {
    const el = document.activeElement as HTMLElement | null;
    const what = el ? `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 50)}` : "nothing";
    if (!el || el === document.body) return { body: true, near: false, what, how: "" };
    const described = (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .some((d) => !!d && (d === a || d.contains(a) || a.contains(d)));
    const inside = a === el || a.contains(el) || el.contains(a);
    const ar = a.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const dx = Math.max(0, ar.left - er.right, er.left - ar.right);
    const dy = Math.max(0, ar.top - er.bottom, er.top - ar.bottom);
    const distance = Math.hypot(dx, dy);
    return { body: false, near: inside || described || distance <= 120, what, how: inside ? "inside" : described ? "aria-describedby" : `${Math.round(distance)}px away` };
  });
  expect(r.body, `${where}: focus was lost to the page body`).toBe(false);
  expect(r.near, `${where}: focus (${r.what}) is on or next to the error (${r.how})`).toBe(true);
}

/** The scan field's visible result line (what the field points to with aria-describedby while it shows). */
async function scanResultLine(page: Page): Promise<Locator> {
  await expect(scanField(page), "the scan field points to its result line").toHaveAttribute("aria-describedby", /\S/);
  const id = await scanField(page).getAttribute("aria-describedby");
  return page.locator(`[id="${id}"]`);
}

test.describe("keyboard only: reach every main action with visible focus; a failed mutation keeps focus at its error", () => {
  test("Worklist: toolbar, filters, rows and Acknowledge by Tab; a failed print and a failed acknowledgment keep focus at the error", async ({ page, context }) => {
    const errors = watchPageErrors(page);
    await openScreen(page, context, STAFF.tanya, "/worklist?view=operations");
    const main = page.locator("#main");
    const changeLine = page.getByRole("region", { name: "Changes since your last acknowledgment" });
    const acknowledge = changeLine.getByRole("button", { name: /^Acknowledge/ });
    await expect(acknowledge, "after the courier there is something to acknowledge").toBeEnabled();
    await scanField(page).focus();
    const stops = await tabThrough(page, 80);
    const views = main.getByRole("navigation", { name: "Worklist views" });
    const toolbar = main.getByRole("toolbar", { name: "Find and filter the worklist" });
    const print = main.getByRole("button", { name: /^Print snapshot/ });
    await expectReachedWithVisibleFocus(
      stops,
      [
        views.getByRole("link", { name: /^Accessioning/ }),
        views.getByRole("link", { name: /^Histotech/ }),
        main.getByRole("button", { name: "All cases" }),
        main.getByRole("button", { name: /^Saved filters/ }),
        print,
        main.getByRole("button", { name: "Download CSV" }),
        toolbar.getByRole("searchbox"),
        toolbar.getByRole("combobox").first(),
        toolbar.getByRole("button", { name: "PAS only" }),
        toolbar.getByRole("button", { name: "On hold" }),
        toolbar.getByRole("button", { name: "Changed" }),
        acknowledge,
        main.getByRole("table", { name: /^Worklist, / }).getByRole("button", { name: "Case" }),
      ],
      "Worklist",
    );
    // A row is a Tab stop (one at a time; the arrows and J/K move between rows) and Enter opens its panel.
    const firstRow = main.locator("tr[data-row-id][tabindex='0']");
    await expect(firstRow).toHaveCount(1);
    await expect(firstRow).toHaveAttribute("data-e2e-tab-reached", "");

    // A failed print snapshot (HTTP 500): said in an alert under the toolbar; focus stays on Print snapshot, which points to it.
    let unroute = await fail500(page, "worklist.snapshot");
    await print.focus();
    await page.keyboard.press("Enter");
    const printError = main.getByRole("alert").filter({ hasText: HTTP_500 });
    await expectFocusAtError(page, printError, "Worklist, failed print snapshot");
    await expect(print).toBeFocused();
    await expect(printError).toContainText(loose("Nothing was printed or downloaded."));
    await expectNoAxeViolations(page, "Worklist after a failed print snapshot");
    await unroute();

    // A failed acknowledgment (HTTP 500): the confirmation stays open and says why inside it (the page behind a modal
    // dialog is inert); focus stays on its confirm button, which points to the error; Esc returns focus to Acknowledge.
    unroute = await fail500(page, "worklist.ack");
    await acknowledge.focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("alertdialog", { name: /^Acknowledge changes up to v\d+\?$/ });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Keep reviewing" }), "the safe option has focus first").toBeFocused();
    await page.keyboard.press("Tab");
    const confirmButton = confirm.getByRole("button", { name: "Acknowledge changes" });
    await expect(confirmButton).toBeFocused();
    await page.keyboard.press("Enter");
    const ackError = confirm.getByRole("alert").filter({ hasText: HTTP_500 });
    await expectFocusAtError(page, ackError, "Worklist, failed acknowledgment");
    await expect(confirmButton).toBeFocused();
    await expectNoAxeViolations(page, "Worklist with a failed acknowledgment in its dialog", MODAL);
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(acknowledge).toBeFocused();
    await expect(changeLine, "nothing was acknowledged").toContainText(/Since your last acknowledgment|You have not acknowledged/);
    await unroute();
    expect(errors).toEqual([]);
  });

  test("Materials, trays: the scan field, the bench's Scan and Found it, the tray's decisions by Tab; a failed tray scan keeps focus in the scan field at its alert", async ({ page, context }) => {
    const errors = watchPageErrors(page);
    await openScreen(page, context, STAFF.priya, "/materials?tab=trays&selected=TRY-M-03");
    await expect(scanField(page), "the scan field has focus on load").toBeFocused();
    await expect(page.getByRole("textbox", { name: /^Scan target: Add to tray TRY-M-03/ })).toBeFocused();
    const main = page.locator("#main");
    const stops = await tabThrough(page, 60);
    await expectReachedWithVisibleFocus(
      stops,
      [
        page.getByRole("navigation", { name: "Trays" }).getByRole("link", { name: /^TRY-M-03 / }),
        main.getByRole("button", { name: "Scan D26-04747 A1-1 H&E L1", exact: true }),
        main.getByRole("button", { name: "Found it D26-04747 A1-2 H&E L2" }),
        main.getByRole("button", { name: /^Record as not on tray/ }).first(),
        main.getByRole("button", { name: "End tray session" }),
      ],
      "Materials, trays",
    );

    // A slide label scanned (typed, then Enter, as a scanner does) and answered with HTTP 500.
    const unroute = await fail500(page, "tray.scan");
    await scanField(page).focus();
    await page.keyboard.type("D26-04747 A1-1 H&E L1");
    await page.keyboard.press("Enter");
    // Announced by the scan field's alert region and shown in the result line under the field, which the field points to.
    const scanError = page.getByRole("banner").getByRole("alert").filter({ hasText: HTTP_500 });
    await expect(scanError).toContainText("Nothing was changed.");
    let line = await scanResultLine(page);
    await expect(line).toContainText(HTTP_500);
    await expectFocusAtError(page, scanError, "Materials trays, failed scan", line);
    await expect(scanField(page)).toBeFocused();
    // The bench's simulated Scan, pressed from the keyboard, fails the same way and hands focus back to the scan field.
    await main.getByRole("button", { name: "Scan D26-04747 A1-1 H&E L1", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(scanField(page)).toBeFocused();
    line = await scanResultLine(page);
    await expect(line).toContainText(HTTP_500);
    await expectFocusAtError(page, scanError, "Materials trays, failed scan from the bench's Scan", line);
    await expect(page.getByRole("region", { name: "Current tray" }), "nothing was recorded").toContainText(loose("8 of 10 expected slides scanned"));
    await expectNoAxeViolations(page, "Materials trays after a failed scan");
    await unroute();
    expect(errors).toEqual([]);
  });

  test("Materials, retrieval: the scan field, each block's Scan and report by Tab; a failed block scan and a failed return keep focus at the error", async ({ page, context }) => {
    const errors = watchPageErrors(page);
    await openScreen(page, context, STAFF.priya, "/materials?tab=retrieval&selected=RR-0192");
    await expect(page.getByRole("textbox", { name: /^Scan target: / })).toBeFocused();
    const main = page.locator("#main");
    const stops = await tabThrough(page, 60);
    await expectReachedWithVisibleFocus(
      stops,
      [
        main.getByRole("button", { name: "Scan D26-03990 B1" }),
        main.getByRole("button", { name: "Scan D26-03990 A1" }),
        main.getByRole("button", { name: "Scan D26-03912 A1" }),
        main.getByRole("button", { name: "Not with the recorded holder…" }),
        main.getByRole("button", { name: "Not at last location…" }).first(),
        main.getByRole("button", { name: "Request blocks" }),
      ],
      "Materials, retrieval",
    );

    // A block label scanned and answered with HTTP 500: announced, focus stays in the scan field, nothing picked.
    let unroute = await fail500(page, "retrieval.scan");
    await scanField(page).focus();
    await page.keyboard.type("D26-03990 B1");
    await page.keyboard.press("Enter");
    const scanError = page.getByRole("banner").getByRole("alert").filter({ hasText: HTTP_500 });
    const line = await scanResultLine(page);
    await expect(line).toContainText(HTTP_500);
    await expectFocusAtError(page, scanError, "Materials retrieval, failed scan", line);
    await expect(scanField(page)).toBeFocused();
    const band = page.getByRole("region", { name: "Current retrieval request" });
    await expect(band.getByText(/^\d+ of \d+ picked/)).toHaveText("0 of 3 picked");
    await unroute();

    // Two blocks are picked from the keyboard (the bench's Scan; D26-03912 A1 is checked out to Marcus Lee, so only he
    // can scan it), then a return is answered with HTTP 500: the block says so in an alert beside Record return,
    // which keeps focus.
    for (const [label, n] of [["D26-03990 B1", 1], ["D26-03990 A1", 2]] as const) {
      await main.getByRole("button", { name: `Scan ${label}` }).focus();
      await page.keyboard.press("Enter");
      await expect(band.getByText(/^\d+ of \d+ picked/)).toHaveText(`${n} of 3 picked`);
      await expect(scanField(page), "after a scan the hands go back to the scanner").toBeFocused();
    }
    unroute = await fail500(page, "retrieval.return");
    const block = main.getByRole("listitem").filter({ hasText: /Pick\s*\d\s*of\s*3\s*D26-03990 B1/ });
    const recordReturn = block.getByRole("button", { name: "Record return" });
    await recordReturn.focus();
    await page.keyboard.press("Enter");
    const returnError = block.getByRole("alert").filter({ hasText: HTTP_500 });
    await expectFocusAtError(page, returnError, "Materials retrieval, failed return");
    await expect(recordReturn).toBeFocused();
    await expect(block, "the block is still out, its location unchanged").toContainText(loose("Checked out to Priya Shah"));
    await expect(block).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));
    await expectNoAxeViolations(page, "Materials retrieval after a failed return");
    await unroute();
    expect(errors).toEqual([]);
  });

  test("Clarify: the queue, the record's links and forms, the docked step and every other action by Tab; a failed reminder keeps focus at its error", async ({ page, context }) => {
    const errors = watchPageErrors(page);
    await openScreen(page, context, STAFF.kim, "/clarifications?selected=CLR-0455");
    const main = page.locator("#main");
    await scanField(page).focus();
    const stops = await tabThrough(page, 60);
    const reminder = main.getByRole("button", { name: /^Send reminder \(simulated\)/ }).first();
    await expectReachedWithVisibleFocus(
      stops,
      [
        main.getByRole("link", { name: /^Overdue/ }),
        main.getByRole("link", { name: /^CLR-0455, / }),
        main.getByRole("link", { name: "Open case D26-04804" }),
        main.getByText("Record an answer given by phone or another channel"),
        reminder,
        main.getByRole("button", { name: "Record acknowledgment" }),
        main.getByRole("button", { name: "Escalate" }),
        main.getByRole("button", { name: "Cancel clarification" }),
      ].map((l) => l.locator("xpath=ancestor-or-self::*[self::a or self::button or self::summary][1]")),
      "Clarify",
    );

    // The docked reminder answered with HTTP 500: an alert under it; focus stays on the button, which points to it.
    const unroute = await fail500(page, "clarification.followUp");
    await reminder.focus();
    await page.keyboard.press("Enter");
    const failure = main.getByRole("alert").filter({ hasText: HTTP_500 });
    await expectFocusAtError(page, failure, "Clarify, failed reminder");
    await expect(reminder).toBeFocused();
    await expectNoAxeViolations(page, "Clarify after a failed reminder");
    await unroute();
    expect(errors).toEqual([]);
  });

  test("Operations: every count, category, blocked item and owner by Tab; the screen records nothing, so there is no mutation to fail", async ({ page, context }) => {
    const errors = watchPageErrors(page);
    const posts: string[] = [];
    page.on("request", (r) => void (r.method() === "POST" && posts.push(new URL(r.url()).pathname)));
    await openScreen(page, context, STAFF.tanya, "/operations");
    const main = page.locator("#main");
    await scanField(page).focus();
    const stops = await tabThrough(page, 160);
    await expectReachedWithVisibleFocus(
      stops,
      [
        main.getByRole("link", { name: /^Intake: \d+ orders?/ }),
        main.getByRole("link", { name: /^Sent on tray: / }),
        main.getByRole("link", { name: /^\d+ holds? stops? work/ }),
        main.getByRole("link", { name: /^Holds\s*\(\d+\)/ }),
        main.getByRole("link", { name: /^Clarifications\s*\(\d+\)/ }),
        main.getByRole("link", { name: /^H-0089 / }),
        main.getByRole("button", { name: "Table" }),
        main.getByRole("link", { name: /^Dana Whitfield: / }),
        main.getByRole("link", { name: "Open the entry queue" }),
      ],
      "Operations",
    );
    // Every control on Operations is a link or a view switch: nothing is recorded from this screen.
    await main.getByRole("button", { name: "Table" }).focus();
    await page.keyboard.press("Enter");
    await expect(main.getByRole("button", { name: "Table" })).toBeFocused();
    expect(posts.filter((p) => p.startsWith("/api/commands/")), "commands sent from Operations").toEqual([]);
    expect(errors).toEqual([]);
  });
});
