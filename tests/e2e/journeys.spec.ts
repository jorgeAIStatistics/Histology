// Phase D browser acceptance: six bench journeys on the real screens, each checked under six conditions:
//  1. the normal path, driven through the real screens;
//  2. missing information (unknown or blocked, with the reason; never 0 or "done"), or missing required input
//     (an inline message, and nothing recorded: proved with a reload or a second read);
//  3. a failed mutation (the command's POST /api/commands/<name> aborted or answered 500): an accessible inline
//     error or alert, and the state is unchanged after a reload;
//  4. a repeated request sent from inside the page (same origin, demo role cookie) with an explicit idempotency key:
//     same key and input replays the stored result with no second side effect; a different input, or another demo
//     role, is refused with 409 IDEMPOTENCY_CONFLICT and never sees the stored result;
//  5. stale state: an old expectedVersion is refused with 409 CONFLICT and overwrites nothing (or, for a command
//     without a version, a state-guarded transition from the wrong state is refused);
//  6. an unavailable simulated dependency (presenter console Outages, or the presenter commands
//     integration.setSourceStatus, printer.setStatus, notifications.setStatus): the screen says it is offline or
//     failed, nothing is shown as done that is not done, and restoring it resolves it where that applies.
// Every journey resets the synthetic demo day first and runs its tests in order. Synthetic data only; nothing here
// contacts anything but the local test server. The other specs (director-journey, guards, intake-keyboard,
// presenter-console) already cover parts of these screens; these journeys add the six conditions around them.
import { expect, test, type BrowserContext, type Locator, type Page, type Request } from "@playwright/test";
import {
  STAFF,
  actAs,
  loose,
  looseNumber,
  openConsoleTab,
  openRoleContext,
  recordOnPage,
  resetDemo,
  runSimulatorEvents,
  toasts,
  worldEvent,
  type StaffId,
} from "./support";

// ---------------------------------------------------------------- local helpers

/** What a hand-made command request from inside the page got back. */
interface CommandReply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: { ok: boolean; result?: any; replayed?: boolean; error?: { code: string; message: string; details?: unknown } };
  correlationId: string | null;
}

/**
 * POST { input, idempotencyKey } to /api/commands/<name> from inside the page: same origin, with the page's demo role
 * cookie, as a retried or hand-made request would. Returns the status, the JSON body and the X-Correlation-Id header.
 */
async function sendCommand(page: Page, name: string, input: unknown, idempotencyKey: string): Promise<CommandReply> {
  return page.evaluate(
    async ({ name, input, idempotencyKey }) => {
      const res = await fetch(`/api/commands/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, idempotencyKey }),
      });
      return { status: res.status, body: await res.json(), correlationId: res.headers.get("x-correlation-id") };
    },
    { name, input, idempotencyKey },
  );
}

/** A fresh idempotency key for one hand-made intent. */
function intentKey(label: string): string {
  return `e2e-journeys-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Expect a refusal with this status and error code; every reply carries its correlation id. */
function expectRefused(reply: CommandReply, status: number, code: string): void {
  expect(reply.correlationId, "X-Correlation-Id header").toBeTruthy();
  expect(reply.status, JSON.stringify(reply.body)).toBe(status);
  expect(reply.body.ok).toBe(false);
  expect(reply.body.error?.code).toBe(code);
}

/** String leaves of a stored result that identify it (ids, numbers as text); a foreign reply must contain none of them. */
function identifyingValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" && value.length >= 6) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => identifyingValues(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => identifyingValues(v, out));
  return out;
}

/**
 * Condition 4 in one place. `first` is the reply that stored the result (sent with `key`). Then:
 *  - the same key and input again: 200, the same result, marked replayed;
 *  - the same key with `changedInput`: 409 IDEMPOTENCY_CONFLICT;
 *  - the same key and input from `otherRole` (the demo role cookie switched with actAs): 409 IDEMPOTENCY_CONFLICT,
 *    with no stored result in the body. The demo role is switched back to `owner` afterwards.
 * The caller proves "no second side effect" on the screen or with a second read.
 */
async function expectKeyIsScoped(
  page: Page,
  context: BrowserContext,
  opts: { name: string; input: unknown; changedInput: unknown; key: string; first: CommandReply; owner: StaffId; otherRole: StaffId },
): Promise<void> {
  const { name, input, changedInput, key, first, owner, otherRole } = opts;
  expect(first.correlationId, "X-Correlation-Id header").toBeTruthy();
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.ok).toBe(true);

  const again = await sendCommand(page, name, input, key);
  expect(again.correlationId, "X-Correlation-Id header").toBeTruthy();
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body.ok).toBe(true);
  expect(again.body.replayed, "the repeat is answered from the stored receipt").toBe(true);
  expect(again.body.result).toEqual(first.body.result);

  const changed = await sendCommand(page, name, changedInput, key);
  expectRefused(changed, 409, "IDEMPOTENCY_CONFLICT");
  expect(changed.body.result).toBeUndefined();

  await actAs(context, otherRole);
  try {
    const foreign = await sendCommand(page, name, input, key);
    expectRefused(foreign, 409, "IDEMPOTENCY_CONFLICT");
    expect(Object.keys(foreign.body).sort(), "a refused key reuse returns only the error").toEqual(["error", "ok"]);
    expect(foreign.body.error?.details).toEqual({ reason: "not_owner" });
    const text = JSON.stringify(foreign.body);
    const leaked = identifyingValues(first.body.result).filter((v) => !foreign.body.error!.message.includes(v) && text.includes(v));
    expect(leaked, "values of the stored result in the refused reply").toEqual([]);
  } finally {
    await actAs(context, owner);
  }
}

/** The request a screen sends for one command, read before it leaves the page (input and its idempotency key). */
function nextCommandRequest(page: Page, name: string): Promise<Request> {
  return page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/commands/${name}`);
}

function requestBody(r: Request): { input: Record<string, unknown>; idempotencyKey: string } {
  return r.postDataJSON() as { input: Record<string, unknown>; idempotencyKey: string };
}

/** Rendered page data (the server's props in the page), with escaped quotes undone, for internal ids the screens never show. */
async function pageData(page: Page): Promise<string> {
  return (await page.content()).replace(/\\"/g, '"');
}

/** The first match of `pattern` in the rendered page data. */
async function fromPageData(page: Page, pattern: RegExp, what: string): Promise<RegExpMatchArray> {
  const m = (await pageData(page)).match(pattern);
  expect(m, `${what} not found in the rendered page data`).not.toBeNull();
  return m!;
}

/** The one container shown in detail on an intake item: its id, version and the order part it is compared with. */
async function containerOnPage(page: Page, seq = 1): Promise<{ id: string; version: number; orderPartId: string }> {
  const m = await fromPageData(page, new RegExp(`"id":"(ctr_\\d+)","seq":${seq},"version":(\\d+),[\\s\\S]*?"orderPartId":"([^"]+)"`), `container ${seq}`);
  return { id: m[1], version: Number(m[2]), orderPartId: m[3] };
}

/** An intake item's internal id, read from the rendered queue data. */
async function intakeIdOnPage(page: Page, displayId: string): Promise<string> {
  return (await fromPageData(page, new RegExp(`"id":"(int_[a-z0-9_]+)","displayId":"${displayId}"`), displayId))[1];
}

/** Open an intake item and wait until the bench is interactive (the scan field takes focus once it is ready). */
async function openIntakeItem(page: Page, item: string): Promise<void> {
  await page.goto(`/intake?item=${item}`);
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(`intake item ${item}(, accessioned as D26-\\d{5})?$`, "i") })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Scan target:/ })).toBeFocused();
}

/** The intake History list (the item's local audit log). */
function intakeHistory(page: Page): Locator {
  return page.getByRole("region", { name: "History" }).first().getByRole("listitem");
}

/** Presenter console → Outages and reset: one simulated source's card. */
function sourceCard(page: Page, name: "EMA-SIM Sunrise Coast" | "OTHER-EHR-SIM Gulf"): Locator {
  const sources = page.getByRole("list").filter({ has: page.getByRole("button", { name: /^(Simulate outage|Restore connection)$/ }) });
  return sources.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
}

/** Take the EMA-SIM source offline, or restore it, from the presenter console (in a second tab, so the page under test stays put). */
async function setEmaFromConsole(context: BrowserContext, state: "offline" | "connected"): Promise<void> {
  const consolePage = await context.newPage();
  try {
    await openConsoleTab(consolePage, "outages");
    const ema = sourceCard(consolePage, "EMA-SIM Sunrise Coast");
    if (state === "offline") {
      await ema.getByRole("button", { name: "Simulate outage" }).click();
      await expect(ema.getByRole("button", { name: "Restore connection" })).toBeVisible();
      await expect(ema).toContainText(loose("EMA-SIM Sunrise Coast: unreachable since"));
    } else {
      await ema.getByRole("button", { name: "Restore connection" }).click();
      await expect(ema.getByRole("button", { name: "Simulate outage" })).toBeVisible();
    }
  } finally {
    await consolePage.close();
  }
}

/**
 * Wait until React has hydrated this element (its event handlers are attached), so a click right after a load is not
 * lost on the server-rendered markup. Used where the screen gives no other sign of being interactive.
 */
async function whenInteractive(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { message: "the control is interactive" }).toBe(true);
}

/** Choose the one option of a select whose label matches `label` (labels carry times that are not fixed). */
async function selectOptionMatching(select: Locator, label: RegExp): Promise<void> {
  const option = select.locator("option").filter({ hasText: label });
  await expect(option).toHaveCount(1);
  await select.selectOption({ label: (await option.innerText()).trim() });
}

/** Reset the synthetic demo day at the start of a journey. */
function resetBeforeJourney() {
  test.beforeAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await resetDemo(request);
    await request.dispose();
  });
}

/** Windows opened for other demo roles are closed after each test, even when it fails. */
const extraContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of extraContexts.splice(0)) await c.close().catch(() => undefined);
});

