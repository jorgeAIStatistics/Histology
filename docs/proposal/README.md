# Presentation package: Histology Redesigned

| | |
|---|---|
| Prepared for | Director of Operations, Platinum Dermatology |
| Prepared by | Jorge Rodriguez, histology assistant |
| Date | [meeting date] |
| Status | Proposal for discussion |

This folder holds the presentation package for one 30-minute meeting. The project is called Histology Redesigned; its software is called Histology Lab OS. In that meeting I show a 5-minute synthetic demo and a 10-minute proposal, then take questions. **The ask is approval for Phase 0 only:** four weeks of discovery and observation, with no patient data, no software installed on lab systems and no purchase.

> **Ground rules for everything in this folder**
> - The software and every screenshot use fictional organizations and people only. The demo lab is "Lumen Bay Dermatopathology Laboratory (fictional)". There is no real patient data anywhere.
> - Platinum Dermatology is named only as the audience. Nothing here describes its systems, volumes, staffing, problems, finances or plans. Anything lab-specific that I don't know is a visible placeholder: **[to confirm: …]**.
> - No one has endorsed, approved, funded, bought or partnered on this work: not the laboratory, not ModMed, not any vendor.
> - No compliance claim (HIPAA, CLIA, CAP, FDA). Technical controls are not compliance. Passing tests are not clinical validation.
> - No savings, ROI, dollar, accuracy or AI-confidence figures. Every time and effort figure is a rough estimate to refine in Phase 0.
> - The positioning: **configure first, buy second, build last.** A good outcome is the problem solved, even if this software is not what solves it.

## 1. What's in the package

| File | What it is | For whom | Length |
|---|---|---|---|
| [executive-brief.md](executive-brief.md) | Why I'm raising this, the idea, what the demo shows, real vs simulated, the ask, the timeline at a glance, what success looks like | **The Director of Operations** (leave-behind); anyone they forward it to | 2 pages |
| [deck-outline.md](deck-outline.md) | 14 slides plus an appendix: on-slide lines, speaker notes, screenshots, running order, and the screenshot capture list. Slide 13, after the ask, is the one vision slide, marked "vision, not a request" | **Jorge**, to build and present the slides; the Director sees the slides | 14 + 1 slides |
| [director-faq.md](director-faq.md) | 24 hard questions with honest answers: cost, patient data, compliance, ownership, support, downtime, AI, responsibility | **The Director** (leave-behind), and the Medical Director, IT lead and Compliance/Privacy officer if it is forwarded; Jorge, for preparation | about 8 pages |
| [implementation-guide.md](implementation-guide.md) | How the lab could evaluate and, only if justified, adopt it: integration options, Phases 0–5 week by week, roles, IT prerequisites, validation, training, downtime, data protection, support model, risk register, and a one-page decision checklist (section 15). Written as a separate part of this package. | **The Director** (sections 5, 6 and 15); the Medical Director, IT lead and Compliance/Privacy officer for their sections | long; read by section |
| [timeline.md](timeline.md) | The timeline on its own: the meeting, phases and gates, illustrative calendar dates, totals, effort. Written as a separate part of this package. | **The Director** (leave-behind), anyone planning resources | about 4 pages |
| [demo-day-checklist.md](demo-day-checklist.md) | The day before, the code freeze, 30 minutes before, commands, the opening caveat, the 5-minute path, recovery, phrases to avoid, leave-behinds | **Jorge only.** Not a handout. | about 7 pages |
| [product-vision.md](product-vision.md) | Where this could go after a pilot: a long-term vision of a full lab system that works with EMA, what exists and what is still needed, and rough planning ranges (every figure labelled as a rough range). Vision only, not a proposal; nothing in it is requested | **The Director of Operations: optional, long-term reading.** A handout only if the Director asks where this could go; slide 13 is its one-slide summary | about 3 pages |
| README.md (this file) | Index, reading order, schedule, open items | Anyone opening the folder | about 3 pages |

