# Five-minute demo script

*DermPath Research Workbench (working name). Research use only. For a five-minute meeting with the medical director, presented by Jorge Rodriguez.*

Every step below was walked in a dry run on 2026-10-26: production build (`npm run build && npm start`), fresh demo data, Chromium at 1440 × 900. After that dry run the frontend iteration changed the Overview (a scroll-through of one slide), message placement on Slide Review and the Freeze dialog (open items must be acknowledged). Those three passages were updated from the built pages and are covered by automated browser tests (`tests/e2e/iteration.spec.ts`), not by a second walk-through with a timer; rehearse them once. Text in quotation marks is the exact on-screen label. The walkthrough follows the brief: a fictional case with two specimen parts, a QC issue, expert review and an approved label, a frozen dataset, a reproducible experiment, error inspection and adjustable economic impact, after the 60-second "Why this matters".

**Conventions**

- **Role menu** is the button at the top right that shows the current demo user. It is a demo role switch, not authentication. The names in it (Sam Rivera, Dr. Imani Castell, Priya Navarro, Dr. Elena Marsh, Jordan Pike) are **fictional demo users**: on-screen labels, not people. Click the name; the role is printed under it.
- **Nav** is the top navigation: "Overview", "Worklist", "Slide Review", "Dataset", "Experiments", "Impact".
- Slide pages (`/review/…`) and run pages (`/experiments/…`) get new IDs after every reset. Always get there by clicking, never from a saved link.
- A message box confirms each save and stays about 4 seconds (longer while the pointer is on it). On Slide Review it appears over the slide's bottom-left corner, never over the review panel's buttons; elsewhere it appears at the bottom right. Inside a dialog, messages appear in the dialog itself, above its buttons.

## The case: DEMO-S26-0003 (coded patient P-0003)

The only seeded case with two parts, an open QC flag, a label to review with a suggestion, a disputed slide and a QC exclusion. (DEMO-S26-0001 also has parts A and B, but every slide is already approved and has no QC issue.)

| Part | Slide (as listed on the Worklist) | State at the start | Used for |
|---|---|---|---|
| A, "upper back (fictional)" | "Part A · Block A1, Level 1, H&E" | Pending review · Unlabeled · 1 suggestion · QC "1 open" ("Possible blur (heuristic)") | QC issue, look-first review, approval |
| A | "Part A · Block A1, Level 2, H&E" | Disputed · "Readers disagree", 2 readers | Approval blocked until adjudication (optional) |
| B, "scalp (fictional)" | "Part B · Block B1, Level 1, H&E" | Excluded · QC "Low tissue (heuristic)" resolved with "Exclude the slide from datasets" | A finished QC chain that removes a slide from datasets |

The case also has a case-level label, "BCC present (One reader)", which is never copied to its slides. Experiment metrics come from a separate project, "Synthetic pipeline-test cohort (no images, no histology)": 60 fictional patients whose records have no images, with synthetic embeddings. **No number in this demo describes pathology.**

## Before the meeting (not part of the five minutes)

**Start the three processes** (three terminals, each from the repository root). Ports: API 8000, web 3600.

```bash
# Terminal 1: API. The first start on an empty workbench/var seeds the fictional demo and
# the four synthetic pipeline-test runs in-process (a few seconds).
cd workbench/api && .venv/bin/uvicorn dermpath.main:app --port 8000

# Terminal 2: worker, only once http://127.0.0.1:8000/api/v1/health answers (a worker started
# during the first seeding can race it). Needed for the live experiment in step 5.
cd workbench/api && .venv/bin/python -m dermpath.worker

# Terminal 3: web. Always build first: the build bakes in the API address (WB_API_URL,
# default http://127.0.0.1:8000) and the current UI fixes. The build takes about 7 s.
cd workbench/web && npm run build && npm start      # http://localhost:3600
```