// =====================================================================================================================
// Journey 1: normal intake (Maya Torres, accessioner), after the 11:00 courier arrival (guide step 1 world event).
// Items (seed scenario, unpacked in this order): INT-1014-026 Palm Grove (plain), INT-1014-029 Mangrove Bay (no
// manifest), INT-1014-034 Seagrape (no routing rule), INT-1014-024/025 Harbor Point (failed mutations),
// INT-1014-028 Coral Lane (repeated and stale requests), INT-1014-030 Cypress Key (source outage).
// Gap, said here once: while EMA-SIM is offline the bench disables "Request accession", so the request that waits for
// the source (condition 6) is sent from inside the page, as one already in flight when the outage began would be.
// =====================================================================================================================
test.describe("journey 1: normal intake (Maya, accessioner)", () => {
  test.describe.configure({ mode: "serial" });
  resetBeforeJourney();

  test("normal path: after the courier, Maya records a container check and accepts the rule-based routing on a plain item; the simulated source issues its accession", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    const { actions } = await runSimulatorEvents(page, 1);
    await expect(actions.filter({ hasText: loose("Done: Courier arrives: record arrival of CR-1014-11 (received by Maya Torres)") })).toHaveCount(1);

    await openIntakeItem(page, "INT-1014-026");
    const container = page.getByRole("region", { name: /^Container 1 of Part A Order ORD-77126/ });
    await expect(container).toContainText(loose("Not yet verified"));
    const routing = page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ });
    await expect(routing).toContainText(loose("Suggested dermatopathologist Dr. Elena Marsh"));
    await expect(routing).toContainText(loose("From rule: Palm Grove Skin Clinic → Dr. Elena Marsh (rule set v3, effective Sep 1)."));
    const decision = page.getByRole("complementary", { name: "Decision" });
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();
    await expect(decision).toContainText(loose("Cannot request yet: waits for a check of the bottle against the order and routing to be accepted."));

    // The check is a person's attestation; the bottle agrees with the order and the requisition.
    await decision.getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77126 Staff verified$/ })).toBeVisible();
    await expect(container).toContainText(loose("Last check by Maya Torres"));
    await expect(container).toContainText(loose("against ORD-77126 v1: all compared fields agree."));

    // Routing is now the next step: the suggestion from the approved rule, accepted by the person at the bench.
    await expect(decision.getByRole("heading", { level: 3, name: "Accept routing to Dr. Elena Marsh" })).toBeVisible();
    await decision.getByRole("button", { name: "Accept routing", exact: true }).click();
    await expect(page.getByRole("heading", { level: 3, name: /Rule applied · confirmed/ })).toBeVisible();
    await expect(routing).toContainText(loose("Decided by Maya Torres"));
    await expect(page.getByRole("region", { name: "Current case" })).toContainText(loose("Routed to Dr. Elena Marsh"));

    // Every check passed: the number comes from the simulated source, once.
    await expect(decision).toContainText(loose("Ready: every check passed. The number is issued by the simulated source, never typed here."));
    await decision.getByRole("button", { name: "Request accession (simulated source)" }).click();
    const issued = toasts(page).getByText(/^Accession D26-\d{5} issued by EMA-SIM \(simulated\)$/);
    await expect(issued).toBeVisible();
    const number = (await issued.innerText()).match(/D26-\d{5}/)![0];
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity).toContainText(loose(`Accession ${number}`));
    await expect(identity).toContainText("EMA-SIM DERM");
    await expect(page.getByText(loose("provisional INT-1014-026 stays on record"))).toBeVisible();
    const history = intakeHistory(page);
    await expect(history.filter({ hasText: loose("INT-1014-026 container 1: staff verified against physical container by Maya Torres") })).toHaveCount(1);
    await expect(history.filter({ hasText: loose("INT-1014-026: routing to Dr. Elena Marsh confirmed by Maya Torres") })).toHaveCount(1);
  });

  test("missing information: an office with no manifest reads Unknown, never 0; an office with no rule waits in the exception lane with no doctor guessed, and a hand-made confirm records nothing", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, "INT-1014-029");
    // The arrival summary: two offices sent no manifest, so the delivery's expectation is Unknown (never 0, never complete).
    const courier = page.getByRole("region", { name: /^Courier CR-1014-11 Arrived/ });
    await expect(courier.getByRole("definition").nth(1)).toHaveText("Unknown");
    await expect(courier).toContainText(loose("2 offices sent no source manifest; 10 expected on manifests."));
    await courier.getByRole("button", { name: /^Manifest by office/ }).click();
    const byOffice = courier.getByRole("table", { name: "Courier CR-1014-11 by office: expected and received containers" });
    const mangrove = byOffice.getByRole("row", { name: /^Mangrove Bay Dermatology / });
    await expect(mangrove.getByRole("cell")).toHaveText(["Unknown", "1"]);
    await expect(byOffice.getByRole("row", { name: /^Seagrape Skin Studio / }).getByRole("cell")).toHaveText(["Unknown", "1"]);
    await expect(byOffice.getByRole("row", { name: /^Harbor Point Dermatology / }).getByRole("cell")).toHaveText(["4", "4"]);
    await expect(courier).toContainText(loose("A delivery with an unknown expectation is never counted as complete."));
    await expect(courier).not.toContainText(/Expected\s*0(?!\d)/);

    // No routing rule for the office: the exception lane, a named owner, and no doctor guessed anywhere.
    await openIntakeItem(page, "INT-1014-034");
    const row = page.getByRole("region", { name: /^Exceptions/ }).getByRole("link", { name: /^Provisional intake item INT-1014-034/ });
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row).toContainText(loose("No doctor yet"));
    await expect(row).toContainText(loose("Needs routing · Kim Nguyen"));
    const routing = page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ });
    await expect(routing).toContainText(loose("Routing exception: no approved rule applies"));
    await expect(routing).toContainText(loose("Assigned dermatopathologist Unassigned: routing exception"));
    await expect(routing).not.toContainText(loose("Dr. "));
    await expect(page.getByRole("button", { name: /^Accept routing/ })).toHaveCount(0);
    const decision = page.getByRole("complementary", { name: "Decision" });
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();

    // A confirm sent by hand finds no suggestion to accept: refused, and nothing is recorded.
    const forged = await sendCommand(page, "routing.confirm", { intakeItemId: await intakeIdOnPage(page, "INT-1014-034") }, intentKey("j1-confirm-exception"));
    expectRefused(forged, 423, "BLOCKED");
    expect(forged.body.error?.message).toBe(
      "INT-1014-034 is a routing exception: there is no rule suggestion to accept. An accessioning lead or supervisor must assign a dermatopathologist with a reason.",
    );
    await page.reload();
    await expect(routing).toContainText(loose("Routing exception: no approved rule applies"));
    await expect(page.getByRole("region", { name: "Current case" })).toContainText(loose("Routed to Unassigned: routing exception"));
    await expect(intakeHistory(page).filter({ hasText: /routing to .* confirmed by/ })).toHaveCount(0);
  });

  test("failed mutation: a routing acceptance that never reaches the server says so inline and changes nothing", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    // Primary step (the container is checked first, so routing is the next step).
    await openIntakeItem(page, "INT-1014-024");
    const decision = page.getByRole("complementary", { name: "Decision" });
    await decision.getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77118 Staff verified$/ })).toBeVisible();
    await page.route("**/api/commands/routing.confirm", (route) => route.abort("internetdisconnected"));
    await decision.getByRole("button", { name: "Accept routing", exact: true }).click();
    await expect(decision.getByRole("alert")).toContainText(loose("Could not reach the local server"));
    await expect(page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ })).toContainText(loose("Rule applied · suggested"));
    await page.unroute("**/api/commands/routing.confirm");
    await page.reload();
    await expect(page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ })).toContainText(loose("Rule applied · suggested"));
    await expect(page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ })).not.toContainText(loose("Decided by"));
    await expect(intakeHistory(page).filter({ hasText: /routing to .* confirmed by/ })).toHaveCount(0);
  });

  test("repeated request: the same container check sent twice with one key is recorded once; another input or another demo role with that key is refused", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, "INT-1014-028");
    const container = page.getByRole("region", { name: /^Container 1 of Part A Order ORD-77142/ });
    await expect(container).toContainText(loose("Not yet verified"));
    const c = await containerOnPage(page);
    const input = { containerId: c.id, expectedVersion: c.version, orderPartId: c.orderPartId };
    const key = intentKey("j1-verify");
    const first = await sendCommand(page, "intake.verifyContainer", input, key);
    expect(first.body.result?.state).toBe("verified");
    await expectKeyIsScoped(page, context, {
      name: "intake.verifyContainer",
      input,
      changedInput: { ...input, expectedVersion: c.version + 1 },
      key,
      first,
      owner: STAFF.maya,
      otherRole: STAFF.kim,
    });
    // A real second run would have been refused as stale (the version moved on); the replay ran nothing: one check recorded.
    await page.reload();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77142 Staff verified$/ })).toBeVisible();
    await expect(intakeHistory(page).filter({ hasText: loose("INT-1014-028 container 1: staff verified against physical container by Maya Torres") })).toHaveCount(1);
    expect((await containerOnPage(page)).version).toBe(c.version + 1);
  });

  test("stale state: an edit of the bottle observation from the version before the check is refused with 409 CONFLICT and overwrites nothing", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, "INT-1014-028");
    const c = await containerOnPage(page);
    const label = page.getByRole("paragraph").filter({ hasText: "Bottle label as typed by staff (not a photo):" });
    await expect(label).toHaveText(loose("Bottle label as typed by staff (not a photo): Pike, Jordan · 1990-04-18 · Part A · L jawline · shave"));
    const stale = await sendCommand(
      page,
      "intake.recordObservation",
      { containerId: c.id, expectedVersion: c.version - 1, observed: { site_text: "R jawline" } },
      intentKey("j1-stale-observation"),
    );
    expectRefused(stale, 409, "CONFLICT");
    expect(stale.body.error?.message).toContain(`you had version ${c.version - 1}, current is ${c.version}`);
    // A stale check is refused the same way.
    const staleCheck = await sendCommand(page, "intake.verifyContainer", { containerId: c.id, expectedVersion: c.version - 1, orderPartId: c.orderPartId }, intentKey("j1-stale-verify"));
    expectRefused(staleCheck, 409, "CONFLICT");

    await page.reload();
    await expect(label).toHaveText(loose("Bottle label as typed by staff (not a photo): Pike, Jordan · 1990-04-18 · Part A · L jawline · shave"));
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77142 Staff verified$/ })).toBeVisible();
    await expect(intakeHistory(page).filter({ hasText: loose("observation edited") })).toHaveCount(0);
    await expect(intakeHistory(page).filter({ hasText: loose("staff verified against physical container") })).toHaveCount(1);
    expect((await containerOnPage(page)).version).toBe(c.version);
  });

  test("unavailable dependency: with EMA-SIM offline the accession request waits and is never shown as issued; after the connection is restored the retry issues it once", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, "INT-1014-030");
    const decision = page.getByRole("complementary", { name: "Decision" });
    await decision.getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77160 Staff verified$/ })).toBeVisible();
    await decision.getByRole("button", { name: "Accept routing", exact: true }).click();
    await expect(decision).toContainText(loose("Ready: every check passed."));

    await setEmaFromConsole(context, "offline");
    // The open bench learns of the outage (live refresh): the request is unavailable, and says why.
    const outage = page.getByRole("status").filter({ hasText: loose("EMA-SIM Sunrise Coast (accession source) unreachable since") });
    await expect(outage).toContainText(loose("Request accession is unavailable."));
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();
    const path = page.getByRole("navigation", { name: "Path to accession" });
    await expect(path.getByRole("button", { name: /^Step 5, Accession, blocked: Source offline \(simulated\)/ })).toBeVisible();

    // The request already on its way when the source went down: kept as submitted, nothing issued.
    const intakeId = await intakeIdOnPage(page, "INT-1014-030");
    const waiting = await sendCommand(page, "accession.request", { intakeItemIds: [intakeId] }, intentKey("j1-accession-offline"));
    expect(waiting.status).toBe(200);
    expect(waiting.correlationId).toBeTruthy();
    expect(waiting.body.result).toMatchObject({ status: "submitted", outcome: "source_offline", accessionNumber: null });
    const ar = waiting.body.result.requestDisplayId as string;
    await page.reload();
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity).toContainText(loose("Official number: not issued"));
    await expect(identity).not.toContainText(/Accession D26-/);
    await expect(path.getByRole("button", { name: new RegExp(`^Step 5, Accession, waiting: ${ar} waits for the source`) })).toBeVisible();
    await expect(decision.getByRole("button", { name: `Retry accession request ${ar} (simulated source)` })).toBeDisabled();
    await expect(decision).toContainText(loose(`Request ${ar} was submitted at`));
    await expect(decision).toContainText(loose("nothing was issued"));

    // Restored: the same request is retried once and issued once.
    await setEmaFromConsole(context, "connected");
    const retry = decision.getByRole("button", { name: `Retry accession request ${ar} (simulated source)` });
    await expect(retry).toBeEnabled();
    await retry.click();
    const issued = toasts(page).getByText(/^Accession D26-\d{5} issued by EMA-SIM \(simulated\)$/);
    await expect(issued).toBeVisible();
    const number = (await issued.innerText()).match(/D26-\d{5}/)![0];
    await expect(identity).toContainText(loose(`Accession ${number}`));
    const history = intakeHistory(page);
    await expect(history.filter({ hasText: loose(`Maya Torres requested an accession from the simulated source for INT-1014-030 (request ${ar})`) })).toHaveCount(1);
    await expect(history.filter({ hasText: loose(`INT-1014-030 accessioned as ${number}`) })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Done today" }).getByRole("link", { name: /From provisional INT-1014-030/ })).toHaveCount(1);
    const next = `D26-${String(Number(number.slice(4)) + 1).padStart(5, "0")}`;
    await page.goto(`/cases/${next}`);
    await expect(page.getByRole("heading", { level: 1, name: "Case not found" })).toBeVisible();
  });

  // Last in the journey on purpose: it shows an app defect (see the final report), and a failure in a serial journey
  // skips the tests after it.
  test("failed mutation, second entry point: routing accepted from 'Also yours now' and answered with HTTP 500 says so inline and changes nothing", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    // The container still unchecked (as in the director's script), so routing is offered under "Also yours now".
    await openIntakeItem(page, "INT-1014-025");
    const decision = page.getByRole("complementary", { name: "Decision" });
    await page.route("**/api/commands/routing.confirm", (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" }));
    const also = decision.getByRole("region", { name: /^Also yours now/ });
    const fold = also.getByRole("button", { name: /^Show (it|all \d+)$/ });
    if (await fold.isVisible()) await fold.click();
    const failed = nextCommandRequest(page, "routing.confirm");
    await also.getByRole("button", { name: "Accept routing to Dr. Elena Marsh" }).click();
    await failed;
    // Expected: the failure is said on screen (as the primary step does with an inline alert). Any visible place counts
    // here, inline alert or toast, so the check is as lenient as it can honestly be.
    await expect(page.getByText(loose("Unexpected response from the local server (HTTP 500).")).first(), "a failed 'Accept routing' from Also yours now is reported on screen").toBeVisible();
    await page.unroute("**/api/commands/routing.confirm");
    await page.reload();
    await expect(page.getByRole("region", { name: /^Routing to an assigned dermatopathologist/ })).toContainText(loose("Rule applied · suggested"));
    await expect(intakeHistory(page).filter({ hasText: /routing to .* confirmed by/ })).toHaveCount(0);
  });
});

