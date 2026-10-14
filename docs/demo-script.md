# Five-Minute Director Demonstration Script

**Histology Redesigned: one made-up case, eight steps, five minutes**

| | |
|---|---|
| Prepared by | Jorge Rodriguez, histology assistant |
| Audience | Director of Operations and Medical Director |
| Date | 2026-10-14 |
| Status | Draft for practice. Written against the app as built on 2026-10-14 (see Section 11). |
| Where the demo runs | Jorge's own computer only: `http://localhost:3100/demo` |

> **Mandatory caveat. Say it at the start and leave it visible on screen.**
>
> **This demonstration uses synthetic data and simulated connectors. It does not show clinical performance or a production integration.**
>
> - Every name in the app is fictional: the lab ("Lumen Bay Dermatopathology"), the offices, staff, doctors and patients.
> - No director, physician, laboratory or vendor has endorsed, approved, funded, purchased or partnered on this work. Showing it is **not** a request for a purchase or for system access.
> - The app has never been connected to EMA, the lab network or patient information, and is not installed on any lab workstation.
> - The problems it addresses come from my own observations as an employee. They are **not** audited findings or measured rates.
>
> The same sentence appears at the bottom of every step panel in the app, and the `/demo` page header carries the label "Synthetic data, simulated connectors".

---

## 1. The demo in one minute (for the presenter)

**What it is.** The `/demo` page has four tabs: **Guided demo**, **Workflow map**, **Speaker notes** and **Real vs simulated**. The guided demo walks through the eight steps from the master specification (Section 12), on the app's real screens.

**The story.** One fictional patient, **Avery Quinlan**, from the fictional **Harbor Point Dermatology**, has two specimens (parts A and B) that arrive as two separate orders. We follow them from the 11:00 courier to the Operations view. Steps 6 and 7 use **earlier** made-up cases, not Avery Quinlan's.

**What each step panel shows.** "Open the real screen" buttons (links that open the exact record), "What to click", "What to notice", "Real vs simulated in this step", and "Progress (read from the records)".

**The two buttons, in plain words:**

| Button | What it does | Who can press it |
|---|---|---|
| **Run simulator events for this step** | Does only what the *outside world* would do in the story: the courier arrives, the office replies, the source system sends an amended order. It also moves the demo clock forward. Apart from unpacking the step 1 delivery (a simulated scan, recorded as received by Maya Torres), it **never** does staff work. | Any demo role |
| **Auto-perform staff actions (rehearsal)** | Also performs the staff clicks for that step, as the named fictional staff member, through the same rules and safety checks as the real screens. Each action shows in History as a demo action. Meant for practice and for recovering when something goes wrong. | Only while "Acting as" is **Tanya Brooks (Operations supervisor)** |

**Progress is read from the records**, not from button presses. Work you do directly on the real screens counts.

**The demo clock** is a pretend clock, always labeled "Demo clock". After a reset it starts at **10:52 ET**. It starts paused and moves only when you move it (or press Resume to let it run in real time). Each step's simulator button jumps it forward to that step's time. It **never** moves backward.

---

## 2. Setup checklist

### 2.1 The day before

- [ ] Practice the whole demo **twice** with a timer: once using the rehearsal button on every step (acting as Tanya Brooks) to see the expected end state, then reset and once by hand.
- [ ] While practicing, take a few screenshots of the synthetic screens as a paper backup (synthetic data only).
- [ ] Print: the run-of-show table (Section 3), `docs/director-pitch.md` as the one-page handout, and the before/after map from `docs/workflow-map.md`. Optionally `docs/discovery-checklist.md` and `docs/pilot-proposal.md` Section 14 ("Decision requested").
- [ ] On the laptop you will present from: no EMA session, work email, patient information or employer documents open, in browser tabs or in the bookmarks bar. Turn off pop-up notifications.

### 2.2 Thirty minutes before

- [ ] **Start the app.** In Terminal, in the project folder, run `npm run dev` (Node 22 or newer). Open `http://localhost:3100/demo`.
- [ ] **Browser size: 1366 × 768**, browser zoom **100%**. The screens were designed so key fields fit a common 1366-pixel-wide workstation. If the projector forces another size, check that the step panel and the Intake comparison table fit without sideways scrolling.
- [ ] **Reset the demo.** On `/demo`, press **Reset demo** in the toolbar, then **Reset demo data** in the confirmation. Expect the message "Demo data reset" and the toolbar to read **"0 of 8 steps done"** with **Demo clock 10:52 AM ET**. (Also available at Settings, Demo scenarios, "Reset demo data".) A reset also puts every simulated connector back to its starting state (sources and notifications "connected", printers "online").
- [ ] **Pause the demo clock (recommended).** In the top bar, open **Demo clock** and choose **Pause clock**. The step buttons still jump it forward; pausing just keeps it from drifting while you talk.
- [ ] **Check "Acting as".** The top-bar selector should read **Maya Torres, Accessioner**. The role is remembered by the browser, and a data reset does **not** change it, so switch back to Maya if you rehearsed as Tanya Brooks.
- [ ] **Presenter text size.** If the room is large, press **Presenter text size: normal** in the `/demo` toolbar so it reads **large**. This only enlarges the guided-demo panel and the speaker notes, and the browser remembers it. Leave browser zoom at 100% so the other screens keep their layout.
- [ ] Do **not** switch on any simulated outage (Settings, Demo scenarios) before the demo unless you plan to show it.

