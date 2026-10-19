# Demo runbook (release candidate)

*Synthetic data, simulated connectors. Every name, MRN, office and case is fictional. Nothing in this demo connects to a real laboratory system. The longer talk track is [docs/demo-script.md](../demo-script.md); this page is the operator's checklist. Where the two differ, trust the console.*

## 1. Start it
Node 22 or later.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

- `npm start` runs `HLOS_MODE=demo next start -p 3100`. Open http://localhost:3100.
- `npm run dev` also runs in demo mode, because `next dev` defaults to demo.
- **Never** present from `npm run start:locked`. That is the fail-closed build: every change is refused, the role switch is off, and `/demo` is a 404. It exists to show that a build without `HLOS_MODE=demo` cannot be used as a write path.

The database is `data/histology-lab-os.db`, or `HLOS_DB_PATH` when set. It is created and seeded on first use.

## 2. Reset before every run
1. Open the **presenter console**: the "Console" link at the right of the top bar, or `/demo`.
2. Press **Reset demo** in the toolbar, then **Reset demo data** in the confirmation. The same control is on the **Outages and reset** tab.
3. Expect:
   - "0 of 8 steps done";
   - demo clock **10:52 AM ET, paused**;
   - every simulated connector back to its starting state (sources connected, printers online, notifications on).
4. **Role and clock** tab: set **Acting as** to **Maya Torres, Accessioner**. The top bar's read-only note names the same person. A reset does not change the role.
5. Leave browser zoom at 100%. For a large room use **Presenter text size** in the console toolbar. It enlarges only the guide and the notes.

Alternative from a terminal (stop the server first):

```bash
npm run db:reset
```

## 3. The eight guided steps
Open the **Guide** tab (`/demo?tab=guide&step=1`). Each step names the role, the screen and what to click. **Run simulator events for this step** does only what the outside world would do, and moves the clock forward. Progress is read from the records, so a step reads as done whether you clicked through the real screens or used the rehearsal button.

| Step | Role | Screen | Done when (from the records) |
|---|---|---|---|
| 1. Courier arrival | Maya | Intake | Arrival recorded (CR-1014-11); containers unpacked; part A routing suggested from the approved rule |
| 2. Related orders (REL-0112) | Maya, then Kim Nguyen (lead) | Intake | The candidate was reviewed by a person; nothing was merged |
| 3. Part B clarification | Maya raises and sends; Kim reviews, resolves and releases | Intake, then Clarify | The clarification was raised; the hold is on part B only; the simulated office answered; the answer was reviewed, then resolved; the hold was released **after** the amended order arrived |
| 4. Accession | Maya | Intake | The simulated source issued the official accession |
| 5. Gross record, part A | Dana (grosser) | Gross | Started, then approved for downstream use |
| 6. Tray and printer | Priya (histotech) | Materials | 9th slide scanned; unexpected slide flagged; PJ-8841 reconciled |
| 7. Block retrieval RR-0192 | Priya | Materials | Wrong block rejected (mismatch logged); requested block matched |
| 8. Operations review | Tanya Brooks or the Director (read only) | Operations | Steps 1 to 7 are done; Operations lists what is still blocked |

## 4. Show an outage on purpose (optional)
On **Outages and reset**:

- **Source systems.** Set EMA-SIM offline. The top bar's freshness turns amber, and open worklists say their data may be stale. Messages due during the outage wait in the outbox. Set it back to connected (or press "Deliver queued source messages now"); each queued message is imported exactly once.
- **Label printers.** Offline keeps jobs queued. A timeout after submission leaves the outcome unknown, and no reprint is allowed until someone reconciles it.
- **Office notifications.** Failures leave a clarification "delivery failed" or "unknown", never "delivered".
- **Drafting and extraction assistant.** When unavailable, the grosser enters and confirms values by hand.

Restore each one before continuing the main story.

## 5. World events (instead of bench buttons)
The **World events** tab holds everything the outside world does. No bench screen has these buttons:

- unpacking a courier bag;
- a colleague's edit;
- the office answering a clarification;
- the source acknowledging a gross entry;
- printer behaviour.

Each picker lists only records the event can act on now. The server still checks everything.

Unpacking from the console is recorded as received by the **acting role**, because it is the lab-audience command `intake.receivePhysicalItem`. The console says so.

## 6. If something goes wrong
| Symptom | Fix |
|---|---|
| A button is missing or refused | The server checks the role. Switch **Acting as** on Role and clock to the step's role. |
| The office never answers (step 3) | Was the clarification sent? If its delivery failed, restore notifications on Outages and reset, resend, then run the step 3 simulator events again. |
| The amended order does not arrive | EMA-SIM is offline. Set it back to connected on Outages and reset. |
| The hold release is refused | You are acting as an accessioner. Switch to Kim Nguyen. |
| Anything else | **Reset demo**, then use the rehearsal button on each earlier step (acting as Tanya Brooks) to catch up. |

## 7. Say this, every time
- It is a **synthetic demonstration**. The connectors are simulated and no real patient data is used.
- "Acting as" is a **demo role switch, not a sign-in**. There is no authentication; see [security-privacy.md](security-privacy.md).
- Passing tests are **not clinical validation**, and nothing here is a claim of HIPAA, CLIA, CAP or FDA compliance.