// =====================================================================================================================
// Journey 2: patient identity conflict. Seeded: INT-1014-022 (Tobias Kettering), whose bottles carry a date of birth
// that differs from order ORD-75469, held by H-0088 with identity clarification CLR-0453 already answered by the
// office. Made here: INT-1014-024 (Theo Barnes, from the 11:00 courier), where Maya types the bottle's date of birth
// as written and her check records the identity mismatch. Clarifications Maya raises get the next ids (CLR-0457 on).
// Gap, said here once: the "Other" clarification that must NOT cover the identity mismatch (condition 2) is set up
// through the same commands the Clarifications screen sends, from inside the page, to keep the journey short; the
// decisive part (what the intake bench says about it) is read on the screen.
// =====================================================================================================================
test.describe("journey 2: identity conflict", () => {
  test.describe.configure({ mode: "serial" });
  resetBeforeJourney();

  const ITEM = "INT-1014-024";
  /** The identity clarification Maya raises on INT-1014-024 (its display id is read from the screen). */
  const raised = { displayId: "" };

  test("normal path: only an identity clarification resolved as 'order is correct' lets the seeded item be accessioned, under the order's patient, with the bottle's value kept and nothing merged", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, "INT-1014-022");
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity.getByRole("term").filter({ hasText: loose("Patient identity differs: DOB") })).toBeVisible();
    await expect(identity).toContainText(loose("1974-07-22 on the bottle"));
    await expect(identity).toContainText(loose("1974-07-21 on the order"));
    const decision = page.getByRole("complementary", { name: "Decision" });
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();
    await expect(decision).toContainText(loose("Cannot request yet: waits for a lead to resolve the patient identity question, routing to be accepted and hold H-0088 to be released."));
    await decision.getByRole("button", { name: "Accept routing", exact: true }).click();
    await expect(page.getByRole("heading", { level: 3, name: /Rule applied · confirmed/ })).toBeVisible();
    await expect(decision).toContainText(loose("Cannot request yet: waits for a lead to resolve the patient identity question and hold H-0088 to be released."));

    // The lead reviews the office's answer and resolves it as "the order is correct", releasing H-0088 with a reason.
    await actAs(context, STAFF.kim);
    await page.goto("/clarifications?selected=CLR-0453");
    const panel = page.getByRole("region", { name: /^Identity conflict question: INT-1014-022/ });
    const clrDecision = panel.getByRole("complementary", { name: "Decision" });
    const reviewSlot = panel.getByRole("list", { name: /^Conversation with Harbor Point Dermatology/ }).getByRole("listitem").filter({ hasText: loose("Review by Kim Nguyen") });
    await reviewSlot.getByLabel(/^Review note/).fill("Office says the bottle's date of birth was miswritten; name and MRN on the bottle match the order.");
    await clrDecision.getByRole("button", { name: "Mark answer reviewed" }).click();
    await expect(clrDecision.getByRole("heading", { level: 3, name: "Resolve CLR-0453" })).toBeVisible();
    await clrDecision.getByRole("button", { name: "Resolve", exact: true }).click();
    const resolve = page.getByRole("dialog", { name: "Resolve CLR-0453?" });
    await resolve.getByRole("combobox", { name: /^Resolution/ }).selectOption({ label: "Office confirmed the order is correct" });
    await resolve.getByRole("textbox", { name: /^Resolution note/ }).fill("Office confirmed the patient on order ORD-75469; the bottle's date of birth was written incorrectly.");
    await resolve.getByRole("checkbox", { name: /^Also release H-0088/ }).check();
    await resolve.getByRole("textbox", { name: /^Hold release reason/ }).fill("Identity confirmed by the office; the order's patient stands.");
    await resolve.getByRole("button", { name: "Resolve and release hold" }).click();
    await expect(resolve).toBeHidden();
    await expect(panel).toContainText(loose("Resolved by Kim Nguyen: Office confirmed the order is correct."));

    // Back at the bench the item is ready, and the official number is issued for the order's patient.
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, "INT-1014-022");
    await expect(decision).toContainText(loose("Ready: every check passed."));
    await decision.getByRole("button", { name: "Request accession (simulated source)" }).click();
    const issued = toasts(page).getByText(/^Accession D26-\d{5} issued by EMA-SIM \(simulated\)$/);
    await expect(issued).toBeVisible();
    const number = (await issued.innerText()).match(/D26-\d{5}/)![0];

    // Nothing merges patients: the case is the order's patient; the bottle's value stays as found on the item's evidence.
    await page.goto(`/cases/${number}`);
    await expect(page.getByRole("heading", { level: 1, name: `Case ${number}` })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(loose("Kettering, Tobias"));
    await expect(page.getByRole("main")).toContainText(loose("MRN 503277 · EMA-SIM Sunrise Coast"));
    await expect(page.getByRole("main")).toContainText(loose("Order ORD-75469"));
    await expect(page.getByRole("main")).not.toContainText(/merged (into|with)/i);
    await page.goto(`/cases/${number}?tab=history`);
    await expect(page.getByRole("region", { name: "History" }).getByRole("listitem").filter({ hasText: loose("CLR-0453") }).first()).toBeVisible();
    await openIntakeItem(page, "INT-1014-022");
    const evidence = page.getByRole("region", { name: /^Container 1 of Part A Order ORD-75469/ });
    await expect(evidence.getByRole("row", { name: /^Date of birth / }).getByRole("cell").nth(0)).toHaveText("1974-07-21");
    await expect(evidence.getByRole("row", { name: /^Date of birth / }).getByRole("cell").nth(1)).toHaveText("1974-07-22");
  });

  test("missing information: a bottle whose date of birth differs from the order blocks accession with the reason; an 'Other' answer does not cover it, and an identity difference cannot be accepted locally", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await runSimulatorEvents(page, 1);
    await openIntakeItem(page, ITEM);
    // Maya types the bottle as written, then records her check: the identity mismatch is recorded with both values.
    await page.getByRole("button", { name: "Edit observation" }).click();
    const edit = page.getByRole("dialog", { name: "Edit observation: container 1" });
    await edit.getByRole("textbox", { name: "Date of birth (as written)" }).fill("1972-06-15");
    await edit.getByRole("button", { name: "Save observation" }).click();
    await expect(edit).toBeHidden();
    const decision = page.getByRole("complementary", { name: "Decision" });
    await decision.getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77118 Discrepancy recorded$/ })).toBeVisible();
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity).toContainText(loose("1972-06-15 on the bottle"));
    await expect(identity).toContainText(loose("1972-06-14 on the order"));
    await expect(page.getByRole("region", { name: "Current finding" })).toContainText(loose("Date of birth differs: the bottle says “1972-06-15”; the order and the requisition say “1972-06-14”."));
    const request = decision.getByRole("button", { name: "Request accession (simulated source)" });
    await expect(request).toBeDisabled();
    await expect(decision).toContainText(loose("Cannot request yet: waits for a lead to resolve the patient identity question"));
    await expect(decision).not.toContainText(loose("Ready: every check passed"));
    const reasons = decision.getByRole("group").filter({ hasText: /^Show all \d+ reasons/ });
    await reasons.getByText(/^Show all \d+ reasons/).click();
    await expect(reasons.getByRole("listitem").filter({ hasText: loose(`${ITEM} container 1 (ORD-77118 part A): patient identity differs (date of birth).`) })).toContainText(
      loose('Accession waits until a lead resolves an identity clarification as "office confirmed the order is correct"; an open question or a scoped hold is not enough'),
    );

    // A question in another category, answered and resolved as "order is correct", is not an identity decision.
    const intakeItemId = await intakeIdOnPage(page, ITEM);
    const created = await sendCommand(
      page,
      "clarification.create",
      { category: "other", refs: { intakeItemId }, subjectLabel: `${ITEM} (all containers) · ORD-77118`, question: "Please confirm the requisition was printed for this patient.", evidence: [], priority: "routine", hold: null },
      intentKey("j2-other-create"),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const other = created.body.result as { clarificationId: string; displayId: string; version: number };
    const sent = await sendCommand(page, "clarification.send", { clarificationId: other.clarificationId, expectedVersion: other.version }, intentKey("j2-other-send"));
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const answered = await sendCommand(page, "clarification.simulateOfficeAnswer", { clarificationId: other.clarificationId }, intentKey("j2-other-answer"));
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await actAs(context, STAFF.kim);
    const reviewed = await sendCommand(page, "clarification.review", { clarificationId: other.clarificationId, expectedVersion: answered.body.result.version, note: "Requisition confirmed." }, intentKey("j2-other-review"));
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const resolved = await sendCommand(
      page,
      "clarification.resolve",
      { clarificationId: other.clarificationId, expectedVersion: reviewed.body.result.version, resolutionCode: "confirmed_order", note: "Requisition confirmed by the office." },
      intentKey("j2-other-resolve"),
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    await openIntakeItem(page, ITEM);
    await expect(request).toBeDisabled();
    await reasons.getByText(/^Show all \d+ reasons/).click();
    await expect(reasons.getByRole("listitem").filter({ hasText: loose(`${ITEM} container 1 (ORD-77118 part A): patient identity differs (date of birth).`) })).toContainText(
      loose(`${other.displayId} was resolved in category 'other'; only an identity clarification resolved as 'office confirmed the order is correct' covers a patient identity difference`),
    );

    // An identity difference is never accepted locally: refused for the accessioner (role) and for the lead (safety rule).
    const discrepancy = (await fromPageData(page, /"(idc_\d+)"/, "the recorded identity discrepancy"))[1];
    const byLead = await sendCommand(page, "intake.acceptDiscrepancy", { discrepancyId: discrepancy, expectedVersion: 1, reason: "Looks like a typo." }, intentKey("j2-accept-lead"));
    expectRefused(byLead, 422, "INVARIANT");
    expect(byLead.body.error?.message).toContain("Patient identity differences are not accepted locally.");
    await actAs(context, STAFF.maya);
    const byAccessioner = await sendCommand(page, "intake.acceptDiscrepancy", { discrepancyId: discrepancy, expectedVersion: 1, reason: "Looks like a typo." }, intentKey("j2-accept-maya"));
    expectRefused(byAccessioner, 403, "FORBIDDEN");
    expect(byAccessioner.body.error?.message).toMatch(/^Not allowed: Accessioner cannot /);
    await page.reload();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77118 Discrepancy recorded$/ })).toBeVisible();
    await expect(identity).toContainText(loose("1972-06-15 on the bottle"));
    await expect(intakeHistory(page).filter({ hasText: /accepted the recorded/ })).toHaveCount(0);
    await expect(request).toBeDisabled();
  });

  test("failed mutation: raising the identity clarification fails (HTTP 500), the dialog says so, and no question or hold is created", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, ITEM);
    const decision = page.getByRole("complementary", { name: "Decision" });
    await page.route("**/api/commands/clarification.create", (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" }));
    await decision.getByRole("button", { name: /^Raise clarification/ }).click();
    const raise = page.getByRole("dialog", { name: "Raise clarification" });
    await expect(raise.getByRole("combobox", { name: /^Category/ })).toHaveValue("identity_conflict");
    await expect(raise.getByRole("checkbox", { name: /^Place a scoped hold Hold: INT-1014-024 \(all containers\)/ })).toBeChecked();
    await raise.getByRole("button", { name: "Raise clarification", exact: true }).click();
    await expect(raise.getByRole("alert")).toContainText(loose("Unexpected response from the local server (HTTP 500)."));
    await expect(raise.getByRole("link", { name: /^Open CLR-\d+ in Clarifications$/ })).toHaveCount(0);
    await page.unroute("**/api/commands/clarification.create");
    await raise.getByRole("button", { name: "Close without raising" }).click();
    await page.reload();
    await expect(page.getByRole("region", { name: "Current finding" })).toContainText(loose("No holds on this item."));
    await expect(page.getByRole("region", { name: "Holds, questions and tasks" }).filter({ hasText: loose("Identity conflict") })).toHaveCount(0);

    // Raised for real (the hold placed with it), it is drafted, not sent.
    await decision.getByRole("button", { name: /^Raise clarification/ }).click();
    await raise.getByRole("button", { name: "Raise clarification", exact: true }).click();
    const open = raise.getByRole("link", { name: /^Open CLR-\d+ in Clarifications$/ });
    await expect(open).toBeVisible();
    raised.displayId = (await open.innerText()).match(/CLR-\d+/)![0];
    await raise.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("region", { name: "Holds, questions and tasks" })).toContainText(loose("Hold: INT-1014-024 (all containers)"));
  });

  test("unavailable dependency: with office notifications down the identity question's delivery is failed, never delivered; after restoring them an escalation is delivered", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openConsoleTab(page, "outages");
    await page.getByRole("button", { name: "Make notifications fail" }).click();
    await expect(page.getByRole("button", { name: /^Restore notifications/ })).toBeVisible();

    await page.goto(`/clarifications?selected=${raised.displayId}`);
    const panel = page.getByRole("region", { name: /^Identity conflict question: INT-1014-024/ });
    const decision = panel.getByRole("complementary", { name: "Decision" });
    await expect(panel).toContainText(loose("Drafted, not sent."));
    await decision.getByRole("button", { name: "Send (simulated)" }).click();
    await expect(panel).toContainText(loose("Delivery failed (simulated). Harbor Point Dermatology did not get the last notice."));
    const conversation = panel.getByRole("list", { name: /^Conversation with Harbor Point Dermatology/ });
    const notice = conversation.getByRole("listitem").filter({ hasText: loose("Initial notice") });
    await expect(notice).toContainText(loose("Delivery failed (simulated)"));
    await expect(notice).not.toContainText(loose("Delivered (simulated)"));
    await expect(decision.getByRole("region", { name: "Waiting on" })).toContainText(loose("Harbor Point Dermatology has not received the notice (delivery failed)"));
    // The simulated office cannot answer a question it never got.
    await openConsoleTab(page, "world");
    await expect(worldEvent(page, "The office answers a clarification").getByRole("combobox", { name: "Clarification" }).locator("option", { hasText: raised.displayId })).toHaveCount(0);
    // The bench never shows it as delivered either.
    await openIntakeItem(page, ITEM);
    await expect(page.getByRole("region", { name: "Holds, questions and tasks" })).not.toContainText(loose("Delivered"));

    // Restored: the escalation notice goes out and is delivered (simulated); the question now waits for the office.
    await openConsoleTab(page, "outages");
    await page.getByRole("button", { name: /^Restore notifications/ }).click();
    await expect(page.getByRole("button", { name: "Make notifications fail" })).toBeVisible();
    await page.goto(`/clarifications?selected=${raised.displayId}`);
    await decision.getByRole("button", { name: "Escalate" }).click();
    await page.getByRole("alertdialog", { name: `Escalate ${raised.displayId}?` }).getByRole("button", { name: "Escalate" }).click();
    await expect(conversation.getByRole("listitem").filter({ hasText: loose("Escalation") }).first()).toContainText(loose("Delivered (simulated)"));
    await expect(panel).not.toContainText(loose("did not get the last notice"));
  });

  test("repeated request: the lead's resolution sent twice with one key is recorded once; another input or another demo role with that key is refused; 'container is correct' still does not cover the identity mismatch", async ({ page, context }) => {
    // The simulated office answers (presenter console); the lead reviews the answer on the Clarifications screen.
    await actAs(context, STAFF.kim);
    await openConsoleTab(page, "world");
    const office = worldEvent(page, "The office answers a clarification");
    await office.getByRole("combobox", { name: "Clarification" }).selectOption(raised.displayId);
    await office.getByRole("button", { name: "Simulate office answer" }).click();
    await expect(office).toContainText(loose(`Simulated office reply recorded for ${raised.displayId}.`));
    await page.goto(`/clarifications?selected=${raised.displayId}`);
    const panel = page.getByRole("region", { name: /^Identity conflict question: INT-1014-024/ });
    const decision = panel.getByRole("complementary", { name: "Decision" });
    const reviewSlot = panel.getByRole("list", { name: /^Conversation with Harbor Point Dermatology/ }).getByRole("listitem").filter({ hasText: loose("Review by Kim Nguyen") });
    await reviewSlot.getByLabel(/^Review note/).fill("Office answered; checked against the bottle and the order.");
    await decision.getByRole("button", { name: "Mark answer reviewed" }).click();
    await expect(decision.getByRole("heading", { level: 3, name: `Resolve ${raised.displayId}` })).toBeVisible();

    // Internal id and version from the server-rendered page data (a fresh load: client refreshes do not rewrite it).
    await page.reload();
    await expect(decision.getByRole("heading", { level: 3, name: `Resolve ${raised.displayId}` })).toBeVisible();
    const clr = await recordOnPage(page, "clr", raised.displayId);
    const input = { clarificationId: clr.id, expectedVersion: clr.version, resolutionCode: "confirmed_observed", note: "Office says the bottle is right: the order names a different patient." };
    const key = intentKey("j2-resolve");
    const first = await sendCommand(page, "clarification.resolve", input, key);
    expect(first.body.result?.state ?? "resolved").toBe("resolved");
    await expectKeyIsScoped(page, context, {
      name: "clarification.resolve",
      input,
      changedInput: { ...input, resolutionCode: "confirmed_order" },
      key,
      first,
      owner: STAFF.kim,
      otherRole: STAFF.tanya,
    });
    await page.reload();
    await expect(panel).toContainText(loose("Resolved by Kim Nguyen: Office confirmed what we observed (container is correct)."));
    await panel.getByRole("group").filter({ hasText: /^History\s*\(\d+ recorded events\)/ }).getByText(/^\(\d+ recorded events\)$/).click();
    await expect(panel.getByRole("listitem").filter({ hasText: loose(`Kim Nguyen resolved ${raised.displayId}:`) })).toHaveCount(1);

    // At the bench: "container is correct" means the order names someone else, so accession still waits, and says why.
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, ITEM);
    const bench = page.getByRole("complementary", { name: "Decision" });
    await expect(bench.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();
    const reasons = bench.getByRole("group").filter({ hasText: /^Show all \d+ reasons/ });
    await reasons.getByText(/^Show all \d+ reasons/).click();
    await expect(reasons.getByRole("listitem").filter({ hasText: loose(`${ITEM} container 1 (ORD-77118 part A): patient identity differs (date of birth).`) })).toContainText(
      loose(`${raised.displayId} was resolved as 'container is correct': the order names a different patient; accession waits for the corrected order and a new check of the container`),
    );
  });

  test("stale state: retyping the bottle's date of birth from an old version is refused with 409 CONFLICT; the recorded value and the identity block stay", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, ITEM);
    const c = await containerOnPage(page);
    const stale = await sendCommand(page, "intake.recordObservation", { containerId: c.id, expectedVersion: c.version - 1, observed: { birth_date: "1972-06-14" } }, intentKey("j2-stale-observation"));
    expectRefused(stale, 409, "CONFLICT");
    await page.reload();
    await expect(page.getByRole("region", { name: "Current case" })).toContainText(loose("1972-06-15 on the bottle"));
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77118 Discrepancy recorded$/ })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Decision" }).getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();
    expect((await containerOnPage(page)).version).toBe(c.version);
  });
});