**Reset the demo data** in the browser (about 4 s): open http://localhost:3600 → role menu → "Jordan Pike" (Admin) → role menu → "Reset demo data" → dialog "Reset the demo data?" → "Reset demo data". The page reloads, still as Jordan Pike. Only the Admin role can reset; for any other role the button explains "Resetting the demo data needs the admin demo role (POST /demo/reset is admin-only, demo mode only)."

**Check, in this order**

- [ ] Top bar "Research use only" → "System status" lists "API mode ok", "Database ok", "Tile service (OpenSlide) ok", "Worker ok", "ML service ok". Close it with Esc.
- [ ] Top bar "Project" reads "BCC research template (demo)". The browser remembers the last project, and the last demo ends on the cohort project.
- [ ] Nav "Impact": the amber "FICTIONAL" box starts "The values below are fictional defaults". If it says "You have changed the fictional defaults", press "Reset to fictional defaults". The browser remembers Impact inputs.
- [ ] Do not rehearse after the reset, or reset again afterwards: the demo writes records (a QC resolution, an approval, a dataset, two runs).
- [ ] Start position: role menu → "Sam Rivera" (Histology assistant); nav "Overview"; scroll to the top; let the message box disappear.
- [ ] Window at least 1440 × 900, zoom 100 %. Close every other window and tab; notifications off. **No real patient material is open on this machine.**
- [ ] Fallback: the fourteen images in `workbench/docs/screenshots/` (01-overview … 14-freeze-acknowledgement) open in an image viewer.

Dry-run timings (production build, local machine): every action answered in under 0.5 s, apart from waiting for a message box to clear; the first slide tile was drawn about 70 ms after the viewer started; two experiment runs finished about 5 s after the first click. The five minutes are set by what you say, so rehearse once with a timer.

## 0:00–0:15. Opening caveat (say this first)

**Screen:** Overview (eyebrow "Why this matters", heading "More time for the cases that need a pathologist's judgement.").

> "Before I start: this is a research-use-only prototype. Everything you will see is either public test data released under CC0 or synthetic and fictional. Nothing here uses our lab's data, and nothing implies that you or the lab endorse it. The software does not make diagnoses, and nothing on screen claims diagnostic capability."

## 0:15–1:15. Why this matters (60 seconds)

**Screen:** Overview. Scroll slowly: the public CC0 slide stays on the right while five numbered steps pass on the left. At step 2 ("The screen finds tissue; people record the problems") the background fades and the readout under the slide shows "28.2%"; at step 4 ("Patches at a known scale") the 41 patches appear. Keep going past "After the freeze, synthetic data only" to "We build this to augment pathologists, not to replace them." and its five commitments. The six-step walkthrough panel ("The five-minute walkthrough", "One fictional case, end to end") is at the bottom, beside "Open the worklist".

If asked about the slide: it is a public CC0 test image from the OpenSlide project, not a patient of the lab. The tissue mask and the patches were computed by the prototype's own code; the outline at step 3 is marked as illustrative, and no diagnosis is shown or inferred.

> "I would like to explore building a tool around how you already work. The goal is to give you more time for the cases that need your judgement, by reducing repetitive work and helping the lab organise and learn from its slides. You would define what matters, review every suggestion the software makes and stay in control. We would start with one small research pilot and measure whether it actually saves time and supports consistent decisions. If the measurements say it does not, we stop or change course."

> "The commitment is that you decide: you can accept, correct, reject or hide anything the software suggests, you can record your own view before seeing any suggestion, and nothing is signed out, ordered, dismissed or reprioritised automatically. Any extra work for histology staff gets measured, not hidden."

## 1:15–1:40. A fictional case with two specimen parts

**Screen:** Worklist (`/worklist`). **Role:** "Sam Rivera" (Histology assistant), already selected.

