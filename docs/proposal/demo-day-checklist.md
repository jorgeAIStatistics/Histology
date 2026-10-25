# Demo-day checklist

**For Jorge Rodriguez (presenter) only. NOT FOR DISTRIBUTION: do not print it for, hand it out to or forward it to anyone.** A working checklist, not a handout.

## Before you present (for Jorge only; do not hand this out)

- [ ] **Know who owns this work.** Check my employment agreement and the company policies on intellectual property (IP) ownership and outside work. If I intend to build a commercial product from this, get independent legal advice before presenting, not after. [to confirm: what my agreement and the policies say] FAQ questions 13 and 22 currently say "no commercial interest in it today" and "no plan to sell it" [to confirm], and question 22 calls the optional product vision (including a product other labs could use) a direction, not a plan; make them match what I actually intend before the meeting.
- [ ] **Present the pilot ask.** The request is Phase 0 only. Keep the bigger ambition, a full lab system, as "where this could go": slide 13, after the ask, in under a minute, and the product vision handout only if the Director asks.
- [ ] **Do not describe other organizations' systems as outdated.** Never call a named vendor's, lab's or practice's system old or outdated. Talk about what I've seen at the bench and what this design does; "many lab systems still use dated interfaces" is as far as it goes.

---

| | |
|---|---|
| Meeting | 30 minutes with the Director of Operations, Platinum Dermatology: 5-minute demo, 10-minute proposal, then questions |
| Target week | 2026-11-09 to 11-13 (fallback 2026-11-16 to 11-20) [to confirm: meeting date, time and room] |
| Rehearsals | Twice during 2026-11-02 to 11-06, each time following this checklist from top to bottom |
| Where the demo runs | My own laptop only: `http://localhost:3100` |

> **The rule that never bends.** Synthetic data only, on my own laptop. Never open EMA, work email or anything with patient information on this laptop during the meeting. Never install or run the app on a lab computer, and never connect it to the lab network. Using a lab computer is a Phase 1 decision that hasn't been made. If the room only offers a lab computer, present from the slides and screenshots instead.

The long talk track is `../demo-script.md`, and the operator's runbook is `../release/demo-runbook.md`. **Where any document and the presenter console differ, trust the console.**

---

## 1. The day before

**Software (at home, on my own network)**
- [ ] `node --version` shows 22 or newer.
- [ ] Run the setup commands in section 3. The install is the only step that needs the internet.
- [ ] Optional confidence check: `npm run check` (the type check plus the unit, integration and contract tests; a few minutes). If anything fails, present from the last build that passed and don't show the new part.
- [ ] Record the version I rehearsed: `git rev-parse --short HEAD`, and confirm `git status --short` is empty (nothing uncommitted). **No code changes after the last rehearsal.** If something must change, rebuild and rehearse again.
- [ ] **Code freeze, after the last rehearsal (by Fri 6 Nov):** commit or tag the exact code I will present (my decision). Re-run the type check, the unit tests, the demo browser suite on a fresh build and the secured suite. Write the results in a dated addendum to `../release/verification-stage6.md`. Then update the counts and the date in the brief (section 4), the FAQ (questions 9 and 12: "about 800", not a fixed total), slides 7 and A1, the guide (sections 2.1 and 9.4) and the README (section 7), and rebuild `out/`.
- [ ] After the freeze, recapture the screenshots (`deck-outline.md`, capture list), add the synthetic-patient band, and rebuild the deck.
- [ ] Re-read the public sources G1–G5 (implementation guide, Appendix C) in a normal browser, and confirm every statement quoted from them.
- [ ] Confirm that my GitHub repository is private, and settle the date for deleting and purging the early prompt file (FAQ questions 14 and 24).
- [ ] Turn Wi-Fi off and run the whole demo once. It should work with no network.

**Rehearse with a timer**
- [ ] One run with the rehearsal button on every step, acting as Tanya Brooks, to see the expected end state.
- [ ] Reset, then one timed run of the default path in section 5. Aim for 5:00 or less.
- [ ] Write the actual times of both rehearsals into the table in section 5. If the default path runs over 5:00, use the short path, or budget 7 minutes for the demo and drop slides 4–6 from the proposal time.
- [ ] Practice the opening caveat (section 4) out loud until I can say it without notes.

**Laptop**
- [ ] Use a separate browser profile with no bookmarks, no history and no saved sign-ins. Use Chrome or Edge: the browser tests ran on Chromium only.
- [ ] Turn off all pop-up notifications (Focus or Do Not Disturb). Close messaging apps.
- [ ] Desktop and Dock are clean: no work files, no employer documents, nothing with a real name on it.
- [ ] Bring the charger, a display adapter (HDMI or USB-C), and a mouse if I prefer one.