// =====================================================================================================================
// Journey 3: related orders REL-0112 (INT-1014-031 Part A on ORD-77120, INT-1014-032 Part B on ORD-77121, Avery
// Quinlan, same encounter ENC-55031). Kim Nguyen (accessioning lead) decides; nothing is ever merged. The decision
// can be made once, so the conditions run in the order the bench allows: a missing reason and a failed request
// first (nothing recorded), then the decision itself, then a replay of that very request, a stale one, and an outage.
// =====================================================================================================================
test.describe("journey 3: related orders REL-0112 (Kim, lead)", () => {
  test.describe.configure({ mode: "serial" });
  resetBeforeJourney();

  const PART_A = "INT-1014-031";
  const PART_B = "INT-1014-032";
  /** The decision request the screen sent (its input and idempotency key), replayed in the repeated-request test. */
  const sentDecision = { input: {} as Record<string, unknown>, key: "", result: null as unknown, correlationId: "" };

  const workspace = (page: Page) => page.getByRole("region", { name: "REL-0112 side by side" });
  const related = (page: Page) => page.getByRole("region", { name: "Related orders" });
  const decisionColumn = (page: Page) => page.getByRole("complementary", { name: "Decision" });
  /** Nothing decided yet: the lead's choices are still offered, none chosen, and no decision is shown or recorded. */
  async function expectUndecided(page: Page) {
    await expect(workspace(page)).toBeVisible();
    for (const radio of await workspace(page).getByRole("radio").all()) await expect(radio).not.toBeChecked();
    await expect(page.getByRole("navigation", { name: "Path to accession" }).getByRole("button", { name: /^Step 3, Related orders, yours now/ })).toBeVisible();
    await expect(page.getByText(loose("Decision by Kim Nguyen"))).toHaveCount(0);
    await expect(intakeHistory(page).filter({ hasText: loose("REL-0112") }).filter({ hasText: /approved as one accession|kept separate|not related|escalated/ })).toHaveCount(0);
  }

  test("missing information: the decision needs a reason; without one nothing is recorded, on the screen or on the server", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await runSimulatorEvents(page, 1);
    await openIntakeItem(page, PART_A);
    const ws = workspace(page);
    await ws.getByRole("radio", { name: /^Keep separate/ }).check();
    // Record decision is aria-disabled so a press can say why (Playwright treats aria-disabled as not clickable, hence force).
    await decisionColumn(page).getByRole("button", { name: /^Record decision/ }).click({ force: true });
    const reason = ws.getByLabel(/^Reason/);
    await expect(reason).toBeFocused();
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    await expect(ws.getByText("A reason is required: say why. It is recorded with your name.")).toBeVisible();
    // The server refuses a decision without a reason too.
    const candidate = await recordOnPage(page, "rel", "REL-0112");
    const noReason = await sendCommand(page, "related.review", { candidateId: candidate.id, expectedVersion: candidate.version, decision: "keep_separate", reason: "   " }, intentKey("j3-no-reason"));
    expectRefused(noReason, 400, "VALIDATION");
    await page.reload();
    await expectUndecided(page);
  });

  test("failed mutation: a decision that never reaches the server says so inline; after a reload REL-0112 still needs review", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, PART_A);
    const ws = workspace(page);
    await ws.getByRole("radio", { name: /^Keep separate/ }).check();
    await ws.getByLabel(/^Reason/).fill("Two separate biopsies; keep them as two cases.");
    await page.route("**/api/commands/related.review", (route) => route.abort("internetdisconnected"));
    await decisionColumn(page).getByRole("button", { name: /^Record decision/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: loose("Could not reach the local server") }).first()).toBeVisible();
    await expect(page.getByText(loose("Decision by Kim Nguyen"))).toHaveCount(0);
    await page.unroute("**/api/commands/related.review");
    await page.reload();
    await expectUndecided(page);
  });

  test("normal path: Kim links the two as related with a reason; both source orders ORD-77120 and ORD-77121 stay, nothing is merged", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, PART_A);
    const ws = workspace(page);
    await expect(ws.getByRole("row", { name: /^Separate source orders / })).toContainText(loose("ORD-77120 ORD-77121"));
    await expect(decisionColumn(page)).toContainText(loose("Review, not merge. Both orders and both provisional ids are kept."));
    await ws.getByRole("radio", { name: /^Link as related: one accession, parts kept with their original orders/ }).check();
    await expect(ws.getByRole("status").filter({ hasText: "If recorded" })).toContainText(loose("Nothing is merged."));
    await ws.getByLabel(/^Reason/).fill("Same patient reference, encounter ENC-55031, office and collection day; parts keep ORD-77120 and ORD-77121.");
    const sent = nextCommandRequest(page, "related.review");
    await decisionColumn(page).getByRole("button", { name: /^Record decision/ }).click();
    const request = await sent;
    const body = requestBody(request);
    sentDecision.input = body.input;
    sentDecision.key = body.idempotencyKey;
    const response = await request.response();
    expect(response?.status()).toBe(200);
    sentDecision.correlationId = response?.headers()["x-correlation-id"] ?? "";
    expect(sentDecision.correlationId, "X-Correlation-Id header").toBeTruthy();
    sentDecision.result = ((await response!.json()) as { result: unknown }).result;

    const rel = related(page);
    await expect(rel).toContainText(loose("Decision by Kim Nguyen"));
    await expect(rel).toContainText(loose("Approved: one accession, parts kept with original orders"));
    await expect(rel).toContainText(loose("Order ORD-77120"));
    await expect(rel).toContainText(loose("Order ORD-77121"));
    await expect(rel).toContainText(loose("ORD-77121 and ORD-77120 stay separate source records (both kept)"));
    await expect(rel.getByRole("link", { name: new RegExp(`^Provisional intake item ${PART_B}`) })).toBeVisible();
    // Both provisional items stay, each on its own source order.
    await openIntakeItem(page, PART_B);
    await expect(page.getByRole("region", { name: /^Source order/ })).toContainText(loose("Order ORD-77121"));
    await expect(page.getByRole("region", { name: "Current case" })).toContainText(loose(`Provisional intake item ${PART_B}, not an accession number`));
    await openIntakeItem(page, PART_A);
    await expect(page.getByRole("region", { name: /^Source order/ })).toContainText(loose("Order ORD-77120"));
  });

  test("repeated request: replaying the screen's own decision request with its key creates no second decision; another input or another demo role with that key is refused", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, PART_A);
    // The screen's own request (read in the normal path) stored the result under its key.
    const first: CommandReply = { status: 200, body: { ok: true, result: sentDecision.result }, correlationId: sentDecision.correlationId };
    await expectKeyIsScoped(page, context, {
      name: "related.review",
      input: sentDecision.input,
      changedInput: { ...sentDecision.input, decision: "keep_separate" },
      key: sentDecision.key,
      first,
      owner: STAFF.kim,
      otherRole: STAFF.tanya,
    });
    await page.reload();
    await expect(related(page)).toContainText(loose("Approved: one accession, parts kept with original orders"));
    await expect(
      intakeHistory(page).filter({ hasText: loose("REL-0112 (ORD-77120 + ORD-77121) approved as one accession (parts kept with their original orders; nothing merged) by Kim Nguyen") }),
    ).toHaveCount(1);
  });

  test("stale state: a decision sent with REL-0112's old version is refused with 409 CONFLICT and overwrites nothing", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, PART_A);
    const stale = await sendCommand(
      page,
      "related.review",
      { ...sentDecision.input, decision: "not_related", reason: "Sent from a tab opened before the decision." },
      intentKey("j3-stale"),
    );
    expectRefused(stale, 409, "CONFLICT");
    await page.reload();
    await expect(related(page)).toContainText(loose("Approved: one accession, parts kept with original orders"));
    await expect(related(page)).toContainText(/Decision by Kim Nguyen at \d{1,2}:\d{2} [AP]M ET: Approved: one accession, parts kept with original orders\. Reason: Same patient reference/);
    await expect(intakeHistory(page).filter({ hasText: loose("Sent from a tab opened before the decision.") })).toHaveCount(0);
  });

  test("unavailable dependency: with EMA-SIM offline the decision and the checks still work locally, but nothing is shown as accessioned; restoring the source clears the outage", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await setEmaFromConsole(context, "offline");
    await openIntakeItem(page, PART_A);
    const outage = page.getByRole("status").filter({ hasText: loose("EMA-SIM Sunrise Coast (accession source) unreachable since") });
    await expect(outage).toContainText(loose("Request accession is unavailable. Verification, routing and related-order review still work locally."));
    await expect(related(page)).toContainText(loose("Approved: one accession, parts kept with original orders"));
    // Local work continues: the bottle check for Part A is recorded while the source is down.
    await decisionColumn(page).getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77120 Staff verified$/ })).toBeVisible();
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity).toContainText(loose("Official number: not issued"));
    await expect(identity).not.toContainText(/Accession D26-/);
    // The joint request REL-0112 approved is offered, but disabled while the source is down, and says why.
    await expect(decisionColumn(page).getByRole("button", { name: `Request accession for ${PART_A} + ${PART_B} together (simulated source)` })).toBeDisabled();
    await expect(decisionColumn(page)).toContainText(loose("Source system unreachable (simulated outage). Your verification is saved locally. Request the accession when the source is back."));
    await expect(decisionColumn(page)).toContainText(loose("One accession approved in REL-0112; parts keep their original orders and designations."));

    await setEmaFromConsole(context, "connected");
    await expect(outage).toHaveCount(0);
    await expect(decisionColumn(page)).not.toContainText(loose("Source system unreachable"));
    await expect(identity).toContainText(loose(`Provisional intake item ${PART_A}, not an accession number`));
  });
});