`timeline.md` is the standalone version of the implementation guide's section 6. The brief's section 7 and slide 9 are the one-glance versions of the same plan; all three use the same weeks and totals.

**The leave-behind set** (the same on slide 14 and in `demo-day-checklist.md` section 9): the executive brief, the timeline, the Director FAQ, and the implementation guide's section 15 (the one-page decision checklist). The printed versions are in `out/` (section 9 below). The product vision is not part of this set: it is handed over only if the Director asks where this could go.

## 2. Reading order

**For the Director of Operations (about 15 minutes in all)**
1. `executive-brief.md`: the whole proposal in two pages.
2. `timeline.md`, then `implementation-guide.md` section 15 (the one-page decision checklist), and sections 5–7 if you want the detail.
3. `director-faq.md`: only the questions that matter to you. The index at the top groups them.
4. For background, these existing documents: `../pilot-proposal.md` (options, metric definitions, rollback) and `../discovery-checklist.md` (the questions Phase 0 would answer).
5. *Optional, long-term:* `product-vision.md`, where this could go if the pilot proves its value. Separate from the proposal; nothing in it is requested, and its ranges are rough.

**For the Medical Director, IT lead or Compliance/Privacy officer, if the Director forwards it**
1. `executive-brief.md`.
2. `director-faq.md`, questions 7–11 (data, compliance, testing, integration, hosting), 12 (support), 16–19 (safety) and 21 and 24 (responsibility, the AI service).
3. `implementation-guide.md`, the sections for your role (the contents list at the top).
4. `../release/production-readiness.md`: what is verified, simulated, blocked, and what still needs a person to check.

**For Jorge, preparing**
1. `demo-day-checklist.md`, then rehearse twice.
2. `deck-outline.md`: build the slides and capture the screenshots.
3. `director-faq.md`: say each answer out loud once.
4. `implementation-guide.md`: know where each phase, role and risk is, so you can point to it during questions.
5. Background: `../demo-script.md` (long talk track) and `../release/demo-runbook.md` (operator steps).

## 3. Schedule before the meeting

Today is Saturday 2026-10-24.

| When | What | Who |
|---|---|---|
| Mon 10-26 to Fri 10-30 | Software refinements and this presentation package | Jorge |
| Mon 11-02 to Fri 11-06 | Review every document. Fill the [to confirm] items I already know from my own role (never patient data). Rehearse the demo twice using `demo-day-checklist.md`, timing both. Freeze the code after the last rehearsal: commit or tag it, re-run the checks and record them (checklist section 1). Recapture the screenshots after the code freeze if the screens changed, then update `out/` in Word and PowerPoint (section 9). | Jorge |
| Week of 11-09 to 11-13 (target); 11-16 to 11-20 (fallback) | The 30-minute meeting: 5-minute demo, 10-minute proposal, questions | Jorge, Director of Operations |

## 4. What happens after a yes (summary)

Weeks are counted from approval; week 1 starts with the Phase 0 kickoff, assumed within about 2 weeks of approval. Phases overlap. All figures are rough estimates to refine in Phase 0.

| Phase | Weeks | Exit gate |
|---|---|---|
| 0. Discovery and governance | 1–4 | Configure, buy, build, or stop. Stopping or configuring existing tools is a success. |
| 1. Synthetic sandbox at the lab | 5–10 | Usability findings addressed; intended use approved by the Medical Director; support model chosen and connector developer named; go or no-go for Phase 2 |
| 2. Technical foundation and integration feasibility | 8–22 (vendor-dependent, 2–6 months) | Secured mode working in a test environment with real sign-in and test interface messages; no production patient data |
| 3. Validation and training | 20–28 | Validation approved under the lab's quality system; go-live readiness review |
| 4. Limited pilot: one workflow, one bench | 28–36 | Weekly review against the baseline, with the pre-agreed metric definitions |
| 5. Decision | 36–38 | Continue, expand, change or stop, by pre-agreed criteria |