**Paper**
- [ ] Print one copy each of the leave-behinds in section 9, plus one for me.
- [ ] Print the deck (`out/Histology-Redesigned-Director-Presentation.pdf`) as the backup in case the laptop or projector fails. Use the slides, not the full screenshots (section 9).
- [ ] Print this checklist, with section 5 (the 5-minute path) on a single page.

**My [to confirm] items**
- [ ] Every `[to confirm: …]` I can answer from my own role is filled in across the package. Never use patient data. Leave the rest visible as placeholders.

## 2. Thirty minutes before

- [ ] Start the app: `npm start` (section 3). Wait for "Ready".
- [ ] Health check: `curl -s http://localhost:3100/api/health` returns `"status":"healthy"`.
- [ ] Open `http://localhost:3100/demo`. The header carries the label "Synthetic data, simulated connectors".
- [ ] Browser window **1366 × 768**, zoom **100%**. On the projector, check that the step panel and the Intake comparison table fit without sideways scrolling.
- [ ] **Reset demo** in the console toolbar, then **Reset demo data**. Expect "0 of 8 steps done", **Demo clock 10:52 AM ET**, paused, with every simulated connector back to its starting state.
- [ ] **Role and clock** tab (`/demo?tab=role`): set **Acting as** to **Maya Torres, Accessioner**. A reset doesn't change the role, so check it after rehearsing as Tanya Brooks. Keep the clock paused.
- [ ] In a large room, set **Presenter text size** to large. Leave the browser zoom at 100%.
- [ ] Leave every simulated outage off, unless I plan to show one.
- [ ] Open the slide deck in a second window, at slide 1.
- [ ] Phone on silent. Water.

**One minute before:** the screen shows `/demo?tab=guide&step=1`, "0 of 8 steps done", demo clock 10:52 AM ET (paused). The slides are on slide 1.

## 3. The commands

All commands run from the project folder.

**Set up (the day before, needs internet once)**
```bash
npm install
npm run build
```

**Start the demo (demo mode, port 3100)**
```bash
npm start
```
- If the build fails or something is odd, `npm run dev` also runs in demo mode on the same port. It is slower to load the first page.
- **Never present from `npm run start:locked`.** That is the fail-closed build: it shows no data and refuses every change. It exists only for the `locked-build.png` screenshot.

**Check that it's up**
```bash
curl -s http://localhost:3100/api/health
```

**Reset**

The normal way is in the browser: **Reset demo** in the `/demo` toolbar, or on the **Outages and reset** tab. From the terminal, stop the server first (Ctrl+C), then run:
```bash
npm run db:reset
```
Start it again with `npm start`.

**If port 3100 is already in use**
```bash
lsof -i :3100
```
Stop the old server in the terminal where it is running (Ctrl+C), then start again.

## 4. What to say first: the caveat

Say this before touching anything, and point at the "Synthetic data, simulated connectors" label:

> "Before I start: this demonstration uses synthetic data and simulated connectors. It does not show clinical performance or a production integration. Every name in it is fictional, including the lab, Lumen Bay. It runs only on my laptop and has never been connected to EMA, the lab network or patient information. Nobody has endorsed or approved it. The problems it addresses are my own observations, not measured rates."

## 5. The 5-minute path

These IDs are what a fresh reset produces when the steps are done in order. Each step panel's "What to click" is the authority if anything differs. Every step's simulator button moves the demo clock forward by itself.

**Default path: steps 1, 2, 6, 7 and 8 by hand; steps 3–5 with the rehearsal button while I narrate.** Only the automated journey has been timed so far, and doing steps 3–5 by hand is about twenty clicks. The rehearsal button does the same staff actions through the same rules, as the named fictional staff, and each one is recorded as a demo action.