**Do:**
1. Nav "Worklist".
2. Press `/` and type `DEMO-S26-0003` (box "Search patient code, accession or stain").
3. Point to the case row "P-0003 › DEMO-S26-0003 · DEMO · Collected Mar 22, 2026 · site-south · Parts A, B" and its three slides: "Part A · Block A1, Level 1, H&E" (Pending review), "Part A · Block A1, Level 2, H&E" (Disputed), "Part B · Block B1, Level 1, H&E" (Excluded).
4. Optional, 5 s: "Case and hierarchy" opens "P-0003 › DEMO-S26-0003": Part A "upper back (fictional)", Part B "scalp (fictional)", and the line "Codes only: never names, record numbers or birth dates." Close with Esc.
5. Click "Part A · Block A1, Level 1, H&E".

**You will see:** Slide Review with the header "P-0003 › DEMO-S26-0003 › Part A · Level 1, H&E", badges "Pending review", "DEMO", "1 open QC issue"; on the image "SYNTHETIC — NO HISTOLOGY" and "No scale bar: microns per pixel unknown"; on the left the case rail with both parts.

**Say:**
> "This is a made-up case. The hierarchy goes patient code, case, part, block, slide, level and stain. That matters later: all of one patient's slides must stay together when we build a dataset. There are no names here, only codes. The tag says DEMO: these images are generated by software, with no real tissue in them."

**Behind it:** `GET /projects/proj-bcc-demo/worklist`, `GET /cases/{id}`. Role switch: `POST /auth/demo-login`.

## 1:40–2:20. A QC issue

**Screen:** Slide Review, Part A Level 1, tab "QC". **Role:** "Sam Rivera" (Histology assistant).

**Do:**
1. Tab "QC" (or key `2`). Point to "Automated screen" with its "EXPERIMENTAL" tag: "Tissue fraction (otsu-saturation-1)" "27.4%" ("flag below 5%") and "Focus: median variance of Laplacian" "1.075" ("below the uncalibrated threshold 60").
2. Scroll the panel to the issue "Possible blur (heuristic)" (tag "heuristic suggestion"; steps "Open, Reviewed, Action suggested, Resolved"; "Dataset eligibility: decided at resolution").
3. "Review" → "Confirmed" is already selected → "Save review".
4. "Suggest action" → "Suggested corrective action": "Consider rescan" → "Save suggestion". The hint reads "A proposal for a person to decide. Nothing is ordered, recut or rescanned."
5. "Resolve" → in "Resolution: what was decided or done" type `No rescan: focus adequate where it matters` → leave "Effect on dataset eligibility" at "No effect on dataset eligibility" → "Resolve issue". All four steps turn green; "History (4)"; the "1 open QC issue" badge disappears.
6. 10 s: in the case rail under "Part B, scalp (fictional)" click "Level 1 · H&E", then tab "QC" again (the tab resets when the slide changes). The finished chain: "Low tissue (heuristic)" → "Review: confirmed" → "Suggested action (for a human decision): Consider recut" → "Resolution: Lab lead decided not to recut for the research set; slide excluded" → "Dataset eligibility: Exclude the slide from datasets" (in red).

**Say:**
> "Only tissue detection and a rough blur screen are automated, and both are experimental. Here the screen flagged possible blur; a person reviews it, proposes an action and records the outcome. Folds, chatter and staining problems are recorded by staff. A flag never orders a recut or throws anything away. The point is the link: issue, what we did about it, the outcome, and whether the slide may be used for research. On Part B the outcome was to exclude the slide, and you will see that exclusion again in the dataset."

**Behind it:** `GET /slides/{id}/qc`; `PATCH /qc/issues/{id}` with `review`, `suggest_action`, `resolve`.

## 2:20–3:00. Expert review and an approved label

**Screen:** Slide Review, Part A Level 1, tab "Labels". **Role:** "Dr. Imani Castell" (Pathologist).

