// The presenter console (/demo, synthetic demo only): every presenter-only control lives on this one surface,
// never on a bench screen. The top bar only shows the demo role and demo time (read only) and links to it.
//  - The console exists in demo mode with its tabs (Guide, Role and clock, World events, Outages and reset).
//  - The bench screens (Intake, Clarify, Gross, Materials) carry no presenter control.
//  - World events drive the real screens: unpack a requisition, a simulated source acknowledgment, printer behaviour.
// Each test starts from the reproducible synthetic 10:52 state.
import { expect, test, type Page } from "@playwright/test";
import { STAFF, actAs, loose, openConsoleTab, resetDemo, toasts, worldEvent } from "./support";

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

/** Text and controls that only a presenter surface may carry. */
async function expectNoPresenterControls(page: Page, where: string) {
  await expect(page.getByText(/Presenter controls/i), `${where}: no presenter disclosure`).toHaveCount(0);
  await expect(
    page.getByRole("main").getByRole("button", { name: /simulate (a |the )?(colleague|office answer|source acknowledg|acknowledg)|unpack (next|all)|printer behaviour/i }),
    `${where}: no simulated-event button`,
  ).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("combobox", { name: /demo control|acting as/i }), `${where}: no demo control picker`).toHaveCount(0);
}

test.describe("presenter console", () => {
  test("exists in demo mode with its tabs; the top bar shows the demo role and time read only and links to it", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    await page.goto("/intake");
    const bar = page.getByRole("banner");

    // Read only: the demo role and the demo time, in words, never a control.
    const indicator = bar.getByRole("note", { name: /^Demo role: / });
    await expect(indicator).toHaveAccessibleName("Demo role: Maya Torres, Accessioner (demo role switch, not a sign-in). Demo time Wed Oct 14, 10:52 AM ET, paused.");
    await expect(indicator).toContainText(loose("Maya, Accessioner"));
    await expect(indicator).toContainText(loose("10:52 AM, paused"));
    await expect(bar.getByRole("combobox")).toHaveCount(0);
    await expect(bar.getByRole("button", { name: /presenter|acting as|demo clock|demo role/i })).toHaveCount(0);
    // The always-visible Synthetic demo status and the keyboard keys stay.
    await expect(bar.getByRole("note", { name: "Demo mode" })).toContainText("Synthetic");
    await expect(bar.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();

    // One link to the console, reachable by keyboard with a visible focus ring.
    const link = bar.getByRole("link", { name: "Presenter console" });
    await expect(link).toHaveCount(1);
    await expect(link).not.toHaveAttribute("aria-current", "page");
    await bar.getByRole("button", { name: "Keyboard shortcuts" }).focus();
    await page.keyboard.press("Tab"); // the Synthetic demo status link
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    expect(await link.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none")).toBe(true);
    await page.keyboard.press("Enter");

    // The console: labeled as the presenter's surface, the guide keeps its URL.
    await expect(page).toHaveURL(/\/demo\?tab=guide&step=1$/);
    await expect(page.getByRole("heading", { level: 1, name: "Presenter console" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(loose("Presenter (synthetic demo)"));
    await expect(bar.getByRole("link", { name: "Presenter console" })).toHaveAttribute("aria-current", "page");
    const tabs = page.getByRole("navigation", { name: "Presenter console sections" }).getByRole("link");
    await expect(tabs).toHaveText(["Guide", "Role and clock", "World events", "Outages and reset", "Workflow map", "Speaker notes", "Real vs simulated"]);
    await expect(page.getByRole("button", { name: "Run simulator events for this step" })).toBeVisible();

    // Role and clock: the demo role switch (not a sign-in) and the demo clock controls.
    await openConsoleTab(page, "role");
    await expect(page.getByRole("main").getByRole("combobox", { name: /^Acting as/ })).toHaveValue(STAFF.maya);
    await expect(page.getByRole("heading", { level: 2, name: "Demo clock" })).toBeVisible();
    for (const name of ["Advance 5 min", "Resume clock", "Reset clock to 10:52", "Jump to 11:20 PAS cancellation"]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }

    // World events: five simulated events, each with a target picker listing only eligible synthetic records.
    await openConsoleTab(page, "world");
    const pick = (event: Parameters<typeof worldEvent>[1], label: string) => worldEvent(page, event).getByRole("combobox", { name: label });
    await expect(pick("Courier bag: unpack and receive", "Courier delivery").locator("option")).toHaveText([/^CR-1014-11, expected 11:00 AM ET: \d+ of \d+ still in the bag, arrival not recorded$/]);
    await expect(pick("A colleague edits an intake item", "Intake item").locator("option", { hasText: "INT-1014-022" })).toHaveCount(1);
    const clarifications = pick("The office answers a clarification", "Clarification").locator("option");
    await expect(clarifications.filter({ hasText: "CLR-0455" })).toHaveCount(1); // sent
    await expect(clarifications.filter({ hasText: "CLR-0454" })).toHaveCount(0); // delivery failed: the office never got it
    await expect(clarifications.filter({ hasText: "CLR-0456" })).toHaveCount(0); // drafted
    await expect(pick("The source system acknowledges a gross entry", "Gross entry").locator("option").first()).toHaveText(/^D26-\d{5} Part [A-Z], entered by /);
    await expect(pick("Printer behaviour", "Printer").locator("option")).toHaveCount(3);
    for (const event of ["Courier bag: unpack and receive", "A colleague edits an intake item", "The office answers a clarification", "The source system acknowledges a gross entry", "Printer behaviour"] as const) {
      await expect(worldEvent(page, event)).toContainText(/Simulates /);
    }

    // Outages and reset: what used to be Settings, Demo scenarios.
    await openConsoleTab(page, "outages");
    await expect(page.getByRole("button", { name: "Simulate outage" })).toHaveCount(2);
    for (const name of ["Fail next message", "Replay duplicate", "Send older version", "Make notifications fail", "Make assistant unavailable", "Reset demo data"]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }
    await expect(page.getByRole("list", { name: "Simulated printers and their fault settings" }).getByRole("listitem")).toHaveCount(3);

    // Settings keeps one line pointing to the console.
    await page.goto("/settings?tab=demo");
    const main = page.getByRole("main");
    await expect(main).toContainText(loose("Demo scenarios (source outages, printers, notifications, the assistant, injected failures and reset) are on the presenter console, Outages and reset."));
    await expect(main.getByRole("button")).toHaveCount(0);
    await main.getByRole("link", { name: "presenter console, Outages and reset" }).click();
    await expect(page).toHaveURL(/\/demo\?tab=outages$/);
  });

  test("bench screens carry no presenter controls", async ({ page, context }) => {
    // Intake: an item and the empty bench.
    await actAs(context, STAFF.maya);
    await page.goto("/intake?item=INT-1014-022");
    await expect(page.getByRole("heading", { level: 2, name: "Provisional intake item INT-1014-022" })).toBeVisible();
    await expectNoPresenterControls(page, "Intake item");
    await page.goto("/intake");
    await expect(page.getByRole("region", { name: "Courier manifest" })).toBeVisible();
    await expectNoPresenterControls(page, "Intake");

    // Clarify: a sent question the simulated office could answer.
    await actAs(context, STAFF.kim);
    await page.goto("/clarifications?selected=CLR-0455");
    await expect(page.getByRole("complementary", { name: "Decision" })).toBeVisible();
    await expectNoPresenterControls(page, "Clarify");

    // Gross: the source-entry queue, its attested entries waiting for the source, and one attested record.
    await actAs(context, STAFF.sam);
    await page.goto("/grossing?view=source");
    const attested = page.locator("details").filter({ hasText: "Entered (staff attested), awaiting acknowledgment" });
    await attested.locator("summary").click();
    const rows = attested.getByRole("row");
    await expect(rows.nth(1)).toContainText(/Not acknowledged yet\. Waiting for (EMA-SIM Sunrise Coast|OTHER-EHR-SIM Gulf)\./);
    await expectNoPresenterControls(page, "Gross source entry");
    await rows.nth(1).getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: /^Gross record for D26-\d{5} Part [A-Z]$/ })).toBeVisible();
    await expect(page.getByText(/Entered \(staff attested\) by .* Not acknowledged by the source\./)).toBeVisible();
    await expectNoPresenterControls(page, "Gross record");

    // Materials: the print queue (the printer switches used to sit at its foot).
    await actAs(context, STAFF.priya);
    await page.goto("/materials?tab=print");
    await expect(page.getByRole("heading", { level: 1, name: "Materials" })).toBeVisible();
    await expect(page.getByRole("group", { name: /Simulate printer behaviour/ })).toHaveCount(0);
    await expectNoPresenterControls(page, "Materials print");
  });

  test("world events from the console reach the bench: unpack a requisition, a source acknowledgment, printer behaviour", async ({ page, context }) => {
    // Courier bag (as the accessioner, who may receive): the requisition becomes a provisional intake item on Intake.
    await actAs(context, STAFF.maya);
    await openConsoleTab(page, "world");
    const courier = worldEvent(page, "Courier bag: unpack and receive");
    const before = await courier.getByRole("combobox", { name: "Courier delivery" }).locator("option").first().innerText();
    const total = Number(before.match(/(\d+) of (\d+) still in the bag/)![2]);
    await courier.getByRole("button", { name: "Unpack next requisition" }).click();
    const outcome = courier.getByRole("status").filter({ hasText: "still in the bag." });
    await expect(outcome).toContainText(new RegExp(`INT-1014-\\d{3} received.* ${total - 1} still in the bag\\.`));
    await expect(courier.getByRole("combobox", { name: "Courier delivery" }).locator("option").first()).toContainText(`${total - 1} of ${total} still in the bag`);
    const received = (await outcome.innerText()).match(/INT-1014-\d{3}/)![0];
    await courier.getByRole("link", { name: `Open ${received} on Intake` }).click();
    await expect(page.getByRole("heading", { level: 2, name: `Provisional intake item ${received}` })).toBeVisible();

    // Source acknowledgment (as the histology assistant): the attested entry becomes acknowledged by the simulated source.
    await actAs(context, STAFF.sam);
    await openConsoleTab(page, "world");
    const ack = worldEvent(page, "The source system acknowledges a gross entry");
    const entry = ack.getByRole("combobox", { name: "Gross entry" });
    const part = (await entry.inputValue()).trim();
    const label = (await entry.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "")).match(/^(D26-\d{5}) Part ([A-Z])/)!;
    await ack.getByRole("button", { name: "Simulate source acknowledgment" }).click();
    await expect(toasts(page)).toContainText(loose("Simulated source acknowledgment recorded"));
    await expect(ack).toContainText(new RegExp(`${label[1]} Part ${label[2]}: acknowledged by .+ \\(simulated\\)\\.`));
    await expect(entry.locator("option", { hasText: `${label[1]} Part ${label[2]},` })).toHaveCount(0);
    await ack.getByRole("link", { name: "Open the gross record" }).click();
    await expect(page).toHaveURL(new RegExp(`/grossing\\?part=${part}$`));
    await expect(page.getByText(loose("Acknowledged by the simulated source at"))).toBeVisible();

    // Printer behaviour: the slide printer becomes unavailable; the print queue says so, then it is ready again.
    await actAs(context, STAFF.priya);
    await openConsoleTab(page, "world");
    const printer = worldEvent(page, "Printer behaviour");
    await printer.getByRole("combobox", { name: "Printer" }).selectOption({ label: "Slide printer 1 (now ready)" });
    await expect(printer.getByRole("button", { name: "Set printer behaviour" })).toBeDisabled();
    await printer.getByRole("combobox", { name: "Behaviour" }).selectOption({ label: "Unavailable (jobs stay queued)" });
    await printer.getByRole("button", { name: "Set printer behaviour" }).click();
    await expect(printer).toContainText(loose("Slide printer 1 unavailable: new jobs stay queued until someone releases them (simulated)."));
    await page.goto("/materials?tab=print");
    await expect(page.getByRole("status").filter({ hasText: "Slide printer 1 is unavailable (simulated)" })).toBeVisible();
    await openConsoleTab(page, "world");
    await printer.getByRole("combobox", { name: "Printer" }).selectOption({ label: "Slide printer 1 (now unavailable)" });
    await printer.getByRole("combobox", { name: "Behaviour" }).selectOption({ label: "Ready" });
    await printer.getByRole("button", { name: "Set printer behaviour" }).click();
    await expect(printer).toContainText(loose("Slide printer 1 ready (simulated)."));
  });
});
