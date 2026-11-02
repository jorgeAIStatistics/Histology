# Presentation deck outline

**Histology Redesigned: 14 slides plus one appendix slide, for a 30-minute meeting**

| | |
|---|---|
| Prepared for | Director of Operations, Platinum Dermatology |
| Prepared by | Jorge Rodriguez, histology assistant |
| Date | [meeting date] |
| Status | Proposal for discussion. Outline of the deck; the built deck is `out/Histology-Redesigned-Director-Presentation.pptx`. The software shown is Histology Lab OS, the software of the Histology Redesigned project. |

> **Rules for every slide.** Use fictional names only: the demo lab is "Lumen Bay Dermatopathology Laboratory (fictional)". Use no real patient data, no real coworkers' names (role titles only), and no logos or branding of any real organization, including the audience's. Platinum Dermatology appears only as the audience on the title slide. Make no compliance, savings or endorsement claims. Every effort or time figure is labeled as a rough estimate to refine in Phase 0.

## Running order (30 minutes)

| Part | Slides | Time |
|---|---|---|
| Opening | 1–3 | about 2 min |
| **Live demo** in the browser (see `demo-day-checklist.md`) | Slides 4–6 are the fallback only, if the live demo fails. After a live demo, skip straight to slide 7 | 5 min |
| Proposal | 7–12 | about 6.5 min (opening plus proposal: under 10 min) |
| Vision, not a request | 13, after the ask | under 1 min |
| Questions | 14 (A1 only if asked) | about 14 min, plus a minute or two of buffer |

Screenshots use the exact file names listed in the "Screenshot capture list" section at the end. They were captured on 2026-10-24 from the synthetic demo (working tree before the code freeze). **Recapture them after the code freeze**, then rebuild the deck.

---

## Slide 1: Histology Redesigned

**On the slide**
- Closing handoff gaps in the histology workflow, measured first
- Prepared for: Director of Operations, Platinum Dermatology
- Jorge Rodriguez, histology assistant · [meeting date]
- Synthetic demonstration · fictional data · not endorsed by anyone

**Screenshot:** none.

**Speaker notes (about 30 s)**
"Thank you for giving me thirty minutes. I'll spend about five minutes on a live demo and about ten on how the lab could try this safely. The rest is for your questions. One thing up front: everything you'll see is made-up data on my own laptop. It has never touched EMA, the lab network or any patient information, and nobody has endorsed or approved it. At the end I'll ask for one small decision, and it isn't a purchase."

---

## Slide 2: What I see at the bench

**On the slide**
- The same specimen details copied by hand at several handoffs
- Office-to-doctor routing kept in people's memory
- Parts A and B sometimes arriving as separate orders
- Clarification replies that can wait, for reasons we don't know yet
- Gross entry batched late; labels and "the bible" handled by hand

*Footer: my observations as an employee, not measured rates.*

**Screenshot:** none.

**Speaker notes (about 45 s)**
"These are things I've seen myself. Accessioners remember which office goes to which doctor. Parts A and B sometimes come in as two orders, and that's hard to fix later. Some clarification replies take a long time, and I don't know why. Gross descriptions get typed in after the batch, some nights until about nine. Many labels, and the bible, are handled by hand. I want to be careful: these are observations, not measurements. I don't know how often each one happens. Some may already have a fix I don't know about. That's why the first step I'm proposing is to measure."

---

## Slide 3: Configure first, buy second, build last

**On the slide**
- **1. Configure:** check what EMA and our existing tools already do
- **2. Buy:** look at existing products (several LIS vendors advertise ModMed integrations; these are vendor claims)
- **3. Build:** only for gaps that remain, and only after measuring
- A good outcome is the problem solved, even if this software isn't what solves it

**Screenshot:** none.

**Speaker notes (about 40 s)**
"The order matters. First EMA. ModMed advertises features like gross defaults, label printing and tracking, and I don't know what we have licensed or switched on. A configuration change could be the cheapest and safest fix. Second, existing products. Several LIS and tracking vendors say they integrate with ModMed. Those are their claims, and we'd check them. Building comes last, and only for what's left. I built this demo as evidence that the remaining gaps can be closed safely. It isn't a request to buy or install it."

---

## Slide 4: Demo, part 1: arrival and two orders for one patient

**On the slide**
- Courier delivery checked against what was expected
- Routing by a written, versioned rule; an unknown office is flagged, not guessed
- Two orders, one patient: the system suggests, a person decides
- Nothing is merged; both original orders are kept

**Screenshots:** `console-guide.png` (small, top left) and `intake-rel0112.png` (main).