**Do:**
1. Role menu → "Dr. Imani Castell".
2. Case rail under "Part A, upper back (fictional)": "Level 1 · H&E". The "Labels" tab opens; the header shows "Not labelled by you". Point to "Reference label": Slide "none (Unlabeled)"; Case "BCC present (One reader). Valid for the case only, never copied to its slides."
3. "Independent initial review": click the switch (Off → On). The suggestion area changes to "Hidden until you record your assessment."
4. In the form ("Record your own view first. Suggestions for this slide appear only after you do; the record shows they were hidden.") click "BCC present"; leave "Confidence" at "Medium" and "Also record it as my slide label" ticked → "Record my assessment".
5. The record reads "Your assessment: BCC present, medium confidence, recorded … Suggestions were hidden at the time." The card appears: "DEMO FIXTURE SUGGESTION: NOT produced by a trained model · BCC present · slide scope · score 0.71 (a raw score, not a probability)", with "Accept", "Correct", "Reject", "Hide".
6. "Accept". The card adds "Dr. Imani Castell accepted · …"; "Reference label" now reads "BCC present (One reader)".
7. Scroll the panel to "Review decision" → "Approve" → the box reads "Move from Pending review to Approved. The slide becomes eligible for datasets that include approved slides." → "Confirm: Approved". The badge turns "Approved" in the panel and the header.
8. Optional, 5 s: case rail "Level 2 · H&E". Header "Disputed" and "Readers disagree"; panel "Readers disagree at slide scope: BCC absent (not benign) vs BCC present" with "Adjudicate"; "Approval is blocked until the open disagreement is adjudicated."

**Say:**
> "This is fictional data on a synthetic image, so no diagnosis is being made. What matters is the record. With independent review on, the suggestion stays hidden until you have recorded your own view, and the record says it was hidden. The suggestion here is a fixture, not a trained model, and your decision on it is stored separately from it. Every change has an author, a time and a reason. Approval is a research label, not a sign-out. Where two readers disagree, the slide cannot be approved until a pathologist settles it."

**Behind it:** `PATCH /projects/{pid}/members/me` (independent review), `POST /slides/{id}/assessment`, `POST /labels/{id}/review` (accept), `POST /slides/{id}/review-state` (approved).

## 3:00–3:30. A frozen dataset

**Screen:** Dataset (`/dataset`). **Role:** "Priya Navarro" (Research lead).

**Do:**
1. Role menu → "Priya Navarro". Nav "Dataset". The seeded "Workflow demo slides — pipeline test (synthetic) · v1" opens first (frozen before the demo: 8 slides from 4 patients).
2. "New draft" → dialog "New dataset draft". Keep the defaults (Name "BCC slide-level research set", "Initial split": "Random, grouped by coded patient (60 / 20 / 20)", Seed 7) → "Create draft".
3. Point to "What is in it": "5 unique coded patients → 6 unique cases → 7 unique blocks → 9 unique slides", and "Patients are the unit that matters for leakage: 9 slides come from only 5 coded patients." P-0003 is in because you approved its slide a minute ago. Point to "Exclusions, with reasons": "8 slides in the project did not enter", including "Excluded by a resolved QC issue 1" (Part B) and "Open reader disagreement 1" (Level 2).
4. "Freeze" → dialog "Freeze BCC slide-level research set v1?" with the counts and the split. Below them, an amber box "… open item(s) would be frozen into this version" lists the seeded open fold (and a near-duplicate pair when the random split put its two slides on different sides). Tick "Freeze anyway and record these items in the manifest", type a reason (for example "demo: open items kept on purpose"), then "Freeze permanently". The "Manifest" tab opens: "Hash verified now", "sha256 …" (64 characters, different after every reset), the amber note "Frozen with acknowledged open items" with your reason, and the table "Items (9)", which includes the row P-0003 · "DEMO-S26-0003 / A / A1 / L1" H&E · "BCC present" with its split.
5. Tab "Splits and test lock": patients and slides per split, the guarantee "every slide, level and stain of one coded patient is in exactly one split", and "Test set lock … locked away from training, active learning and threshold selection … audited."

