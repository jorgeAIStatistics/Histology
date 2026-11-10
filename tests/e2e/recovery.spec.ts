// Stage 6 Phase E3: error recovery on the real screens (demo config). Nothing is shown as done unless the server
// confirmed it, and nothing is recorded twice when an answer is lost.
//
//   1. A reload in the middle of work (a typed decision reason; a typed gross field): nothing is recorded, the screen
//      after the reload shows the server's state, and the typed draft does NOT survive the reload. There is no draft
//      storage in this application; the browser asks before leaving a form with unsaved edits (beforeunload), and
//      that is all. Nothing here invents a draft feature.
//   2. An interrupted request: the command reaches the server, which records it, and the connection drops before the
//      answer (Playwright fetches the real answer, then aborts the browser's request). The screen says it could not
//      reach the server (NETWORK), never success. Pressing again sends the SAME idempotency key: the server replays
//      its stored result, and the database shows one request, one audit event and one receipt.
//   3. A proxy's 502 page instead of the answer: "The server did not confirm this action" (UNCONFIRMED), never
//      success; nothing was recorded (the request never reached the server); pressing again sends the same key and
//      records it once.
//   4. The answer is lost, the person closes the dialog, leaves the tab and comes back (client-side navigation, the
//      same document), and enters the same request in the new, empty dialog: it carries the lost request's key and is
//      replayed. (Before Stage 6 E3 a new component meant a new key, and the request was recorded twice.)
//
// Covered elsewhere and not repeated: a request aborted BEFORE it reaches the server and a 500 text/plain answer
// (journeys.spec.ts "failed mutation"), stale versions (409), a repeated key, an expired session (the secured suite).
// Counts are read from this run's database file, read only (process.env.E2E_DB, set by playwright.config.ts).
// Synthetic data only; nothing here contacts anything but the local test server.
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { STAFF, actAs, loose, resetDemo, runSimulatorEvents, toasts } from "./support";

// ---------------------------------------------------------------- helpers

/** One read-only look at this run's database (opened and closed per call, so a demo reset never meets an open handle). */
function readDb<T>(fn: (db: Database.Database) => T): T {
  const file = process.env.E2E_DB;
  expect(file, "E2E_DB is set by playwright.config.ts").toBeTruthy();
  const db = new Database(path.resolve(file!), { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const count = (sql: string, ...params: unknown[]): number => readDb((db) => (db.prepare(sql).get(...params) as { n: number }).n);
/** Audit events recorded for a person (origin user). Background imports and world events are recorded with other origins. */
const userEvents = () => count("SELECT COUNT(*) n FROM audit_event WHERE origin = 'user'");

/** Wait until React has hydrated this element (its handlers are attached), so a click right after a load is not lost. */
async function whenInteractive(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { message: "the control is interactive" }).toBe(true);
}

/** Reload the page with a form holding unsaved edits: returns the kind of dialog the browser showed (accepted, so the reload goes ahead). */
async function reloadAcceptingLeave(page: Page): Promise<string | null> {
  let seen: string | null = null;
  page.once("dialog", (d) => {
    seen = d.type();
    void d.accept();
  });
  await page.reload();
  return seen;
}

async function openIntakeItem(page: Page, item: string): Promise<void> {
  await page.goto(`/intake?item=${item}`);
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(`intake item ${item}(, accessioned as D26-\\d{5})?$`, "i") })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Scan target:/ })).toBeFocused();
}

