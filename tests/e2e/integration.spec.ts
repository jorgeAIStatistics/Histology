// Stage 6, D5: the Integration screen (/integration) in the browser, fed by the integration SIMULATOR through the
// signed inbound endpoint (POST /api/integration/inbound, contract "hlos.source-message" 1.0). The simulator is the
// real one (src/server/integration/simulator.ts): its deterministic scenarios, signed with this run's random root
// secret (playwright.config.ts gives the same HLOS_INTEGRATION_SIM_SECRET to the web server and this worker), sent
// over HTTP to this test server only (its transport refuses any host but loopback, and never follows a redirect).
// Its synthetic world (the seed's orders it amends) is read, read only, from this run's database file.
//
// Covered, in order (one database for the file; each test builds on the ones before):
//   1. a normal order import appears (one line, accepted, nothing to review);
//   2. a duplicate shows once (delivered three times, applied once);
//   3. an amended order shows the difference and the work it touches (the container was checked against v1);
//   4. missing fields are shown as rejected, with the reason per field;
//   5. an identity conflict needs review, names its owner, and is never merged (Intake still shows the patient on file);
//   6. an out-of-order (older) version is shown as ignored, and the newer one stays;
//   7. a source outage shows "Unavailable" with the last successful sync, and nothing from it is applied;
//   8. recovery delivers the backlog once, and the screen clears;
//   9. the source's event time and the local received time are both shown, labelled apart, and differ;
//  10. Operations and the top bar's source-freshness popover link here with counts; axe (WCAG 2.x A/AA, 2.2 AA) at
//      1366 and 1024 wide, with no horizontal overflow.
// Synthetic data only; nothing here contacts anything but the local test server.
import AxeBuilder from "@axe-core/playwright";
import Database from "better-sqlite3";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { STAFF, actAs, loose, resetDemo, type StaffId } from "./support";
import {
  SimSourceState,
  httpTransport,
  runScenario,
  worldFromDb,
  type OutageControl,
  type ScenarioName,
  type ScenarioReport,
  type SimWorld,
} from "../../src/server/integration/simulator";
import { labLocalToIso } from "../../src/lib/time";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.use({ reducedMotion: "reduce" });

/** A command as a demo role, the way the screen sends it (the demo role cookie stands in for the role switch). */
async function command(request: APIRequestContext, actor: StaffId, name: string, input: unknown): Promise<void> {
  const res = await request.post(`/api/commands/${name}`, {
    headers: { Cookie: `hlos_actor=${actor}` },
    data: { input, idempotencyKey: `e2e-integration-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const body = (await res.json()) as { ok: boolean; error?: { message: string } };
  expect(body.ok, `${name} failed: ${body.error?.message}`).toBe(true);
}

// ---------------------------------------------------------------- the simulator, over HTTP to this server

const ROOT_SECRET = process.env.HLOS_INTEGRATION_SIM_SECRET ?? "";
let world: SimWorld;
/** The simulated source's own memory (its outbox) across the outage and recovery tests. */
const sourceState = new SimSourceState();

/** No scenario but the outage ones may touch the source's link. */
const NO_OUTAGE: OutageControl = {
  description: "not used",
  begin: async () => {
    throw new Error("this scenario has no outage");
  },
  end: async () => {},
};

/**
 * Run one simulator scenario against this server and require every step to get the answer the scenario expects.
 * Short backoff (the policy itself is unit-tested); the per-request timeout stays generous.
 */
async function simulate(baseURL: string, name: ScenarioName, outage: OutageControl = NO_OUTAGE): Promise<ScenarioReport> {
  expect(ROOT_SECRET, "HLOS_INTEGRATION_SIM_SECRET is set for this worker by playwright.config.ts").toMatch(/^[A-Za-z0-9_-]{32,256}$/);
  const lines: string[] = [];
  const report = await runScenario(name, {
    transport: httpTransport(baseURL),
    rootSecret: ROOT_SECRET,
    world,
    outage,
    policy: { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 50, timeoutMs: 15_000 },
    state: sourceState,
    log: (l) => lines.push(l),
  });
  expect(report.ok, `scenario ${name}:\n${lines.join("\n")}`).toBe(true);
  return report;
}

// ---------------------------------------------------------------- the screen

async function openIntegration(page: Page, actor: StaffId = STAFF.tanya, url = "/integration"): Promise<void> {
  await actAs(page.context(), actor);
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: "Integration" })).toBeVisible();
}

function group(page: Page, name: "Needs review" | "Waiting on the source" | "Failed and retryable" | "Informational"): Locator {
  return page.getByRole("region", { name: new RegExp(`^${name} \\(\\d+\\)$`) });
}

/** One comparison row (an article named by its heading). */
function row(scope: Locator, heading: string | RegExp): Locator {
  return scope.getByRole("article", { name: typeof heading === "string" ? new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`) : heading });
}