**Speaker notes (fallback only, about 60 s, if the live demo fails)**
"Here is what the live demo would have shown. The guide runs eight steps in a fictional lab called Lumen Bay. The courier arrives at eleven, and the screen compares what was expected with what came in. It suggests the doctor from a written rule and shows which version. An office with no rule goes to an exception list, so no doctor is guessed. Here, parts A and B came in as two orders. The system shows why they might belong together, and the accessioning lead decides, with a reason. Nothing is merged."

---

## Slide 5: Demo, part 2: hold only what's wrong

**On the slide**
- Bottle says left, order says right: one clarification, and only Part B is held
- A person reviews the office's answer before the question is closed
- The hold comes off separately, with a reason, after the corrected order arrives
- Part A's gross record moves on; Part B stays visibly unfinished

**Screenshots:** `clarify-hold.png` (left) and `gross-approval.png` (right).

**Speaker notes (fallback only, about 60 s)**
"Part B's bottle says left forearm and the order says right. Instead of stopping the whole case, one specific question goes to the office, with an owner and a follow-up time, and only Part B is held. The office's answer is simulated here. The answer itself doesn't close anything: the lead reviews it, and the hold comes off only after the corrected order arrives. On the right, the grosser confirms every number for Part A, and the next tasks appear right away. Part B still shows as waiting, so the case never looks finished when it isn't."

---

## Slide 6: Demo, part 3: physical checks, and what is still blocked

**On the slide**
- A tray missing a slide can't be marked complete
- A printer timeout shows "unknown", never "printed", until someone checks
- A wrong block scan is rejected, and nothing changes
- Operations: what is blocked, who owns it, how long it has waited

**Screenshots:** three zoomed crops, one callout each: the tray's "Cannot complete" panel (`tray-verification.png`), the "Wrong block: not accepted" panel (`retrieval-mismatch.png`), and the "Blocked now" headline (`operations-blocked.png`; not the per-person chart).

**Speaker notes (fallback only, about 60 s)**
"These use earlier made-up cases. The tray expects ten slides; one is missing and one belongs to another doctor's case, so it can't be completed. A label job timed out, so the screen says unknown, and someone checks the printer before anything is reprinted. A web page can't apply labels for us. Real printing depends on our printers and label stock. Scanning the wrong block is rejected and nothing changes. Last, Operations shows what's still blocked and who owns the next step. These numbers come from made-up data, not results, and they're not for ranking anyone."

---

## Slide 7: What's real and what's simulated

**On the slide**
- **Works today, on synthetic data:** the workflow rules, role checks, audit trail, backup and restore, health checks
- **Simulated:** EMA, offices, couriers, printers, scanners and the drafting "assistant"
- **Blocked:** real sign-in and hosting, until the organization provides them
- **Needs people to check:** screen readers, paper printing, real hardware, touchscreens
- About 800 automated checks pass, on synthetic data. **Not clinical validation.**

**Screenshot:** two crops of `integration-reconciliation.png`: the page title with its "Simulated: source systems" label, and the summary line "5 need review, 1 waiting on the source and 1 failed and retryable".

**Speaker notes (about 60 s)**
"I want to be exact about what's real. The rules you saw run for real on my laptop, with role checks on the server, an audit trail that shows if anyone edits it, and encrypted backups that I've restored and checked. Everything outside is simulated: EMA, the offices, the printers, the scanners. On the right, the simulated EMA messages: five need a person to review, and nothing changed by itself. Real sign-in is built but switched off until IT gives it a real identity provider and a place to run. The tests pass, but tests only show the code does what the tests say. They aren't clinical validation."

---

## Slide 8: Implementation: six phases, with gates where the plan can stop

**On the slide**
- **0. Discovery and governance:** decide to configure, buy, build or stop
- **1. Synthetic sandbox at the lab:** bench usability with real scanners and printers, no patient data
- **2. Technical foundation:** hosting, sign-in, security review, vendor interface (test only)
- **3. Validation and training:** under the lab's quality system, approved by the Medical Director
- **4. Limited pilot**, then **5. Decision:** one workflow, one bench, shadow mode first, rollback ready

**Screenshot:** none. A simple six-box flow, with a gate symbol after Phases 0–3; Phase 4 is labeled "weekly continue-or-stop reviews", and Phase 5 is the decision.

