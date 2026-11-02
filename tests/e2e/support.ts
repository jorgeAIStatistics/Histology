// Shared helpers for the browser acceptance tests (tests/e2e). Not a spec file.
// Everything here drives the app the way a presenter would: the demo role
// cookie stands in for the "Acting as" selector on the presenter console (a
// demo role switch, not a sign-in), and the reset endpoint restores the
// synthetic 10:52 starting state.
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, test } from "@playwright/test";

/** Demo staff ids from the seed (src/server/seed). */
export const STAFF = {
  maya: "stf_maya", // accessioner
  kim: "stf_kim", // accessioning lead
  dana: "stf_dana", // grosser
  sam: "stf_sam", // histology assistant
  priya: "stf_priya", // histotech
  tanya: "stf_tanya", // operations supervisor
  director: "stf_director", // Director of Operations (read-only demo role)
} as const;

export type StaffId = (typeof STAFF)[keyof typeof STAFF];

function baseURL(): string {
  const url = test.info().project.use.baseURL;
  if (!url) throw new Error("baseURL is not configured for the e2e project");
  return url;
}

/** Switch the demo role for every following request in this browser context. */
export async function actAs(context: BrowserContext, staffId: StaffId): Promise<void> {
  await context.addCookies([{ name: "hlos_actor", value: staffId, url: baseURL() }]);
}

/**
 * A second browser window acting as another demo role (for example a colleague
 * watching the worklist while someone else works). Close it when done.
 */
export async function openRoleContext(browser: Browser, staffId: StaffId): Promise<BrowserContext> {
  const use = test.info().project.use;
  const context = await browser.newContext({ baseURL: baseURL(), viewport: use.viewport ?? { width: 1366, height: 768 } });
  await actAs(context, staffId);
  return context;
}

/**
 * The demo role in effect. The page under test shows it read only in the top
 * bar ("Demo role: …", not a control); the "Acting as" selector itself lives on
 * the presenter console (Role and clock tab). Opens the console in a second tab
 * of the same browser context (same demo role cookie), reads the selector's
 * value, checks the top bar of the page under test names the same person, and
 * closes the tab again, so the page under test is never navigated away.
 */
export async function actingAsValue(page: Page): Promise<string> {
  const indicator = page.getByRole("banner").getByRole("note", { name: /^Demo role: / });
  await expect(indicator).toBeVisible();
  const consolePage = await page.context().newPage();
  try {
    await consolePage.goto("/demo?tab=role");
    const select = consolePage.getByRole("main").getByRole("combobox", { name: /^Acting as/ });
    await expect(select).toBeVisible();
    const value = await select.inputValue();
    const text = await select.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "");
    expect(text, "the Acting as selector names a person").not.toBe("");
    await expect(indicator).toHaveAccessibleName(new RegExp(`^Demo role: ${re(text)}[ ,(]`));
    return value;
  } finally {
    await consolePage.close();
  }
}