/** The value next to a label in a row's or a source's facts ("The source says", "Recorded here", "Difference", "Who", …). */
function fact(scope: Locator, label: string): Locator {
  return scope.locator(`xpath=.//dt[normalize-space()="${label}"]/following-sibling::dd[1]`);
}

function messages(page: Page): Locator {
  return page.getByRole("list", { name: "Recent messages" }).getByRole("listitem");
}

function source(page: Page, name: "EMA-SIM Sunrise Coast" | "OTHER-EHR-SIM Gulf"): Locator {
  return page.getByRole("region", { name: "Sources" }).getByRole("article", { name });
}

/** "Latest 10 of 103" → 103: every message recorded (one per message id), whatever is shown. */
async function messageTotal(page: Page): Promise<number> {
  const text = (await page.getByText(/^(Latest \d+ of \d+|All \d+), newest first/).textContent()) ?? "";
  const m = /of (\d+)|All (\d+)/.exec(text);
  return Number(m?.[1] ?? m?.[2]);
}

/** The counts in the screen's focal sentence (0 when a group is not named). */
async function focalCounts(page: Page): Promise<{ review: number; waiting: number; failed: number }> {
  const text = (await page.getByRole("region", { name: "What needs doing" }).innerText()).replace(/\s+/g, " ");
  const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
  return { review: n(/(\d+) needs? review/), waiting: n(/(\d+) waiting on the source/), failed: n(/(\d+) failed and retryable/) };
}

