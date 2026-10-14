# Histology Lab OS: "Histology Redesigned"

> **Synthetic local demonstration.** Every patient, office, clinician, staff member and identifier in this app is fictional. It is not connected to any real system, it must never hold real patient data, and it is not for patient care. No laboratory, director, physician or vendor has endorsed, approved, purchased or partnered on it.

---

## What this is

Histology Lab OS ("Histology Redesigned") is a working local demonstration of an **operational coordination and specimen-tracking companion** for a dermatopathology lab. It runs alongside the lab's existing EHR/LIS and does not replace it. It was built for Jorge Rodriguez, a histology assistant, so he can show one idea to his Director of Operations and medical director. It starts from his own employee observations. These observations are not audited findings or measured rates. The demo follows one multipart case through the day: arrival and reconciliation, routing each office to its dermatopathologist, specimen-specific clarifications with an owner, a live digital doctor/PAS worklist that does the information job of the printed daily report ("the bible"), and grossing records that move on one part at a time. It also has smaller print-queue, tray and block-retrieval demonstrations. The official accession, orders, gross report and diagnosis stay in the authoritative system. In this demo that system is a local simulator called **EMA-SIM**. Existing products already cover parts of this space, among them ModMed's own pathology software [R1], Leica CEREBRO [R10], Milestone MacroPATH [R11] and Epredia slide printers [R12]. The project does not claim to have invented specimen tracking.

## What it is NOT

- **Not connected to anything real.** The source system, offices, notifications, printers, scanners and the AI assistant are all simulated locally. ModMed documents APIs and HL7 interfaces [R2][R3][R4], but this project did not use any of them, and the documentation does not show what any particular lab can access.
- **Not real data.** Everything comes from a reproducible synthetic seed. About 60 cases and more than 300 slides are illustrative values. They do not model any lab's case mix.
- **Not for patient care.** It is not clinically validated, not a medical device and not a compliance tool. A disclaimer does not make a prototype compliant.
- **No authentication.** The "Acting as" selector in the top bar is a **demo role switch**. It has no sign-in and no password, and anyone can pick any role. The server still checks the chosen role's permissions on every action, so you can see what each role is allowed to do.
- **No AI model.** The drafting and extraction "assistant" uses fixed rules that give the same output for the same input, and the screens say so. No API key is needed.
- **Not an endorsement.** Nothing here implies approval, procurement, access permission or partnership by any director, the employer or a vendor.

---

## Quick start

You need **Node.js 22 or newer**. Run `node --version` to check.

```bash
npm install          # install the project's packages (once)
npm run db:reset     # build a fresh synthetic lab day in data/histology-lab-os.db
npm run dev          # start the app
```

Then open **http://localhost:3100**. The first page depends on the demo role you are acting as. The default is Maya Torres, Accessioner, who lands on Intake.