### 2.3 One minute before

- [ ] Screen shows `/demo?tab=guide&step=1`, toolbar "0 of 8 steps done", Demo clock 10:52 AM ET (paused).
- [ ] This script or the printed run-of-show is next to you. The app's **Speaker notes** tab (`/demo?tab=notes`) has nearly the same notes if you want them on a second screen.

### 2.4 Which role to select for each step

"Acting as" is a **demo role switch, not a sign-in**. The server checks the role on every action, whatever the menu says.

| Step | Story role ("Acting as") | Shortest path (fewer switches) | Why this role |
|---|---|---|---|
| 1 Courier arrival | Maya Torres, Accessioner | Maya Torres | Receives the delivery and accepts routing |
| 2 Related orders | Maya Torres, then **Kim Nguyen, Accessioning lead** | Maya, then Kim | Only a lead or supervisor may decide that two orders belong together |
| 3 Clarification and hold | Maya Torres raises it; **Kim Nguyen** reviews, resolves and releases the hold | Stay as Kim for the whole step | Review, resolution and hold release need a lead or supervisor |
| 4 Accession | Maya Torres | Stay as Kim (a lead may also request it) | Requests the official number |
| 5 Gross record, Part A | Dana Whitfield, Grosser | Dana Whitfield | Confirms values and approves her own part |
| 6 Tray and printer | Priya Shah, Histotechnologist | Priya Shah | Tray checks and print reconciliation |
| 7 Block retrieval | Marcus Lee, Histotechnologist | Stay as Priya (same role) | Picks blocks |
| 8 Operations | Tanya Brooks, Operations supervisor, or Director of Operations (demo, read-only) | Tanya Brooks | Overview of what is still blocked |
| Any rehearsal button | **Tanya Brooks, Operations supervisor** | | The rehearsal acts as other named staff, so it is limited to the supervisor demo role |

If you need to cut every switch, you can stay as **Tanya Brooks** for the whole demo: her demo role can perform every staff action. Say so aloud, and note that you lose the role-check moment in step 2.

---

## 3. Run of show (timed)

The talk budget totals **5:00**. The app's step panels and Speaker notes tab suggest slightly longer times (about 5 min 10 s in all, with a 25 s opening and a 25 s closing); this script trims the opening, step 6 and step 7 by 5 s each and gives the closing 5 s more.

IDs shown are what a fresh reset produces when the steps are done in order (checked on 2026-10-14). If you do things in a different order, some numbers can differ; the panel's "Open the real screen" buttons always link to the actual records.