// =====================================================================================================================
// Journey 4: grossing and handoff. Seeded records already in the right state: D26-04801 Part A awaiting grossing
// (grossed here from the generic shave dictation), D26-04797 Part C a draft with a missing piece count and dimensions
// that need review, D26-04797 Part A operator reviewed. The tray handoff uses TRY-M-03 (Dr. Elena Marsh), whose last
// two expected slides are completed here. Dana Whitfield grosses, Sam Ortiz enters in the source system, Priya Shah
// sends the tray.
// =====================================================================================================================
test.describe("journey 4: grossing and handoff", () => {
  test.describe.configure({ mode: "serial" });
  resetBeforeJourney();

  const PART = "D26-04801 Part A";
  const sentApproval = { input: {} as Record<string, unknown>, key: "", result: null as unknown, correlationId: "" };
  const nextStep = (page: Page, part: string) => page.getByRole("region", { name: `Next step for ${part}` });
  const statusRail = (page: Page) => page.getByRole("navigation", { name: "Gross record status" });

  test("normal path: Dana grosses D26-04801 Part A from the dictation, confirms every value and approves; Sam marks it entered, which is not an acknowledgment", async ({ page, context }) => {
    await actAs(context, STAFF.dana);
    await page.goto("/grossing?part=D26-04801-A");
    await expect(page.getByRole("heading", { level: 1, name: `Gross record for ${PART}` })).toBeVisible();
    await page.getByLabel("Synthetic dictation").selectOption("generic-shave");
    await page.getByRole("button", { name: "Attach transcript and extract" }).click();
    await expect(page.getByText(loose("Proposed from transcript, not confirmed")).first()).toBeVisible();
    await expect(page.getByText(loose("Confirmed by Dana Whitfield"))).toHaveCount(0);
    const next = nextStep(page, PART);
    await expect(next.getByRole("button", { name: "Approve for downstream use" })).toBeDisabled();

    // The container label is observed at the bench (the dictation does not say), then each proposal is confirmed explicitly.
    await page.getByRole("radio", { name: "Yes, matches the part" }).check();
    const confirmLabel = page.getByRole("button", { name: /^Confirm( my value)?: Container label matches part$/ });
    await confirmLabel.click();
    await expect(confirmLabel).toHaveCount(0);
    const confirms = page.getByRole("button", { name: /^Confirm: / });
    for (let guard = 0; guard < 12 && (await confirms.count()) > 0; guard++) {
      const before = await confirms.count();
      await confirms.first().click();
      await expect(confirms).toHaveCount(before - 1);
    }
    await expect(page.getByText(loose("Proposed from transcript, not confirmed"))).toHaveCount(0);

    await page.getByRole("button", { name: "Compose from confirmed values" }).click();
    await expect(page.getByLabel(new RegExp(`^Narrative for ${PART}`))).toHaveValue(/\S/);
    await next.getByRole("button", { name: "Save draft" }).click();
    await next.getByRole("button", { name: "Mark operator reviewed" }).click();
    await expect(next).toContainText(loose("Operator reviewed. Ready to approve for downstream use."));
    const sent = nextCommandRequest(page, "gross.approve");
    await next.getByRole("button", { name: "Approve for downstream use" }).click();
    const request = await sent;
    sentApproval.input = requestBody(request).input;
    sentApproval.key = requestBody(request).idempotencyKey;
    const response = await request.response();
    expect(response?.status()).toBe(200);
    sentApproval.correlationId = response?.headers()["x-correlation-id"] ?? "";
    sentApproval.result = ((await response!.json()) as { result: unknown }).result;

    const approved = page.getByRole("status").filter({ has: page.getByRole("heading", { name: `${PART} approved for downstream use` }) });
    await expect(approved).toContainText(loose("Enter approved gross description in source system — D26-04801 part A Owner: Sam Ortiz"));
    await expect(approved).toContainText(/D26-04801 A1 eligible for the next processing run/);
    await expect(approved).toContainText(loose("Source-system entry is pending; nothing was written to the source system."));

    // Sam types it into the source system by hand and attests it: entered, but not acknowledged.
    await actAs(context, STAFF.sam);
    await page.goto("/grossing?part=D26-04801-A");
    await nextStep(page, PART).getByRole("button", { name: "Mark entered in source system (staff attestation)" }).click();
    await expect(page.getByText(/Entered \(staff attested\) by Sam Ortiz.* Not acknowledged by the source\./)).toBeVisible();
    await expect(statusRail(page).getByRole("listitem").filter({ hasText: loose("Source acknowledged (simulated)") })).toContainText(loose("(not yet)"));
  });

  test("missing information: a draft with a missing piece count and dimensions to review lists its blockers and cannot be reviewed or approved, on the screen or on the server", async ({ page, context }) => {
    await actAs(context, STAFF.dana);
    const part = "D26-04797 Part C";
    await page.goto("/grossing?part=D26-04797-C");
    await expect(page.getByRole("heading", { level: 1, name: `Gross record for ${part}` })).toBeVisible();
    const next = nextStep(page, part);
    const blockers = next.getByRole("status").filter({ hasText: loose("Cannot approve yet") });
    await expect(blockers).toContainText(loose("Cannot approve yet: 2 items need attention"));
    await expect(blockers.getByRole("listitem").filter({ hasText: loose("Missing:") }).getByRole("button", { name: "Piece count" })).toBeVisible();
    await expect(blockers.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Dimensions" }) })).toContainText(
      loose("needs review: Unit not stated and the second dimension may be a missed decimal (4 vs 0.4)"),
    );
    await expect(next.getByRole("button", { name: "Mark operator reviewed" })).toBeDisabled();
    await expect(next.getByRole("button", { name: "Approve for downstream use" })).toBeDisabled();
    // A missing count is never shown as 0.
    await expect(page.getByRole("textbox", { name: "Piece count (required)" })).toHaveValue("");

    // Sent by hand, review and approval are refused for the same reasons, and nothing moves.
    const record = await fromPageData(page, /"id":"(gr_acc_d26_04797_pc_v1)"[^{}]*?"version":(\d+)/, "the D26-04797 Part C gross record");
    const review = await sendCommand(page, "gross.markReviewed", { grossRecordId: record[1], expectedVersion: Number(record[2]) }, intentKey("j4-review-blocked"));
    expect(review.status, JSON.stringify(review.body)).toBeGreaterThanOrEqual(400);
    expect(review.body.ok).toBe(false);
    expect(review.body.error?.message).toMatch(/Piece count/);
    const approve = await sendCommand(page, "gross.approve", { grossRecordId: record[1], expectedVersion: Number(record[2]) }, intentKey("j4-approve-blocked"));
    expect(approve.status, JSON.stringify(approve.body)).toBeGreaterThanOrEqual(400);
    expect(approve.body.ok).toBe(false);
    await page.reload();
    await expect(statusRail(page).getByRole("listitem").filter({ hasText: loose("Draft") }).first()).toContainText(loose("(current step)"));
    await expect(statusRail(page).getByRole("listitem").filter({ hasText: loose("Approved for downstream use") })).toContainText(loose("(not yet)"));
    await expect(blockers).toContainText(loose("Cannot approve yet: 2 items need attention"));
  });

  test("failed mutation: an approval that never reaches the server says so inline; after a reload the record is still operator reviewed, not approved", async ({ page, context }) => {
    await actAs(context, STAFF.dana);
    const part = "D26-04797 Part A";
    await page.goto("/grossing?part=D26-04797-A");
    const next = nextStep(page, part);
    await expect(statusRail(page).getByRole("listitem").filter({ hasText: loose("Operator reviewed") }).first()).toContainText(loose("(current step)"));
    await page.route("**/api/commands/gross.approve", (route) => route.abort("internetdisconnected"));
    await next.getByRole("button", { name: "Approve for downstream use" }).click();
    await expect(page.getByRole("alert").filter({ hasText: loose("Could not reach the local server") }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: `${part} approved for downstream use` })).toHaveCount(0);
    await page.unroute("**/api/commands/gross.approve");
    await page.reload();
    await expect(statusRail(page).getByRole("listitem").filter({ hasText: loose("Operator reviewed") }).first()).toContainText(loose("(current step)"));
    await expect(statusRail(page).getByRole("listitem").filter({ hasText: loose("Approved for downstream use") })).toContainText(loose("(not yet)"));
  });

  test("repeated request: replaying the screen's own approval with its key creates the blocks once; another input or another demo role with that key is refused", async ({ page, context }) => {
    await actAs(context, STAFF.dana);
    await page.goto("/cases/D26-04801?tab=material");
    const partA = page.getByRole("region", { name: "Part A", exact: true });
    const blockRows = partA.getByRole("row", { name: /^D26-04801 A\d+ / });
    await expect(blockRows.first()).toBeVisible();
    const blocks = await blockRows.count();
    expect(blocks).toBeGreaterThan(0);
    const first: CommandReply = { status: 200, body: { ok: true, result: sentApproval.result }, correlationId: sentApproval.correlationId };
    await expectKeyIsScoped(page, context, {
      name: "gross.approve",
      input: sentApproval.input,
      changedInput: { ...sentApproval.input, expectedVersion: Number(sentApproval.input.expectedVersion) + 1 },
      key: sentApproval.key,
      first,
      owner: STAFF.dana,
      otherRole: STAFF.tanya,
    });
    await page.reload();
    await expect(blockRows).toHaveCount(blocks);
    await page.goto("/cases/D26-04801?tab=history");
    const history = page.getByRole("region", { name: "History" }).getByRole("listitem");
    await expect(history.filter({ hasText: loose("Dana Whitfield approved D26-04801 part A v1 for downstream use.") })).toHaveCount(1);
    await expect(history.filter({ hasText: /Block D26-04801 A\d+ recorded from the approved cassette allocation/ })).toHaveCount(blocks);
  });

  test("stale state: saving the draft narrative from an old version is refused with 409 CONFLICT and overwrites nothing", async ({ page, context }) => {
    await actAs(context, STAFF.dana);
    const part = "D26-04797 Part C";
    await page.goto("/grossing?part=D26-04797-C");
    const narrative = page.getByRole("textbox", { name: `Narrative for ${part} (required)` });
    const original = await narrative.inputValue();
    expect(original).not.toBe("");
    const record = await fromPageData(page, /"id":"(gr_acc_d26_04797_pc_v1)"[^{}]*?"version":(\d+)/, "the D26-04797 Part C gross record");
    const version = Number(record[2]);
    // A colleague saves first (the version moves on), then a save from the version this tab loaded arrives.
    const colleague = `${original} Checked at the bench.`;
    const fresh = await sendCommand(page, "gross.updateFields", { grossRecordId: record[1], expectedVersion: version, patch: {}, narrative: colleague }, intentKey("j4-colleague-save"));
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.result?.version).toBe(version + 1);
    const stale = await sendCommand(page, "gross.updateFields", { grossRecordId: record[1], expectedVersion: version, patch: {}, narrative: "Part C: overwritten from a stale tab." }, intentKey("j4-stale-save"));
    expectRefused(stale, 409, "CONFLICT");
    await page.reload();
    await expect(narrative).toHaveValue(colleague);
    await expect(narrative).not.toHaveValue(/stale tab/);
  });

  test("unavailable dependency: with the simulated source offline the entry stays 'not acknowledged', the console's acknowledgment is disabled with the reason, and after restoring it the acknowledgment arrives", async ({ page, context }) => {
    await actAs(context, STAFF.sam);
    await page.goto("/grossing?view=source");
    const attested = page.getByRole("group").filter({ hasText: /^Entered \(staff attested\), awaiting acknowledgment/ });
    await attested.getByText(/^Entered \(staff attested\), awaiting acknowledgment/).click();
    const row = attested.getByRole("row", { name: /^D26-04801 Part A/ });
    await expect(row).toContainText(loose("Not acknowledged yet. Waiting for EMA-SIM Sunrise Coast."));
    // The source goes down: the open queue says the entry is still not acknowledged, and why (live refresh, no reload).
    await setEmaFromConsole(context, "offline");
    await expect(row).toContainText(loose("Not acknowledged. Source unreachable; it cannot acknowledge until it is back."));
    await expect(row).not.toContainText(/Acknowledged by/);

    await openConsoleTab(page, "world");
    const ack = worldEvent(page, "The source system acknowledges a gross entry");
    await selectOptionMatching(ack.getByRole("combobox", { name: "Gross entry" }), /^D26-04801 Part A, entered by Sam Ortiz, .*\(source offline\)$/);
    await expect(ack.getByRole("button", { name: "Simulate source acknowledgment" })).toBeDisabled();
    await expect(ack).toContainText(loose("EMA-SIM Sunrise Coast is offline (simulated outage), so it cannot acknowledge yet. Restore the connection on Outages and reset."));
    await page.goto("/grossing?part=D26-04801-A");
    await expect(page.getByText(/Entered \(staff attested\) by Sam Ortiz.* Not acknowledged by the source\./)).toBeVisible();
    await expect(page.getByText(loose("Acknowledged by the simulated source at"))).toHaveCount(0);

    await setEmaFromConsole(context, "connected");
    await openConsoleTab(page, "world");
    await selectOptionMatching(ack.getByRole("combobox", { name: "Gross entry" }), /^D26-04801 Part A, entered by Sam Ortiz, /);
    await ack.getByRole("button", { name: "Simulate source acknowledgment" }).click();
    await expect(ack).toContainText(/D26-04801 Part A: acknowledged by .+ \(simulated\)\./);
    await page.goto("/grossing?part=D26-04801-A");
    await expect(page.getByText(loose("Acknowledged by the simulated source at"))).toBeVisible();
    await expect(statusRail(page).getByRole("listitem").filter({ hasText: loose("Source acknowledged (simulated)") })).toContainText(loose("Source acknowledged (simulated) (current step) Simulated source,"));
  });

  // Last in the journey on purpose: it shows an app defect (see the final report).
  test("handoff: a tray sent to the pathologist reads 'sent', never a receipt by the pathologist; its case says 'Sent on tray'", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await page.goto("/materials?tab=trays&selected=TRY-M-03");
    const tray = page.getByRole("region", { name: "Current tray" });
    await expect(tray).toContainText(looseNumber("8 of 10 expected slides scanned"));
    await page.getByRole("button", { name: "Scan D26-04747 A1-1 H&E L1", exact: true }).click();
    await expect(tray).toContainText(looseNumber("9 of 10 expected slides scanned"));
    await page.getByRole("button", { name: "Found it D26-04747 A1-2 H&E L2" }).click();
    await page.getByRole("button", { name: "Scan D26-04747 A1-2 H&E L2", exact: true }).click();
    await expect(tray).toContainText(looseNumber("10 of 10 expected slides scanned"));
    await page.getByRole("button", { name: "Mark tray complete" }).click();
    const needs = page.getByRole("region", { name: "What the tray needs" });
    await expect(needs.getByRole("heading", { level: 2, name: "TRY-M-03 is verified complete: every slide has its own matching scan." })).toBeVisible();
    await needs.getByRole("button", { name: "Deliver tray to Dr. Elena Marsh" }).click();

    // Sent, and said so; no receipt by the pathologist is claimed anywhere.
    await expect(needs.getByRole("heading", { level: 2, name: "TRY-M-03 was sent to Dr. Elena Marsh. Receipt is not recorded." })).toBeVisible();
    await expect(page.getByText(loose("Sent. Receipt by the pathologist is not recorded."))).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Trays" }).getByRole("link", { name: /^TRY-M-03 / })).toHaveAccessibleName(/^TRY-M-03 Sent \(receipt not recorded\)$/);
    await expect(page.getByRole("main")).not.toContainText(/received by (the )?(pathologist|Dr\.)|receipt (is )?recorded(?! )/i);
    // The tray's own status, in the band of the tray in hand, says the same as the tray list ("Delivered" reads as a receipt).
    await expect(tray, "the current tray's status after sending").toContainText(loose("Sent (receipt not recorded)"));
    await expect(tray, "the current tray's status after sending").not.toContainText(/Delivered/);

    // The case whose only part went out on this tray: sent on trays, receipt not recorded.
    await page.goto("/cases/D26-04746");
    await expect(page.getByText(loose("The only part is sent on trays (receipt not recorded); no additional work open."))).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText(/received by (the )?(pathologist|Dr\.)|receipt recorded/i);
    // The worklist says it in the same words (the stage label is "Sent on tray").
    await page.goto("/worklist?view=operations");
    const row = page.getByRole("table", { name: /^Worklist, / }).getByRole("row", { name: /^D26-04746,/ });
    await expect(row).toBeVisible();
    await expect(row.getByRole("cell").nth(1), "the worklist stage of a part sent on a tray").toHaveText("A sent on tray");
  });
});

