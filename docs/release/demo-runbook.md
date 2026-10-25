# Demo runbook: presenting on Jorge's laptop

*Updated 2026-10-24 for the app as it is today (branch `stage-6-production-foundation`). Prepared by Jorge Rodriguez for presenting to the Director of Operations, Platinum Dermatology. Synthetic data, simulated connectors. Every name, MRN, office, laboratory and case in the app is fictional ("Lumen Bay Dermatopathology Laboratory (fictional)"). Nothing in this demo connects to EMA, a lab network or patient information. The longer talk track is [docs/demo-script.md](../demo-script.md); this page is the operator's checklist. Where the two differ, trust the console.*

> **Mandatory caveat. Say it at the start and leave it visible on screen.**
>
> **This demonstration uses synthetic data and simulated connectors. It does not show clinical performance or a production integration.** No one has endorsed, approved, funded, purchased or partnered on this work, and showing it is not a request for a purchase or for system access. Passing tests are not clinical validation, and nothing here is a claim of HIPAA, CLIA, CAP or FDA compliance.

## 1. Presenting from a production build (recommended)
Use a production build for the meeting, not `npm run dev`. It is what the automated browser tests run against, every screen opens at full speed (the development server compiles each screen the first time it is opened), and it runs in synthetic demo mode only.

Node 22 or later. In the project folder, the day before:

```bash
npm install
```

```bash
npm run build
```

Then, before the meeting:

```bash
npm start
```

- `npm start` runs `HLOS_MODE=demo next start -p 3100`. Open http://localhost:3100/demo.
- Rebuild (`npm run build`) after any code change. A build only has to be made once per change; it does not touch the demo data.
- The database is `data/histology-lab-os.db` (or `HLOS_DB_PATH` when set). It is created and seeded with the synthetic day on first use.
- **Reset before the meeting** (section 2). The quickest way from a terminal, with the server stopped:

  ```bash
  npm run db:reset
  ```

  then `npm start` again. Or press **Reset demo** in the presenter console while it runs.
- `npm run dev` also runs in demo mode. Keep it for practice only: in development mode the first opening of each screen is slow, and under automation one Intake button (Accept routing, step 1) kept re-rendering so the click could not land. That was also true of the code before this update, and it does not happen in the production build, where the eight-step journey passes.
- **Never** run the main demo from `npm run start:locked`. That is the fail-closed build (section 5.3). It shows no data at all.

The laptop: close EMA, work email and anything with patient or employer information, in tabs and bookmarks too. Turn off pop-up notifications. Browser window 1366 × 768 or larger, zoom 100%.

## 2. Reset before every run
1. Open the **presenter console**: the "Console" link at the right of the top bar, or `/demo`.
2. Press **Reset demo** in the toolbar, then **Reset demo data** in the confirmation. The same control is on the **Outages and reset** tab.
3. Expect:
   - "0 of 8 steps done";
   - demo clock **10:52 AM ET, paused**;
   - every simulated connector back to its starting state (sources connected, printers online, notifications on).
4. **Role and clock** tab: set **Acting as** to **Maya Torres, Accessioner**. The top bar's read-only note ("Demo role: Maya, Accessioner") names the same person. A reset does not change the role.
5. Leave browser zoom at 100%. For a large room use **Presenter text size** in the console toolbar. It enlarges only the guide and the notes.

## 3. The eight guided steps
Open the **Guide** tab (`/demo?tab=guide&step=1`). Each step names the role, the screen and what to click. **Run simulator events for this step** does only what the outside world would do, and moves the clock forward. Progress is read from the records, so a step reads as done whether you clicked through the real screens or used the rehearsal button.

**Checked against the screens on 2026-10-24.** The labels below are the ones on screen today. The automated director journey (`tests/e2e/director-journey.spec.ts`, 8 tests) clicks exactly this path on a fresh production build, as the named roles, and passed in the final run of the demo suite (section 8).

