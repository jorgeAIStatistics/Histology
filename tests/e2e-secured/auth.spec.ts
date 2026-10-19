// SECURED mode in the browser (Stage 6 Phase B): the real OpenID Connect sign-in against the local oidc-provider,
// the server guard on every page and read API, the lock screen, workstation hand-over, re-authentication for a
// sensitive decision, an expired session during a change, sign-out, and an unavailable identity provider.
// Synthetic data only; every request stays on this machine (support.ts aborts anything else).
//
// One database for the whole file (no demo reset exists in secured mode): the tests run in this order and each one
// uses records the earlier ones leave alone (Maya's identity check runs before Kim resolves CLR-0453).
import type { Page } from "@playwright/test";
import {
  DOWN_URL,
  ITEM,
  LOGIN,
  ageLastSignIn,
  auditHead,
  db,
  expect,
  expectNoLabData,
  expireSession,
  labEventsSince,
  loopbackOnly,
  newWorkstation,
  postCommand,
  providerLogin,
  sessionCookie,
  sessionGroup,
  sessionRow,
  signIn,
  test,
} from "./support";

/** Every bench screen (and the pages that lead to one). */
const BENCH_PAGES = [
  "/",
  "/intake",
  `/intake?item=${ITEM}`,
  "/clarifications",
  "/clarifications?selected=CLR-0453",
  "/grossing",
  "/worklist",
  "/worklist?view=histotech",
  "/materials",
  "/operations",
  "/insights",
  "/settings",
  "/cases/D26-04804",
  "/demo",
];

const NOTE_REGION = "Owner and working note";