| # | Talk time | Demo clock (ET) | Screen / URL | Presenter action (acting as) | What the audience should notice | Real (works locally) vs simulated | ~s |
|---|---|---|---|---|---|---|---|
| Open | 0:00–0:20 | 10:52 (paused) | `/demo?tab=guide&step=1` | Say the opening (Section 4). Point at the "Synthetic data, simulated connectors" label. | It is made up, local and not endorsed. | n/a | 20 |
| 1 | 0:20–0:50 | 11:00 | Guide step 1, then **Intake** `/intake`, hero item `/intake?item=INT-1014-031`, unknown office `/intake?item=INT-1014-034` | **Maya.** Press **Run simulator events** (courier CR-1014-11 arrives; all 11 items unpacked). On Intake, point at the manifest strip: Mangrove Bay Dermatology expected "Unknown (no source manifest)". Open INT-1014-031 and accept the suggested routing (Harbor Point Dermatology to Dr. Elena Marsh, rule set v3). Accept routing on INT-1014-032 too (needed before the accession in step 4). Open INT-1014-034 (Seagrape Skin Studio): exception lane. | Expected vs received per office; a missing manifest is "Unknown", never 0. The suggestion names the approved, versioned rule. An office with no rule becomes a routing exception; no doctor is guessed. Provisional INT- numbers look different from accession numbers. | **Real:** manifest reconciliation, rule-based routing with rule version, exception lane, audit trail. **Simulated:** the courier and container contents; orders from "EMA-SIM" (a simulated source system). | 30 |
| 2 | 0:50–1:20 | 11:03 | `/intake?item=INT-1014-031` | **Maya:** press **Staff verified against physical container** for part A. Open the related-order card (REL-0112) and read the reasons. Switch to **Kim Nguyen** and choose **Link as related** (one accession, parts kept with their original orders) with a short reason. Optional: before switching, show that Maya cannot make this decision. | The system only suggests; a person decides, with a reason. Both orders, ORD-77120 and ORD-77121, are kept. Nothing is merged. The server checks the role, whatever the selector says. | **Real:** detection with reasons and conflicts, role-checked decision, audit trail. **Simulated:** the two orders came from the simulated source. (The simulator button has nothing to do here except move the clock.) | 30 |
| 3 | 1:20–2:05 | 11:06, office reply 11:12, amended order about 11:14 | `/intake?item=INT-1014-032`, then `/clarifications?selected=CLR-0457` | **Kim (or Maya):** verify container B; the laterality row shows "Differs" (order: Right dorsal forearm; bottle: Left dorsal forearm). Press **Raise clarification** on that row, keep the hold on **Part B only**, then, on Clarifications, draft and send it (simulated). Back on the guide, press **Run simulator events**: the office answers and the amended order ORD-77121 v2 arrives. On Clarifications as **Kim**: review the answer with a note, resolve it, and release hold H-0090 with a reason. | The hold names its scope: Part B only. Part A can continue. The office answer resolves nothing by itself; a lab reviewer does. The hold comes off only when the lead releases it, after the amended order arrives. The original order version (right) is kept beside the amendment. The message text has no patient details. | **Real:** evidence with both values kept, clarification states, owner and follow-up time, scoped hold, review / resolution / hold release as separate steps. **Simulated:** notification delivery, the office's answer, the amended order, the message draft (fixed demo text, not live AI). | 45 |
| 4 | 2:05–2:30 | 11:18 | `/intake`, then `/cases/D26-04817` | **Kim (or Maya):** request the accession for both Quinlan items together. Open case **D26-04817**: Overview, Material, Source documents, Tasks, History. | The number comes from the simulated source and is labeled that way. Parts A and B keep ORD-77120 and ORD-77121. History shows who did what and when. A double click creates nothing extra. | **Real:** accession preconditions (verification, routing, related-order review), repeat-safe request, linked case view. **Simulated:** issuing the accession number. | 25 |
| 5 | 2:30–3:10 | 11:30 | `/grossing?part=D26-04817-A`, then `/worklist` | **Dana Whitfield:** load the synthetic dictation **quinlan-A**; confirm each proposed number, unit and count; fill the narrative (press **Compose from confirmed values**, then **Save draft**; approval is refused while the narrative is empty); mark operator reviewed; approve for downstream use. Open the Worklist: Dr. Elena Marsh's group shows the change. | Proposed values look different from confirmed ones; approval waits until required values are confirmed. A1 becomes eligible for processing and a source-entry task opens for Sam Ortiz. Part B stays "awaiting grossing"; the case is never shown as complete. "Source update pending" is not "entered in EMA". | **Real:** field-by-field confirmation, per-part approval, downstream tasks, worklist change feed. **Simulated:** the transcript (synthetic) and the extraction (fixed demo rules, not live AI). Nothing is written to any source system. | 40 |
| 6 | 3:10–3:40 | 11:40 | `/materials?tab=trays&selected=TRY-M-03`, then `/materials?tab=print&selected=PJ-8841` | **Priya Shah.** Say: "This is an earlier made-up case." Tray TRY-M-03 (Dr. Marsh): 8 of 10 scanned. In the **Simulated scanner** card, scan the 9th slide, then the Dr. Okafor slide. Point at **Mark tray complete**: it is unavailable (or refused) and says why. Open PJ-8841: the printer never confirmed. Record "Checked at the printer: not printed", then reprint with a reason. | A scan reads "Scanned, matches", not "verified"; one tray scan never verifies every slide. Completion is blocked while a slide is missing or unexpected; the options are controlled. A retry is refused until the unknown outcome is reconciled. The reprint records a reason and links to the original job; it is not a new slide. | **Real:** slide-by-slide tray checks, print job states including "unknown outcome", reconcile-before-retry. **Simulated:** the printer and its timeout; label previews (not validated for real scanners, solvents or stainers). | 30 |
| 7 | 3:40–4:00 | 11:45 | `/materials?tab=retrieval&selected=RR-0192` | **Priya (or Marcus Lee).** Read the last confirmed slot (D26-03990 A1: CAB-2/DR-4/BX-11/S-14, confirmed 2026-10-09 by Marcus Lee) and the checkout history; D26-03912 A1 is checked out and overdue. In the **Scan check** card, scan the wrong block **D26-03909 A1** (mismatch), then **D26-03990 B1** (matches, pick 1 of 3). | Location reads "last confirmed", with who and when; it is not live tracking. The overdue checkout is stated, not guessed. A wrong block changes nothing and is logged. | **Real:** scan check against the request, custody history, pick list by location. **Simulated:** storage history (synthetic) and the scanner (a click or the keyboard stands in for it). | 20 |
| 8 | 4:00–4:30 | 11:50 | Guide step 8 summary, then `/operations` (optional `/insights`) | **Tanya Brooks** (or Director of Operations, demo, read-only). Press **Run simulator events** (moves the clock to 11:50). Pick one blocked item and follow its link to the record. Example: "Enter approved gross description in source system, D26-04817 part A", owner Sam Ortiz. | Each item shows its owner, its age and why it is blocked, and opens the record behind it. Numbers are computed from synthetic data and labeled that way. No scores, no staff rankings. | **Real:** blocked-work list computed from holds, tasks, clarifications, print outcomes and trays; data freshness per source. **Simulated:** all data is synthetic; nothing reflects real lab performance. | 30 |
| Close | 4:30–5:00 | 11:50 | Stay on Operations, or `/demo?tab=map` | Say the closing and the ask (Section 4). | The ask is small: permission to observe and measure, a review of the synthetic demo, and help asking ModMed what is already licensed and configurable. Not a purchase, not system access. | n/a | 30 |