**Speaker notes (about 75 s)**
"If you say yes, it goes one phase at a time, and every phase ends with a gate where we can stop. Phase 0 is four weeks of looking and asking, with no patient data and nothing installed. If we still want to build after that, Phase 1 puts the demo, with made-up data, on one lab computer so coworkers can try it with our real scanners and printers. At that gate you'd also name who builds the interface connector, our IT or a contracted developer, so it never depends on me alone. Phase 2 is IT's part: a real place to run it, real sign-in, an outside security review, and a test interface with the vendor. Phase 3 is validation and training, approved by the Medical Director. Then one small pilot, reviewed every week, and a decision."

---

## Slide 9: Timeline (rough estimates, weeks from approval)

**On the slide**
- Phase 0: weeks 1–4 · Phase 1: weeks 5–10
- Phase 2: weeks 8–22 (vendor-dependent, 2–6 months) · Phase 3: weeks 20–28
- Phase 4: weeks 28–36 · Phase 5: weeks 36–38
- Best case: about **7–9 months** to the end of a limited pilot, with a vendor specification and test environment by about week 15 (about 3 months after approval); **up to about 12 months** with vendor delays
- Cheapest decision-grade path: **Phases 0–1 only, about 10 weeks, no patient data**

**Visual:** a bar chart built in the slide tool (not a screenshot), using this layout. The Phase 2 bar carries "vendor-dependent: 2–6 months"; gate markers G0, G1, G2, G3 and G5 sit below (Phase 4 has weekly reviews instead):

```
Week          1   5    10   15   20   25   30   35
0 Discovery   ████··································
1 Sandbox     ····██████····························
2 Foundation  ·······███████████████················
3 Validation  ···················█████████··········
4 Pilot       ···························█████████··
5 Decision    ···································███
```

**Speaker notes (about 60 s)**
"These are my rough estimates, and Phase 0 is where we'd correct them. The phases overlap because IT and vendor questions take the longest, so they start early, with no contract. In the best case, the vendor gives us a specification and a test environment by about week fifteen, three months in, and we'd reach the end of a small pilot in about seven to nine months. If the vendor test environment is not ready by about week fifteen, plan on the twelve-month case. One caution: ModMed also has its own Pathology module. If our lab works inside it, orders may never travel to a separate system, and the build path would likely stop at the end of Phase 0. The cheapest useful path is the first two phases: about ten weeks, no patient data. That's enough to know whether this is worth more. This plan is for the build path. If we choose to configure EMA or buy a product, we redraw it with them."

---

## Slide 10: What it takes (roles and time, rough estimates)

**On the slide**
- **Sponsor (Director of Operations):** about 1 h a week, plus gate decisions
- **Medical Director:** about 4–8 h, plus gate reviews and validation approval
- **IT:** about 40–100 h · **Compliance/Privacy:** about 10–30 h
- **Bench staff:** 1–2 h usability sessions for 5–8 people; 1–2 h training per role
- **Validation:** about 60–150 h
- **Unknown until quotes or estimates:** vendor interface fees, connector development, external security test, hosting, a support contract or IT time after go-live, hardware and label stock

**Screenshot:** none.

**Speaker notes (about 60 s)**
"Here's who would be involved across the whole plan. For Phase 0 alone it's much less: mostly a few meetings and the inventory. These are ranges, not commitments. The biggest pieces are IT and validation. Validation depends on which workflow we pick, and it's the lab's responsibility under its own quality system. My own time would need an agreement with my manager [to confirm]. Several things I can't estimate yet: the work to build the interface connector, what a vendor would charge, an outside security test, hosting, and hardware or label stock. And one that lasts: support after go-live, whether that's IT time or a contract, including updates, backups and re-checking after changes. Those need quotes or estimates, at Gate 1 and in Phase 2, if we get that far. There are no dollar figures in this proposal on purpose."

---

## Slide 11: Risks and safeguards

**On the slide**
- **One developer (me)** → a named developer before any interface work; a named owner before any pilot (internal IT, a contracted developer, or a vendor product instead)
- **A second system, double entry** → EMA stays the system of record; the extra work is measured, not hidden
- **Interface delays or fees** → Phases 0–1 need no interface; we can stop or switch at any gate
- **Wrong or stale information** → shows "unknown" and data age; fails closed; tamper-evident audit
- **Unproven safety** → an independent security test; validation approved by the Medical Director

**Screenshot:** none. A one-line callout instead: "The activity record has a check that would detect an edit. In the demo it uses a public key, so it only shows how the check works."