- **You can skip `db:reset` the first time.** If the database file is missing or empty, the app seeds it automatically on first use.
- **Reset with the dev server stopped.** The running server keeps the database open. While the app is running, use the in-app reset instead (see [Resetting the demo](#resetting-the-demo)).

### All commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app for local use at http://localhost:3100 (reloads when code changes). |
| `npm run build` | Make an optimized production build. |
| `npm run start` | Run that production build at http://localhost:3100 (run `build` first). |
| `npm run db:reset` | Delete the local database and re-seed the synthetic day. The demo clock starts **running** from 10:52 ET. |
| `npm run db:reset -- --running` | Same, but the demo clock **runs in real time** from 10:52 ET instead of starting paused. |
| `npm test` | Run the domain tests (Vitest, `tests/domain/`). They use a throwaway in-memory copy of the synthetic day, so your demo data is never touched. |
| `npm run test:watch` | Same tests, re-run on every file change. |
| `npm run test:e2e` | Run the 17 browser tests (Playwright, `tests/e2e/`): the full director journey plus guard checks, clicked through the real screens. They build a separate copy of the app on port 3210 with its own database (`data/e2e.db`), so your demo data is never touched. The first time, run `npx playwright install chromium`. |
| `npm run typecheck` | Check the TypeScript types without running anything. |
| `npm run check` | `typecheck` followed by `test`. |
| `npm run schema` | Regenerate `src/server/db/schema.ts` from the `.sql` files. This runs automatically before `dev`, `build`, `test` and `typecheck`. |

Optional environment variables: `HLOS_DB_PATH` (database file location; default `data/histology-lab-os.db`), `NEXT_DIST_DIR` (build folder; default `.next`) and `E2E_PORT` (browser-test port; default 3210).

---

## The guided demo

Open **http://localhost:3100/demo**. It has four tabs: **Guided demo**, **Workflow map**, **Speaker notes** and **Real vs simulated**.

The guide has eight steps. They follow one fictional patient, Avery Quinlan, whose parts A and B arrive as two separate orders (ORD-77120 and ORD-77121) from Harbor Point Dermatology. Earlier synthetic cases are used for the materials steps.

| Step | Demo time (ET) | What happens |
|---|---|---|
| 1 | 11:00 | Courier arrival: expected vs received containers, and routing by the approved rule. An unreviewed office goes to the exception lane. |
| 2 | 11:03 | Parts A and B arrive as two orders. A possible relationship is shown with its reasons. A lead decides; nothing is merged. |
| 3 | 11:06 | The Part B bottle says LEFT and the order says RIGHT. A clarification is raised and only Part B is held. The office answer (simulated) is reviewed before it is resolved. |
| 4 | 11:18 | The simulated source issues the official accession, D26-04817. Parts A and B keep their original order numbers. |
| 5 | 11:30 | Part A's gross record is confirmed, reviewed and approved. Part A moves on and Part B stays waiting. The case is never shown as "complete". |
| 6 | 11:40 | A tray is missing one slide and has one that does not belong, and a print job has an unknown outcome. Both get a controlled resolution. |
| 7 | 11:45 | A block request shows the last confirmed storage slot. A wrong block scan is rejected. |
| 8 | 11:50 | Operations: what is still blocked, who owns the next step, and the evidence. |

Each step has two buttons:

- **Run simulator events for this step** does the "world" events: moves the demo clock, delivers the courier, sends the office's answer and the source system's messages. Any demo role can press it.
- **Auto-perform staff actions (rehearsal)** also does the staff clicks for you, as the named fictional staff member, through the same commands and role checks. It is for rehearsal only and needs the **Operations supervisor** demo role. Otherwise, do the staff actions yourself on the real screens.

The full click-by-click script is in [`docs/demo-script.md`](docs/demo-script.md).

### Resetting the demo

There are two ways to replace all demo data with the 10:52 ET starting state:

- **In the app:** **Settings → Demo scenarios → Reset demo data** (it asks you to confirm).
- **From a terminal, while the app is running:**
  ```bash
  curl -X POST http://localhost:3100/api/demo/reset -H "Content-Type: application/json" -d '{"confirm": true}'
  ```

When the app is stopped, use `npm run db:reset`. A reset replaces the whole database, including the local audit log. The **Reset clock to 10:52** button in the clock menu moves only the clock, not the data.

### The demo clock

- The demo day is **Wednesday, October 14, 2026**. After a reset the clock reads **10:52 ET** (America/New_York). The clock is shown in the top bar.
- It starts **paused** and moves only when you move it (Advance, Jump, or Resume in the clock popover; each guided-demo step jumps it to that step's time). `npm run db:reset -- --running` starts it running in real time instead.
- You can **pause or resume** it, **advance** it (5 minutes from the top-bar menu; 1, 5 or 15 minutes in Settings → Demo scenarios) or **jump forward** to a scripted moment, such as the 11:00 courier. Each guided-demo step also moves it forward.
- It **never moves backwards**, except for the explicit "Reset clock to 10:52". Going backwards would make recorded events look like they are in the future.
- Every timestamp in the app uses this demo clock, so the scenario plays out the same way each time. Times are stored in UTC and shown in Eastern Time.

---

## Roles you can switch to

Use **Acting as** in the top bar. These are fictional people. Permissions are enforced on the server and come from [`src/lib/roles.ts`](src/lib/roles.ts).

| Demo role | Fictional person(s) | Opens on | Can do (examples) | Cannot do |
|---|---|---|---|---|
| Accessioner | Maya Torres (default), Luis Benitez | Intake | Receive courier deliveries; record and verify container observations; accept the suggested routing; request the accession; raise, send and record clarifications; place holds; open a correction review; request prints and apply labels | Override routing, decide related orders, review or resolve clarifications, release holds |
| Accessioning lead | Kim Nguyen | Intake | Everything an accessioner can, plus: override routing or resolve a routing exception (with a reason); decide related-order candidates; review and resolve clarifications; accept a recorded discrepancy; release holds; close correction reviews; take over someone else's task (with a reason) | Approve gross records, edit routing rules |
| Grosser | Dana Whitfield | Grossing | Edit, confirm (including cassette allocation), review, approve and amend gross records; raise clarifications and holds; request prints and apply labels | Attest source-system entry, assemble trays |
| Histology assistant | Sam Ortiz | Worklist (grossing view, source-entry queue) | Edit and review gross drafts; attest that an approved description was entered by hand in the source system; record bench progress; request and reconcile prints; apply labels; assemble trays; request and pick blocks; raise clarifications and holds | Approve gross records, confirm cassette allocation |
| Histotechnologist | Priya Shah, Marcus Lee | Worklist (histotech view) | Record block/slide bench progress; request, reconcile and retire labels; assemble and deliver trays; request and pick blocks; order additional slides (PAS, levels, recuts); review work orders changed at the source | Approve gross records, release a tray with exceptions |
| Operations supervisor | Tanya Brooks | Operations | Nearly everything above, plus: release a tray with documented exceptions, draft routing rule changes, edit the office contact directory, retry failed integration messages, override a hold linked to an open clarification (with a reason), approve routing rule versions, and run guided-demo rehearsal | Keep a work order that was canceled at the source active (that needs a new authorization from the dermatopathologist) |
| Dermatopathologist | Dr. Elena Marsh, Dr. Samuel Okafor, Dr. Nadia Ferreira | Operations | Approve and amend gross records; request blocks from storage; order additional slides; review work-order source changes, including keeping a work order canceled at the source active (only this role can) | Intake, clarification and tray actions |
| Director of Operations (read-only demo) | (demo seat) | Operations | View every screen; acknowledge and snapshot the worklist | Any lab action |
| Medical director (demo) | (demo seat) | Operations | Approve routing rule versions; add or retire coverage exceptions; view; acknowledge and snapshot the worklist | Other lab actions |

Every role can acknowledge the worklist, save filters and print or download snapshots. Every role can also use the **simulator controls** in Settings → Demo scenarios and the demo clock: they change the simulated world, not lab records.

---

## Screens (routes)

| Route | Purpose |
|---|---|
| `/` | Sends you to the landing page for your current demo role. |
| `/intake` | **Arrival and reconciliation bench.** Courier manifest (expected vs received; "Unknown" when no manifest exists), order vs bottle vs requisition comparison, the "staff verified against physical container" step, routing suggestion with the rule that produced it, related-order review, an exception lane, and the accession request. `?item=` and `?lane=to_review\|exceptions\|done`. |
| `/clarifications` | Specimen-specific questions to submitting offices, from draft to reviewed resolution, each with an owner, follow-up time, delivery state (simulated) and any scoped holds. |
| `/worklist` | **Digital doctor/PAS worklist.** It does the information job of the printed daily report. Views: Accessioning, Grossing and source entry, Histotech, Operations. Grouped by dermatopathologist with doctor colour plus name. PAS is shown as text. New, changed and canceled work is tagged since your last acknowledgement. Saved filters, print snapshot and CSV download (both stamped with version and generation time). |
| `/grossing` | Reviewed gross record per part. A synthetic dictation produces proposed values; numbers, units and counts must be confirmed; then reviewed, approved for downstream use, and tracked until staff attest manual entry in the source system. `?part=D26-04817-A`, `?case=`, `?view=source`. |
| `/materials` | Three tabs. **Print jobs** (`?tab=print`): label queue, unknown outcomes, reconcile, reprint with reason, work-order reviews. **Trays** (`?tab=trays`): slide-by-slide tray assembly. **Retrieval** (`?tab=retrieval`): block requests, pick list by location, scan check, custody history. |
| `/cases/[id]` | One case, e.g. `/cases/D26-04817`. Tabs: Overview, Material, Source documents, Tasks and clarifications, History (the local audit trail). |
| `/operations` | What is blocked right now, who owns the next step, how old it is, and the evidence, plus data freshness per source. Charts are labelled as synthetic. |
| `/insights` | How a pilot could be measured, shown with **illustrative** synthetic prior-day events. Not observed lab performance. |
| `/settings` | Tabs: **Routing rules** (versioned office → dermatopathologist rules, coverage), **Demo scenarios** (reset, clock, source outage/duplicate/out-of-order/failure controls, printer and notification controls, assistant on/off), **Integration capabilities**, **Office contacts** (fictional directory), **Preferences**. |
| `/demo` | Guided demo, workflow map, speaker notes, real vs simulated. |

Behind the screens (HTTP endpoints):

| Endpoint | Purpose |
|---|---|
| `POST /api/commands/<name>` | The **only** way data changes. Body: `{ "input": {...}, "idempotencyKey": "..." }`. |
| `GET/POST /api/session` | Read or switch the demo role (cookie `hlos_actor`). Not authentication. |
| `GET /api/live` | Polled every 2.5 s by the screens. Lets the simulated sources deliver anything that is due, and reports changes, the demo clock and source freshness. |
| `POST /api/worklist/export` | CSV download of the worklist (records a snapshot). |
| `POST /api/demo/reset` | Replace all demo data with the starting state. Needs `{ "confirm": true }`. |

---

## How a change flows

Every change to data takes the same path, whether a person clicks a button, the guided demo runs a step, or a test runs:

```
Screen (button or scan)                         src/components/**, src/lib/client/command.ts
   │  POST /api/commands/<name>   { input, idempotencyKey }
   ▼
API route                                       src/app/api/commands/[name]/route.ts
   │  who is acting? (demo role cookie)
   ▼
Command registry: executeCommand()              src/server/commands/registry.ts
   │  1. Same idempotency key seen before?  → return the earlier result; do nothing twice
   │  2. Check the input is complete and well-formed
   │  3. In ONE database transaction:
   │       • server-side role check (src/lib/roles.ts)
   │       • run the command
   ▼
Domain rules                                    src/server/domain/*.ts
   │  holds, readiness, versions (stale → conflict), safety rules (no merge, no renumber)
   ▼
SQLite database (data/histology-lab-os.db)
   • the changed records          • an audit event (who, when, what, why)
   • worklist change feed         • tasks: "who owns the next step"
   │
   ▼
Screens refresh; /api/live tells other open screens that something changed
```

If something is refused, you get a plain message and a code. The codes are: `FORBIDDEN` (your role cannot do this), `CONFLICT` (someone changed it first), `BLOCKED` (a hold or unresolved review is in the way), `INVARIANT` (it would break a safety rule, such as renumbering an issued accession), `VALIDATION`, `NOT_FOUND`, and `SOURCE_OFFLINE` / `PRINTER_UNAVAILABLE` / `ASSISTANT_UNAVAILABLE` (a simulated connector is switched off). If the whole transaction fails, nothing is saved halfway.

There are 88 registered commands. Each is listed with a one-line description in [`docs/dev/command-contract.md`](docs/dev/command-contract.md).

---

## Real, simulated, not built, unknown

| | What |
|---|---|
| **Working locally** (real logic, synthetic data) | Expected vs received reconciliation; rule-based routing with rule versions and an exception lane; related-order candidates and review (never a merge); clarification states, owners, follow-ups and scoped holds; digital doctor/PAS worklist with change tags and stamped snapshots; field-by-field gross confirmation and per-part approval with downstream tasks; print job states including unknown outcome and reconciliation; slide-by-slide tray checks; block retrieval scan check and custody history; stale-update detection; server-side role checks; local append-only audit trail; idempotent imports and commands. |
| **Simulated** (clearly labelled on screen) | The **source system** (EMA-SIM and OTHER-EHR-SIM: orders, amendments, accession numbers, outages, duplicates, late messages); **office notifications and office answers** (no real office is ever contacted); **label printers** (including a timeout); the **drafting/extraction assistant** (deterministic rules, not live AI; manual work continues when it is switched off); the **courier delivery** and bottle contents; **scanners** (typed or keyboard-wedge input stands in); the **demo clock**. |
| **Not implemented** | Writing anything back to EMA (gross entry stays manual and is tracked as a task); real printer control, scanners or microphone input; real sign-in; patient-facing anything. |
| **Unknown, needs discovery** | Which EMA modules and interfaces this lab has; real office contacts, coverage and response agreements; real printers and label materials. See [`docs/discovery-checklist.md`](docs/discovery-checklist.md). |

---

## Folder structure

```
src/
  app/                  Screens (one folder per route) and HTTP endpoints (app/api/)
  components/           UI: ui/ (buttons, tables, pills), domain/ (identity bar, doctor chip, PAS tag),
                        shell/ (top bar, nav, demo banner, clock, role switch) and one folder per screen
  lib/                  Shared by server and browser: roles.ts (permission matrix), domain.ts (state labels),
                        gross.ts (gross fields), identifiers.ts (label encode/decode), time.ts (ET display),
                        client/ (browser helpers: command calls, scan field, live refresh, conflicts)
  server/
    db/                 SQLite connection and schema (.sql files → generated schema.ts)
    core/               Plumbing every command uses: acting person and role check, audit, demo clock,
                        versioned updates, tasks, worklist change feed, ids, settings, error codes
    domain/             The lab rules: intake, routing, related orders, accession, corrections, holds,
                        readiness, clarifications, gross records, print, labels, trays, retrieval, source import
    commands/           Every named action (88), grouped by area; registry.ts runs them
    queries/            Read-only data for each screen (no changes)
    sim/                Simulators: courier, authoritative source (accession numbers), office replies,
                        notifications, printers, and the source "pump" that delivers queued messages
    assist/             Deterministic drafting (clarification text) and extraction (dictation → proposed fields)
    seed/               The reproducible synthetic lab day (reference data, history, scripted scenario)
    session.ts          Demo role cookie (not authentication)
tests/
  domain/               Rule and scenario tests (Vitest), run against an in-memory seeded database
  e2e/                  Browser journey tests (Playwright): director journey + guards
  helpers.ts            Test database, run-as-staff helpers, clock helpers
docs/                   Product, design, data, integration, research and pilot documents (list below)
  dev/                  Builder notes (command contract)
scripts/                Database reset and schema generator
data/                   The local database file (ignored by git)
```

---

## Glossary (plain language)

| Term | Meaning here |
|---|---|
| **Command** | One named action that changes data, such as `clarification.send` or `gross.approve`. Every change goes through a command, so each one is checked, recorded and repeatable in tests. |
| **Optimistic concurrency / stale update** | Each editable record carries a version number. When you save, the app checks that the record is still the version you were looking at. If a colleague saved first, your save is **refused as a conflict** and you are shown what changed, instead of silently overwriting their work. To see it, use "Simulate a colleague editing this item" on Intake. |
| **Idempotency** | Doing the same thing twice has the same effect as doing it once. A double click, a retry or a repeated source message does not create a second case, task, print job or message. Each button press carries an "idempotency key" the server remembers. |
| **Audit log** | An append-only list of who did what, when, from where (person, simulator, import, assistant, demo) and why. It is shown as the History tab on each case. The database refuses to edit or delete these rows, but it is a local file, so it is **not** tamper-proof. |
| **Seed** | The script that builds the same fictional lab day every time: offices, staff, cases, prior-day history and the scripted demo situations. |
| **Simulator** | Code that pretends to be something outside the lab app, such as the source system, an office, a printer or the courier, so the demo can run without touching anything real. Simulated things are labelled on screen. |
| **Adapter** | The plug between the app and an outside system. Today every adapter is a simulator. A real one could only be built after the actual interface, permissions and workflow have been reviewed (see the integration matrix). |
| **Source system** | The authoritative system (EMA at the author's lab; EMA-SIM here). It owns orders, accession numbers and the official record. |
| **Hold** | A stop placed on specific material (for example "Part B") for specific steps (for example gross approval and printing). The rest of the case and the bench keep moving. |
| **Provisional ID** | Intake items get IDs like `INT-1014-007`, which look different from official accession numbers like `D26-04817` on purpose. |

---

## Documents

| Document | What it is |
|---|---|
| [Product brief](docs/product-brief.md) | The problem, the employee observations, what the product is and is not, and assumptions. |
| [Workflow map](docs/workflow-map.md) | Current workflow as observed vs the proposed workflow. Every benefit is a hypothesis to measure. |
| [Design spec](docs/design-spec.md) | Screens, layout, design tokens, accessibility and wording rules. |
| [Data model](docs/data-model.md) | Entities (patient, order, part, block, slide, ...), workflow states and safety rules. |
| [Integration capability matrix](docs/integration-capability-matrix.md) | Field by field: what EMA documentation establishes, what is unknown, what approval is needed, and the fallback. |
| [Research notes](docs/research-notes.md) | The checked sources R1–R12 with dates and what each does and does not establish. |
| [Pilot proposal](docs/pilot-proposal.md) | Configure vs buy vs build, how a pilot would be measured, and deployment dependencies. Costs need vendor quotes; no prices are invented. |
| [Director pitch](docs/director-pitch.md) | A one-page summary for the Director of Operations and medical director. |
| [Discovery checklist](docs/discovery-checklist.md) | Questions for the director and the vendor team, with the default assumption the demo uses for each. |
| [AI assistants](docs/ai-assistants.md) | The four bounded assistants: inputs, outputs, limits and review rules. In this demo they are deterministic. |
| [Roadmap](docs/roadmap.md) | Ideas deliberately deferred, and the rule for moving one into a build. |
| [Demo script](docs/demo-script.md) | The five-minute director demonstration, click by click, with speaker notes. |
| [Acceptance tests](docs/acceptance-tests.md) | The 15 acceptance checks from the specification and which test covers each. |
| [Implementation status](docs/implementation-status.md) | What works, what is simulated, what is not built, what was tested, and known gaps. |
| [Command contract](docs/dev/command-contract.md) | For builders: every registered command, who may run it, and the storyline decisions. |

References like [R1] point to [`docs/research-notes.md`](docs/research-notes.md). The source of truth for scope is `Histology_Lab_OS_Claude_Master_Prompt.txt`.

---

## Safety notes

- **Do not connect this to employer systems.** Do not point it at EMA or any lab database, scrape or automate an EMA session, install it on a lab workstation, or publish it. Any real connection needs approval from the organization's clinical, IT, privacy/security and operations owners first.
- **Do not put real patient data in it**, including names, dates of birth, MRNs, photos of labels or requisitions, internal reports, or real contact details. Use only the synthetic seed.
- **The audit log is local and append-only, not tamper-proof.** The database refuses edits and deletions to audit rows, but anyone with the file can change or replace it. It is not proof of production tamper resistance.
- **The role switch is not security.** Anyone can act as any role. The server-side permission checks show how roles would be enforced, not that the app is secure.
- **Label previews are not validated.** The label text encodes and decodes correctly in the demo's tests, and the preview draws it as a DataMatrix image, but no barcode image has ever been read by a scanner. Nothing has been tested with real scanners, label stock, solvents, processors or stainers.
- **Demo numbers are illustrative.** Charts and counts come from synthetic data. They are not measured lab performance, savings or quality results.

## Troubleshooting

- **Port 3100 is busy:** another copy is probably running. Stop it, or run `npx next dev -p 3101`.
- **Settings says the database is "from an older version":** use **Reset demo data** there, or stop the app and run `npm run db:reset`.
- **`npm install` fails on `better-sqlite3`:** check that Node is version 22 or newer, then try again. This package includes a compiled part that has to match your Node version.
