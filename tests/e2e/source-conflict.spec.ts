// Stage 6, A1: source-conflict review in the browser. Only the importer can open a source conflict, so the conflict is
// imported through the test-only fixture endpoint (POST /api/test/fixtures, src/server/test-fixtures.ts): the real
// importer, fed one named synthetic message from a fixed catalog, guarded by this run's random token.
//
// The case: INT-1014-024 (Theo Barnes, MRN 447902, order ORD-77118, from the 11:00 courier) is checked and routed, so
// nothing else holds its accession. Then the simulated source sends a NEW order, ORD-77990, for the same MRN with a
// different name and date of birth (fixture "source-conflict-patient"). The importer keeps the patient on file and opens
// one patient-level review for the accessioning lead (Kim Nguyen). These tests follow it on the real screens:
//   a. the conflict is imported through the fixture (a repeat is a duplicate);
//   b. Intake shows the right conflict on the affected item, with the exact details that differ, never merged;
//   c. the accession is held, with the reason, while the review is open;
//   d. Kim records the review through the source-conflict dialog, with a reason;
//   e. the evidence is kept: the patient on file is unchanged and the incoming order is still on record;
//   f. the item's History shows who reviewed it, what was decided and why;
//   g. Maya (accessioner) has no button, and a review she sends by hand is refused (403), changing nothing;
//   h. a repeated request (same idempotency key) is answered from its receipt (one review); another payload with that
//      key is refused (409 IDEMPOTENCY_CONFLICT); a stale expectedVersion is refused (409 CONFLICT);
//   i. the dialog says inline that a reason (and the decision) is required, and records nothing.
// Last, the second catalog fixture ("source-conflict-order-amend") opens an order-level conflict on the same item.
// Synthetic data only; nothing here contacts anything but the local test server.
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { STAFF, actAs, importFixture, loose, resetDemo, runSimulatorEvents, toasts, type FixtureImport } from "./support";

// ---------------------------------------------------------------- local helpers (the same as in journeys.spec.ts)

interface CommandReply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: { ok: boolean; result?: any; replayed?: boolean; error?: { code: string; message: string; details?: unknown } };
  correlationId: string | null;
}

/** POST { input, idempotencyKey } to /api/commands/<name> from inside the page (same origin, the page's demo role cookie). */
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

function intentKey(label: string): string {
  return `e2e-source-conflict-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function expectRefused(reply: CommandReply, status: number, code: string): void {
  expect(reply.correlationId, "X-Correlation-Id header").toBeTruthy();
  expect(reply.status, JSON.stringify(reply.body)).toBe(status);
  expect(reply.body.ok).toBe(false);
  expect(reply.body.error?.code).toBe(code);
}

function nextCommandRequest(page: Page, name: string): Promise<Request> {
  return page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/commands/${name}`);
}

function requestBody(r: Request): { input: Record<string, unknown>; idempotencyKey: string } {
  return r.postDataJSON() as { input: Record<string, unknown>; idempotencyKey: string };
}

async function pageData(page: Page): Promise<string> {
  return (await page.content()).replace(/\\"/g, '"');
}

async function fromPageData(page: Page, pattern: RegExp, what: string): Promise<RegExpMatchArray> {
  const m = (await pageData(page)).match(pattern);
  expect(m, `${what} not found in the rendered page data`).not.toBeNull();
  return m!;
}

async function intakeIdOnPage(page: Page, displayId: string): Promise<string> {
  return (await fromPageData(page, new RegExp(`"id":"(int_[a-z0-9_]+)","displayId":"${displayId}"`), displayId))[1];
}

async function openIntakeItem(page: Page, item: string): Promise<void> {
  await page.goto(`/intake?item=${item}`);
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(`intake item ${item}(, accessioned as D26-\\d{5})?$`, "i") })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Scan target:/ })).toBeFocused();
}

function intakeHistory(page: Page): Locator {
  return page.getByRole("region", { name: "History" }).first().getByRole("listitem");
}

// ---------------------------------------------------------------- this spec's helpers

const ITEM = "INT-1014-024";
const REVIEW = "Review source conflict";
const DECISION_LABEL = "The patient details on file are correct (nothing is changed or merged)";
/** What the importer wrote for the fixture's conflict, in one sentence (the plan's words for it). */
const CONFLICT =
  "New order ORD-77990 gives different details for MRN 447902 (name Barnes, Theo → Barnes, Thea; date of birth 1972-06-14 → 1927-06-14).";