// =====================================================================================================================
// Journey 5: material location (Materials › Retrieve blocks, and Print labels), Priya Shah (histotech). Seeded:
// RR-0192 for Dr. Okafor (D26-03990 B1 and A1 in Cabinet 2/Drawer 4/Box 11, D26-03912 A1 checked out to Marcus Lee and
// overdue), D26-03909 A1 on the bench but not on the request, PJ-8841 with an unknown outcome on Slide printer 1, and
// planned slide D26-04750 A1-5 whose label is not printed yet.
// =====================================================================================================================
test.describe("journey 5: material location (Priya, histotech)", () => {
  test.describe.configure({ mode: "serial" });
  resetBeforeJourney();

  const requested = (page: Page) => page.getByRole("region", { name: "Requested blocks, in walking order" });
  const blockItem = (page: Page, label: string) => requested(page).getByRole("listitem").filter({ hasText: new RegExp(`Pick\\s*\\d\\s*of\\s*3\\s*${label}`) });

  async function openRetrieval(page: Page) {
    await page.goto("/materials?tab=retrieval&selected=RR-0192");
    await expect(page.getByRole("region", { name: "Current retrieval request" })).toContainText(loose("Retrieval request RR-0192"));
  }

  test("missing information: a block not with its recorded holder needs a note to open the investigation, and cannot be filed back without saying where it was found", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await openRetrieval(page);
    const overdue = blockItem(page, "D26-03912 A1");
    await expect(overdue).toContainText(loose("Checked out to Marcus Lee since Oct 10, 11:00 AM ET"));
    await overdue.getByRole("button", { name: "Not with the recorded holder…" }).click();
    const report = page.getByRole("dialog", { name: "D26-03912 A1 is not with Marcus Lee?" });
    // Without a note the investigation is not opened.
    await report.getByRole("button", { name: "Open investigation" }).click({ force: true });
    await expect(report.getByRole("textbox", { name: /^What was checked/ })).toHaveAttribute("aria-invalid", "true");
    await expect(report).toContainText(loose("This needs a short note."));
    await report.getByRole("textbox", { name: /^What was checked/ }).fill("Marcus checked both microtomy benches; it is not with him.");
    await report.getByRole("button", { name: "Open investigation" }).click();
    await expect(report).toBeHidden();
    await expect(overdue).toContainText(loose("Missing — investigation open"));
    // The last confirmed location stays as it was: nothing is inferred from the report.
    await expect(overdue).toContainText(loose("Last confirmed by Marcus Lee at Oct 10, 11:00 AM ET"));
    await expect(page.getByRole("region", { name: "Current retrieval request" })).toContainText(loose("1 not found"));

    // Found again: filing it back needs a "Where it was found" note; without one nothing changes.
    const found = overdue.getByRole("textbox", { name: /^Where it was found/ });
    await expect(found).toHaveValue("");
    await expect(overdue.getByRole("textbox", { name: "Return to slot" })).toHaveValue("CAB-2/DR-1/BX-03/S-12");
    await overdue.getByRole("button", { name: "Record return" }).click();
    await expect(overdue.getByRole("alert")).toContainText(loose("D26-03912 A1 was reported missing. Say where it was found before filing it in CAB-2/DR-1/BX-03/S-12. Nothing changed."));
    await page.reload();
    await expect(overdue).toContainText(loose("Missing — investigation open"));
    await expect(overdue).toContainText(loose("Last confirmed by Marcus Lee at Oct 10, 11:00 AM ET"));
    await overdue.getByRole("textbox", { name: /^Where it was found/ }).fill("Found in the embedding-station tray.");
    await overdue.getByRole("button", { name: "Record return" }).click();
    await expect(toasts(page)).toContainText(loose("D26-03912 A1 filed in CAB-2/DR-1/BX-03/S-12. Location confirmed now by Priya Shah."));
    await expect(overdue).toContainText(loose("Last confirmed by Priya Shah at"));
    await expect(overdue).not.toContainText(loose("Missing — investigation open"));
  });

  test("normal path: a wrong block is rejected and changes nothing; delivery records a hand-over while each block keeps its last confirmed location; a return confirms a slot", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await openRetrieval(page);
    const band = page.getByRole("region", { name: "Current retrieval request" });
    const picked = band.getByText(/^\d+ of \d+ picked/);
    await expect(picked).toHaveText("0 of 3 picked");
    await page.getByRole("button", { name: "Scan D26-03909 A1" }).click();
    await expect(page.getByRole("status").filter({ hasText: loose("Wrong block: not accepted") })).toContainText(loose("D26-03909 A1 is not on RR-0192. Nothing was changed."));
    await expect(picked).toHaveText("0 of 3 picked");

    for (const [label, n] of [["D26-03990 B1", 1], ["D26-03990 A1", 2], ["D26-03912 A1", 3]] as const) {
      await page.getByRole("button", { name: `Scan ${label}` }).click();
      await expect(picked).toHaveText(`${n} of 3 picked`);
    }
    const a1 = blockItem(page, "D26-03990 A1");
    await expect(a1).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));
    await expect(a1).toContainText(loose("Checked out to Priya Shah"));

    // Delivery is a hand-over at the destination: custody is recorded, the location is not inferred.
    await page.getByRole("button", { name: "Deliver to Microtomy bench 2" }).click();
    await expect(band).toContainText(loose("Delivered"));
    await expect(a1).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));
    await expect(a1.getByRole("list", { name: "Location: Cabinet 2, Drawer 4, Box 11, Slot 14" })).toBeVisible();
    await a1.getByRole("group").filter({ hasText: /^Custody history/ }).getByText(/^Custody history/).click();
    await expect(a1.getByRole("listitem").filter({ hasText: loose("Delivered to Microtomy bench 2 for RR-0192 (hand-over recorded; destination not scanned, last confirmed location unchanged)") })).toHaveCount(1);
    await page.reload();
    await expect(a1).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));

    // The return confirms this block's slot, now, by the person who scanned it.
    await expect(a1.getByRole("textbox", { name: "Return to slot" })).toHaveValue("CAB-2/DR-4/BX-11/S-14");
    await a1.getByRole("button", { name: "Record return" }).click();
    await expect(toasts(page)).toContainText(loose("D26-03990 A1 filed in CAB-2/DR-4/BX-11/S-14. Location confirmed now by Priya Shah."));
    await expect(a1).toContainText(loose("Last confirmed by Priya Shah at"));
    await expect(blockItem(page, "D26-03990 B1")).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));
  });

  test("failed mutation: a return that never reaches the server says so inline; after a reload the block is still out and its location unchanged", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await openRetrieval(page);
    const b1 = blockItem(page, "D26-03990 B1");
    await page.route("**/api/commands/retrieval.return", (route) => route.abort("internetdisconnected"));
    await b1.getByRole("button", { name: "Record return" }).click();
    await expect(b1.getByRole("alert")).toContainText(loose("Could not reach the local server"));
    await page.unroute("**/api/commands/retrieval.return");
    await page.reload();
    await expect(b1).toContainText(loose("Checked out to Priya Shah"));
    await expect(b1).toContainText(loose("Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET"));
  });

  test("repeated request: one return sent twice with one key files the block once; another slot or another demo role with that key is refused", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await openRetrieval(page);
    const blockId = (await fromPageData(page, /"blockId":"([^"]+)","blockLabel":"D26-03990 B1"/, "the D26-03990 B1 block id"))[1];
    const input = { blockId, locationCode: "CAB-2/DR-4/BX-11/S-15" };
    const key = intentKey("j5-return");
    const first = await sendCommand(page, "retrieval.return", input, key);
    expect(first.body.result?.message).toContain("D26-03990 B1 filed in CAB-2/DR-4/BX-11/S-15.");
    await expectKeyIsScoped(page, context, {
      name: "retrieval.return",
      input,
      changedInput: { ...input, locationCode: "CAB-2/DR-4/BX-11/S-14" },
      key,
      first,
      owner: STAFF.priya,
      otherRole: STAFF.tanya,
    });
    await page.reload();
    const b1 = blockItem(page, "D26-03990 B1");
    await expect(b1).toContainText(loose("Last confirmed by Priya Shah at"));
    await expect(b1.getByRole("list", { name: "Location: Cabinet 2, Drawer 4, Box 11, Slot 15" })).toBeVisible();
    await b1.getByRole("group").filter({ hasText: /^Custody history/ }).getByText(/^Custody history/).click();
    await expect(b1.getByRole("listitem").filter({ hasText: loose("Returned and filed in CAB-2/DR-4/BX-11/S-15") })).toHaveCount(1);
  });

  test("stale state: a return of a block that never left storage, a scan on a delivered request, and a reconciliation from an old version are all refused; nothing changes", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await openRetrieval(page);
    // D26-03909 A1 is in storage (never checked out): returning it is a transition from the wrong state.
    const storedId = (await fromPageData(page, /"id":"([^"]+)","label":"D26-03909 A1","location":"CAB-2\/DR-1\/BX-03\/S-09"/, "the D26-03909 A1 block"))[1];
    const wrongState = await sendCommand(page, "retrieval.return", { blockId: storedId, locationCode: "CAB-2/DR-1/BX-03/S-12" }, intentKey("j5-return-stored"));
    expectRefused(wrongState, 423, "BLOCKED");
    expect(wrongState.body.error?.message).toContain("Only a checked-out or missing block can be returned to storage. Nothing changed.");
    // RR-0192 is delivered: it no longer accepts scans.
    const lateScan = await sendCommand(page, "retrieval.scan", { requestId: "RR-0192", payload: "HL1:B:EMS:D26-03990:A:1" }, intentKey("j5-late-scan"));
    expectRefused(lateScan, 423, "BLOCKED");
    await page.reload();
    await expect(page.getByRole("region", { name: "Current retrieval request" })).toContainText(loose("3 of 3 picked"));
    expect((await fromPageData(page, /"id":"([^"]+)","label":"D26-03909 A1","location":"([^"]+)"/, "the D26-03909 A1 block"))[2], "D26-03909 A1 stays in its slot").toBe("CAB-2/DR-1/BX-03/S-09");

    // A reconciliation of PJ-8841 sent with an old version is a conflict; the outcome stays unknown.
    await page.goto("/materials?tab=print&selected=PJ-8841");
    const job = await fromPageData(page, /"id":"(pj_[a-z0-9_]+)","displayId":"PJ-8841"[^{}]*?"version":(\d+)/, "print job PJ-8841");
    const stale = await sendCommand(page, "print.reconcile", { printJobId: job[1], expectedVersion: Number(job[2]) - 1, outcome: "printed_ok", note: "From an old tab." }, intentKey("j5-stale-reconcile"));
    expectRefused(stale, 409, "CONFLICT");
    await page.reload();
    await expect(page.getByRole("row", { name: /^PJ-8841 / }).getByRole("cell").nth(3)).toHaveText(/^Unknown outcome\s*Reconcile before reprint$/);
  });

  // Last in the journey on purpose: its final check shows an app defect (see the final report).
  test("unavailable dependency: with the slide printer offline a label job stays queued and prints nothing; an unknown outcome blocks a reprint; restoring the printer lets the queued job be released", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await openConsoleTab(page, "outages");
    const printers = page.getByRole("list", { name: "Simulated printers and their fault settings" });
    await printers.getByRole("button", { name: "Slide printer 1 (simulated): Offline" }).click();
    await expect(printers.getByRole("button", { name: "Slide printer 1 (simulated): Offline (current)" })).toHaveAttribute("aria-pressed", "true");

    await page.goto("/materials?tab=print");
    await expect(page.getByRole("status").filter({ hasText: "Slide printer 1 is unavailable (simulated)" })).toBeVisible();
    const queue = page.getByRole("button", { name: "Queue for later: D26-04750 A1-5 H&E deeper L1" });
    await expect(async () => {
      if (!(await queue.isVisible())) await page.getByText(/^Slide labels not yet printed/).click();
      await expect(queue).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await queue.click();
    const queuedToast = toasts(page).getByText(/^PJ-\d+ queued \(printer unavailable\)$/);
    await expect(queuedToast).toBeVisible();
    const pj = (await queuedToast.innerText()).match(/PJ-\d+/)![0];
    const row = page.getByRole("row", { name: new RegExp(`^${pj} `) });
    await expect(row.getByRole("cell").nth(3)).toHaveText(/^Queued\s*Prints only when released$/);
    await expect(row).toContainText(loose("Not submitted"));
    await page.goto(`/materials?tab=print&filter=attention&selected=${pj}`);
    const panel = page.getByRole("complementary", { name: "D26-04750 A1-5 H&E deeper L1" });
    await expect(panel).toContainText(loose(`Print job ${pj} Queued`));
    await expect(panel).toContainText(loose("No label is recorded as printed for this record."));
    await expect(panel.getByRole("button", { name: "Reprint with reason" })).toBeDisabled();

    // The unknown outcome on PJ-8841 blocks a reprint until someone reconciles it at the printer.
    await page.goto("/materials?tab=print&selected=PJ-8841");
    const unknown = page.getByRole("complementary", { name: "D26-04783 A1-5 H&E deeper L1" });
    await expect(unknown.getByRole("button", { name: "Reprint with reason" })).toBeDisabled();
    await expect(unknown).toContainText(loose("Reprint: Reconcile the unknown outcome first (check the printer)."));

    // Restored: the queued job is released once and prints.
    await openConsoleTab(page, "outages");
    await printers.getByRole("button", { name: "Slide printer 1 (simulated): Online" }).click();
    await expect(printers.getByRole("button", { name: "Slide printer 1 (simulated): Online (current)" })).toHaveAttribute("aria-pressed", "true");
    await page.goto(`/materials?tab=print&filter=attention&selected=${pj}`);
    await expect(page.getByRole("status").filter({ hasText: "Slide printer 1 is available (simulated). 1 job is still queued." })).toBeVisible();
    // Expected: with the printer back, the job panel no longer says the printer is unavailable.
    await expect(panel, "the queued job's panel after the printer is restored").not.toContainText(loose("Slide printer 1 is unavailable (simulated)."));
    await page.getByRole("button", { name: "Release queued jobs" }).click();
    await expect(toasts(page)).toContainText(loose("released to the printer (simulated)"));
    // This printer only acknowledges: the job is not shown as printed until someone records the label in hand.
    await expect(row.getByRole("cell").nth(3)).toHaveText(/^Printer acknowledged\s*Output not recorded$/);
    await expect(panel).toContainText(loose(`${pj}: the printer acknowledged the job (simulated) but does not report completion.`));
    await expect(page.getByRole("row", { name: /D26-04750 A1-5 H&E/ })).toHaveCount(1);
  });
});