---

## 4. Speaker notes (say it in your own words)

At about 140 spoken words a minute these notes take about 4 min 45 s, so most clicking has to happen while you talk. The app's Speaker notes tab has a very similar version (its opening and closing are 25 seconds each).

**Opening (about 20 s).**
"Thank you for your time. I call this Histology Redesigned. At the bench I keep seeing the same specimen information copied by hand at several handoffs, and questions to offices that sometimes wait a long time for an answer; we don't yet know why. Those are my observations, not measurements. Everything here is made-up data on my laptop, with simulated connections, and nobody has endorsed or approved it."

**1. Courier arrival (about 30 s).**
"It's 11:00 on the demo clock and the courier arrives. Instead of each of us remembering which office goes to which doctor, the screen compares what we expected with what came in, and suggests the dermatopathologist from a written, approved rule, and it shows which rule. This office sent no list, so it says 'Unknown', not zero. This new office has no rule, so it goes to an exception lane. Nothing is guessed."

**2. Two orders, one patient (about 30 s).**
"Avery Quinlan, a made-up patient, had parts A and B entered as two separate orders. Today that can look like two patients. The system only says they may belong together, and shows why: same patient reference, same visit, same office, same day. The accessioning lead decides, with a reason. Both original orders stay exactly as they were. Nothing is merged."

**3. Part B: left or right (about 45 s).**
"Part B's bottle says left forearm; the order says right. We raise one specific question to the office, with an owner and a follow-up time, and only Part B is held. Part A keeps moving. The message carries no patient details; it points to a secure view. The office's reply here is simulated. Notice the reply doesn't close anything: the lead reviews it and resolves it, and the hold comes off only after the corrected order arrives. Faster answers would also need an agreement with the offices; more messages alone can just add noise."

**4. The accession (about 25 s).**
"Now the accession is requested for both items together. The number comes from the source system, which is simulated here. The provisional intake number looks different on purpose. The case keeps both original order numbers on parts A and B, and the history shows who did what, and when."

**5. Part A moves on its own (about 40 s).**
"Dana grosses Part A. The dictation is a synthetic transcript, and every value it suggests stays 'proposed' until she confirms each number, unit and count. Once Part A is approved, the next steps appear right away: cassette A1 can go to processing, and Sam gets a task to enter the description in EMA. It doesn't pretend it's already there. Part B is still waiting, so the case isn't finished. This might help with the evening batch, but we'd have to measure that, and entering directly in EMA might turn out to be the better fix."

**6. Tray and printer (about 30 s).**
"This step uses an earlier made-up case. The tray expects ten slides; one is missing and one belongs to another doctor, so it can't be marked complete. A label job timed out, so the outcome is 'unknown'. Someone checks the printer before anything is reprinted, and the reprint records a reason. A web page can't apply 300 labels; real printing depends on our printers and materials."

**7. Finding a block (about 20 s).**
"For a block request, the screen shows the last confirmed slot and who had it, not a promise that it's there. One block is checked out and overdue, and it says so. Scanning the wrong block is rejected, and nothing changes."

**8. What is still blocked (about 30 s).**
"Operations shows what is still blocked, who owns the next step, how long it has waited, and the evidence behind it. Here, Part A is waiting for Sam to enter it in EMA. These numbers come from made-up data. They're not results, and they're not for ranking anyone."

**Closing and the ask (about 30 s).**
"I'm not asking for a purchase, system access or patient data. I'm asking for three things: permission to observe and time a few real cycles, with my coworkers' agreement and no patient identifiers in my notes; thirty minutes for a small group to review this synthetic demo and tell me what I got wrong; and help asking ModMed what we already have and can configure. EMA first, existing products second, and only then anything new. Thank you."

---

## 5. Before and proposed after (summary)

The full map, with the handoff table and the hypotheses, is in **`docs/workflow-map.md`**. The same map is on the app's **Workflow map** tab (`/demo?tab=map`). O-numbers are my observations (`docs/product-brief.md`, Section 2.1). H-numbers are **hypotheses to measure**, not results. The "after" column is a proposal that has not been validated with lab staff.