/** The presenter console (/demo) on one of its tabs, in synthetic demo mode. */
export async function openConsoleTab(page: Page, tab: "role" | "world" | "outages"): Promise<void> {
  await page.goto(`/demo?tab=${tab}`);
  await expect(page.getByRole("heading", { level: 1, name: "Presenter console" })).toBeVisible();
  const label = { role: "Role and clock", world: "World events", outages: "Outages and reset" }[tab];
  await expect(page.getByRole("navigation", { name: "Presenter console sections" }).getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
}

/** One simulated world event on the presenter console's World events tab (a region named by its heading). */
export function worldEvent(page: Page, name: "Courier bag: unpack and receive" | "A colleague edits an intake item" | "The office answers a clarification" | "The source system acknowledges a gross entry" | "Printer behaviour") {
  return page.getByRole("region", { name });
}

/** Replace the e2e database with the reproducible synthetic starting state (10:52 ET, clock paused). */
export async function resetDemo(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/demo/reset", { data: { confirm: true } });
  expect(res.ok(), `demo reset failed: HTTP ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { ok: boolean; result: { clock: { running: boolean } } };
  expect(body.ok).toBe(true);
  expect(body.result.clock.running).toBe(false);
}

/** The guided demo (presenter console /demo, Guide tab) on one step. */
export async function openGuideStep(page: Page, step: number): Promise<void> {
  await page.goto(`/demo?tab=guide&step=${step}`);
  await expect(page.getByRole("heading", { level: 1, name: "Presenter console" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Presenter console sections" }).getByRole("link", { name: "Guide" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(loose("Synthetic data, simulated connectors")).first()).toBeVisible();
}

/**
 * Press "Run simulator events for this step" (world events only: courier,
 * simulated office, simulated source; never a staff action) and return the
 * result region with its action list expanded.
 */
export async function runSimulatorEvents(page: Page, step: number) {
  await openGuideStep(page, step);
  await page.getByRole("button", { name: "Run simulator events for this step" }).click();
  const result = page.getByRole("region", { name: `Result of the last run of step ${step}` });
  await expect(result.getByText(loose("Simulator events done"))).toBeVisible();
  const details = result.locator("details");
  if ((await details.getAttribute("open")) === null) await details.getByText(/^\d+ actions? in this run/).click();
  await expect(details).toHaveAttribute("open", "");
  return { result, actions: details.getByRole("listitem") };
}

/** The toast region (role=region "Notifications"). */
export function toasts(page: Page) {
  return page.getByRole("region", { name: "Notifications" });
}

/** Escape a string for use inside a RegExp. */
export function re(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The exact words of `text`, in order, but tolerant of how the screen splits
 * them into elements: text from adjacent elements can join without a space in
 * textContent ("Expected 4 ·" + "Received 4"), so each space matches zero or
 * more whitespace characters. Every other character must match exactly.
 * A trailing number must end there: "Received 1" does not match "Received 12".
 */
export function loose(text: string): RegExp {
  const body = re(text.trim()).replace(/\s+/g, "\\s*");
  return new RegExp(/\d$/.test(text.trim()) ? `${body}(?!\\d)` : body);
}

/** Like loose(), and a leading number must start there too: "8 of 10" does not match "18 of 10". Only where no digit can precede it on screen. */
export function looseNumber(text: string): RegExp {
  const body = loose(text).source;
  return new RegExp(/^\d/.test(text.trim()) ? `(?<!\\d)${body}` : body);
}

/**
 * The internal id and version of a record shown on the current page, read from
 * the data the server rendered into it (the screens never show internal ids).
 * Used only to build a forged request for a server-side permission check.
 */
export async function recordOnPage(page: Page, idPrefix: string, displayId: string): Promise<{ id: string; version: number }> {
  const html = (await page.content()).replace(/\\"/g, '"');
  const m = html.match(new RegExp(`"id":"(${idPrefix}_\\d+)","displayId":"${re(displayId)}"[^{}]*?"version":(\\d+)`));
  expect(m, `${displayId} (${idPrefix}_…) not found in the rendered page data`).not.toBeNull();
  return { id: m![1], version: Number(m![2]) };
}

/** POST a command from inside the page (same origin, with the page's demo role cookie), as a hand-made request would. */
export async function postCommandFromPage(page: Page, name: string, input: unknown): Promise<{ status: number; body: { ok: boolean; error?: { code: string; message: string } } }> {
  return page.evaluate(
    async ({ name, input }) => {
      const res = await fetch(`/api/commands/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, idempotencyKey: `e2e-forged-${name}-${Date.now()}` }),
      });
      return { status: res.status, body: await res.json() };
    },
    { name, input },
  );
}

/** What POST /api/test/fixtures answered: the importer's own result for the fixture's message (src/server/domain/sourceImport.ts ImportResult). */
export interface FixtureImport {
  outcome: "applied" | "duplicate_ignored" | "stale_ignored" | "failed";
  eventId: string;
  messageId: string;
  detail: string;
  orderId?: string;
  sourceOrderId?: string;
  version?: number;
  previousVersion?: number;
  receiptCount?: number;
  reconciliation: { kind: string; summary: string; ref?: string }[];
}

/** The fixture names the test endpoint knows (src/server/test-fixtures.ts TEST_FIXTURE_NAMES). */
export type FixtureName = "source-conflict-patient" | "source-conflict-order-amend";

/**
 * Import one named, synthetic source message through the test-only endpoint POST /api/test/fixtures (the real
 * importer, as the simulated source would deliver it). Sends this run's token, which playwright.config.ts generated
 * and the web server and this worker both inherited, in the x-hlos-fixture-token header. Returns the ImportResult.
 */
export async function importFixture(request: APIRequestContext, name: FixtureName): Promise<FixtureImport> {
  const token = process.env.HLOS_TEST_FIXTURE_TOKEN;
  expect(token, "HLOS_TEST_FIXTURE_TOKEN is set for this worker by playwright.config.ts").toBeTruthy();
  const res = await request.post("/api/test/fixtures", { data: { fixture: name }, headers: { "x-hlos-fixture-token": token! } });
  expect(res.status(), `fixture ${name}: HTTP ${res.status()} ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { ok: boolean; fixture: string; result: FixtureImport };
  expect(body.ok).toBe(true);
  expect(body.fixture).toBe(name);
  return body.result;
}