async function expectNoAxeViolations(page: Page, where: string): Promise<void> {
  // The same check as tests/e2e/accessibility.spec.ts: WCAG 2.0/2.1 A and AA and WCAG 2.2 AA, no rule disabled.
  await expect(page, `${where}: the page has its title`).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const found = results.violations.map((v) => `${v.id} [${v.impact}] ${v.help}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(found, `axe violations on ${where}`).toEqual([]);
  expect(results.passes.length, `axe rules that passed on ${where}`).toBeGreaterThan(10);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// =====================================================================================================================

test.describe("the Integration screen, fed by the signed simulator", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await resetDemo(request);
    // World event: the 11:00 courier arrives and its bag is unpacked (simulated), as in the guided demo's step 1.
    await command(request, STAFF.maya, "demo.runStep", { step: 1 });
    await request.dispose();
    // The simulator's synthetic world: the seed's orders it amends, read only from this run's database.
    const file = process.env.E2E_DB;
    expect(file, "E2E_DB is set by playwright.config.ts").toBeTruthy();
    const db = new Database(file!, { readonly: true, fileMustExist: true });
    try {
      world = worldFromDb(db);
    } finally {
      db.close();
    }
    expect(world.amendable.order_id).toBe("ORD-77150");
  });

  test.afterAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await resetDemo(request);
    await request.dispose();
  });

  test("the signed endpoint answers only this run's simulator; the screen opens for a bench role with honest labels", async ({ page, request, baseURL }) => {
    // Unsigned: refused before anything is read, and nothing is recorded.
    const unsigned = await request.post("/api/integration/inbound", { data: { contract: "hlos.source-message" } });
    expect(unsigned.status()).toBe(401);
    expect((await request.get("/api/integration/inbound")).status()).toBe(404);

    await openIntegration(page);
    await expect(page.getByRole("main").getByText("Simulated: source systems")).toBeVisible();
    await expect(source(page, "EMA-SIM Sunrise Coast")).toContainText(loose("Simulated source system: orders and accession numbers"));
    for (const g of ["Needs review", "Waiting on the source", "Failed and retryable", "Informational"] as const) await expect(group(page, g)).toBeVisible();
    // The action groups come first, in this order; informational last.
    const headings = await page.getByRole("main").getByRole("heading", { level: 2 }).allInnerTexts();
    expect(headings.filter((h) => /\(\d+\)$/.test(h)).map((h) => h.replace(/ \(\d+\)$/, ""))).toEqual(["Needs review", "Waiting on the source", "Failed and retryable", "Informational"]);
    expect(baseURL).toMatch(/^http:\/\/localhost:\d+$/);
  });

  test("1. a normal order import appears: one line, accepted and applied, nothing to review", async ({ page, baseURL }) => {
    await openIntegration(page);
    const before = await focalCounts(page);
    const total = await messageTotal(page);

    await simulate(baseURL!, "new-order");
    await page.reload();
    const item = messages(page).filter({ hasText: "sim/new-order/SIM-90101#v1" });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(loose("Order SIM-90101 v1"));
    await expect(item).toContainText(loose("Accepted and applied"));
    await expect(item).toContainText(loose("New order SIM-90101 v1 imported"));
    expect(await messageTotal(page)).toBe(total + 1);
    // Nothing for a person: the counts did not move, and the order is in no action group.
    expect(await focalCounts(page)).toEqual(before);
    for (const g of ["Needs review", "Waiting on the source", "Failed and retryable"] as const) await expect(group(page, g)).not.toContainText("SIM-90101");

    // The message as received, behind a disclosure, shown as data (text, not markup).
    const raw = item.locator("pre");
    await expect(raw).toBeHidden();
    await item.getByText("Message as received (raw data)").click();
    await expect(raw).toBeVisible();
    await expect(raw).toContainText('"order_id": "SIM-90101"');
    await expect(raw).toContainText('"name": "Quill, Juniper"');
    // Text only: no element inside (React escapes it; nothing in a message is ever rendered as markup or a link).
    expect(await raw.evaluate((el) => el.children.length)).toBe(0);
  });

  test("2. a duplicate shows once: one line, delivered three times, applied once", async ({ page, baseURL }) => {
    const report = await simulate(baseURL!, "duplicate");
    expect(report.steps.map((s) => s.result)).toEqual(["accepted", "duplicate", "duplicate"]);
    await openIntegration(page);
    const item = messages(page).filter({ hasText: "SIM-90501" });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(loose("Accepted and applied"));
    await expect(item).toContainText(loose("Delivered 3 times, applied once"));
    // Shown once on the whole screen (the visible text; the closed raw-message disclosure is not shown).
    expect((await page.getByRole("main").innerText()).split("sim/duplicate/SIM-90501#v1").length - 1).toBe(1);
  });

  test("3. an amended order shows the difference and the work it touches", async ({ page, baseURL }) => {
    // Maya checks the ORD-77150 bottle (INT-1014-029) against the order as it is now (v1).
    await actAs(page.context(), STAFF.maya);
    await page.goto("/intake?item=INT-1014-029");
    const decision = page.getByRole("complementary", { name: "Decision" });
    await decision.getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77150 Staff verified$/ })).toBeVisible();

    // Then the source amends ORD-77150: v2 changes part A's site.
    await simulate(baseURL!, "amended-order");
    await openIntegration(page);
    const amended = row(group(page, "Needs review"), "Site, laterality and procedure: ORD-77150 part A");
    await expect(amended).toHaveCount(1);
    await expect(amended).toContainText("Review open");
    await expect(fact(amended, "The source says")).toHaveText(loose("Part A: Left temple (lateral aspect) · Left · shave"));
    await expect(fact(amended, "Recorded here")).toContainText(loose("As checked (v1): Part A: Left temple · Left · shave."));
    await expect(fact(amended, "Difference")).toContainText(loose("Changed at source after the check: site Left temple → Left temple (lateral aspect)."));
    await expect(fact(amended, "Difference")).toContainText(loose("Container 1 was checked against v1; the source is now at v2."));
    // Who must review it, and the work it touches, linked.
    await expect(fact(amended, "Who")).toHaveText("Kim Nguyen (Accessioning lead)");
    await expect(fact(amended, "Record")).toContainText(loose("Order changed after receipt — re-check INT-1014-029 part A against ORD-77150 v2"));
    const intake = amended.getByRole("link", { name: /^Intake INT-1014-029/ });
    await expect(intake).toHaveAttribute("href", "/intake?item=INT-1014-029");
    await intake.click();
    await expect(page).toHaveURL(/\/intake\?item=INT-1014-029$/);
    // Intake already says it: the order changed after the check, so the bottle is checked again.
    await expect(page.getByRole("main")).toContainText(loose("Check container 1 again: ORD-77150 changed after the last check (v1 → v2)"));
  });

  test("4. missing fields are shown as rejected, with the reason per field; nothing was applied", async ({ page, baseURL }) => {
    const report = await simulate(baseURL!, "missing-data");
    expect(report.steps[0].httpStatus).toBe(400);
    expect(report.steps[0].errors.map((e) => `${e.path}:${e.code}`)).toEqual(["payload.patient.birth_date:required", "payload.specimens.0.site:required"]);
    await openIntegration(page);
    const rejected = row(group(page, "Failed and retryable"), "Rejected: missing or invalid data: SIM-90701 v1");
    await expect(rejected).toHaveCount(1);
    await expect(rejected).toContainText(loose("Rejected"));
    await expect(fact(rejected, "Difference")).toHaveText(loose("Rejected: patient.birth_date is missing; specimens.0.site is missing. Nothing was applied."));
    await expect(fact(rejected, "Recorded here")).toContainText(loose("Not applied; kept in the failure queue (1 delivery)"));
    await expect(fact(rejected, "Next")).toContainText(loose("the source must re-send corrected data under the same message id"));
    // Retrying the same invalid data could only fail again: no retry button on this row.
    await expect(rejected.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
    // It is not in the recent (applied) messages, and no order SIM-90701 exists anywhere on the screen but this row.
    await expect(messages(page).filter({ hasText: "SIM-90701" })).toHaveCount(0);
  });

  test("5. an identity conflict needs review, names its owner, and is never merged", async ({ page, baseURL }) => {
    const report = await simulate(baseURL!, "conflicting-identifiers");
    expect(report.steps.map((s) => s.result)).toEqual(["conflict_review", "conflict_review"]);
    await openIntegration(page);
    const review = group(page, "Needs review");

    // A new order names the MRN on file (Lee Marten, 100234) with another name and date of birth.
    const patient = row(review, "Source conflict: MRN 100234, patient on file");
    await expect(patient).toHaveCount(1);
    await expect(patient).toContainText(loose("Patient identity: review open"));
    await expect(fact(patient, "The source says")).toHaveText(loose("Order SIM-90601 v1: MRN 100234 · Fairbrook, Wren · born 1944-01-01"));
    await expect(fact(patient, "Recorded here")).toHaveText(loose("MRN 100234 · Marten, Lee · born 1949-08-25 (kept as it is)"));
    await expect(fact(patient, "Difference")).toHaveText(
      loose("Name Marten, Lee → Fairbrook, Wren; date of birth 1949-08-25 → 1944-01-01. The order was linked to the patient on file by MRN; nothing was merged or overwritten."),
    );
    await expect(fact(patient, "Who")).toHaveText("Kim Nguyen (Accessioning lead)");
    await expect(patient.getByText("A person must review")).toBeVisible();

    // An issued order re-sent under another MRN: the patient on file stays; the case is linked.
    const issued = row(review, `Patient details: ${world.accessioned.order_id} v${world.accessioned.version + 1}`);
    await expect(issued).toHaveCount(1);
    await expect(issued).toContainText(loose("Patient identity: review open"));
    await expect(fact(issued, "Difference")).toContainText(loose("nothing was merged"));
    await expect(issued.getByRole("link", { name: /^Case D26-\d{5} part A/ })).toHaveCount(1);
    // Identity first: both identity rows lead the group.
    const firstTwo = (await review.getByRole("article").allInnerTexts()).slice(0, 2).join("\n");
    expect(firstTwo).toContain("MRN 100234, patient on file");
    expect(firstTwo).toContain(world.accessioned.order_id);

    // Never merged: Intake still shows the patient on file, and its existing source-conflict review.
    await actAs(page.context(), STAFF.kim);
    await patient.getByRole("link", { name: /^Intake INT-1014-029/ }).click();
    await expect(page).toHaveURL(/\/intake\?item=INT-1014-029$/);
    const identity = page.getByRole("region", { name: "Current case" });
    await expect(identity).toContainText("Marten, Lee");
    await expect(identity).toContainText(loose("DOB 1949-08-25"));
    await expect(identity).not.toContainText("Fairbrook");
    await expect(identity).not.toContainText("1944-01-01");
    const queueRow = page.getByRole("region", { name: /^Exceptions/ }).getByRole("link", { name: /^Provisional intake item INT-1014-029/ });
    await expect(queueRow).toContainText("Source conflict");
    await expect(page.getByRole("complementary", { name: "Decision" })).toContainText(loose("Accession waits for this review; nothing is merged or changed."));
  });

  test("6. an out-of-order (older) version is shown as ignored; the newer version stays", async ({ page, baseURL }) => {
    const report = await simulate(baseURL!, "out-of-order");
    expect(report.steps.map((s) => s.result)).toEqual(["accepted", "accepted", "stale"]);
    await openIntegration(page);
    const late = row(group(page, "Informational"), "Older version received late: SIM-90801 v2");
    await expect(late).toHaveCount(1);
    await expect(late).toContainText(loose("Ignored, not applied"));
    await expect(fact(late, "The source says")).toHaveText(loose("Amended order SIM-90801 v2, sent after a newer version"));
    await expect(fact(late, "Recorded here")).toHaveText("Stored v3 kept");
    await expect(fact(late, "Difference")).toHaveText(loose("An older version arrived after a newer one; it was not applied."));
    for (const g of ["Needs review", "Waiting on the source", "Failed and retryable"] as const) await expect(group(page, g)).not.toContainText("SIM-90801");
    // The applied versions are v1 and v3; v2 is only in its "ignored" row.
    await expect(messages(page).filter({ hasText: "sim/out-of-order/SIM-90801#v3" })).toContainText(loose("Accepted and applied"));
    await expect(messages(page).filter({ hasText: "sim/out-of-order/SIM-90801#v2" })).toHaveCount(0);
  });

  test("7. a source outage shows Unavailable with the last successful sync, and nothing from it is applied", async ({ page, request, baseURL }) => {
    await openIntegration(page);
    const ema = source(page, "EMA-SIM Sunrise Coast");
    await expect(fact(ema, "Last successful sync")).toHaveText("11:00 AM ET");
    const total = await messageTotal(page);
    const before = await focalCounts(page);

    // The source becomes unreachable here (the presenter's outage control), then the demo clock passes 11:20: two
    // messages the simulated source holds fall due, and the source keeps them.
    const outage: OutageControl = {
      description: "EMA-SIM set offline with the presenter control",
      begin: async () => command(request, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" }),
      // Still down when this scenario ends (the recovery test restores it).
      end: async () => {},
    };
    await command(request, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });
    await command(request, STAFF.tanya, "demo.setClock", { iso: labLocalToIso(world.day, "11:20") });
    // The simulator sends two new orders meanwhile: each is answered 503 (nothing recorded) and stays in its outbox.
    const report = await simulate(baseURL!, "source-outage", outage);
    expect(report.steps.map((s) => s.httpStatus)).toEqual([503, 503]);
    expect(report.backlog).toEqual(["sim/outage/SIM-91001#v1", "sim/outage/SIM-91002#v1"]);

    await page.reload();
    await expect(ema).toContainText("Unavailable");
    await expect(fact(ema, "Last successful sync")).toHaveText("11:00 AM ET");
    await expect(fact(ema, "Last error")).toHaveText("Not reachable (simulated outage).");
    await expect(fact(ema, "Messages waiting")).toHaveText(loose("2 at the source, not yet delivered here"));
    await expect(ema).toContainText(loose("Nothing from it is applied until it is back"));
    const waiting = row(group(page, "Waiting on the source"), "Source unavailable: EMA-SIM Sunrise Coast");
    await expect(waiting).toHaveCount(1);
    await expect(fact(waiting, "Recorded here")).toHaveText(loose("2 messages waiting at the source; nothing from them has been applied here."));
    await expect(fact(waiting, "Last successful sync")).toHaveText("11:00 AM ET");
    // Nothing done: no message was recorded, no order created, nothing new to review.
    expect(await messageTotal(page)).toBe(total);
    await expect(page.getByRole("main")).not.toContainText("SIM-91001");
    await expect(page.getByRole("main")).not.toContainText("SIM-91002");
    expect(await focalCounts(page)).toEqual({ ...before, waiting: before.waiting + 1 });
    // The top bar says it too.
    await expect(page.getByRole("button", { name: /^Source freshness:/ })).toHaveAccessibleName(/^Source freshness: EMA-SIM offline since /);
  });

  test("8. recovery delivers the backlog once, and the screen clears", async ({ page, request, baseURL }) => {
    await openIntegration(page);
    const total = await messageTotal(page);
    const restore: OutageControl = {
      description: "EMA-SIM restored with the presenter control (its own held messages are delivered once)",
      begin: async () => {
        throw new Error("the outage began in the previous test");
      },
      end: async () => command(request, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "connected" }),
    };
    const report = await simulate(baseURL!, "recovery", restore);
    // The simulator's backlog: each delivered once, then re-sent once more and ignored as a duplicate.
    expect(report.steps.map((s) => `${s.messageId}:${s.result}`)).toEqual([
      "sim/outage/SIM-91001#v1:accepted",
      "sim/outage/SIM-91002#v1:accepted",
      "sim/outage/SIM-91001#v1:duplicate",
      "sim/outage/SIM-91002#v1:duplicate",
    ]);
    expect(report.backlog).toEqual([]);

    await page.reload();
    const ema = source(page, "EMA-SIM Sunrise Coast");
    await expect(ema).toContainText("Connected");
    await expect(ema).not.toContainText("Unavailable");
    await expect(fact(ema, "Messages waiting")).toHaveText(loose("0 at the source, not yet delivered here"));
    await expect(fact(ema, "Last error")).toHaveText("None recorded");
    await expect(fact(ema, "Last successful sync")).toHaveText("11:20 AM ET");
    // The screen clears: nothing waits on the source any more.
    await expect(group(page, "Waiting on the source")).toHaveAccessibleName("Waiting on the source (0)");
    await expect(group(page, "Waiting on the source")).toContainText("Nothing is waiting on a source.");
    // Exactly once: the two simulator orders and the source's held amendment are new; its held re-send is a duplicate.
    expect(await messageTotal(page)).toBe(total + 3);
    for (const id of ["sim/outage/SIM-91001#v1", "sim/outage/SIM-91002#v1"]) {
      const item = messages(page).filter({ hasText: id });
      await expect(item).toHaveCount(1);
      await expect(item).toContainText(loose("Delivered 2 times, applied once"));
    }
    await expect(messages(page).filter({ hasText: "ORD-75061#v2" })).toHaveCount(1);
    await expect(messages(page).filter({ hasText: "ORD-77118#v1" })).toContainText(loose("Delivered 2 times, applied once"));
    await expect(page.getByRole("button", { name: /^Source freshness:/ })).toHaveAccessibleName(/^Source freshness: Synced /);
  });

  test("9. the source's event time and the time received here are both shown, labelled apart, and differ", async ({ page }) => {
    await openIntegration(page);
    const amended = row(group(page, "Needs review"), "Site, laterality and procedure: ORD-77150 part A");
    const sent = amended.locator('xpath=.//dt[normalize-space()="Source says sent"]/following-sibling::dd[1]//time');
    const received = amended.locator('xpath=.//dt[normalize-space()="Received here"]/following-sibling::dd[1]//time');
    await expect(sent).toHaveText("10:40 AM ET");
    await expect(received).toHaveText("11:00 AM ET");
    await expect(sent).toHaveAttribute("datetime", labLocalToIso(world.day, "10:40"));
    await expect(received).toHaveAttribute("datetime", labLocalToIso(world.day, "11:00"));
    // The same pair on a received message: the source's claimed time (10:31) is not the local receipt time (11:00).
    // SIM-90101 is older than the latest ten by now: every message is one link away.
    await expect(messages(page).filter({ hasText: "sim/new-order/SIM-90101#v1" })).toHaveCount(0);
    await page.getByRole("link", { name: /^Show all \d+ messages$/ }).click();
    await expect(page).toHaveURL(/\/integration\?messages=all#recent-messages-title$/);
    const item = messages(page).filter({ hasText: "sim/new-order/SIM-90101#v1" });
    await expect(item).toHaveCount(1);
    await expect(item.locator('xpath=.//dt[normalize-space()="Source says sent"]/following-sibling::dd[1]')).toHaveText("10:31 AM ET");
    await expect(item.locator('xpath=.//dt[normalize-space()="Received here"]/following-sibling::dd[1]')).toHaveText("11:00 AM ET");
  });

  test("10. Operations and the source-freshness popover link here with counts; axe at 1366 and 1024 with no horizontal overflow", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await openIntegration(page);
    const counts = await focalCounts(page);
    const linkName = new RegExp(`^Integration: ${counts.review} needs? review, ${counts.waiting} waiting on the source, ${counts.failed} failed$`);

    // Operations, the Integration category: a link with the same counts.
    await page.goto("/operations?category=integration#blocked");
    const blocked = page.getByRole("region", { name: "Blocked now" });
    await expect(blocked.getByRole("link", { name: linkName })).toHaveAttribute("href", "/integration");
    // And beside source freshness, on every Operations view.
    await page.goto("/operations");
    const freshness = page.getByRole("complementary", { name: "Owners and sources" }).getByRole("region", { name: "Source freshness" });
    await freshness.getByRole("link", { name: linkName }).click();
    await expect(page).toHaveURL(/\/integration$/);

    // The top bar's source-freshness popover.
    await page.getByRole("button", { name: /^Source freshness:/ }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Open Integration: source messages and reviews" }).click();
    await expect(page).toHaveURL(/\/integration$/);
    await expect(page.getByRole("heading", { level: 1, name: "Integration" })).toBeVisible();

    // axe, with every group populated and one raw message open, at the bench size and at the tablet size.
    for (const size of [
      { width: 1366, height: 768 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/integration");
      await expect(page.getByRole("heading", { level: 1, name: "Integration" })).toBeVisible();
      await expectNoAxeViolations(page, `/integration at ${size.width}`);
      expect(await horizontalOverflow(page), `horizontal overflow at ${size.width}`).toBeLessThanOrEqual(0);
      const rejected = row(group(page, "Failed and retryable"), "Rejected: missing or invalid data: SIM-90701 v1");
      await rejected.getByText("Message as received (raw data)").click();
      await expect(rejected.locator("pre")).toBeVisible();
      await expectNoAxeViolations(page, `/integration at ${size.width} with a raw message open`);
      expect(await horizontalOverflow(page), `horizontal overflow at ${size.width} with a raw message open`).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
  });
});