| Handoff | Before (observed) | Proposed after (hypothesis) | Shown in step | Stays in EMA |
|---|---|---|---|---|
| Courier arrival | Courier about 11 a.m. with specimens from several offices; whether any list of expected containers exists is unknown (O1) | Expected vs received per office; "Unknown" when there is no list (H1) | 1 | Orders |
| Office to pathologist | Accessioners remember which office goes to which doctor (O2) | Approved, versioned rule; an unknown office goes to an exception lane (H2) | 1 | The official assignment, if EMA holds it (confirm) |
| Parts A and B as separate orders | Looks like "two patients"; hard to correct after accession (O4) | A related-order suggestion with reasons; a reviewer decides; nothing merged (H3) | 2 | Orders, accession, any official correction |
| Questions to offices | EMA message; replies can be delayed, cause unknown (O5) | One clarification per question, with owner, follow-up time and escalation; hold only the affected part; answer reviewed before it is resolved (H4, H5). Needs an agreement with the offices. | 3 | The message channel, if it stays in EMA; order corrections |
| Gross description | Handwritten, batched, then typed into EMA, sometimes until about 9 p.m. (O7) | Per-part reviewed record; the next task appears as each part is ready; "entered" only after EMA acknowledges (H6) | 5 | The official gross description |
| "The bible" | Daily printed report by doctor, colored pages, PAS table in yellow (O9) | Live worklist by doctor name and color; PAS shown as text with its order and block or slide; printable snapshot with time and version (H7, H8) | 5 | Orders and stain/work orders |
| Slide labels | 300+ labels a day printed and applied by hand; extras printed separately (O8) | Print queue tied to official IDs; unknown outcome reconciled before any retry (H9). Applying labels stays manual. | 6 | Label printing, if EMA does it [R1] |
| Tray assembly | Current lab's step not mapped in detail; repeated scanning seen at a previous lab (O11) | Slide-by-slide tray check; missing or unexpected slides flagged (H10) | 6 | Nothing in the first build |
| Block retrieval | Manual number checking (O10) | Last confirmed location, checkout history, wrong-block scan rejected (H11) | 7 | Unknown whether EMA records storage (confirm) |
| "What is blocked?" | Asking around (assumed; not specifically observed) | Operations view: owner, age, evidence and data age (H12) | 8 | Nothing |

**What stays the same:** EMA remains the system of record. Physical work stays physical. Clinical decisions stay with authorized people. The new review steps **cost time**, and that time has to be counted against any time saved.

---

## 6. Likely questions and honest answers

Short answers first. If you don't know, say "I don't know yet; that's on the discovery checklist" (`docs/discovery-checklist.md`).

### 6.1 From the Director of Operations

**"Does this replace EMA?"**
No. It's a companion to EMA. EMA stays the system of record for patients, orders, accession numbers, approved gross descriptions and reports. The first thing I'd check is what EMA can already do: ModMed advertises gross defaults, configurable stains, tracking, accession sequences and slide or cassette label printing "in most cases" [R1]. I don't know what we have licensed or turned on.

**"Can't EMA already do this?"**
Possibly, for parts of it. That's why the order is configure first, then existing products, then build [R1]. Specialist products already exist for tracking, grossing documentation and slide printing [R10][R11][R12]; those are vendor descriptions, not proven results for our lab.

**"What would a pilot cost?"**
I don't know, and I haven't put any prices in. Every cost needs a vendor quote or an internal estimate: licenses, configuration, interfaces, hardware, labels, validation, training, support and hosting (`docs/pilot-proposal.md`, cost summary). The first thing I'm asking for costs staff time only: some observation, and a 30-minute review.

**"How do you know it saves time?"**
I don't, yet. The demo shows how the workflow *could* behave; it proves no savings. The plan is to measure a baseline first, the same way before and after: accession minutes per case, clarification response and resolution times, grossing-to-entry delay, age of open work, retyping time, reprints, label handling, block retrieval time. We'd report the middle value and the slow tail, show unfinished work separately, never count missing data as fast, and subtract the extra checking any new tool adds. Time saved, waiting reduced and actual dollars are kept separate (`docs/pilot-proposal.md`, Sections 6 to 8).

**"What data would you need?"**
For the first step, none from EMA and no patient data: just observation notes with times and categories, no names or numbers, with my coworkers' agreement. Any later shadow test would use only data the lab, IT and privacy owners approve, through a supported interface or approved export, with EMA staying authoritative (`docs/integration-capability-matrix.md`).

**"Did you use anything from work to build this?"**
No. No patient data, no employer screenshots or reports, no real contacts. It has never been connected to EMA or the lab network. All names are made up.

**"What about the 9 p.m. typing?"**
I don't know the real constraint yet. It could be the grossing itself, the documentation, the typing, staffing or processing cutoffs, so each would be measured separately. Direct structured entry inside EMA might be the better first fix. Published work found voice recognition had a negligible effect on how long grossing took, though it reduced transcription needs [R8].

**"Would this be used to rate staff?"**
No. Results would be reported by team, station or office category, never as individual rankings from raw counts.

**"Who would build and support a real version?"**
Undecided, and that's a real dependency: a built tool needs professional engineering, security and support, and must not depend on one employee. That's another reason to look at EMA configuration and existing products first. (Answer honestly about how the prototype itself was made.)

**"How long would a pilot take?"**
The lab would set the durations. Each stage has a gate: observe, baseline, review the synthetic demo, then possibly a short approved shadow comparison with a rollback plan (`docs/pilot-proposal.md`, Section 5).

### 6.2 From the medical director

**"Is this validated?"**
No. It isn't clinically validated or validated for any lab use, and I make no compliance claims. The label previews aren't validated with real scanners, solvents or stainers. The role selector isn't a login, and the local audit log isn't proof of tamper resistance. Real use would need review and sign-off by the clinical, IT, privacy and security, and operations owners, plus local validation. A disclaimer or role buttons don't make a prototype compliant.