Read the split off the screen. It is random by patient and changed between resets in the dry run (train 3 patients with 5 or 7 slides; validation 1 patient; test 1 patient with 3 or 1 slides). The 5 / 6 / 7 / 9 counts did not change.

**Say:**
> "Freezing records the exact image hashes, label versions and split assignments. If a label changes later, we get a new version; this one never changes. Every slide from one patient lands on the same side, so the model is never tested on a patient it has already seen. The test set is locked away from training and tuning. And it will not freeze over open problems silently: it lists them, and if we go ahead anyway, our reason is written into the record."

If asked about the warnings lower in the summary ("1 included slide has open QC issues (Fold). Resolve them first, or record them with a reason when you freeze: freezing asks." and a near-duplicate pair "in different splits: possible leakage · Awaiting human review"): they are seeded examples. Freezing refuses until someone either resolves them or acknowledges them with a reason, and the acknowledgement becomes part of the hashed manifest. In a real study the research lead resolves them first.

**Behind it:** `POST /projects/{pid}/datasets`, `GET /datasets/{id}/summary`, `POST /datasets/{id}/freeze`, `GET /datasets/{id}/manifest`.

## 3:30–4:05. A reproducible experiment

**Screen:** Experiments (`/experiments`). **Role:** "Priya Navarro" (Research lead).

**Do:**
1. Nav "Experiments". Point to "Readiness ladder": "1 Engineering readiness · We are here (in progress)"; "2 Internal validation", "3 External validation" and "4 Clinical deployment readiness" all "Not started".
2. Scroll past "Encoders": "UNI (ViT-L/16, pathology foundation model)" shows "missing weights" ("WB_UNI_WEIGHTS is not set …"); "ResNet-18 (generic ImageNet, NOT a pathology model)" shows "missing dependency".
3. "New experiment" is already filled in: "Frozen dataset version" "BCC slide-level research set v1 (9 slides)", "Encoder" "Synthetic deterministic embeddings (pipeline test)", "Head" "Baseline: mean pool + logistic regression", "Seed" 7, "Threshold rule (on validation)" "Youden J". Click "Queue experiment" **twice**, changing nothing.
4. Under "Runs", two new rows "meanpool_logreg · synthetic-deterministic-v1 · seed 7" (each marked "PIPELINE TEST — NOT PATHOLOGY VALIDATION", with the manifest you just froze) turn "succeeded" in about 5 seconds.
5. Open the top run. Banner "PIPELINE TEST — NOT PATHOLOGY VALIDATION". Panel "Provenance: what makes it reproducible": "Seed" 7, "Code revision" (a git commit, d181a72… in the dry run), "Dataset manifest" (the hash just frozen), "Weights" synthetic:no-weights, "Checkpoint" (a 64-character hash, 3.6 KiB). Note the first characters of the checkpoint.
6. "All experiments" → open the second row: the "Checkpoint" hash is identical.

With one validation patient the evaluation says "insufficient evidence", and when that patient has only one class (as in both dry runs) "Operating threshold" shows the rule "Fixed 0.5 fallback" with the notice "Fallback threshold". Say so; that is the honest result for five patients.

**Say:**
> "This run uses synthetic embeddings, not pathology, to prove the machinery works: a frozen dataset in, a model trained, results saved. Same frozen data, same seed, same code: the checkpoint is byte for byte the same. It says nothing about pathology performance. With five patients there is nothing to measure, and the screen says so instead of showing a number. The pathology encoder is shown as missing weights because we have not obtained licensed weights; we don't swap in something else under the same name."

If asked: "+uncommitted" after the code revision means the code had uncommitted changes when the run started; a study run would use a committed revision.

**Behind it:** `GET /encoders`, `POST /projects/{pid}/experiments` (a `train` job on the worker), `GET /experiments/{id}`.

## 4:05–4:25. Error inspection

**Screen:** Experiments, cohort project. **Role:** "Priya Navarro" (Research lead).