function commandRequest(page: Page, name: string): Promise<Request> {
  return page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/commands/${name}`);
}
const keyOf = (r: Request) => (r.postDataJSON() as { idempotencyKey: string }).idempotencyKey;

/** Materials → Retrieval → "Request blocks": the dialog with the given blocks ticked (in order) and a purpose. */
async function openRequestDialog(page: Page, blockIndexes: number[], purpose: string): Promise<Locator> {
  await page.goto("/materials?tab=retrieval");
  const open = page.getByRole("button", { name: "Request blocks" });
  await expect(open).toBeEnabled();
  await whenInteractive(open);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Request blocks from storage" });
  await expect(dialog).toBeVisible();
  const boxes = dialog.getByRole("checkbox");
  for (const i of blockIndexes) await boxes.nth(i).check();
  await dialog.getByRole("textbox", { name: /^Purpose/ }).fill(purpose);
  return dialog;
}

const retrievalCounts = () => ({
  requests: count("SELECT COUNT(*) n FROM retrieval_request"),
  created: count("SELECT COUNT(*) n FROM audit_event WHERE action = 'retrieval.created'"),
  user: userEvents(),
});

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await resetDemo(request);
  await request.dispose();
});

// =====================================================================================================================
// 1. A reload in the middle of work
// =====================================================================================================================

test("reload while typing a decision reason: the browser asks first; nothing is recorded; after the reload the screen shows the server's state and the typed reason is gone", async ({ page, context }) => {
  await actAs(context, STAFF.kim);
  await runSimulatorEvents(page, 1); // the 11:00 courier brings INT-1014-031 and INT-1014-032 (REL-0112)
  await openIntakeItem(page, "INT-1014-031");
  const ws = page.getByRole("region", { name: "REL-0112 side by side" });
  const candidate = () => readDb((db) => db.prepare("SELECT status, version, reviewed_by, decision_reason FROM related_order_candidate WHERE display_id = 'REL-0112'").get());
  const before = { candidate: candidate(), user: userEvents() };
  expect(before.candidate).toMatchObject({ status: "pending_review", reviewed_by: null });

  await ws.getByRole("radio", { name: /^Keep separate/ }).check();
  const reason = ws.getByLabel(/^Reason/);
  await reason.click();
  await reason.fill("Two separate biopsies; keep them as two cases.");
  expect(await reloadAcceptingLeave(page), "the browser asks before a reload discards the typed reason").toBe("beforeunload");

  await expect(page.getByRole("textbox", { name: /^Scan target:/ })).toBeFocused();
  await expect(ws).toBeVisible();
  for (const radio of await ws.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  await expect(ws.getByLabel(/^Reason/)).toHaveValue(""); // the draft does not survive a reload (no draft storage)
  await expect(page.getByText(loose("Decision by Kim Nguyen"))).toHaveCount(0);
  expect(candidate()).toEqual(before.candidate);
  expect(userEvents()).toBe(before.user);
});

test("reload while typing a gross field: the browser asks first; nothing is recorded; after the reload the field shows the stored (empty) value and the blockers are unchanged", async ({ page, context }) => {
  await actAs(context, STAFF.dana);
  const part = "D26-04797 Part C";
  await page.goto("/grossing?part=D26-04797-C");
  await expect(page.getByRole("heading", { level: 1, name: `Gross record for ${part}` })).toBeVisible();
  const pieces = page.getByRole("textbox", { name: "Piece count (required)" });
  await expect(pieces).toHaveValue("");
  await whenInteractive(pieces);
  const record = () => readDb((db) => db.prepare("SELECT version, state, fields, narrative FROM gross_record WHERE id = 'gr_acc_d26_04797_pc_v1'").get());
  const before = { record: record(), user: userEvents() };

  await pieces.click();
  await pieces.fill("3");
  await expect(pieces).toHaveValue("3");
  expect(await reloadAcceptingLeave(page), "the browser asks before a reload discards the typed value").toBe("beforeunload");

  await expect(page.getByRole("heading", { level: 1, name: `Gross record for ${part}` })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Piece count (required)" })).toHaveValue(""); // the server's value; the typed 3 is gone
  const blockers = page.getByRole("region", { name: `Next step for ${part}` }).getByRole("status").filter({ hasText: loose("Cannot approve yet") });
  await expect(blockers).toContainText(loose("Cannot approve yet: 2 items need attention"));
  expect(record()).toEqual(before.record);
  expect(userEvents()).toBe(before.user);
});

// =====================================================================================================================
// 2. An interrupted request: recorded by the server, the answer lost
// =====================================================================================================================

test("the connection drops after the server recorded the request: the screen says it could not reach the server, never 'created'; pressing again sends the same key and nothing is recorded twice", async ({ page, context }) => {
  await actAs(context, STAFF.priya);
  const dialog = await openRequestDialog(page, [0, 1], "Deeper levels for comparison (interrupted request)");
  const before = retrievalCounts();

  // The browser's request reaches the server (which records it); the answer is lost on the way back.
  let recordedByServer: { status: number; body: { ok: boolean; result?: { displayId: string } } } | null = null;
  await page.route(
    "**/api/commands/retrieval.create",
    async (route) => {
      const response = await route.fetch();
      recordedByServer = { status: response.status(), body: await response.json() };
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  const firstSent = commandRequest(page, "retrieval.create");
  await dialog.getByRole("button", { name: "Create request" }).click();
  const first = await firstSent;
  await expect(dialog.getByRole("alert")).toContainText(loose("Could not reach the local server"));
  await expect(dialog.getByRole("alert")).toContainText(loose("trying again will not create a duplicate"));
  await expect(dialog).toBeVisible();
  await expect.poll(() => recordedByServer?.status).toBe(200);
  const createdId = recordedByServer!.body.result!.displayId;
  // Never shown as done: no "created" toast, no navigation to the new request.
  await expect(toasts(page).getByText(new RegExp(`${createdId} created`))).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("selected")).toBeNull();
  // ...although the server did record it (exactly why the screen must not guess either way).
  expect(retrievalCounts()).toEqual({ requests: before.requests + 1, created: before.created + 1, user: before.user + 1 });

  // The person presses again: the same intent, the same key; the server replays its stored result.
  const retrySent = commandRequest(page, "retrieval.create");
  await dialog.getByRole("button", { name: "Create request" }).click();
  const retry = await retrySent;
  expect(keyOf(retry), "the retry reuses the first attempt's idempotency key").toBe(keyOf(first));
  const answer = await retry.response();
  expect(answer?.status()).toBe(200);
  const body = (await answer!.json()) as { ok: boolean; replayed?: boolean; result: { displayId: string } };
  expect(body).toMatchObject({ ok: true, replayed: true, result: { displayId: createdId } });
  await expect(toasts(page)).toContainText(loose("Already recorded. No duplicate was created."));
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`selected=${createdId}`));

  // One request, one audit event, one receipt: nothing was recorded twice.
  expect(retrievalCounts()).toEqual({ requests: before.requests + 1, created: before.created + 1, user: before.user + 1 });
  expect(count("SELECT COUNT(*) n FROM command_receipt WHERE idempotency_key = ?", keyOf(first))).toBe(1);
  expect(count("SELECT COUNT(*) n FROM retrieval_request WHERE display_id = ?", createdId)).toBe(1);
});

// =====================================================================================================================
// 3. A proxy's 502 page instead of the answer
// =====================================================================================================================

test("a 502 page from a proxy: 'The server did not confirm this action', never 'created'; nothing was recorded; pressing again sends the same key and records it once", async ({ page, context }) => {
  await actAs(context, STAFF.priya);
  const dialog = await openRequestDialog(page, [2, 3], "Recut for a second opinion (proxy error)");
  const before = retrievalCounts();
  await page.route(
    "**/api/commands/retrieval.create",
    (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" }),
    { times: 1 },
  );
  const firstSent = commandRequest(page, "retrieval.create");
  await dialog.getByRole("button", { name: "Create request" }).click();
  const first = await firstSent;
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText(loose("The server did not confirm this action:"));
  await expect(alert).toContainText(loose("Unexpected response from the local server (HTTP 502). Reload to see what was recorded before trying again."));
  await expect(dialog).toBeVisible();
  await expect(toasts(page).getByText(/RR-\d+ created/)).toHaveCount(0);
  expect(retrievalCounts()).toEqual(before); // the proxy answered; the request never reached the server

  const retrySent = commandRequest(page, "retrieval.create");
  await dialog.getByRole("button", { name: "Create request" }).click();
  const retry = await retrySent;
  expect(keyOf(retry)).toBe(keyOf(first));
  const body = (await (await retry.response())!.json()) as { ok: boolean; replayed?: boolean; result: { displayId: string } };
  expect(body.ok).toBe(true);
  expect(body.replayed).toBeUndefined(); // it ran now, once
  await expect(toasts(page)).toContainText(loose(`${body.result.displayId} created`));
  await expect(dialog).toBeHidden();
  expect(retrievalCounts()).toEqual({ requests: before.requests + 1, created: before.created + 1, user: before.user + 1 });
});

// =====================================================================================================================
// 4. The same, after the form was closed and the tab left and opened again (a new component, the same document)
// =====================================================================================================================

test("after a lost answer the person closes the dialog, leaves the tab and comes back, and enters the same request again: it carries the first key and nothing is recorded twice", async ({ page, context }) => {
  await actAs(context, STAFF.priya);
  const purpose = "Levels for the tumour board (asked again after leaving the tab)";
  const dialog = await openRequestDialog(page, [4, 5], purpose);
  const before = retrievalCounts();
  await page.route(
    "**/api/commands/retrieval.create",
    async (route) => {
      await route.fetch(); // recorded by the server
      await route.abort("connectionreset"); // the answer is lost
    },
    { times: 1 },
  );
  const firstSent = commandRequest(page, "retrieval.create");
  await dialog.getByRole("button", { name: "Create request" }).click();
  const first = await firstSent;
  await expect(dialog.getByRole("alert")).toContainText(loose("Could not reach the local server"));
  await expect.poll(() => retrievalCounts().requests).toBe(before.requests + 1);

  // Close the dialog, go to another materials tab and back (client-side navigation: the same document).
  await page.evaluate(() => ((window as unknown as { __e3SameDocument?: boolean }).__e3SameDocument = true));
  await dialog.getByRole("button", { name: "Do not request" }).click();
  await expect(dialog).toBeHidden();
  const jobs = page.getByRole("navigation", { name: "Materials jobs" });
  await jobs.getByRole("link", { name: /^Assemble trays/ }).click();
  await expect(page).toHaveURL(/tab=trays/);
  await jobs.getByRole("link", { name: /^Retrieve blocks/ }).click();
  await expect(page).toHaveURL(/tab=retrieval/);
  expect(await page.evaluate(() => (window as unknown as { __e3SameDocument?: boolean }).__e3SameDocument), "no reload happened").toBe(true);

  // A new dialog (its form starts empty), the same request entered again.
  const open = page.getByRole("button", { name: "Request blocks" });
  await whenInteractive(open);
  await open.click();
  const again = page.getByRole("dialog", { name: "Request blocks from storage" });
  await expect(again).toBeVisible();
  await expect(again.getByRole("textbox", { name: /^Purpose/ })).toHaveValue("");
  for (const box of await again.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
  const boxes = again.getByRole("checkbox");
  await boxes.nth(4).check();
  await boxes.nth(5).check();
  await again.getByRole("textbox", { name: /^Purpose/ }).fill(purpose);
  const retrySent = commandRequest(page, "retrieval.create");
  await again.getByRole("button", { name: "Create request" }).click();
  const retry = await retrySent;
  expect(keyOf(retry), "the same intent, entered again in a new form, reuses the lost request's key").toBe(keyOf(first));
  const body = (await (await retry.response())!.json()) as { ok: boolean; replayed?: boolean };
  expect(body).toMatchObject({ ok: true, replayed: true });
  await expect(toasts(page)).toContainText(loose("Already recorded. No duplicate was created."));
  expect(retrievalCounts()).toEqual({ requests: before.requests + 1, created: before.created + 1, user: before.user + 1 });
});