const REASON = "Called Harbor Point: the name and date of birth on file are correct; ORD-77990 was keyed with a typo (synthetic).";
const REVIEWED_TOAST = "Source conflict reviewed: details on file confirmed for ORD-77118, ORD-77990. Nothing was merged or changed.";
const REVIEWED_SUMMARY =
  "Kim Nguyen reviewed the source conflict on ORD-77118, ORD-77990: details on file confirmed. The patient reference and the order link were not changed; nothing was merged.";

/** The open source-conflict review on the item, as the server rendered it into the page (the screens never show internal ids). */
async function conflictOnPage(page: Page): Promise<{ taskId: string; version: number }> {
  const m = await fromPageData(page, /"sourceConflicts":\[\{"id":"(task_\d+)","version":(\d+),"about":"patient"/, "the open source conflict");
  return { taskId: m[1], version: Number(m[2]) };
}

/** No open source conflict is rendered for the item. */
async function expectNoConflictOnPage(page: Page): Promise<void> {
  expect(await pageData(page)).toContain('"sourceConflicts":[]');
}

/** The patient on file, as the identity band shows it: Theo Barnes, 1972-06-14, MRN 447902; never the incoming details. */
async function expectPatientOnFile(page: Page): Promise<void> {
  const identity = page.getByRole("region", { name: "Current case" });
  await expect(identity).toContainText("Barnes");
  await expect(identity).toContainText("Theo");
  await expect(identity).toContainText(loose("DOB 1972-06-14"));
  await expect(identity).toContainText(loose("MRN 447902"));
  await expect(identity).not.toContainText("Thea");
  await expect(identity).not.toContainText("1927-06-14");
  await expect(identity.getByText("Patient identity differs:")).toHaveCount(0);
}

/** Watch the page for any sourceConflict.review request (to prove none was sent). */
function watchReviewRequests(page: Page): Request[] {
  const sent: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/commands/sourceConflict.review") sent.push(r);
  });
  return sent;
}