**"Does the software make clinical decisions?"**
No. No diagnosis, no stain ordering, no specimen-matching decisions, no accession corrections, no report release. Related orders are suggestions a person decides on. PAS is shown from the order that authorized it, never guessed from diagnosis text.

**"Is the AI real?"**
Not in this demo. The drafting and extraction "assistant" uses fixed demo rules and is labeled that way. Every proposed value needs a person to confirm it, and the manual workflow still works with the assistant switched off. The fake data even includes an order note that tries to give the assistant instructions; it's treated as plain text and changes nothing (covered by the automated tests).

**"What if a site or side discrepancy is found after accessioning?"**
The app never changes the site on an accessioned part, renumbers a case or merges cases. It opens a correction review that keeps the original references, and the actual correction goes through the lab's authorized process in EMA.

**"What about PAS that gets canceled after the slide is printed?"**
The seeded day includes one: at about 11:20 on the demo clock, the simulated source removes a PAS from an earlier case whose PAS label was already printed. The work is marked for review instead of being erased, and the worklist shows it as a change. If asked, open the Worklist after step 5 to show it.

**"Who approves the office-to-pathologist rules?"**
In the demo, a fictional demo medical-director role approves the rule set. In reality the lab decides who approves the mapping and coverage; that's a discovery question.

**"Does the evidence say barcodes reduce errors?"**
Published single-center work is encouraging but not a promise for us. One histology improvement series reported labeling errors falling from 1.03% to 0.28% after a barcode-enabled LIS, then 0.22% with workflow changes [R6]. Another found that mandating block confirmation alone didn't change wrong-tissue-in-block rates; a workflow hard stop did [R7]. Process matters as much as the tool. CAP/NSH guidance on identification and barcode validation is something to review with lab leadership [R5].

**"Would this make patients safer?"**
A short pilot can't show a reduction in rare harm events. We would track near misses and process measures instead, and claim nothing about harm prevention.

**"What do you need from me?"**
Thirty minutes with a small group to review the synthetic demo and correct my assumptions, and your guidance on which clinical questions must be answered before anything goes further. Nothing else.

---

## 7. If something goes wrong (recovery)

**Rule of thumb:** don't troubleshoot live for more than about ten seconds. Say one calm sentence, then use the rehearsal button, skip, or reset. Re-running a step is safe: it checks what is already done and creates no duplicates.

### 7.1 Three recovery moves

1. **Rehearsal button.** Switch "Acting as" to **Tanya Brooks (Operations supervisor)**, press **Auto-perform staff actions (rehearsal)**, then **Perform rehearsal actions** in the confirmation. Say: "I'll let the demo replay these clicks; each one is recorded as a demo action." The action log under the step shows each action and its result.
2. **Skip.** Steps 6 and 7 use earlier cases and don't depend on the hero case, so they can be skipped or done in any order. Steps 2 to 5 depend on each other, in order (1, 2, 3, 4, 5). Step 8 always works; it shows whatever state exists.
3. **Reset and catch up.** **Reset demo** in the `/demo` toolbar returns everything to the 10:52 starting state. Then, acting as Tanya Brooks, open each step up to where you were and press the rehearsal button, in order. Switch back to the step's role and continue. A reset erases all demo history, which is fine because it's synthetic.

### 7.2 What the step messages mean

| Message under the step | Meaning | What to do |
|---|---|---|
| "Simulator events done" / "...and rehearsal actions done" | It worked. | Continue. |
| "Refused, as expected" on an action, or a button that is unavailable and explains why | A safety check said no, on purpose (for example, completing a tray with a missing slide). | Point it out; it's part of the story. |
| "Nothing to simulate yet" | The simulator is waiting for a staff action first (for example, step 3 before the clarification is sent). | Do the staff action on the real screen (the message says which), or use the rehearsal button. |
| "x of y actions completed; z did not" | Something earlier isn't done. Nothing was overwritten. | Read the reason in the log; usually an earlier step needs finishing. |
| "This step is not available yet in this build" | A command this step needs isn't in this build. Nothing changed. | Skip to the next step. |

### 7.3 Specific problems