| Time (target) | Rehearsal 1 | Rehearsal 2 | Step | Acting as | Do | Say (one line) |
|---|---|---|---|---|---|---|
| 0:00–0:20 | [m:ss] | [m:ss] | Caveat | Maya Torres | Section 4. Point at the label. | "Everything here is made up, and it's mine, not the lab's." |
| 0:20–1:00 | [m:ss] | [m:ss] | 1. Courier | Maya Torres | **Run simulator events for this step**. On Intake, point at the **Courier manifest** strip (Mangrove Bay: expected "Unknown"). Open INT-1014-031 and press **Accept routing to Dr. Elena Marsh** (under **Also yours now**; **Show it** if folded); do the same on INT-1014-032. Open INT-1014-034 (Seagrape Skin Studio): the exception lane. | "It names the rule it used. An office with no rule isn't guessed." |
| 1:00–1:40 | [m:ss] | [m:ss] | 2. Two orders | Maya, then Kim Nguyen | On INT-1014-031, press **Record: I checked this bottle against the order**. Open REL-0112 and read the reasons. Switch to Kim and choose **Link as related**, type a short reason, then **Record decision**. | "It suggests; a person decides. Nothing is merged." |
| 1:40–2:40 | [m:ss] | [m:ss] | 3–5. Left or right, accession, gross Part A | Tanya Brooks | Switch to Tanya and say so. On steps 3, 4 and 5 in turn: **Auto-perform staff actions (rehearsal)**, then **Perform rehearsal actions**. Then show three results: CLR-0457 (hold H-0090 was on Part B only, released after the amended order); case D26-04817; the gross record for Part A, approved, with Part B still awaiting grossing. | "Only Part B waited. The office's answer didn't close anything; a person did. Part A moved on; the case isn't done." |
| 2:40–3:20 | [m:ss] | [m:ss] | 6. Tray and printer | Priya Shah | TRY-M-03: scan the 9th slide, then the other doctor's slide. Point at **Mark tray complete**, which is unavailable. On PJ-8841, record **Not printed**, then **Reprint with reason**. | "An earlier made-up case. 'Unknown' is not 'printed'." |
| 3:20–3:45 | [m:ss] | [m:ss] | 7. Block retrieval | Priya Shah | RR-0192: scan the wrong block D26-03909 A1 (mismatch), then D26-03990 B1 (match). | "Last confirmed location, not live tracking. The wrong block is rejected." |
| 3:45–4:30 | [m:ss] | [m:ss] | 8. Operations | Tanya Brooks | **Run simulator events for this step**. Open `/operations` and follow one blocked item to its record. | "Who owns the next step and how long it has waited. Made-up numbers, no rankings." |
| 4:30–5:00 | [m:ss] | [m:ss] | Hand back | — | Skip straight to slide 7 (slides 4–6 are the fallback only). | "That's the demo. Let me show you how the lab could try this safely." |

**Full by-hand path for steps 3–5** (use only if both timed rehearsals fit 5:00):
- **Step 3. Maya raises; Kim reviews, resolves and releases.** As Maya on INT-1014-032: **Record: I checked this bottle against the order** (laterality "Differs"), then **Raise clarification** on that row, keep the hold box ticked (Part B only) and press **Raise clarification**; **Open CLR-0457 in Clarifications**, **Send (simulated)**. Back on the guide: **Run simulator events for this step**. As Kim on CLR-0457: **Write review note**, type it, **Mark answer reviewed**, **Resolve**, then **Resolve, keep hold**; then **Release H-0090**, a reason, **Release hold**.
- **Step 4.** As Kim (or Maya): **Request accession for INT-1014-031 + INT-1014-032 together (simulated source)**, then **Open case D26-04817**.
- **Step 5.** As Dana Whitfield on `/grossing?part=D26-04817-A`: **Attach transcript and extract** (dictation quinlan-A), confirm each of the 9 values, **Compose from confirmed values**, **Save draft**, **Mark operator reviewed**, **Approve for downstream use**. Open the Worklist.

**Short path (about 3 minutes)**, if time is cut:
1. Act as **Tanya Brooks** throughout, and say so aloud.
2. Step 1: do it by hand.
3. Steps 2–5: press **Auto-perform staff actions (rehearsal)** on each, in order, and show only the Part B hold on Clarifications and case D26-04817.
4. Step 6: show the tray that can't be completed.
5. Step 7: skip it with one sentence.
6. Step 8: Operations.

## 6. If something breaks

**Rule:** don't troubleshoot live for more than about ten seconds. Say one calm sentence and use one of the three moves below. Re-running a step is safe: it creates no duplicates.

1. **Rehearsal button.** Switch **Acting as** to Tanya Brooks, then press **Auto-perform staff actions (rehearsal)**, then **Perform rehearsal actions**. Say: "I'll let the demo replay these clicks. Each one is recorded as a demo action."
2. **Skip.** Steps 6 and 7 use earlier cases and can be skipped or done in any order. Steps 2 to 5 depend on each other. Step 8 always works.
3. **Reset and catch up.** **Reset demo**, then, acting as Tanya Brooks, press the rehearsal button on each step up to where I was, in order.