/** The seeded identity item is on screen, with its (synthetic) patient. */
async function expectItemShown(page: Page) {
  await expect(page.getByRole("heading", { level: 2, name: `Provisional intake item ${ITEM}` })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Kettering, Tobias");
}

function intakeNote(page: Page) {
  return page.getByRole("region", { name: NOTE_REGION });
}

function itemNotes(): string | null {
  return (db().prepare("SELECT notes FROM intake_item WHERE display_id = ?").get(ITEM) as { notes: string | null }).notes;
}

function clarificationState(display: string): string {
  return (db().prepare("SELECT state FROM clarification WHERE display_id = ?").get(display) as { state: string }).state;
}

/** The intake item's working note, opened for editing with `text` typed (not saved). */
async function typeWorkingNote(page: Page, text: string) {
  const card = intakeNote(page);
  await card.getByRole("button", { name: "Edit owner or note" }).click();
  const note = card.getByRole("textbox", { name: "Working note" });
  await note.fill(text);
  return { card, note, save: card.getByRole("button", { name: "Save owner and note" }) };
}

test.describe("secured mode: sign-in, the server guard, lock, hand-over, re-authentication and sign-out", () => {
  test("no session: every bench page redirects to sign-in and shows no data; the read APIs answer 401 with no data", async ({ page, request, context, baseURL }) => {
    for (const path of BENCH_PAGES) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page, path).toHaveURL(/\/signin\?returnTo=/);
      await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
      await expect(page.getByRole("banner")).toHaveCount(0); // the plain page has no app chrome, no counts
      await expectNoLabData(page, ["Kim Nguyen", "Maya Torres"]);
    }
    // A forged demo role cookie opens nothing: it is not a sign-in.
    await context.addCookies([{ name: "hlos_actor", value: "stf_tanya", url: baseURL! }]);
    await page.goto(`/intake?item=${ITEM}`);
    await expect(page).toHaveURL(/\/signin\?returnTo=/);
    await expectNoLabData(page);

    const variants: Record<string, string>[] = [{}, { cookie: "hlos_actor=stf_tanya" }];
    for (const headers of variants) {
      const live = await request.get("/api/live", { headers });
      expect(live.status()).toBe(401);
      const body = await live.json();
      expect(body).toEqual({ ok: false, error: { code: "SIGN_IN_REQUIRED", message: expect.any(String), details: { reason: "missing" } } });
      expect(live.headers()["cache-control"]).toContain("no-store");

      const exportRes = await request.post("/api/worklist/export", { headers: { ...headers, Origin: baseURL! }, data: { view: "histotech", filters: {} } });
      expect(exportRes.status()).toBe(401);
      expect((await exportRes.json()).error.code).toBe("SIGN_IN_REQUIRED");
      expect(exportRes.headers()["content-type"]).not.toContain("text/csv");

      const session = await request.get("/api/session", { headers });
      expect(session.status()).toBe(401);

      // The activity heartbeat touches nothing without a session, and never from another origin.
      const activity = await request.post("/api/auth/activity", { headers: { ...headers, Origin: baseURL! }, data: {} });
      expect(activity.status()).toBe(401);
      expect((await activity.json()).error.code).toBe("SIGN_IN_REQUIRED");
      const foreign = await request.post("/api/auth/activity", { headers: { ...headers, Origin: "http://localhost:1" }, data: {} });
      expect(foreign.status()).toBe(403);
    }
  });

  test("sign-in through the provider's form as Kim lands on the page asked for, with her name and role in the top bar", async ({ page }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    await expect(page).toHaveURL(`/intake?item=${ITEM}`);
    await expectItemShown(page);
    const session = sessionGroup(page);
    await expect(session.getByRole("note", { name: "Signed in: Kim Nguyen, Accessioning lead" })).toBeVisible();
    await expect(session).toContainText("Kim Nguyen");
    await expect(session).toContainText("Accessioning lead");
    await expect(session.getByRole("button", { name: "Lock" })).toBeVisible();
    await expect(session.getByRole("button", { name: "Sign out" })).toBeVisible();
    // No demo surface: no demo role, no presenter console; the synthetic seed is labelled.
    const banner = page.getByRole("banner");
    await expect(banner.getByRole("note", { name: /^Demo role/ })).toHaveCount(0);
    await expect(banner.getByRole("link", { name: "Presenter console" })).toHaveCount(0);
    await expect(banner.getByRole("note", { name: /^Synthetic data/ })).toBeVisible();
    // The bar keeps its height.
    expect((await banner.boundingBox())!.height).toBe(52);
    expect((await sessionRow(page.context())).staff_id).toBe("stf_kim");
  });

  test("a forged hlos_actor cookie is ignored: the session decides who acts", async ({ page, context, baseURL }) => {
    await signIn(page, LOGIN.kim);
    await context.addCookies([{ name: "hlos_actor", value: "stf_tanya", url: baseURL! }]);
    await page.reload();
    await expect(sessionGroup(page).getByRole("note", { name: "Signed in: Kim Nguyen, Accessioning lead" })).toBeVisible();
    const who = await page.evaluate(async () => (await (await fetch("/api/session")).json()) as { actor: { id: string } });
    expect(who.actor.id).toBe("stf_kim");
    const before = auditHead();
    // Claiming to be the supervisor is refused (the screen was not opened for her); as Kim the role is refused.
    const asTanya = await postCommand(page, "tray.releaseWithExceptions", { trayId: "tray_x", note: "forged", expectedVersion: 1 }, "stf_tanya");
    expect(asTanya.status).toBe(409);
    expect(asTanya.body.error?.code).toBe("ACTOR_MISMATCH");
    const asKim = await postCommand(page, "tray.releaseWithExceptions", { trayId: "tray_x", note: "forged", expectedVersion: 1 }, "stf_kim");
    expect(asKim.status).toBe(403);
    expect(asKim.body.error?.code).toBe("FORBIDDEN");
    expect(labEventsSince(before).filter((e) => e.action !== "command.denied")).toEqual([]);
  });

  test("Maya (accessioner) is denied identity resolution: no button on screen, and a direct API call gets 403 with nothing recorded", async ({ page }) => {
    await signIn(page, LOGIN.maya, "/clarifications?selected=CLR-0453");
    const panel = page.getByRole("region", { name: /^Identity conflict question: INT-1014-022/ });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Mark answer reviewed" })).toBeDisabled();
    await expect(panel).toContainText("Not allowed for Accessioner");
    const state = clarificationState("CLR-0453");
    const id = (db().prepare("SELECT id, version FROM clarification WHERE display_id = 'CLR-0453'").get() as { id: string; version: number });
    const before = auditHead();
    const resolve = await postCommand(
      page,
      "clarification.resolve",
      { clarificationId: id.id, expectedVersion: id.version, resolutionCode: "confirmed_order", note: "Forged by a direct call." },
      "stf_maya",
    );
    expect(resolve.status).toBe(403);
    expect(resolve.body.error?.code).toBe("FORBIDDEN");
    const conflict = await postCommand(page, "sourceConflict.review", { taskId: "task_none", expectedVersion: 1, decision: "details_on_file_stand", reason: "Forged" }, "stf_maya");
    expect(conflict.status).toBe(403);
    expect(conflict.body.error?.code).toBe("FORBIDDEN");
    expect(clarificationState("CLR-0453")).toBe(state);
    // Only the refusals themselves are on record (who tried what), never a decision.
    expect(labEventsSince(before)).toEqual([
      { action: "command.denied", actor_id: "stf_maya" },
      { action: "command.denied", actor_id: "stf_maya" },
    ]);
  });

  for (const who of [LOGIN.admin, LOGIN.auditor] as const) {
    test(`the ${who === LOGIN.admin ? "laboratory administrator" : "auditor"} gets the 403 page on every bench screen and no bench data`, async ({ page }) => {
      await signIn(page, who, "/operations");
      await expect(page).toHaveURL(/\/forbidden$/);
      await expect(page.getByRole("heading", { level: 1, name: "Not allowed" })).toBeVisible();
      for (const path of BENCH_PAGES.filter((p) => p !== "/demo" && p !== "/")) {
        await page.goto(path);
        await expect(page, path).toHaveURL(/\/forbidden$/);
        await expect(page.getByRole("heading", { level: 1, name: "Not allowed" })).toBeVisible();
        await expectNoLabData(page);
      }
      // Stage 6 Phase F: the 403 page offers the top bar's Lock and Sign out (it has no app chrome), and "Go to your start
      // page" (like "/") leads to their own screen, the audit report, never back to the 403 page. Their top bar offers no
      // bench screen (every link would be a 403).
      await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      await page.getByRole("link", { name: "Go to your start page" }).click();
      await expect(page).toHaveURL(/\/audit$/);
      await expect(page.getByRole("heading", { level: 1, name: "Audit trail integrity" })).toBeVisible();
      await expect(page.getByRole("banner").getByRole("navigation", { name: "Main" })).toHaveCount(0);
      await page.goto("/");
      await expect(page).toHaveURL(/\/audit$/);
      await expectNoLabData(page);
      const csv = await page.evaluate(async (actor) => {
        const res = await fetch("/api/worklist/export", { method: "POST", headers: { "Content-Type": "application/json", "X-HLOS-Actor": actor }, body: JSON.stringify({ view: "histotech", filters: {} }) });
        return { status: res.status, type: res.headers.get("content-type") };
      }, who === LOGIN.admin ? "stf_test_admin" : "stf_test_auditor");
      expect(csv.status).toBe(403);
      expect(csv.type).not.toContain("text/csv");
      // No bench data reaches these roles through the shell or /api/live either (counts, clock, source health).
      const leaks = await page.evaluate(async () => {
        const rsc = await (await fetch("/intake", { headers: { RSC: "1" } })).text();
        const live = await fetch("/api/live");
        return { rsc, liveStatus: live.status, live: await live.text() };
      });
      expect(leaks.liveStatus).toBe(403);
      for (const text of [leaks.rsc, leaks.live, await page.content()]) {
        expect(text).not.toMatch(/EMA-SIM|OTHER-EHR-SIM|Sunrise Coast|"counts":\{"intake":\d|"auditSeq":[1-9]/);
      }
    });
  }

  for (const [login, reason, text] of [
    [LOGIN.stranger, "unlinked", "not linked to a staff record in this laboratory"],
    [LOGIN.otherlab, "wrong_lab", "Your account belongs to a different laboratory."],
  ] as const) {
    test(`${login === LOGIN.stranger ? "an unlinked user" : "a user whose lab claim names another laboratory"} is denied at sign-in: no session, no data, audited`, async ({ page, context }) => {
      const before = auditHead();
      await page.goto("/intake");
      await page.getByRole("link", { name: "Sign in with your organization account" }).click();
      await providerLogin(page, login);
      await expect(page).toHaveURL(new RegExp(`/no-access\\?reason=${reason}$`));
      await expect(page.getByRole("heading", { level: 1, name: "No access to this laboratory" })).toBeVisible();
      await expect(page.getByRole("main")).toContainText(text);
      await expectNoLabData(page);
      expect((await context.cookies()).some((c) => c.name === "hlos_session")).toBe(false);
      const denied = db().prepare("SELECT reason FROM audit_event WHERE seq > ? AND action = 'auth.denied'").all(before) as { reason: string }[];
      expect(denied).toEqual([{ reason }]);
      await page.goto(`/intake?item=${ITEM}`);
      await expect(page).toHaveURL(/\/signin\?returnTo=/);
    });
  }

  test("Lock: the page content leaves the DOM (no patient, case or operator details), and Unlock as the same person returns to the same page", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, "/clarifications?selected=CLR-0453");
    await expect(page.getByRole("region", { name: /^Identity conflict question: INT-1014-022/ })).toContainText("Tobias Kettering");
    const before = await sessionRow(context);

    await sessionGroup(page).getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expectNoLabData(page, ["Kim Nguyen", "CLR-0453", "Harbor Point"]);
    await expect(page).toHaveTitle(/^Workstation locked/);
    await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out / switch user" })).toBeVisible();
    // The server session is locked too: a read API with this browser's cookie gets nothing.
    await expect.poll(async () => (await sessionRow(context)).locked_at).not.toBeNull();
    const live = await page.evaluate(async () => {
      const r = await fetch("/api/live");
      return { status: r.status, body: await r.json() };
    });
    expect(live.status).toBe(401);
    expect(live.body.error.code).toBe("SESSION_LOCKED");

    await page.getByRole("button", { name: "Unlock" }).click();
    await providerLogin(page, LOGIN.kim);
    await expect(page).toHaveURL("/clarifications?selected=CLR-0453");
    await expect(page.getByRole("region", { name: /^Identity conflict question: INT-1014-022/ })).toContainText("Tobias Kettering");
    await expect(sessionGroup(page).getByRole("note", { name: "Signed in: Kim Nguyen, Accessioning lead" })).toBeVisible();
    // The same session, unlocked by the fresh sign-in.
    const after = await sessionRow(context);
    expect(after.id_hash).toBe(before.id_hash);
    expect(after.locked_at).toBeNull();
    expect(after.revoked_at).toBeNull();
  });

  test("after a lock, the Back button and the browser cache reveal nothing (pages are no-store and the server decides)", async ({ page }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const first = await page.goto(`/intake?item=${ITEM}`);
    expect(first?.headers()["cache-control"]).toContain("no-store");
    await expectItemShown(page);
    await page.goto("/clarifications?selected=CLR-0453");
    await expect(page.getByRole("region", { name: /^Identity conflict question: INT-1014-022/ })).toBeVisible();

    await sessionGroup(page).getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible();
    await expectNoLabData(page);

    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible();
    await expect(page).toHaveURL(/\/signin\?.*reason=locked/);
    await expectNoLabData(page, ["Kim Nguyen"]);
    await page.goForward();
    await expect(page.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible();
    await expectNoLabData(page, ["Kim Nguyen"]);
  });

  test("idle: background polling never counts as activity, real input does (heartbeat), and the client timer locks after HLOS_SESSION_IDLE_MIN here and on the server", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    await page.clock.install();
    await page.reload();
    await expectItemShown(page);
    const lastActivity = async () => (db().prepare("SELECT last_activity_at FROM auth_session WHERE id_hash = ?").get((await sessionRow(context)).id_hash) as { last_activity_at: string }).last_activity_at;
    const loaded = await lastActivity();
    // 40 s of polling (/api/live every 2.5 s, the session every 15 s) and no input: the server sees no activity.
    await page.clock.fastForward("00:40");
    await page.waitForTimeout(1500);
    expect(await lastActivity()).toBe(loaded);
    // Real input that makes no request of its own (a bare Shift key): the client tells the server (POST /api/auth/activity).
    const heartbeat = page.waitForRequest((r) => r.url().endsWith("/api/auth/activity") && r.method() === "POST");
    await page.keyboard.press("Shift");
    await heartbeat;
    await expect.poll(lastActivity).not.toBe(loaded);
    await expectItemShown(page);
    // Then 2 min 10 s without input (HLOS_SESSION_IDLE_MIN=2): the client locks, then the server session.
    await page.clock.fastForward("01:30");
    await expectItemShown(page);
    await page.clock.fastForward("00:40");
    await expect(page.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible();
    await expectNoLabData(page, ["Kim Nguyen"]);
    await expect.poll(async () => (await sessionRow(context)).locked_at).not.toBeNull();
  });

  test("Sign out / switch user on the lock screen ends the session; the next person signs in with their own account", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const kim = await sessionRow(context);
    await sessionGroup(page).getByRole("button", { name: "Lock" }).click();
    await page.getByRole("button", { name: "Sign out / switch user" }).click();
    await page.getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    const ended = db().prepare("SELECT revoked_reason FROM auth_session WHERE id_hash = ?").get(kim.id_hash) as { revoked_reason: string };
    expect(ended.revoked_reason).toBe("signed_out");
    // The provider session ended too: the next sign-in asks who it is.
    await page.getByRole("link", { name: "Sign in again" }).click();
    await providerLogin(page, LOGIN.maya);
    await expect(sessionGroup(page).getByRole("note", { name: "Signed in: Maya Torres, Accessioner" })).toBeVisible();
  });

  test("sign-out with the provider's logout declined: the provider's session opens nothing, the next sign-in shows the login form", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const kim = await sessionRow(context);
    await sessionGroup(page).getByRole("button", { name: "Lock" }).click();
    await page.getByRole("button", { name: "Sign out / switch user" }).click();
    // At the provider's own sign-out page the person at the keyboard declines: the provider keeps Kim's session.
    await page.getByRole("button", { name: "No, stay signed in" }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    const ended = db().prepare("SELECT revoked_reason FROM auth_session WHERE id_hash = ?").get(kim.id_hash) as { revoked_reason: string };
    expect(ended.revoked_reason).toBe("signed_out");
    // "Sign in again" (and the sign-in page) must not come straight back in as Kim: the provider asks who it is.
    await page.getByRole("link", { name: "Sign in again" }).click();
    await providerLogin(page, LOGIN.kim);
    await expect(sessionGroup(page).getByRole("note", { name: "Signed in: Kim Nguyen, Accessioning lead" })).toBeVisible();
    const again = await sessionRow(context);
    expect(again.id_hash).not.toBe(kim.id_hash);
    expect(Date.now() - Date.parse(again.auth_time)).toBeLessThan(60_000);
    // The same from the plain sign-in page after a lock (no session cookie involved in the decision).
    await sessionGroup(page).getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "No, stay signed in" }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    await page.goto(`/intake?item=${ITEM}`);
    await expect(page).toHaveURL(/\/signin\?returnTo=/);
    await page.getByRole("link", { name: "Sign in with your organization account" }).click();
    await providerLogin(page, LOGIN.maya);
    await expect(sessionGroup(page).getByRole("note", { name: "Signed in: Maya Torres, Accessioner" })).toBeVisible();
  });

  test("a session revoked on the server (administrator): the page content leaves the screen at once, typed input included", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const TEXT = "Typed before the administrator revoked the session.";
    await typeWorkingNote(page, TEXT);
    const row = await sessionRow(context);
    db().prepare("UPDATE auth_session SET revoked_at = ?, revoked_reason = 'admin_revoked' WHERE id_hash = ?").run(new Date().toISOString(), row.id_hash);
    // The next background check (/api/live every 2.5 s) learns it: nothing stays on screen.
    await expect(page.getByRole("heading", { level: 1, name: "Session ended" })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page).toHaveTitle(/^Session ended/);
    await expectNoLabData(page, ["Kim Nguyen", TEXT, "CLR-0453"]);
    await expect(page.getByRole("link", { name: "Sign in again" })).toBeVisible();
  });

  test("a background refresh (router.refresh() after someone else's change) is not activity on the server; a full page load is", async ({ page, context, browser }) => {
    await signIn(page, LOGIN.kim, "/worklist?view=histotech");
    await expect(sessionGroup(page)).toBeVisible();
    const row = await sessionRow(context);
    const last = () => (db().prepare("SELECT last_activity_at FROM auth_session WHERE id_hash = ?").get(row.id_hash) as { last_activity_at: string }).last_activity_at;
    const aged = new Date(Date.now() - 60_000).toISOString();
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(aged, row.id_hash);
    // Kim's open page refreshes itself (an RSC request, not a prefetch) when Maya records a change elsewhere.
    const refreshed = page.waitForRequest(
      (r) => r.method() === "GET" && r.headers()["rsc"] === "1" && !r.headers()["next-router-prefetch"] && new URL(r.url()).pathname === "/worklist",
    );
    const other = await newWorkstation(browser);
    const maya = await other.newPage();
    await signIn(maya, LOGIN.maya, "/worklist?view=histotech");
    await page.bringToFront();
    const saved = await postCommand(maya, "worklist.saveFilter", { name: "Synthetic refresh probe", view: "histotech", filters: {} }, "stf_maya");
    expect(saved.status).toBe(200);
    await refreshed;
    await page.waitForTimeout(1000);
    expect(last()).toBe(aged);
    await other.close();
    // A full page load is the person doing something.
    await page.reload();
    await expect(sessionGroup(page)).toBeVisible();
    await expect.poll(last).not.toBe(aged);
  });

  test("a different person unlocking takes the workstation over: the previous session ends and the same screen comes back as theirs", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const kim = await sessionRow(context);
    await sessionGroup(page).getByRole("button", { name: "Lock" }).click();
    await page.getByRole("button", { name: "Unlock" }).click();
    await providerLogin(page, LOGIN.maya);
    await expect(page).toHaveURL(`/intake?item=${ITEM}`);
    await expect(sessionGroup(page).getByRole("note", { name: "Signed in: Maya Torres, Accessioner" })).toBeVisible();
    await expectItemShown(page);
    const ended = db().prepare("SELECT revoked_reason FROM auth_session WHERE id_hash = ?").get(kim.id_hash) as { revoked_reason: string };
    expect(ended.revoked_reason).toBe("handover");
    expect((await sessionRow(context)).staff_id).toBe("stf_maya");
  });

  test("the server answers SESSION_LOCKED to a change (idle on the server): the screen locks, says it was not recorded, and every tab of this browser locks", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const second = await context.newPage();
    await second.goto("/worklist?view=histotech");
    await expect(sessionGroup(second)).toBeVisible();
    // Only the change itself may meet the lock (the background checks would find it first otherwise).
    await page.route(/\/api\/(live|auth\/session)(\?|$)/, (route) => route.abort());
    const { save } = await typeWorkingNote(page, "Typed after the server's idle window.");
    const notesBefore = itemNotes();
    // Time travel for the server: the last user-driven request was 3 minutes ago (HLOS_SESSION_IDLE_MIN=2).
    const row = await sessionRow(context);
    db().prepare("UPDATE auth_session SET last_activity_at = ? WHERE id_hash = ?").run(new Date(Date.now() - 3 * 60_000).toISOString(), row.id_hash);
    const before = auditHead();
    await save.click();
    await expect(page.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Your last action was not recorded.");
    await expectNoLabData(page, ["Kim Nguyen"]);
    expect(itemNotes()).toBe(notesBefore);
    expect(labEventsSince(before)).toEqual([]);
    expect((await sessionRow(context)).locked_at).not.toBeNull();
    // The other tab locks too, without waiting for its own checks.
    await expect(second.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible({ timeout: 3_000 });
    await expectNoLabData(second, ["Kim Nguyen"]);
    await second.close();
  });

  test("the worklist CSV export works in secured mode: it carries the page's actor and records the snapshot as the signed-in person", async ({ page }) => {
    await signIn(page, LOGIN.kim, "/worklist?view=histotech");
    const before = auditHead();
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/worklist/export") && r.method() === "POST");
    const download = page.waitForEvent("download");
    await page.getByRole("main").getByRole("button", { name: "Download CSV" }).click();
    expect((await sent).headers()["x-hlos-actor"]).toBe("stf_kim");
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    expect(labEventsSince(before).map((e) => [e.action, e.actor_id])).toContainEqual(["worklist.snapshot", "stf_kim"]);
  });

  test("hand-over: a screen opened as Kim, after Maya signs in on the same workstation in another tab, is refused on submit (ACTOR_MISMATCH) and nothing is recorded", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const kimSession = await sessionRow(context);
    const { save } = await typeWorkingNote(page, "Typed by Kim before the hand-over.");
    const notesBefore = itemNotes();
    const before = auditHead();

    const other = await context.newPage();
    await other.goto("/api/auth/login?returnTo=%2Fintake");
    await providerLogin(other, LOGIN.maya);
    await expect(other).toHaveURL("/intake");
    await expect(sessionGroup(other).getByRole("note", { name: "Signed in: Maya Torres, Accessioner" })).toBeVisible();
    expect((await sessionRow(context)).staff_id).toBe("stf_maya");
    const kimNow = db().prepare("SELECT revoked_at, revoked_reason FROM auth_session WHERE id_hash = ?").get(kimSession.id_hash) as { revoked_at: string | null; revoked_reason: string };
    expect(kimNow.revoked_reason).toBe("handover");

    // Kim's tab is not silently re-rendered for Maya: it says who is signed in now.
    await page.bringToFront();
    await expect(page.getByRole("alert", { name: "This screen was opened by another user" })).toContainText("Reload to continue as Maya Torres.");
    await expect(intakeNote(page).getByRole("textbox", { name: "Working note" })).toHaveValue("Typed by Kim before the hand-over.");
    await save.click();
    const error = intakeNote(page).getByRole("alert");
    await expect(error).toContainText("This screen was opened by another user. Nothing was recorded. Reload to continue as Maya Torres.");
    await expect(error.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(itemNotes()).toBe(notesBefore);
    expect(labEventsSince(before)).toEqual([]);

    // Reload continues as the person signed in now.
    page.on("dialog", (d) => void d.accept());
    await error.getByRole("button", { name: "Reload" }).click();
    await expect(sessionGroup(page).getByRole("note", { name: "Signed in: Maya Torres, Accessioner" })).toBeVisible();
    await other.close();
  });

  test("a sensitive decision after the re-authentication window asks 'Confirm it's you', keeps the input, replays nothing, then succeeds after signing in again", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, "/clarifications?selected=CLR-0453");
    const panel = page.getByRole("region", { name: /^Identity conflict question: INT-1014-022/ });
    const decision = panel.getByRole("complementary", { name: "Decision" });
    // Reviewing the answer is not sensitive.
    const reviewSlot = panel.getByRole("list", { name: /^Conversation with Harbor Point Dermatology/ }).getByRole("listitem").filter({ hasText: "Review by Kim Nguyen" });
    await reviewSlot.getByLabel(/^Review note/).fill("Office says the bottle's date of birth was miswritten; name and MRN match the order.");
    await decision.getByRole("button", { name: "Mark answer reviewed" }).click();
    await expect(decision.getByRole("heading", { level: 3, name: "Resolve CLR-0453" })).toBeVisible();
    expect(clarificationState("CLR-0453")).toBe("reviewed");

    // The last sign-in at the provider was 10 minutes ago (HLOS_REAUTH_MAX_AGE_MIN=5).
    await ageLastSignIn(context, 10);
    const before = auditHead();
    await decision.getByRole("button", { name: "Resolve", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Resolve CLR-0453?" });
    const NOTE = "Office confirmed the patient on order ORD-75469; the bottle's date of birth was written incorrectly.";
    await dialog.getByRole("textbox", { name: /^Resolution note/ }).fill(NOTE);
    await dialog.getByRole("button", { name: "Resolve, keep hold" }).click();
    const error = dialog.getByRole("alert");
    await expect(error).toContainText("Confirm it's you: This decision needs a recent sign-in. Nothing was recorded.");
    expect(clarificationState("CLR-0453")).toBe("reviewed");
    expect(labEventsSince(before).filter((e) => e.action !== "command.denied")).toEqual([]);

    const popupPromise = page.waitForEvent("popup");
    await error.getByRole("button", { name: "Confirm it's you" }).click();
    const popup = await popupPromise;
    await providerLogin(popup, LOGIN.kim);
    await popup.waitForEvent("close");
    await expect(dialog.getByRole("status")).toContainText("Confirmed. Press the button again to record it.");
    // Nothing was replayed: still not resolved, and the typed note is still there.
    expect(clarificationState("CLR-0453")).toBe("reviewed");
    await expect(dialog.getByRole("textbox", { name: /^Resolution note/ })).toHaveValue(NOTE);
    const row = await sessionRow(context);
    expect(Date.now() - Date.parse(row.auth_time)).toBeLessThan(60_000);

    await dialog.getByRole("button", { name: "Resolve, keep hold" }).click();
    await expect(dialog).toBeHidden();
    await expect(panel).toContainText("Resolved by Kim Nguyen");
    expect(clarificationState("CLR-0453")).toBe("resolved");
    expect(labEventsSince(before).map((e) => [e.action, e.actor_id])).toContainEqual(["clarification.resolved", "stf_kim"]);
  });

  test("an expired session during a change: the screen says nothing was recorded, keeps the typed text, and offers sign-in", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const TEXT = "Typed while the session ran out.";
    const { note, save, card } = await typeWorkingNote(page, TEXT);
    const notesBefore = itemNotes();
    await expireSession(context);
    const before = auditHead();
    await save.click();
    const error = card.getByRole("alert");
    await expect(error).toContainText("Your session has ended: Nothing was recorded. Sign in again to continue; what you entered stays on this screen.");
    await expect(page.getByRole("alert", { name: "Your session has ended" })).toContainText("Nothing was recorded.");
    await expect(note).toHaveValue(TEXT);
    expect(itemNotes()).toBe(notesBefore);
    expect(labEventsSince(before)).toEqual([]);

    // Signing in again (pop-up; every sign-in asks at the provider, even while it still knows Kim) keeps the page;
    // pressing Save again records it.
    const popupPromise = page.waitForEvent("popup");
    await error.getByRole("button", { name: "Sign in again" }).click();
    const popup = await popupPromise;
    await providerLogin(popup, LOGIN.kim);
    await popup.waitForEvent("close");
    await expect(card.getByRole("status")).toContainText("Signed in again. Press the button again to record it.");
    await expect(note).toHaveValue(TEXT);
    await expect(page.getByRole("alert", { name: "Your session has ended" })).toHaveCount(0);
    await save.click();
    await expect(card.getByRole("textbox", { name: "Working note" })).toHaveCount(0);
    expect(itemNotes()).toBe(TEXT);
  });

  test("sign-out ends the session: the old cookie gets 401, Back shows nothing", async ({ page, context, request }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    const cookie = await sessionCookie(context);
    const before = auditHead();
    await sessionGroup(page).getByRole("button", { name: "Sign out" }).click();
    // The provider's own sign-out page (RP-initiated logout), then back to this application.
    await page.getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    await expect(page.getByRole("heading", { level: 1, name: "Signed out" })).toBeVisible();
    expect((await context.cookies()).some((c) => c.name === "hlos_session")).toBe(false);
    const signedOut = db().prepare("SELECT actor_id FROM audit_event WHERE seq > ? AND action = 'auth.signed_out'").all(before);
    expect(signedOut).toEqual([{ actor_id: "stf_kim" }]);

    const old = await request.get("/api/live", { headers: { cookie: `hlos_session=${cookie}` } });
    expect(old.status()).toBe(401);
    expect((await old.json()).error.code).toBe("SIGN_IN_REQUIRED");

    await page.goBack();
    await page.waitForLoadState();
    await expectNoLabData(page, ["Kim Nguyen"]);
    await page.goto(`/intake?item=${ITEM}`);
    await expect(page).toHaveURL(/\/signin\?returnTo=/);
  });

  // Stage 6 Phase C4 (shared workstation): a second tab left open must not keep showing the patient after sign-out.
  test("sign-out in one tab clears every other tab of this browser at once: no patient, case or operator details stay in their DOM", async ({ page, context }) => {
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    await expectItemShown(page);
    const second = await context.newPage();
    await second.goto("/clarifications?selected=CLR-0453");
    await expect(second.getByRole("region", { name: /^Identity conflict question: INT-1014-022/ })).toContainText("Tobias Kettering");
    // Only the sign-out broadcast may clear the second tab: its own background checks cannot reach the server.
    await second.route(/\/api\/(live|auth\/session)(\?|$)/, (route) => route.abort());
    await sessionGroup(page).getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    await expect(second.getByRole("heading", { level: 1, name: "Signed out" })).toBeVisible({ timeout: 3_000 });
    await expect(second).toHaveTitle(/^Signed out/);
    await expectNoLabData(second, ["Kim Nguyen", "CLR-0453", "Harbor Point", "Tobias"]);
    await second.close();
  });

  test("the 403 page's Lock locks the session on the server, and its Sign out ends it (a shared workstation is never left signed in)", async ({ page, context, browser }) => {
    await signIn(page, LOGIN.admin, "/operations");
    await expect(page).toHaveURL(/\/forbidden$/);
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page).toHaveURL(/\/signin\?reason=locked/);
    await expect(page.getByRole("heading", { level: 1, name: "Workstation locked" })).toBeVisible();
    await expect.poll(async () => (await sessionRow(context)).locked_at).not.toBeNull();

    const other = await newWorkstation(browser);
    const second = await other.newPage();
    await signIn(second, LOGIN.auditor, "/operations");
    await expect(second).toHaveURL(/\/forbidden$/);
    const auditor = await sessionRow(other);
    await second.getByRole("button", { name: "Sign out" }).click();
    await second.getByRole("button", { name: "Yes, sign me out" }).click();
    await expect(second).toHaveURL(/\/signed-out$/);
    const ended = db().prepare("SELECT revoked_reason FROM auth_session WHERE id_hash = ?").get(auditor.id_hash) as { revoked_reason: string };
    expect(ended.revoked_reason).toBe("signed_out");
    await other.close();
  });

  test("at 200% zoom (720x450) the signed-in top bar keeps its two rows: every control sits inside the bar, the scan target whole", async ({ browser, baseURL }) => {
    const zoomed = await browser.newContext({ baseURL, viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    await loopbackOnly(zoomed);
    const page = await zoomed.newPage();
    await signIn(page, LOGIN.kim, `/intake?item=${ITEM}`);
    await expect(sessionGroup(page).getByRole("button", { name: "Sign out" })).toBeVisible();
    const outside = await page.evaluate(() => {
      const bar = document.querySelector("header[data-shell-chrome]")!.getBoundingClientRect();
      const label = document.querySelector('label[for="scan-field"] span[title]') as HTMLElement | null;
      return {
        height: Math.round(bar.height),
        outside: [...document.querySelectorAll<HTMLElement>("header[data-shell-chrome] a[href], header[data-shell-chrome] button, header[data-shell-chrome] input")]
          .filter((el) => el.getBoundingClientRect().width > 2 && !el.closest(".sr-only"))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5 || r.right > document.documentElement.clientWidth + 0.5;
          })
          .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName),
        targetCut: !label || label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1,
      };
    });
    expect(outside).toEqual({ height: 102, outside: [], targetCut: false });
    await zoomed.close();
  });

  test("the identity provider unavailable: sign-in fails closed with a clear message and shows no data", async ({ page, request }) => {
    expect(DOWN_URL).toMatch(/^http:\/\/localhost:\d+$/);
    await page.goto(`${DOWN_URL}/intake?item=${ITEM}`);
    await expect(page).toHaveURL(/\/signin\?returnTo=/);
    await page.getByRole("link", { name: "Sign in with your organization account" }).click();
    await expect(page).toHaveURL(/\/signin\?error=provider_unavailable/);
    await expect(page.getByRole("alert")).toContainText("The sign-in service could not be reached. Nothing was signed in.");
    await expectNoLabData(page, ["Kim Nguyen"]);
    expect((await page.context().cookies(DOWN_URL)).some((c) => c.name === "hlos_session")).toBe(false);
    const live = await request.get(`${DOWN_URL}/api/live`);
    expect(live.status()).toBe(401);
  });
});