| Symptom | Likely cause | Fix |
|---|---|---|
| A control is refused or missing for the current person | The server checks the role | Switch "Acting as" to the role in Section 2.4. Turn it into a talking point. |
| Step 3: the office never answers | The clarification wasn't sent, or its simulated delivery failed | Send it from the Clarifications screen. If delivery failed, go to Settings, Demo scenarios, **Restore notifications**, resend, then press the step 3 simulator button again. |
| Step 3: the amended order doesn't arrive | The simulated source was switched offline | Settings, Demo scenarios, Source systems: set EMA-SIM back to connected and deliver queued messages (or press the step 3 simulator button again). |
| Step 3: hold release refused | Acting as an accessioner | Switch to Kim Nguyen (lead). |
| Step 4: "Request accession" refused with a list | A precondition is missing | Read the list. Common ones: routing not accepted on INT-1014-032, related-order decision not made, container A not verified. |
| Step 4: "Source system unreachable (simulated outage)" | EMA-SIM was set offline | Set it back to connected and retry the **same** request; it will not create a second one. |
| Step 5: approve is not available | A required value is still proposed, needs review or is missing, or the narrative is empty | Confirm it. For the narrative, press **Compose from confirmed values**, then **Save draft**. If the extractor marked something "needs review", the grosser must decide; the rehearsal never confirms those for you. |
| A message says the record changed since you opened it | The stale-update check worked (someone, or a rehearsal, changed it first) | Reload the page and repeat the action. |
| The page looks out of date | It hasn't refreshed | Reload. Progress is read from the records. |
| Step 8 says the Operations summary couldn't be read | Display problem on the guide | Open `/operations` directly. |
| The app doesn't load at all | The server stopped | Run `npm run dev` again; data is kept in the local database file. If the data is damaged: stop the server, run `npm run db:reset`, start it again. |
| Running long | | Skip steps 6 and 7 with one sentence each ("the tray can't be completed with a slide missing; a wrong block is rejected"). |
| Laptop or projector fails | | Use the printed pitch, the before/after map and your rehearsal screenshots. Offer to run the demo another time. |

---

## 8. Known expected outcomes (what the records should show)

These come from the guided-demo progress checks and the automated hero-journey test. After a full run, the toolbar reads **"8 of 8 steps done"**.

| Step | Expected outcome in the records |
|---|---|
| 1 | Courier CR-1014-11 arrival recorded; 11 of 11 physical items received. Quinlan items INT-1014-031 and INT-1014-032 routed to Dr. Elena Marsh by rule set v3. Seagrape Skin Studio item INT-1014-034 is a routing exception owned by Kim Nguyen, with no doctor suggested. |
| 2 | Related-order candidate REL-0112 decided "single accession approved" by Kim Nguyen, with a reason. ORD-77120 and ORD-77121 both still exist with their own parts. |
| 3 | Clarification CLR-0457 (laterality) answered (simulated), reviewed, then resolved as "confirmed observed". Hold H-0090 on "Part B (ORD-77121 · B)" blocked gross approval, processing, printing and tray delivery, **not** accessioning, and was released by Kim Nguyen only after amended order ORD-77121 v2 was imported. Version 1 (right side) is kept. |
| 4 | Accession D26-04817 issued by the simulated source. Part A linked to ORD-77120, part B to ORD-77121. Both intake items point to it; nothing deleted or merged. |
| 5 | Part A gross record "approved for downstream use"; A1 eligible for processing; source-entry task for Sam Ortiz; Part A source update "pending entry". Part B "awaiting grossing". The case is not complete. A worklist change was recorded. |
| 6 | TRY-M-03 not verified complete (the 10th slide is missing; the unexpected slide was flagged). PJ-8841 was not reprinted before reconciliation; after "not printed", one reprint (PJ-8842 in rehearsal) linked to the original, same slide, with a reason. |
| 7 | Wrong block D26-03909 A1 rejected as a mismatch; nothing about the request or that block changed; the mismatch is logged. D26-03990 B1 matched (pick 1 of 3). |
| 8 | Operations still lists open work with owners and ages, including D26-04817 part A waiting for source-system entry by Sam Ortiz. The released Part B hold is no longer listed. |

---

## 9. Real, simulated, not implemented, unknown

The app's **Real vs simulated** tab (`/demo?tab=real`) has the in-app list. Summary (the "Unknown" row also adds items from `docs/discovery-checklist.md` that the tab does not list):

| Category | What it covers |
|---|---|
| **Working locally in this demo** | Expected vs received reconciliation; routing by approved, versioned rule and the exception lane; related-order suggestions and review (never a merge); clarification states, owners, follow-up times, scoped holds, review and resolution; digital doctor/PAS worklist with "changed since you last acknowledged" and a printable snapshot showing its time and version; gross record confirmation and per-part approval with downstream tasks; print job states with unknown outcome and reconciliation; slide-by-slide tray checks; block retrieval scan checks and custody history; stale-update detection; server-side role checks; a local audit trail. |
| **Simulated** | The source systems (EMA-SIM and OTHER-EHR-SIM: orders, amendments, accession numbers); office notifications and answers (no real office is ever contacted); label and cassette printers, including the timeout; the drafting and extraction assistant (fixed demo rules, not live AI); the courier and container contents; the demo clock. |
| **Not implemented** | Writing gross descriptions or any data back to EMA (entry stays manual and is tracked as a task); real printer control, scanners or microphone input; real sign-in and identity management. |
| **Unknown (needs discovery)** | Which EMA modules are licensed and enabled at our lab, and which interfaces exist [R1][R2][R3][R4]; real office contacts, coverage and response agreements; the approved office-to-pathologist mapping; which printers, scanners and label materials exist; what actually delays incremental gross entry. |

---

## 10. What a real deployment would require

Say this only if asked, or point to `docs/pilot-proposal.md`, Section 9. None of it is being requested now.