| Symptom | Fix |
|---|---|
| A button is missing or refused | The server checks the role. Switch **Acting as** to the step's role. Make it a talking point: "It checks who I am, whatever the menu says." |
| Step 3: the office never answers | Was the clarification sent? If delivery failed: **Outages and reset**, set notifications back on, resend, then run step 3's simulator events again. |
| Step 3: the amended order doesn't arrive | EMA-SIM is offline. On **Outages and reset**, set it back to connected. |
| Step 3: the hold release is refused | I'm acting as an accessioner. Switch to Kim Nguyen. |
| Step 4: the accession request is refused with a list | Read the list. Usually routing wasn't accepted on INT-1014-032, or a step 2 decision is missing. |
| Step 5: approve isn't available | A value is still "proposed", or the narrative is empty. Press **Compose from confirmed values**, then **Save draft**. |
| "The record changed since you opened it" | The stale-update check worked. Reload and repeat. |
| The page looks out of date | Reload. Progress is read from the records. |
| The app doesn't load | Check the terminal. Run `npm start` again. If the data looks damaged: stop the server, run `npm run db:reset`, start again. |
| Running long | Skip steps 6 and 7 with one sentence each. |
| Laptop or projector fails | Use slides 4–6 (screenshots) or the printed deck, and offer to show the live demo another time. |

## 7. Phrases to avoid

| Don't say | Say instead |
|---|---|
| "It's HIPAA compliant", "CAP-ready", "validated" | "It has technical controls tested on synthetic data. Compliance and validation are the lab's decisions, under its quality system." |
| "It will save us X hours" or "X dollars" | "I don't know yet. Phase 0 measures the baseline first." |
| "ModMed supports this", "it already works with EMA" or "it's integrated with EMA", "ModMed approved it" | "ModMed's public pages describe HL7 order and result interfaces. We'd confirm with ModMed what fits." (On slide 13 only: "a lab system designed to work with EMA, not replace it.") |
| "It's production-ready" or "ready to go live" | "The foundation is built and tested, but production use is blocked until real sign-in and hosting exist." |
| "The AI checks it" or "the AI catches errors" | "No AI decides anything. The demo's assistant is fixed rules, and a person confirms every value." |
| "Our lab has a problem with…", "this is broken here" | "I've observed… I'd like to measure it." |
| "The tests prove it works" | "The tests show the code does what the tests say, on synthetic data." |
| "It replaces EMA", "the bible" or "the LIS" | "It's a companion. EMA stays the system of record, and paper stays until the lab decides." For the long-term vision: "EMA stays the practices' record; a lab system would work with it." |
| "It's secure" | "It hasn't had an independent security test yet. That's in Phase 2." |
| "Real-time tracking" | "Last confirmed location, with who and when." |
| "Everyone at the bench wants this" | "I'd like a few colleagues to try it and tell me what's wrong." |
| Any coworker's, doctor's or office's real name, or any real case | Role titles and the fictional demo names only |
| "I need a budget" or "we should buy…" | "I'm asking only for Phase 0: four weeks, no patient data, nothing installed." |
| "This will become our new lab system" or "a product we can sell" | "That's where this could go, much later, and only if the pilot proves its value. Today I'm asking for Phase 0." |
| "[Any named company]'s system is outdated" | "Many lab systems still use dated interfaces. I'd like to measure what would help here." |

## 8. After the demo and during questions

- Hand over to the slides at slide 7, skipping slides 4–6 (see `deck-outline.md`).
- After the ask (slide 12), slide 13 is the one vision slide. Say "this is a vision, not a request", keep it under a minute, then go to questions (slide 14).
- For questions, `director-faq.md` has short, honest answers. If I don't know: "I don't know yet. That's a Phase 0 question." Write it down.
- If the conversation moves to configuring EMA or buying a product, support it. That is a good outcome.

## 9. What to leave behind

Print and hand over these four (the same set as slide 14 and the README):
1. **The executive brief** (`out/Histology-Redesigned-Executive-Brief.pdf`, two pages).
2. **The timeline** (`out/Histology-Redesigned-Timeline.pdf`).
3. **The Director FAQ** (`out/Histology-Redesigned-Director-FAQ.pdf`).
4. **The one-page decision checklist:** section 15 of the implementation guide (`out/Histology-Redesigned-Implementation-Guide.pdf`). Offer the full guide if asked.

Optional, if asked: `../discovery-checklist.md` and `../pilot-proposal.md` (section 14, "Decision requested").

Only if the Director asks where this could go: **the product vision** (`out/Histology-Redesigned-Product-Vision.pdf`), optional, long-term reading, separate from the proposal. Bring one copy and keep it back unless asked.

Share the deck only as the PDF (`out/Histology-Redesigned-Director-Presentation.pdf`); never send the .pptx, because its speaker notes carry presenter coaching.

For the printed screenshot backup (section 1), print the slides (the deck PDF), not the full screenshots: the full Operations image includes a per-person chart that the slide crop leaves out.

**Never leave** a copy of the software, a USB drive, or the laptop. Don't install it anywhere. If someone wants to try it, offer another session.

**After the meeting:** write down what was decided and the open questions, using role titles only and no patient information. Don't start any observation until the Phase 0 kickoff has agreed the consent approach.