- **Duration:** best case, about 7–9 months from approval to the end of a limited pilot, if a vendor specification and test environment are available by about week 15 (about 3 months after approval); up to about 12 months with vendor or contract delays. Vendor scoping starts in week 1 with no contract; only signing waits for Gate 1.
- **One caution:** if the lab works inside EMA's Pathology module, orders may never travel to a separate system, and the build path would likely stop at Gate 0 (guide section 4.1).
- **The cheapest decision-grade path** is Phases 0–1 only: about 10 weeks, with no patient data.
- **Phases 1–5 are the build path.** If Phase 0 chooses configure or buy, the plan is redrawn with ModMed or the vendor.

**How this maps to the earlier documents.** In `../pilot-proposal.md`:
- Section 5's stages "Observe" and "Baseline" fall in Phase 0. Its "Synthetic demo review" starts in Phase 0, as a 30-minute small-group review, and continues in Phase 1 as the bench usability sessions.
- Its "approved shadow comparison" is the start of Phase 4.
- Its rollout modes are A (local demonstration) for Phases 0–1, B (shadow) and C (small live pilot) for Phase 4. Mode D (writeback to EMA) is not part of this plan.
- The earlier documents say the lab sets the durations. The weeks here are my estimates for the lab to correct.

## 5. Open items for Jorge to settle before the meeting

Each one stays a visible **[to confirm: …]** until it is answered. Never fill one with patient data or a guess.

- [ ] The meeting date (replace every [meeting date]), time and room, and whether a projector is available.
- [ ] My time at the bench, as of the meeting date (the brief says "about four months").
- [ ] A time agreement with my manager for Phase 0 work.
- [ ] Whether the lab uses a separate LIS besides EMA. If I don't know this from my own role, leave it for Phase 0.
- [ ] How and when I built the software (my own time and computer?), and how I describe working with an AI coding assistant (FAQ questions 14, 15 and 24).
- [ ] The employer policy on employee-built tools and on AI coding assistants, which needs HR or legal (FAQ questions 13 and 24; discovery item 12.5). Leave it as a Phase 0 question. (Discovery item 12.5 itself does not yet mention AI tools; raise it at the kickoff.)
- [ ] **The early prompt file** (`Histology_Lab_OS_Claude_Master_Prompt.txt`, at the repository root, tracked since the first commit and pushed to the personal GitHub copy). It names the employer and one real role-holder. Decide the date to delete it and purge it from the history and the GitHub copy (FAQ questions 14 and 24; guide 13.3). Never quote its contents.
- [ ] Confirm that the GitHub repository is private, and which account the commit user name "clalrityai" belongs to (FAQ question 13).
- [ ] Whether I have any commercial interest or plan (FAQ questions 13 and 22); say it plainly either way, and keep it consistent with the optional product vision (a direction, not a plan).
- [ ] Re-read the public sources G1–G5 (guide Appendix C) in a normal browser and confirm every quoted statement.
- [ ] After the code freeze: re-run the checks, write the dated addendum to `../release/verification-stage6.md`, and update the counts (checklist section 1).
- [ ] My preferred work contact for slide 14.
- [ ] A proposed Phase 0 kickoff date (brief section 9).

**Left for Phase 0, not for me:** the accreditation and checklist edition that apply; the hosting and business-associate arrangement; acceptable data loss and recovery times; the choice of pilot workflow; and every vendor capability, fee and contract.

## 6. Screenshots

There are ten screenshots, captured on 2026-10-24 from the synthetic demo (the working tree before the code freeze); `assets/captions.md` describes each one. **Recapture them after the code freeze.** Their exact file names, screens and states are in the "Screenshot capture list" at the end of `deck-outline.md`:

`console-guide.png`, `intake-rel0112.png`, `clarify-hold.png`, `gross-approval.png`, `tray-verification.png`, `retrieval-mismatch.png`, `operations-blocked.png`, `integration-reconciliation.png`, `audit-verify.png`, `locked-build.png`.