| Step | Acting as | Screen | Press (exact labels) | Done when (from the records) |
|---|---|---|---|---|
| 1. Courier arrival | Maya | Guide, then Intake | **Run simulator events for this step** (courier CR-1014-11 arrives, 11 items unpacked). On `/intake`, the **Courier manifest** strip. Open INT-1014-031: in the decision column, under **Also yours now** (press **Show it** if it is folded), **Accept routing to Dr. Elena Marsh**. The same on INT-1014-032. Open INT-1014-034: exceptions lane, no doctor suggested. | Arrival recorded; containers unpacked; part A routing suggested from rule set v3 |
| 2. Related orders (REL-0112) | Maya, then Kim Nguyen (lead) | Intake | As Maya on INT-1014-031: **Record: I checked this bottle against the order**. The **Related orders** card reads "Your demo role can view the candidate but not decide". Switch to Kim: the **REL-0112 side by side** comparison leads the page; choose **Link as related**, type a reason, then **Record decision** in the decision column. | The candidate was reviewed by a person; nothing was merged |
| 3. Part B clarification | Maya raises; Kim reviews, resolves and releases | Intake, then Clarify | On INT-1014-032: **Record: I checked this bottle against the order** (laterality "Differs"), then **Raise clarification** on that row; keep the hold box ticked (Part B only) and press **Raise clarification**, then **Open CLR-0457 in Clarifications**. Press **Send (simulated)**. Back on the guide: **Run simulator events for this step** (the office answers and amended order ORD-77121 v2 arrives). As Kim on CLR-0457: **Write review note**, type it, **Mark answer reviewed**, **Resolve**, then **Resolve, keep hold**; then **Release H-0090**, a reason, **Release hold**. | Raised; hold on part B only; answered (simulated); reviewed, then resolved; hold released **after** the amended order arrived |
| 4. Accession | Maya (or stay as Kim) | Intake, then the case | **Request accession for INT-1014-031 + INT-1014-032 together (simulated source)**. Then **Open case D26-04817**: Overview, Material, Source documents, Tasks, History. | The simulated source issued D26-04817 |
| 5. Gross record, part A | Dana Whitfield (grosser) | Gross, then Worklist | `/grossing?part=D26-04817-A`: **Attach transcript and extract** (dictation "quinlan-A"), **Confirm: …** on each of the 9 values, **Compose from confirmed values**, **Save draft**, **Mark operator reviewed**, **Approve for downstream use**. The Worklist row under Dr. Elena Marsh (teal) reads "A ready for processing · B awaiting gross". | Started, then approved for downstream use |
| 6. Tray and printer | Priya Shah (histotech) | Materials | Trays, TRY-M-03 ("8 of 10 expected slides scanned"): under **On the bench, not on the tray** (simulated scanner), **Scan** on D26-04747 A1-1 H&E L1, then on D26-04745 A1-1 H&E L1 (Dr. Okafor's). **Mark tray complete** stays unavailable: "Cannot complete: 1 not scanned, 1 unexpected." Print labels, PJ-8841: **Not printed**, then **Reprint with reason**, a reason, **Reprint with reason**. | 9th slide scanned; unexpected slide flagged; PJ-8841 reconciled (reprint PJ-8842 linked to it) |
| 7. Block retrieval RR-0192 | Priya | Materials | Retrieve blocks, RR-0192: read "Cabinet 2 Drawer 4 Box 11 … Slot 14 … Last confirmed by Marcus Lee" and the overdue D26-03912 A1. **Scan D26-03909 A1** (wrong block: "Wrong block: not accepted"), then **Scan D26-03990 B1** ("1 of 3 picked"). | Wrong block rejected (mismatch logged); requested block matched |
| 8. Operations review | Tanya Brooks or the Director (read only) | Guide, then Operations | **Run simulator events for this step** (clock 11:50). On `/operations`: the **Blocked now** table and the **Source-system entry** table; D26-04817 part A, "Sam Ortiz holds the entry task"; its evidence link opens the case's Tasks. | Steps 1 to 7 are done; Operations lists what is still blocked |

## 4. Show an outage on purpose (optional)
On **Outages and reset**:

- **Source systems.** Set EMA-SIM offline. The top bar's freshness turns amber, open worklists say their data may be stale, and `/integration` shows the source as unavailable with its last successful sync. Messages due during the outage wait in the outbox. Set it back to connected (or press "Deliver queued source messages now"); each queued message is imported exactly once.
- **Label printers.** Offline keeps jobs queued. A timeout after submission leaves the outcome unknown, and no reprint is allowed until someone reconciles it.
- **Office notifications.** Failures leave a clarification "delivery failed" or "unknown", never "delivered".
- **Drafting and extraction assistant.** When unavailable, the grosser enters and confirms values by hand.

Restore each one before continuing the main story.

## 5. Optional extras (only if there is time or a question)
Each takes about a minute. None is part of the eight steps; skip them freely.

### 5.1 `/integration`: what the simulated sources sent, against what the lab recorded
- Acting as Tanya Brooks (supervisor) or another bench role, open `/integration` (also linked from Operations).
- It is labelled **"Simulated: source systems"** and **"Simulated: source adapters"**. Right after a reset nothing needs a person. Once the courier is unpacked (step 1) it shows one item under **Needs review**: order ORD-77140 v1 expected two containers and one was received, so the accession for INT-1014-027 stays blocked until a person decides. "Source says sent" and "Received here" are shown separately.
- Say: "A message from the source never changes a specimen or a patient on its own. A difference waits here for a person." The sources are simulated. The real interface is something to confirm with ModMed (EMA is documented as sending orders as HL7 ORM and receiving results as HL7 ORU: https://www.modmed.com/synapsys/hl7/).
- The signed inbound endpoint and its 12-scenario simulator (`npm run integration:sim`) are for the automated tests. They are switched off in `npm start`; do not try them live.

### 5.2 The audit trail: `/audit` and its check
- `/audit` is the audit report for the **laboratory administrator and the auditor** roles, which exist only in the signed-in (secured) build. In the demo **no demo role can open it**: every demo role, even the supervisor, gets **"Not allowed"**. That refusal is itself a talking point: the server checks the role for every screen.
- To show the integrity check itself, open a second terminal window in the project folder (the server can keep running) and run:

  ```bash
  HLOS_MODE=demo npm run audit:verify
  ```

  Expect "Audit chain: VERIFIED", the number of events checked, and **"key id: demo-not-secret (the PUBLIC demo key: these seals prove nothing)"**. Say exactly that: in the demo the key is public, so the check shows how the mechanism works, not that this demo's history is protected. It prints counts and sequence numbers only, never event content.

### 5.3 The locked-build proof: no configuration, no data
1. Stop `npm start` (Ctrl+C) and run `npm run start:locked` (the same build, without `HLOS_MODE=demo` and without sign-in configured).
2. Open http://localhost:3100/intake. Every page goes to **"This build is not configured"**, with no lab data. `/demo` is not available. http://localhost:3100/api/live answers 401 with no data.
3. Say: "A build that is neither the synthetic demo nor configured for a real sign-in shows nothing and records nothing. The demo role switch exists only in demo mode." (The signed-in mode exists and is tested, but only against a local test identity provider; turning it on for real is blocked until a real identity provider and hosting exist.)
4. Stop it and run `npm start` again before going on.

## 6. World events (instead of bench buttons)
The **World events** tab holds everything the outside world does. No bench screen has these buttons:

- unpacking a courier bag;
- a colleague's edit;
- the office answering a clarification;
- the source acknowledging a gross entry;
- printer behaviour.

Each picker lists only records the event can act on now. The server still checks everything.

Unpacking from the console is recorded as received by the **acting role**, because it is the lab-audience command `intake.receivePhysicalItem`. The console says so.

## 7. If something goes wrong
| Symptom | Fix |
|---|---|
| A button is missing or refused | The server checks the role. Switch **Acting as** on Role and clock to the step's role. |
| "Accept routing" is not in sight (step 1) | It is under **Also yours now** in the decision column. Press **Show it** when the list is folded. |
| The office never answers (step 3) | Was the clarification sent? If its delivery failed, restore notifications on Outages and reset, resend, then run the step 3 simulator events again. |
| The amended order does not arrive | EMA-SIM is offline. Set it back to connected on Outages and reset. |
| The hold release is refused | You are acting as an accessioner. Switch to Kim Nguyen. |
| A screen is slow to open the first time | You are on `npm run dev`. Use the production build (section 1). |
| Anything else | **Reset demo**, then use the rehearsal button on each earlier step (acting as Tanya Brooks) to catch up. |

## 8. How this page was checked (2026-10-24)
- Every label in section 3 was compared with the screens and with `tests/e2e/director-journey.spec.ts`, which clicks the same path as the named roles on a fresh production build.
- Final runs on 2026-10-24, after the last code change, synthetic data only:
  - `npx tsc --noEmit`: clean;
  - `npx vitest run`: 642 passed, 0 failed;
  - demo browser suite, `E2E_TAG=p1 E2E_PORT=3501 npx playwright test` on a fresh production build: 139 passed, 0 failed (it includes the eight-step journey);
  - secured browser suite, `E2E_SECURED_TAG=p1s E2E_SECURED_PORT=3502 npm run test:e2e:secured` (a local test identity provider): 26 passed, 0 failed.
- Re-run independently later the same evening (2026-10-24, same uncommitted working tree, no code change in between): type check clean; `npx vitest run` 642 passed; demo browser suite on a fresh production build 139 passed; secured suite 26 passed. These are the numbers the presentation package quotes until the post-freeze run is recorded in a dated addendum to [verification-stage6.md](verification-stage6.md).
- Final run on 2026-10-24 (about 23:20), after the last code change (the server log line naming the settings that lock a secured build): type check clean; `npx vitest run` 643 passed; demo browser suite on a fresh production build 139 passed; secured suite 26 passed. Recorded in [verification-stage6.md](verification-stage6.md) section 7.

  Passing tests show that the code does what the tests say. They are not clinical validation.
- Section 5 was run by hand against a demo build: `/integration` after a reset, `/audit` (refused for every demo role), `HLOS_MODE=demo npm run audit:verify` (VERIFIED with the public demo key), and the locked build's refusals.
- **Not checked:** a projector, another browser than Chromium, a screen reader, paper printing, real scanners or printers.

## 9. Say this, every time
- It is a **synthetic demonstration**. The connectors are simulated and no real patient data is used.
- "Acting as" is a **demo role switch, not a sign-in**. Sign-in exists in the secured build and is tested only against a local test identity provider; it is not active anywhere. See [security-privacy.md](security-privacy.md).
- Passing tests are **not clinical validation**, and nothing here is a claim of HIPAA, CLIA, CAP or FDA compliance. Validation would be the laboratory's responsibility, under its own quality system, with the medical director's approval.
- The problems the demo addresses come from my own observations as an employee, not from measured rates.