**Do:**
1. Top bar "Project" → "Synthetic pipeline-test cohort (no images, no histology)" → "All experiments".
2. Open "Synthetic cohort · abmil (PIPELINE TEST)". Point to: "Splits train 36 patients / 69 items · val 12 patients / 21 items · test 12 patients / 23 items"; "Operating threshold 0.484 … Chosen on the validation split … Youden … before any test evaluation"; the warning "Read these numbers with care: small sample: 21 item(s) (< 30); estimates are unstable"; "Confusion matrix (21 items, 12 patients)": 8 true positive, 1 false negative, 2 false positive, 10 true negative; the metrics table with numerators, denominators and 95 % intervals, for example "Sensitivity (recall) 0.889 · 8 / 9 · 0.700 – 1.000".
3. Tab "Errors (3)": "false negatives first". First card: "False negative · SYN-0029 · truth BCC present · predicted BCC absent (not benign) · score 0.206 vs threshold 0.484 · scanner-b, site-south, H&E" and "Generator-spec record from the pipeline-test cohort: there is no image to open." Then two false positives, SYN-0046 and SYN-0008.

These figures were identical after three resets in the dry run.

**Say:**
> "To show what error inspection looks like with enough items, this is a separate synthetic cohort: 60 fictional patients, no images, synthetic embeddings with a planted signal. These numbers come from synthetic embeddings, not pathology. What matters is the form: every rate has its numerator and denominator and an interval, the threshold is chosen on validation and frozen before the test set is opened, and the misses come first, one by one."

**Behind it:** `GET /experiments/{id}/evaluation?split=val`, `GET /experiments/{id}/errors?split=val`.

## 4:25–4:50. Adjustable economic impact

**Screen:** Impact (`/impact`). Any role. Optional: role menu → "Dr. Elena Marsh" (Medical director), the read-only demo role; it is a fictional user.

**Do:**
1. Nav "Impact". Point to "FICTIONAL" and "The values below are fictional defaults, not measurements from any lab." Result: "Annual net cash benefit $29,313", "Positive every year, before one-time costs.", "Payback: about 24.6 months."
2. "Pathologist minutes saved per case": change 2 to 1. Result: "−$33,187", "A loss every year: the recurring costs exceed the cash this releases. That is a valid result to report.", "No payback: the recurring net cash benefit is zero or negative, so the one-time costs are never recovered." "Year-one net benefit −$93,187".
3. Optional: the "Realisation fraction" slider under "Capacity released is not cash".

**Say:**
> "These numbers are made up; real ones would come from timing our own work. Freed time is not automatically cash, so this setting controls how much of it counts. If the extra scanning and annotation outweigh the time saved, the calculator shows a loss, and we would report that. It doesn't assume we have a scanner, and it counts freed capacity, not fewer pathologists."

**Behind it:** the client-side calculator in `web/lib/roi.ts` (formulas from the brief, tested with vitest).

## 4:50–5:00. Close and the ask

> "What I'm asking for is your review of a one-page pilot protocol and a data governance template. Nothing goes further without the right approvals, and the lab's data stays out of this prototype."

Hand over pilot-protocol.md, data-governance.md and director-overview.md.

## Phrases to avoid