async function openReviewDialog(page: Page): Promise<Locator> {
  const decision = page.getByRole("complementary", { name: "Decision" });
  const next = decision.getByRole("region", { name: "Your next step" });
  await expect(next.getByRole("heading", { level: 3, name: REVIEW })).toBeVisible();
  await next.getByRole("button", { name: REVIEW }).click();
  const dialog = page.getByRole("dialog", { name: REVIEW });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Shared between the serial tests: the request the dialog sent, and what it got back. */
const recorded: { input: Record<string, unknown> | null; key: string; result: unknown } = { input: null, key: "", result: null };

test.describe("source-conflict review (fixture-imported patient conflict on INT-1014-024)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await resetDemo(request);
    await request.dispose();
  });

  test("the fixture endpoint answers only this run's token: no or a wrong token is 404, the right token with an unknown fixture is 400 (nothing imported)", async ({ request }) => {
    const token = process.env.HLOS_TEST_FIXTURE_TOKEN ?? "";
    // The worker inherited the token playwright.config.ts generated for this run (and gave the web server).
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    const NOT_FOUND = { ok: false, error: { code: "NOT_FOUND", message: "Not found." } };
    const variants: Record<string, string>[] = [{}, { "x-hlos-fixture-token": "" }, { "x-hlos-fixture-token": `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}` }, { "x-hlos-fixture-token": `${token}0` }];
    for (const headers of variants) {
      const res = await request.post("/api/test/fixtures", { data: { fixture: "source-conflict-patient" }, headers });
      expect(res.status(), JSON.stringify(headers)).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    expect((await request.get("/api/test/fixtures", { headers: { "x-hlos-fixture-token": token } })).status()).toBe(404);
    // Only the right token gets past the gate: the server and this worker hold the same one. (Nothing was imported by
    // the refused requests: the next test's first import of this fixture is "applied", not a duplicate.)
    const unknown = await request.post("/api/test/fixtures", { data: { fixture: "no-such-fixture" }, headers: { "x-hlos-fixture-token": token } });
    expect(unknown.status()).toBe(400);
    expect(((await unknown.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "VALIDATION",
      message: "Unknown fixture. Known fixtures: source-conflict-patient, source-conflict-order-amend.",
    });
  });

  test("a. the patient-level source conflict is imported through the fixture, after INT-1014-024 was checked and routed (a repeat is a duplicate)", async ({ page, context, request }) => {
    await actAs(context, STAFF.maya);
    const { actions } = await runSimulatorEvents(page, 1);
    await expect(actions.filter({ hasText: loose("Done: Courier arrives: record arrival of CR-1014-11 (received by Maya Torres)") })).toHaveCount(1);

    // Maya checks the bottle and accepts the routing: nothing else holds the accession.
    await openIntakeItem(page, ITEM);
    const decision = page.getByRole("complementary", { name: "Decision" });
    await decision.getByRole("button", { name: "Record: I checked this bottle against the order" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /^Container 1 of Part A Order ORD-77118 Staff verified$/ })).toBeVisible();
    await decision.getByRole("button", { name: "Accept routing", exact: true }).click();
    await expect(page.getByRole("heading", { level: 3, name: /Rule applied · confirmed/ })).toBeVisible();
    await expect(decision).toContainText(loose("Ready: every check passed."));

    // The simulated source sends ORD-77990 for MRN 447902 with another name and date of birth.
    const first: FixtureImport = await importFixture(request, "source-conflict-patient");
    expect(first).toMatchObject({ outcome: "applied", messageId: "fixture/source-conflict-patient/ORD-77990#v1", sourceOrderId: "ORD-77990", version: 1 });
    expect(first.reconciliation.map((n) => n.kind)).toEqual(["order_created", "patient_conflict"]);
    expect(first.reconciliation[1].summary).toBe(
      "MRN 447902 is on file with different details (name Barnes, Theo → Barnes, Thea; date of birth 1972-06-14 → 1927-06-14); review task opened, nothing merged.",
    );
    // The same fixture again is the same message id: ignored as a duplicate, nothing else changes.
    const again = await importFixture(request, "source-conflict-patient");
    expect(again).toMatchObject({ outcome: "duplicate_ignored", eventId: first.eventId, receiptCount: 2, reconciliation: [] });
  });

  test("b. Intake shows the right conflict on the affected item, with the exact details that differ; the patient on file is shown, never merged", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, ITEM);
    // The queue moves the item to the exceptions lane with the source-conflict flag.
    const row = page.getByRole("region", { name: /^Exceptions/ }).getByRole("link", { name: new RegExp(`^Provisional intake item ${ITEM}`) });
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row).toContainText("Source conflict");

    // The finding says what the source sent and that the details on file were kept.
    const finding = page.getByRole("region", { name: "Current finding" });
    await expect(finding).toContainText(loose(`${CONFLICT} The patient details on file were kept; nothing was merged.`));
    const path = page.getByRole("navigation", { name: "Path to accession" });
    await expect(path.getByRole("button", { name: /^Step 2, Differences, yours now: Source conflict: your review$/ })).toBeVisible();

    // The patient on file stays as it is: one patient, not a mix of both.
    await expectPatientOnFile(page);

    // Kim's next step names the conflict in words; the dialog shows the incoming details beside the details on file.
    const decision = page.getByRole("complementary", { name: "Decision" });
    const next = decision.getByRole("region", { name: "Your next step" });
    await expect(next).toContainText(loose(`${CONFLICT} Accession waits for this review; nothing is merged or changed.`));
    const dialog = await openReviewDialog(page);
    const sent = dialog.getByRole("region", { name: "What the source sent" });
    await expect(sent).toContainText(loose(CONFLICT));
    await expect(sent).toContainText(loose("The order was linked to the patient reference on file by MRN within this tenant. The details on file were kept."));
    await expect(sent).toContainText(loose(`Holds back the accession of ${ITEM} (order ORD-77118).`));
    const onFile = dialog.getByRole("definition");
    await expect(onFile).toHaveText([/^Barnes, Theo$|^Theo Barnes$/, "1972-06-14", /^447902 in /]);
    await expect(dialog).not.toContainText(loose("Merge"));
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("c. hold: while the review is open the accession is blocked with the reason, on screen and on the server", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, ITEM);
    const decision = page.getByRole("complementary", { name: "Decision" });
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();
    await expect(decision).toContainText(loose("Cannot request yet: waits for your review of the source conflict."));
    await expect(page.getByRole("region", { name: "Current finding" })).toContainText(loose("Accession waits for your review of the source conflict."));
    const path = page.getByRole("navigation", { name: "Path to accession" });
    await expect(path.getByRole("button", { name: /^Step 5, Accession, / })).toHaveAccessibleName("Step 5, Accession, blocked: Waits for source conflict");

    // A request sent by hand is refused by the server with the same reason; nothing is issued.
    const forged = await sendCommand(page, "accession.request", { intakeItemIds: [await intakeIdOnPage(page, ITEM)] }, intentKey("c-accession"));
    expectRefused(forged, 423, "BLOCKED");
    expect(forged.body.error?.message).toBe(
      "Cannot request accession yet: ORD-77118: the source sent patient details that differ from the patient on file. Accession waits until an accessioning lead or supervisor reviews the source conflict; nothing is merged or changed automatically",
    );
    await page.reload();
    await expect(page.getByRole("region", { name: "Current case" })).toContainText(loose("Official number: not issued"));
    await expect(intakeHistory(page).filter({ hasText: loose("requested an accession") })).toHaveCount(0);
  });

  test("g. unauthorized: Maya (accessioner) has no review button and waits on Kim; a review she sends by hand is refused with 403 and changes nothing", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, ITEM);
    const decision = page.getByRole("complementary", { name: "Decision" });
    await expect(page.getByRole("button", { name: REVIEW })).toHaveCount(0);
    await expect(decision.getByRole("heading", { name: "Waiting on" })).toBeVisible();
    await expect(decision).toContainText(loose(`Kim Nguyen to review the source conflict: ${CONFLICT.charAt(0).toLowerCase()}${CONFLICT.slice(1)}`));
    await expect(decision).toContainText(loose("Cannot request yet: waits for Kim Nguyen's review of the source conflict."));
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();

    const before = await conflictOnPage(page);
    const forged = await sendCommand(
      page,
      "sourceConflict.review",
      { taskId: before.taskId, expectedVersion: before.version, decision: "details_on_file_confirmed", reason: "Looks fine to me" },
      intentKey("g-maya"),
    );
    expectRefused(forged, 403, "FORBIDDEN");
    expect(forged.body.error?.message).toBe("Not allowed: Accessioner cannot resolve clarifications. Allowed: Accessioning lead, Operations supervisor.");

    // Nothing changed: the same review is still open at the same version, and still holds the accession.
    await page.reload();
    expect(await conflictOnPage(page)).toEqual(before);
    await expect(decision).toContainText(loose("Cannot request yet: waits for Kim Nguyen's review of the source conflict."));
    await expect(intakeHistory(page).filter({ hasText: loose("reviewed the source conflict") })).toHaveCount(0);
  });

  test("i. the dialog says inline that the decision and a reason are required, and records nothing", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, ITEM);
    const sent = watchReviewRequests(page);
    const before = await conflictOnPage(page);
    const dialog = await openReviewDialog(page);
    const radio = dialog.getByRole("radio", { name: DECISION_LABEL });
    const reason = dialog.getByRole("textbox", { name: /^Reason, recorded with your name/ });
    const record = dialog.getByRole("button", { name: "Record review" });

    // Nothing chosen, nothing typed: both are said inline, the decision first (focus goes to it).
    await record.click();
    await expect(dialog.getByText("Choose the decision to record it.")).toBeVisible();
    await expect(dialog.getByText("A reason is required: say what you checked and why the details on file stand.")).toBeVisible();
    await expect(radio).toBeFocused();
    await expect(radio).toHaveAttribute("aria-invalid", "true");

    // The decision chosen, the reason still missing (or only spaces): the reason is said, and focus goes to it.
    await radio.check();
    await expect(dialog.getByText("Choose the decision to record it.")).toHaveCount(0);
    await reason.fill("   ");
    await record.click();
    await expect(dialog.getByText("A reason is required: say what you checked and why the details on file stand.")).toBeVisible();
    await expect(reason).toBeFocused();
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toBeVisible();
    expect(sent, "no review request was sent").toHaveLength(0);

    // Cancelled: nothing was recorded (a reload reads the same open review).
    await reason.fill("");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    expect(await conflictOnPage(page)).toEqual(before);
    await expect(intakeHistory(page).filter({ hasText: loose("reviewed the source conflict") })).toHaveCount(0);
    expect(sent).toHaveLength(0);
  });

  test("d. Kim (accessioning lead) records the review through the dialog, with a reason; the accession is no longer held", async ({ page, context }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, ITEM);
    const before = await conflictOnPage(page);
    const dialog = await openReviewDialog(page);
    await dialog.getByRole("radio", { name: DECISION_LABEL }).check();
    await dialog.getByRole("textbox", { name: /^Reason, recorded with your name/ }).fill(REASON);
    const request = nextCommandRequest(page, "sourceConflict.review");
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/commands/sourceConflict.review");
    await dialog.getByRole("button", { name: "Record review" }).click();
    const body = requestBody(await request);
    expect(body.input).toEqual({ taskId: before.taskId, expectedVersion: before.version, decision: "details_on_file_confirmed", reason: REASON });
    expect(body.idempotencyKey).toBeTruthy();
    const reply = (await (await response).json()) as { ok: boolean; result: unknown };
    expect(reply.ok).toBe(true);
    expect(reply.result).toMatchObject({ taskId: before.taskId, status: "done", version: before.version + 1, decision: "details_on_file_confirmed", message: REVIEWED_TOAST });
    Object.assign(recorded, { input: body.input, key: body.idempotencyKey, result: reply.result });

    await expect(dialog).toBeHidden();
    await expect(toasts(page).getByText(REVIEWED_TOAST)).toBeVisible();
    const decision = page.getByRole("complementary", { name: "Decision" });
    await expect(decision).toContainText(loose("Ready: every check passed."));
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeEnabled();
    await expect(page.getByRole("button", { name: REVIEW })).toHaveCount(0);
    await page.reload();
    await expectNoConflictOnPage(page);
    await expect(page.getByRole("navigation", { name: "Path to accession" }).getByRole("button", { name: /^Step 2, Differences, done: None found$/ })).toBeVisible();
  });

  test("h. repeated and stale requests: the same key replays the stored result (one review); another payload with that key is 409 IDEMPOTENCY_CONFLICT; the old expectedVersion is 409 CONFLICT", async ({ page, context }) => {
    expect(recorded.input, "test d recorded the dialog's request").not.toBeNull();
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, ITEM);

    // The dialog's request again (a double submit or a retry after a lost reply): the stored result, nothing re-run.
    const replay = await sendCommand(page, "sourceConflict.review", recorded.input, recorded.key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, replayed: true });
    expect(replay.body.result).toEqual(recorded.result);

    // The same key with another payload is refused and does not see the stored result.
    const changed = await sendCommand(page, "sourceConflict.review", { ...recorded.input, reason: `${REASON} (edited)` }, recorded.key);
    expectRefused(changed, 409, "IDEMPOTENCY_CONFLICT");
    expect(changed.body.result).toBeUndefined();

    // A new request built from the version the dialog had (before the review) is stale.
    const stale = await sendCommand(page, "sourceConflict.review", { ...recorded.input, reason: "Second look (synthetic)" }, intentKey("h-stale"));
    expectRefused(stale, 409, "CONFLICT");
    const v = recorded.input!.expectedVersion as number;
    expect(stale.body.error?.message).toBe(
      `This source-conflict review changed since you opened it (you had version ${v}, current is ${v + 1}). Review the latest version first.`,
    );

    // One review on record, with the first reason only.
    await page.reload();
    const reviews = intakeHistory(page).filter({ hasText: loose("reviewed the source conflict") });
    await expect(reviews).toHaveCount(1);
    await expect(reviews).toContainText(loose(`Reason: ${REASON}`));
    await expect(reviews).not.toContainText("(edited)");
    await expect(reviews).not.toContainText("Second look");
  });

  test("e. the evidence is kept: the patient on file is unchanged, and the incoming order ORD-77990 is still on record with its details", async ({ page, context, request }) => {
    await actAs(context, STAFF.kim);
    await openIntakeItem(page, ITEM);
    await expectPatientOnFile(page);

    // The integration log keeps the incoming message with what differed, and the repeat as a duplicate.
    await page.goto("/settings?tab=integration");
    const log = page.getByRole("table", { name: "Inbound source messages and their outcomes, newest first" });
    const rows = log.getByRole("row").filter({ hasText: "fixture/source-conflict-patient/ORD-77990#v1" });
    await expect(rows).toHaveCount(2);
    const applied = rows.filter({ hasText: loose("New order ORD-77990 v1 imported") });
    await expect(applied).toHaveCount(1);
    await expect(applied).toContainText(loose("ORD-77990 v1"));
    await expect(applied).toContainText(loose("Applied"));
    await expect(applied).toContainText(loose("Sync / demo control"));
    await expect(applied).toContainText(
      loose(
        "New order ORD-77990 v1 imported (1 part). MRN 447902 is on file with different details (name Barnes, Theo → Barnes, Thea; date of birth 1972-06-14 → 1927-06-14); review task opened, nothing merged.",
      ),
    );
    await expect(rows.filter({ hasText: loose("Duplicate of message fixture/source-conflict-patient/ORD-77990#v1") })).toHaveCount(1);

    // The source re-sending it after the review changes nothing: still a duplicate, no new review.
    const resend = await importFixture(request, "source-conflict-patient");
    expect(resend).toMatchObject({ outcome: "duplicate_ignored", receiptCount: 3 });
    await openIntakeItem(page, ITEM);
    await expectNoConflictOnPage(page);
    await expect(page.getByRole("complementary", { name: "Decision" }).getByRole("button", { name: "Request accession (simulated source)" })).toBeEnabled();
  });

  test("f. the item's History shows the review: who (Kim Nguyen, accessioning lead), what (details on file confirmed, nothing merged) and why", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await openIntakeItem(page, ITEM);
    const review = intakeHistory(page).filter({ hasText: loose(REVIEWED_SUMMARY) });
    await expect(review).toHaveCount(1);
    await expect(review).toContainText(loose("Kim Nguyen, Accessioning lead"));
    await expect(review).toContainText(loose(`Reason: ${REASON}`));
    await expect(review).toContainText("Local");
    // The recorded before/after: the task closed, the patient reference the same before and after.
    await review.getByText("Details", { exact: true }).click();
    const values = review.getByRole("table", { name: "Original and new values" });
    await expect(values.getByRole("row", { name: /^task / })).toContainText('"status":"open"');
    await expect(values.getByRole("row", { name: /^task / })).toContainText('"status":"done"');
    await expect(values.getByRole("row", { name: /^patientRefUnchanged / })).toContainText("true");
    await expect(values.getByRole("row", { name: /^decision / })).toContainText("details_on_file_confirmed");
    const patientRow = values.getByRole("row", { name: /^patientRef / });
    await expect(patientRow).toContainText('"birth_date":"1972-06-14"');
    await expect(patientRow).not.toContainText("1927-06-14");
  });

  test("the second catalog fixture: a newer ORD-77118 version with another date of birth opens an order-level conflict that holds the accession again", async ({ page, context, request }) => {
    const amend = await importFixture(request, "source-conflict-order-amend");
    expect(amend).toMatchObject({ outcome: "applied", messageId: "fixture/source-conflict-order-amend/ORD-77118#v2", previousVersion: 1, version: 2 });
    expect(amend.reconciliation.map((n) => n.kind)).toContain("patient_conflict");

    await actAs(context, STAFF.kim);
    await openIntakeItem(page, ITEM);
    const conflict = "ORD-77118 v2 changed the patient date of birth 1972-06-14 → 1972-06-15.";
    // Held again, with both reasons: the order-level review and a new check of the bottle against v2.
    const decision = page.getByRole("complementary", { name: "Decision" });
    await expect(decision.getByRole("button", { name: "Request accession (simulated source)" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Current finding" })).toContainText(
      loose("Accession waits for your review of the source conflict and a new check of the bottle (the order changed)."),
    );
    const path = page.getByRole("navigation", { name: "Path to accession" });
    await expect(path.getByRole("button", { name: /^Step 5, Accession, / })).toHaveAccessibleName("Step 5, Accession, blocked: Waits: source conflict, container check");
    // The lead's next step is the order-level review, in words; the dialog shows what changed and that nothing was applied.
    const next = decision.getByRole("region", { name: "Your next step" });
    await expect(next).toContainText(loose(`${conflict} Accession waits for this review; nothing is merged or changed.`));
    await fromPageData(page, /"sourceConflicts":\[\{"id":"task_\d+","version":\d+,"about":"order"/, "the order-level source conflict");
    const dialog = await openReviewDialog(page);
    const sent = dialog.getByRole("region", { name: "What the source sent" });
    await expect(sent).toContainText(loose(conflict));
    await expect(sent).toContainText(
      loose("Changes in ORD-77118 v2: patient date of birth 1972-06-14 → 1972-06-15 (patient record not changed). The previous values stay in effect until an authorized person reviews them. Both versions are kept."),
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    // The patient on file is unchanged by the newer version.
    await expectPatientOnFile(page);
  });
});