**Speaker notes (about 75 s)**
"The biggest risk is me. Right now one person built this, and a lab can't depend on one employee. So before any interface work there has to be a named developer who isn't only me, and before any pilot a named owner: our IT, a contracted developer, or a vendor product instead. Second, it could become one more system to type into. EMA stays the record, and we count any extra work honestly. Third, vendor interfaces can be slow or cost money; the first two phases don't need one. When the software doesn't know something, it says unknown instead of guessing, and the activity record has a check that would detect an edit. In the demo it uses a public key, so it only shows how the check works. None of that replaces an outside security test or validation."

---

## Slide 12: The ask: Phase 0 only

**On the slide**
- Four weeks of discovery and observation
- No patient data. No software installed on lab systems. No purchase.
- You as sponsor (about 4 h over the 4 weeks, plus Gate 0); the Medical Director, IT lead and Compliance/Privacy officer [to estimate at kickoff: a 30-minute kickoff, a 30-minute Gate 0 review, plus their discovery items]; my time [to confirm with my manager, and who covers my bench]
- Permissions: (1) observation with staff consent; (2) a 30-minute small-group demo review; (3) questions to ModMed or an LIS vendor sent through [to confirm: the EMA administrator or IT lead]; no contract, no data
- At week 4: a written recommendation to **configure, buy, build, or stop**

**Screenshot:** none.

**Speaker notes (about 50 s)**
"So here's what I'm asking for: Phase 0 only. Four weeks. I'd observe and time the current workflow, with my coworkers' agreement and no patient identifiers in my notes. A small group would spend thirty minutes telling me what's wrong with the demo. We'd answer the discovery checklist and ask ModMed what we already have and can configure, through whoever you choose. You'd be the sponsor, about four hours over the four weeks. At the end you get a written recommendation: configure, buy, build or stop. If the answer is that EMA can already do this, that's a success, and I'll be glad we checked. I'm not asking for money, system access or patient data."

---

## Slide 13: Where this could go

**Label on the slide:** "Vision, not a request. Today's ask is Phase 0 only."

**On the slide**
- A full lab system built on the same bench rules, working with EMA, not replacing it
- Possible later steps: pathologist sign-out and result delivery to EMA, then billing support, special stains and IHC
- Rough planning ranges (rough estimates): about 18–24 months after the pilot, including validation and go-live, to the lab's own system of record for lab work (EMA stays the practices' record), with a funded team of about 5–8 people; about 3–5 years after the pilot to a product used by many labs
- Each step is a separate decision, made only on the evidence of the one before
- The pilot comes first: does it help the bench, do staff want it, can it connect to EMA, what does validation take?

*Footer (14 pt or larger, not italic): "Rough planning ranges: rough estimates only, not quotes or commitments. Who would fund, own and support it is an open question."*

**Screenshot:** none. A simple path of the four steps in `product-vision.md` section 4: A, the pilot (the current proposal), drawn solid; B to D drawn in outline as possible later steps. Keep this slide quieter than slide 12 (no numeral above 20 pt; the "Vision, not a request" label at 20 pt or more; "Rough estimate" on the same line as each range), and never move it before the ask.

**Speaker notes (about 45 s)**
"One last slide, and it's a vision, not a request. If the pilot works, the foundation is designed to grow into a full lab system that works with EMA, not one that replaces it. Next would come the pathologist's sign-out and sending results back to EMA, then billing support and special stains. To be honest about the scale: a funded team of about five to eight people, roughly eighteen months to two years after the pilot for one lab's own system of record for lab work, with EMA still the practices' record, and three to five years after the pilot for a product many labs could use. Those are rough estimates, not quotes, and who would fund or own it is an open question. None of it is part of today's ask. The pilot comes first, and it's worth doing even if nothing after it happens. I have a short write-up if you'd like it."

---

## Slide 14: Questions

**On the slide**
- Questions
- Leave-behind: the two-page brief, the timeline, the FAQ and the one-page decision checklist
- Jorge Rodriguez, histology assistant · [to confirm: preferred work contact]

**Screenshot:** none.

**Speaker notes (for handling questions)**
"Thank you. I'm happy to take any question, including the hard ones." Then, during questions:
- Answer short first, then offer detail. The likely questions and honest answers are in the Director FAQ.
- If you don't know, say: "I don't know yet. That's a Phase 0 question," and write it down.
- Never guess a cost, a saving, a time saved or a vendor capability. Never name a coworker.
- If the conversation turns to buying a product or configuring EMA, support it. That is a good outcome.
- If asked about the long term, point back to slide 13 and offer the optional Product vision write-up. Keep it as "where this could go", never as part of the ask.

---

## Slide A1 (appendix, only if asked): Evidence and sources