- **Owners' review and sign-off:** clinical (intended use, effect on identification and SOPs, local validation), operations (workflow fit, ownership, training, downtime), IT (hosting, identity, interfaces, devices, backup), privacy and security (data access, contracts, auditability).
- **A confirmed, supported interface** for any data coming from EMA. What ModMed documents (a proprietary API, a read-only certified FHIR API, HL7 order and result feeds, an orders resource) doesn't prove access to internal histology data such as parts, blocks, slides, gross text or assignments [R2][R3][R4].
- **Device work:** compatible printers, drivers and label materials, tested together and validated locally [R5][R12].
- **A written downtime and rollback method**, rehearsed before any trial.
- **A staged path:** local demo (now), then an approved shadow comparison, then a small live pilot, then any write-back to EMA only through a reviewed and tested interface.

---

## 11. How this script was checked

- Written from the code as of 2026-10-14: `src/server/domain/demoSteps.ts` (steps, clock times, scenario IDs), `src/components/demo/` (step panel text, buttons, toolbar, speaker notes), `src/app/demo/page.tsx`, `src/app/api/demo/reset/route.ts`, the seed in `src/server/seed/`, and the storyline in `docs/dev/command-contract.md`.
- The automated guided-demo tests (`tests/domain/demo.test.ts`, 38 tests) passed on 2026-10-14. They cover the **rehearsal** path through all eight steps, at the data level.
- A separate run of all eight rehearsal steps on a fresh synthetic database confirmed the IDs used here (INT-1014-031, -032, -034, REL-0112, CLR-0457, H-0090, D26-04817, PJ-8842) and the Operations list in step 8.
- **Not checked:** the by-hand presenter path in a real browser. Button labels on the Intake, Clarifications, Grossing and Materials screens were still being edited when this was written. Before presenting, rehearse once and trust the step panel's "What to click" over this document if they differ.

---

## 12. Plain-language glossary

| Term | Meaning here |
|---|---|
| Synthetic data | Made-up records generated for the demo. No real patients. |
| Simulated connector / simulator | A stand-in for an outside system (EMA, an office, a printer). It behaves in a scripted way and never contacts anything real. |
| Source system | The official system that owns a record, such as EMA. In the demo, "EMA-SIM" plays this part. |
| Intake item (INT-...) | A provisional receiving record. It is deliberately not an accession number. |
| Accession (D26-...) | The official case number, issued by the source system (simulated here). |
| Related-order candidate (REL-...) | A suggestion that two orders may belong together. A person decides. |
| Clarification (CLR-...) | One specific question to an office, with an owner and a follow-up time. |
| Hold (H-...) | A stop on named steps (for example, gross approval) for named material only (for example, Part B). |
| Reconcile | Check what really happened (for example, at the printer) before doing anything again. |
| Rehearsal | The app performs the staff clicks for a step, as the named fictional staff, for practice or recovery. |
| Demo clock | A pretend clock for the story. It never moves backward. |
| Deep link | A link that opens one exact record or screen. |

---

## References

Cited as [R#] from the master specification. See `docs/research-notes.md` for what each source does and does not establish (checked 2026-10-14). These sources do not describe our lab's configuration or authorization.

- [R1] ModMed, Pathology Lab Reporting Software. https://www.modmed.com/what-we-do/pathology/
- [R2] ModMed API Portal, Getting Started. https://portal.api.modmed.com/docs/getting-started
- [R3] ModMed, HL7 Connectivity. https://www.modmed.com/what-we-do/integrations/synapsys/hl7/
- [R4] ModMed API Portal, ServiceRequest (Orders). https://portal.api.modmed.com/reference/servicerequest-orders
- [R5] CAP/NSH, Practical Guide to Specimen Handling in Surgical Pathology, version 12.0, March 2025. https://www.cap.org/wp-content/uploads/documents/Practical_Guide_to_Specimen_Handling_in_Surgical_Pathology_2025.pdf?download=true
- [R6] Achieving High Reliability in Histology: An Improvement Series to Reduce Errors. Am J Clin Pathol, 2016, 146(5):554–560. https://academic.oup.com/ajcp/article/146/5/554/2529661
- [R7] Weaver et al., Wrong Tissue in Block. Am J Clin Pathol, 2021, 156(4):700–707. https://pubmed.ncbi.nlm.nih.gov/33940603/
- [R8] Ye, Tan and Shum, Using Timestamp Data to Assess the Impact of Voice Recognition on the Efficiency of Grossing Biopsies. Arch Pathol Lab Med, 2021, 145(5):599–606. https://pubmed.ncbi.nlm.nih.gov/32960950/
- [R10] Leica Biosystems, CEREBRO Workflow Management System. https://www.leicabiosystems.com/us/tracking-and-workflow/cerebro/
- [R11] Milestone Medical, MacroPATH. https://www.milestonemedsrl.com/products/grossing-and-macro-digital/macropath/
- [R12] Epredia, Microscope Slide Printers. https://www.epredia.com/products/histology-instruments/slide-printing

> **Closing reminder:** This demonstration uses synthetic data and simulated connectors. It does not show clinical performance or a production integration. No endorsement, approval, procurement or partnership is implied.