Check every image before use: fictional names only, no browser bookmarks or tabs, no notifications, nothing personal. Images that show a fictional patient's name, birth date and MRN carry a band saying so ("Synthetic patient: fictional name, birth date and MRN").

## 7. Evidence behind the claims

| Claim in this package | Where it is shown |
|---|---|
| Latest full run, 2026-10-24, 23:00–23:04, after the last code change (the runtime-mode log line, 22:25; working tree, before the code freeze): type check clean; 643/643 unit, integration and contract tests; 139/139 demo browser tests on a fresh production build; 26/26 secured tests | To be recorded in `../release/demo-runbook.md` section 8, which still shows the earlier 642-test run of the same evening (its owner updates it); then a dated addendum to `../release/verification-stage6.md` after the code freeze |
| Formal record of the 2026-10-19 run: 638/638, 136/136, 26/26, clean production build with no warnings | `../release/verification-stage6.md` |
| What is verified, implemented but not verified, simulated, planned, blocked, or needs a person to check | `../release/production-readiness.md` |
| The signed integration contract `hlos.source-message` 1.0 and its 12 simulated scenarios | `../release/integration-contract.md` |
| Encrypted backup and verified restore | `../release/backup-restore.md` |
| The eight demo steps and reset | `../release/demo-runbook.md`, `../demo-script.md` |
| My observations (O1–O12) and the metric definitions | `../pilot-proposal.md`, sections 2 and 6; `../director-pitch.md` |

## 8. Public sources (each to be confirmed with the vendor, or against the current checklist edition)

- **ModMed HL7.** EMA sends clinical and pathology lab orders as HL7 ORM and receives pathology results as HL7 ORU. Results can carry a PDF and be matched to the patient chart. https://www.modmed.com/synapsys/hl7/ and https://www.modmed.com/?p=31624
- **ModMed lab connection (partner) process.** https://www.modmed.com/lab-connect/
- **ModMed API portal.** A Certified FHIR R4 API (OAuth 2.0 / SMART on FHIR, mainly read and search) and a proprietary EMA API. Which one fits order intake must be confirmed with ModMed. https://portal.api.modmed.com
- **Third-party LIS vendors advertise ModMed integrations.** These are vendor claims, relevant to "buy second". Example: https://www.ligolab.com/post/seamless-diagnosis-mapping-why-ligolabs-modmed-integration-matters-for-dermatopathology
- **CAP Laboratory General checklist, information-system requirements.** Validation at installation and after changes, laboratory director or designee approval, interface checks. Check requirement numbers from older sources (for example GEN.43022, GEN.48500) against the current edition. https://www.mlo-online.com/information-technology/lis/article/13009283/the-inspectionready-lab-includes-it

## 9. Built files (`out/`)

Built from these Markdown files on 2026-10-24; the printed versions name documents by title instead of file paths. **To change them, edit the `.docx` and `.pptx` files directly in Word and PowerPoint, then export the PDFs again (File → Export → PDF; in the guide, refresh the table of contents first).** The one-off build scripts are not kept in the repository. If you also want the Markdown to match, update it by hand.

| File | Use |
|---|---|
| `Histology-Redesigned-Executive-Brief.pdf` / `.docx` | Leave-behind |
| `Histology-Redesigned-Timeline.pdf` / `.docx` | Leave-behind |
| `Histology-Redesigned-Director-FAQ.pdf` / `.docx` | Leave-behind |
| `Histology-Redesigned-Implementation-Guide.pdf` / `.docx` | Section 15 is the leave-behind; the rest on request |
| `Histology-Redesigned-Director-Presentation.pptx` / `.pdf` | The deck; the PDF is also the printed backup. **Share the deck only as the PDF; never send the .pptx** (its speaker notes carry presenter coaching) |
| `Histology-Redesigned-Product-Vision.pdf` / `.docx` | Optional, long-term reading; a handout only if the Director asks where this could go |