| Avoid | Say instead |
|---|---|
| "The AI diagnoses / detects BCC." | "The prototype records expert labels. No model has been trained on real slides." |
| "The model suggested BCC here." | "That suggestion is a demo fixture. No trained model produced it." |
| "It's X% accurate", "89% sensitive" (about any synthetic result) | "This is a pipeline test on synthetic data. It says nothing about pathology performance." |
| "Validated", "clinically validated", "clinical-grade" | "Engineering-tested. Not validated on pathology." |
| "FDA-ready", "HIPAA-compliant", "CLIA/CAP-ready" | "We make no regulatory or compliance claims. The governance template lists what would be needed." |
| "It will replace / reduce pathologists." Also "AI can never replace doctors." | "Our commitment is to build it to augment pathologists. Whether it saves time is what the pilot measures." |
| "It saves N hours" or "it pays back in N months" | "With these fictional inputs the calculator shows this. Real inputs come from timing our work." |
| "In partnership with the lab", "endorsed by", "the director supports" | "I'm exploring a possible research pilot, subject to approval." |
| "Our slides", "our data" | "Public CC0 test data and synthetic images." |
| "Better than [vendor]", "nobody else does QC / skin AI", "first", "unique" | "Others already offer QC and skin AI. We are testing a narrower workflow idea." |
| "The heatmap shows the tumour." | "That is an attention map. It is not a tumour outline or an explanation." |
| "It automatically finds folds and chatter." / "It detected blur." | "Staff record those. Only tissue detection and a rough blur screen are automated, and both are experimental; a person confirms every flag." |
| "Approved means diagnosed." | "Approved means the research label was reviewed. Nothing is signed out." |
| "BCC absent means benign." | "BCC absent can still include other cancers, inflammation or look-alikes." |
| "It will triage / prioritise cases." | "It does not reprioritise anything." |
| "This is worth $X" (any valuation) | "A working demo shows we can build. It does not establish a valuation." |

## If a step fails

Say what failed in plain words and move on. Do not improvise a claim to cover the gap. A control that cannot work explains its missing dependency or role on screen; read that explanation aloud.

| What you see | Why | Do |
|---|---|---|
| "Choose a demo role", or "The API is not reachable" | No demo session, or the API is down | Pick the role from the list. If the API is down, restart it (`cd workbench/api && .venv/bin/uvicorn dermpath.main:app --port 8000`) and reload. |
| A button is grey and its message names a role ("…needs the pathologist demo role…") | Wrong demo role | Role menu → the role the script names for that step. |
| The worklist shows "SYN-…" cases or the wrong case | Project is still "Synthetic pipeline-test cohort" | Top bar "Project" → "BCC research template (demo)". |
| The issue already says "Resolved", the slide is already "Approved", or "BCC slide-level research set" already exists | The data was used after the last reset | Show the record that is there (each issue's "History" says who did what), and reset before the next showing. |
| "Approve" is unavailable: "Approval is blocked until the open disagreement is adjudicated." | You are on Level 2 (disputed) | Case rail → "Level 1 · H&E" under Part A. |
| "Freeze" is unavailable: "Assign patient-grouped splits before freezing (Splits tab)." | "Initial split" was changed to "None yet" | Tab "Splits and test lock" → "Assign splits", then "Freeze". |
| "Freeze permanently" answers "Resolve the open items first, or tick …" or "Give a reason …" | The draft includes open items (the seeded fold, perhaps a near-duplicate pair) | Tick "Freeze anyway and record these items in the manifest", type a reason, then "Freeze permanently". |
| New runs stay "queued" ("waiting for the worker"); the status shows "Worker" not ok | Worker not running | Say so, open the finished seeded run "Workflow demo slides · meanpool_logreg (PIPELINE TEST)" for the provenance, and start the worker afterwards (`cd workbench/api && .venv/bin/python -m dermpath.worker`). |
| "Loading tiles…" stays, or the image is blank | Tile request failed | Reload the page (Cmd+R). The image is synthetic; the step does not depend on it. |
| Impact says "You have changed the fictional defaults" | Inputs remembered from a rehearsal | "Reset to fictional defaults". |
| "Reset demo data" fails in the browser | API error | Stop the API and the worker (Ctrl+C), run `cd workbench/api && .venv/bin/python -m dermpath.seed --reset` (about 8 s), start both again. |
| Anything else | | Continue from `workbench/docs/screenshots/` and say they are screenshots of the same prototype. |

## After the meeting

- Impact: "Reset to fictional defaults". Top bar "Project": back to "BCC research template (demo)".
- Role menu → "Jordan Pike" → "Reset demo data", so the next showing starts clean.
- Stop the web app, the worker and the API with Ctrl+C in their terminals.