**On the slide**
- Latest verification (2026-10-24): type check clean; 643/643 unit, integration and contract; 139/139 demo browser; 26/26 secured. Re-run on the frozen code before the meeting
- Fails closed: a build that isn't configured shows no data and opens no database
- Public sources on ModMed interfaces and CAP information-system requirements: **to confirm with the vendor**
- Full documents: pilot proposal, discovery checklist, production readiness

**Screenshot:** `locked-build.png`.

**Speaker notes (about 50 s)**
"If you want the evidence behind what I said: these are the automated test results from the last full run. This screen is what the software shows when it isn't set up properly. It refuses to show any data, instead of falling back to something unsafe. On integration, ModMed's public pages say EMA sends lab orders out as HL7 messages and takes results back the same way, and that labs connect through a partner process. I haven't confirmed any of that with ModMed; Phase 0 would. The CAP checklist has information-system requirements, and the exact items need checking against the current edition."

**Sources for this slide** (public pages; each must be confirmed with the vendor or against the current checklist edition):
- ModMed HL7 (orders out as HL7 ORM, pathology results in as HL7 ORU, with PDF and chart matching): https://www.modmed.com/synapsys/hl7/ and https://www.modmed.com/?p=31624
- ModMed lab connection (partner) process: https://www.modmed.com/lab-connect/
- ModMed API portal (Certified FHIR R4 API with OAuth 2.0 / SMART on FHIR, mainly read and search; a proprietary EMA API): https://portal.api.modmed.com
- A third-party LIS vendor's description of its ModMed integration (vendor claim): https://www.ligolab.com/post/seamless-diagnosis-mapping-why-ligolabs-modmed-integration-matters-for-dermatopathology
- CAP information-system requirements: validation at installation and after changes, laboratory director or designee approval, and interface checks. Requirement numbers in older sources (for example GEN.43022, GEN.48500) must be checked against the current edition: https://www.mlo-online.com/information-technology/lis/article/13009283/the-inspectionready-lab-includes-it

---

## Screenshot capture list

Capture these from the synthetic demo only, on the presenter laptop, after a fresh **Reset demo**, at the size used on 2026-10-24: a 1440 × 900 window at 2× pixel density, 100% browser zoom (`assets/captions.md`). Crop to the app window. Before saving, check each image: no browser bookmarks, other tabs, notifications, file paths or personal details visible; only fictional names; the "Synthetic data, simulated connectors" label visible where the screen has it.

| File | Screen and state | Used on |
|---|---|---|
| `console-guide.png` | `/demo?tab=guide&step=1` right after reset: "0 of 8 steps done", demo clock 10:52 AM ET | Slide 4 |
| `intake-rel0112.png` | `/intake?item=INT-1014-031` with the related-order card REL-0112 open and its reasons visible, acting as Kim Nguyen (fictional accessioning lead), during step 2 | Slide 4 |
| `clarify-hold.png` | `/clarifications?selected=CLR-0457` showing hold H-0090 scoped to Part B only, during step 3 | Slide 5 |
| `gross-approval.png` | `/grossing?part=D26-04817-A` after Part A is approved for downstream use, with Part B still awaiting grossing (step 5) | Slide 5 |
| `tray-verification.png` | `/materials?tab=trays&selected=TRY-M-03` with the missing and unexpected slides flagged and **Mark tray complete** unavailable, with its reason (step 6) | Slide 6 |
| `retrieval-mismatch.png` | `/materials?tab=retrieval&selected=RR-0192` right after scanning the wrong block D26-03909 A1 (mismatch shown) (step 7) | Slide 6 |
| `operations-blocked.png` | `/operations` after step 8, with the blocked list, owners and ages visible | Slide 6 |
| `integration-reconciliation.png` | `/integration` showing simulated source messages grouped by what a person must do, with the "Simulated" labels visible. The slide uses two crops: the page title with "Simulated: source systems", and the summary line | Slide 7 |
| `audit-verify.png` | Output of `HLOS_MODE=demo npm run audit:verify` on the capture database (VERIFIED, public demo key), framed for the slide. Not the `/audit` screen, which no demo role can open | None (optional backup, if asked about the audit trail) |
| `locked-build.png` | `/locked` ("This build is not configured") from `npm run start:locked`. Capture once, then stop it; never present from this build | Slide A1 |

**After capture:** add the band "Synthetic patient: fictional name, birth date and MRN" below `intake-rel0112.png`, `clarify-hold.png` and `integration-reconciliation.png` (and on the slide crops of the first two), as done on `locked-build.png`. Printed backups use the slide crops, not the full Operations image.

*Where these IDs and labels differ from the presenter console after the software refinements, trust the console and update this table.*