// =====================================================================================================================
// Journey 6: worklist and exceptions, Priya Shah (histotech) on the Operations view. Seeded: PAS work on several cases
// (D26-04741 among them), hold H-0089 on D26-04804 Part B (gross approval only, owner Dana Whitfield), operator
// reviewed gross records on D26-04796 B and D26-04797 A/B that Dana approves in another window (the colleague's
// change), prior-day D26-04745 approved but not yet entered (no entry task: owner unassigned), and D26-04801 with no
// gross record yet (block count unknown).
// =====================================================================================================================
test.describe("journey 6: worklist and exceptions (Priya, histotech)", () => {
  test.describe.configure({ mode: "serial" });
  resetBeforeJourney();

  const grid = (page: Page) => page.getByRole("table", { name: /^Worklist, / });
  const caseRow = (page: Page, accession: string) => grid(page).getByRole("row", { name: new RegExp(`^${accession},`) });
  const changeLine = (page: Page) => page.getByRole("region", { name: "Changes since your last acknowledgment" });
  const CHANGED = "Changed since your last acknowledgment";

  async function openWorklist(page: Page, view: "operations" | "histotech" | "grossing", query = "") {
    await page.goto(`/worklist?view=${view}${query}`);
    await expect(page.getByRole("heading", { level: 1, name: "Worklist" })).toBeVisible();
    await expect(changeLine(page)).toBeVisible();
    await whenInteractive(changeLine(page).getByRole("button", { name: /^Acknowledge/ }));
  }

  /** The worklist version this copy shows ("Version v66, read at …"). */
  async function shownVersion(page: Page): Promise<number> {
    return Number((await changeLine(page).getByText(/^Version v\d+, read at/).innerText()).match(/v(\d+)/)![1]);
  }

  /** Press Acknowledge and confirm it; the confirmation says the scope (this person, this view). */
  async function acknowledge(page: Page, version: number) {
    await changeLine(page).getByRole("button", { name: `Acknowledge (records v${version})` }).click();
    const confirm = page.getByRole("alertdialog", { name: `Acknowledge changes up to v${version}?` });
    await expect(confirm).toContainText(loose("Other people and your other views are not affected."));
    await confirm.getByRole("button", { name: "Acknowledge changes" }).click();
    return confirm;
  }

  /** A colleague (Dana Whitfield, grosser) approves an operator-reviewed gross record on the Gross screen, in her own window. */
  async function colleagueApproves(browser: import("@playwright/test").Browser, partParam: string, part: string) {
    const dana = await openRoleContext(browser, STAFF.dana);
    extraContexts.push(dana);
    const gross = await dana.newPage();
    await gross.goto(`/grossing?part=${partParam}`);
    await gross.getByRole("region", { name: `Next step for ${part}` }).getByRole("button", { name: "Approve for downstream use" }).click();
    await expect(gross.getByRole("heading", { name: `${part} approved for downstream use` })).toBeVisible();
    await dana.close();
  }

  test("normal path: PAS only shows PAS work; On hold lists the hold with its owner and exact scope; acknowledging clears the change tags for this user and this view only", async ({ page, context, browser }) => {
    await actAs(context, STAFF.priya);
    await openWorklist(page, "operations");
    const total = (await changeLine(page).getByText(/^Showing \d+ of \d+ in this view$/).innerText()).match(/of (\d+)/)![1];

    // PAS only: every row listed carries the PAS tag, and a case without PAS is not listed.
    await page.getByRole("toolbar", { name: "Find and filter the worklist" }).getByRole("button", { name: "PAS only" }).click();
    await expect(page).toHaveURL(/[?&]pas=1/);
    const rows = grid(page).getByRole("row", { name: /^D26-\d{5},/ });
    await expect(rows.first()).toBeVisible();
    for (const name of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""))) expect(name).toMatch(/PAS/);
    await expect(caseRow(page, "D26-04741")).toBeVisible();
    await expect(caseRow(page, "D26-04741").getByRole("cell").nth(2)).toContainText(loose("PAS (WO-2141)"));
    await expect(caseRow(page, "D26-04746")).toHaveCount(0);
    await expect(changeLine(page).getByText(/^Showing \d+ of \d+ in this view$/)).not.toHaveText(`Showing ${total} of ${total} in this view`);

    // On hold: the one held case, with the hold's exact scope (Part B, gross approval only) and its owner.
    await openWorklist(page, "operations", "&hold=1");
    await expect(changeLine(page)).toContainText(loose(`Showing 1 of ${total} in this view`));
    const held = caseRow(page, "D26-04804");
    await expect(held).toHaveAccessibleName(/on hold: D26-04804 part B$/);
    await expect(held.getByRole("cell").nth(1)).toHaveText("A awaiting gross · B on hold (gross approval) · C awaiting gross");
    await expect(held.getByRole("cell").nth(3)).toHaveText("Hold: Part B (gross approval)");
    await expect(held.getByRole("cell").nth(7)).toHaveText("Dana Whitfield");

    // A colleague's change tags the case; acknowledging clears it for Priya on this view only.
    await colleagueApproves(browser, "D26-04796-B", "D26-04796 Part B");
    await openWorklist(page, "operations");
    await expect(caseRow(page, "D26-04796").getByRole("cell").first()).toContainText(loose(CHANGED));
    await expect(changeLine(page)).toContainText(loose("0 new, 1 changed, 0 canceled."));
    const version = await shownVersion(page);
    await acknowledge(page, version);
    await expect(changeLine(page)).toContainText(loose(`Nothing to acknowledge since`));
    await expect(changeLine(page)).toContainText(loose(`(v${version})`));
    await expect(caseRow(page, "D26-04796").getByRole("cell").first()).not.toContainText(loose(CHANGED));
    await page.reload();
    await expect(caseRow(page, "D26-04796").getByRole("cell").first()).not.toContainText(loose(CHANGED));
    // The same person's other view keeps its own acknowledgment ...
    await openWorklist(page, "histotech");
    await expect(caseRow(page, "D26-04796").getByRole("cell").first()).toContainText(loose(CHANGED));
    // ... and so does a colleague on the same view.
    const tanya = await openRoleContext(browser, STAFF.tanya);
    extraContexts.push(tanya);
    const other = await tanya.newPage();
    await openWorklist(other, "operations");
    await expect(caseRow(other, "D26-04796").getByRole("cell").first()).toContainText(loose(CHANGED));
  });

  test("missing information: a case with no gross record shows its block count as unknown, never 0; approved work with no entry task names the role it waits for, never a blank owner", async ({ page, context }) => {
    await actAs(context, STAFF.sam);
    await openWorklist(page, "grossing");
    const headers = (await grid(page).getByRole("columnheader").allInnerTexts()).map((h) => h.trim());
    const column = (name: string) => {
      const i = headers.indexOf(name);
      expect(i, `worklist column ${name} (columns: ${headers.join(", ")})`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const noRecord = caseRow(page, "D26-04801");
    await expect(noRecord.getByRole("cell").nth(column("Blocks"))).toHaveText("Unknown (no gross record yet)");
    await expect(noRecord).not.toContainText(/(?<!\d)0 of \d/);
    const unowned = caseRow(page, "D26-04745");
    await expect(unowned.getByRole("cell").nth(column("Source entry"))).toHaveText("Entry pending: A");
    await expect(unowned.getByRole("cell").nth(column("Owner"))).toHaveText("Unassigned (histology assistant)");
  });

  test("failed mutation: an acknowledgment that never reaches the server says so, and the change tags stay", async ({ page, context, browser }) => {
    await actAs(context, STAFF.priya);
    await colleagueApproves(browser, "D26-04797-A", "D26-04797 Part A");
    await openWorklist(page, "operations");
    const row = caseRow(page, "D26-04797");
    await expect(row.getByRole("cell").first()).toContainText(loose(CHANGED));
    const version = await shownVersion(page);
    await page.route("**/api/commands/worklist.ack", (route) => route.abort("internetdisconnected"));
    const confirm = await acknowledge(page, version);
    await expect(page.getByRole("alert").filter({ hasText: loose("Could not reach the local server") }).first()).toBeVisible();
    if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Keep reviewing" }).click();
    await expect(row.getByRole("cell").first()).toContainText(loose(CHANGED));
    await page.unroute("**/api/commands/worklist.ack");
    await page.reload();
    await expect(row.getByRole("cell").first()).toContainText(loose(CHANGED));
    await expect(changeLine(page).getByRole("button", { name: `Acknowledge (records v${version})` })).toBeEnabled();
  });

  test("repeated request: one acknowledgment sent twice with one key is recorded once; another version or another demo role with that key is refused", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await openWorklist(page, "operations");
    const version = await shownVersion(page);
    const input = { view: "operations", seq: version };
    const key = intentKey("j6-ack");
    const first = await sendCommand(page, "worklist.ack", input, key);
    expect(first.body.result).toMatchObject({ view: "operations", ackedSeq: version, unchanged: false });
    await expectKeyIsScoped(page, context, {
      name: "worklist.ack",
      input,
      changedInput: { ...input, seq: version - 1 },
      key,
      first,
      owner: STAFF.priya,
      otherRole: STAFF.tanya,
    });
    await page.reload();
    await expect(caseRow(page, "D26-04797").getByRole("cell").first()).not.toContainText(loose(CHANGED));
    await expect(changeLine(page)).toContainText(loose(`(v${version})`));
    // Tanya's own acknowledgment was not touched by the refused reuse of Priya's key.
    await actAs(context, STAFF.tanya);
    await openWorklist(page, "operations");
    await expect(caseRow(page, "D26-04797").getByRole("cell").first()).toContainText(loose(CHANGED));
    await actAs(context, STAFF.priya);
  });

  test("stale state: an open worklist picks up a colleague's change without a reload; a snapshot from the version it showed before is refused with 409 CONFLICT", async ({ page, context, browser }) => {
    await actAs(context, STAFF.priya);
    await openWorklist(page, "operations");
    const before = await shownVersion(page);
    const row = caseRow(page, "D26-04797");
    await expect(row.getByRole("cell").first()).not.toContainText(loose(CHANGED));
    await page.evaluate(() => {
      (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
    });
    const url = page.url();

    await colleagueApproves(browser, "D26-04797-B", "D26-04797 Part B");
    // Live refresh: the open copy moves to the new version and tags the case, with no reload.
    await expect(row.getByRole("cell").first()).toContainText(loose(CHANGED));
    await expect.poll(() => shownVersion(page)).toBeGreaterThan(before);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), "the worklist window was not reloaded").toBe(true);

    // A snapshot of the version this tab showed before is refused: paper never mixes versions.
    const stale = await sendCommand(page, "worklist.snapshot", { view: "operations", filters: {}, format: "print", expectedSeq: before }, intentKey("j6-stale-snapshot"));
    expectRefused(stale, 409, "CONFLICT");
    expect(stale.body.error?.message).toContain(`you saw v${before}, the latest is v`);
  });

  test("unavailable dependency: with the source offline the open worklist says its data may be stale, the printed snapshot carries its generation time, version and stale data age, and restoring the source clears it", async ({ page, context }) => {
    await actAs(context, STAFF.priya);
    await page.addInitScript(() => {
      (window as unknown as { __prints: number }).__prints = 0;
      window.print = () => {
        (window as unknown as { __prints: number }).__prints += 1;
      };
    });
    await openWorklist(page, "operations");
    const staleBanner = page.getByRole("status").filter({ hasText: loose("EMA-SIM Sunrise Coast unreachable since") });
    await expect(staleBanner).toHaveCount(0);
    await setEmaFromConsole(context, "offline");
    await expect(staleBanner).toContainText(loose("Showing last confirmed data."));
    await expect(changeLine(page)).toContainText(/Simulated source as of \d{1,2}:\d{2}\s[AP]M ET: out of date/);
    await expect(page.getByRole("button", { name: /^Source freshness:/ })).toHaveAccessibleName(/^Source freshness: EMA-SIM offline since /);

    const version = await shownVersion(page);
    await page.getByRole("button", { name: "Print snapshot" }).click();
    const recorded = toasts(page).getByText(new RegExp(`^Snapshot (\\S+) recorded \\(v${version}\\)\\.$`));
    await expect(recorded).toBeVisible();
    const snapshotId = (await recorded.innerText()).match(/^Snapshot (\S+) recorded/)![1];
    await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByText(loose(`Worklist snapshot v${version}.`))).toBeVisible();
    await expect(page.getByText(loose("Generated Wed 2026-10-14 10:52 AM ET by Priya Shah. Not updated after printing."))).toBeVisible();
    await expect(page.getByText(loose(`Snapshot ${snapshotId} recorded.`))).toBeVisible();
    await expect(page.getByText(/^Source data as of Wed 2026-10-14 \d{1,2}:\d{2} AM ET\.\s*STALE\s*a simulated source system was unreachable or out of date when this was generated\.$/)).toBeVisible();
    await page.emulateMedia({ media: "screen" });

    await setEmaFromConsole(context, "connected");
    await expect(staleBanner).toHaveCount(0);
    await expect(changeLine(page)).not.toContainText(loose("out of date"));
  });
});
