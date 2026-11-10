# Why this matters

*A short overview for the medical director, from Jorge Rodriguez (histology assistant and founder). DermPath Research Workbench is a working name for a research-use-only prototype. It runs on public test data and fictional examples only. Nothing here claims diagnostic capability, and nothing implies endorsement by the medical director or the employer.*

## The 60-second version

I would like to explore building a tool around how you already work. The goal is to give you more time for the cases that need your judgement, by reducing repetitive work and helping the lab organise and learn from its slides. You would define what matters, review every suggestion the software makes and stay in control. We would start with one small research pilot and measure whether it actually saves time and supports consistent decisions. If the measurements say it does not, we stop or change course.

## Our commitment

**We build this to augment pathologists, not to replace them.** That is a commitment about how the product behaves. It is not a forecast about jobs. The business case counts freed capacity, less repetitive work, consistency and service quality. It does not count reductions in pathologist headcount.

What that means in the software:
- **You decide.** You can accept, correct, reject or hide any suggestion. The original suggestion and your judgement are kept as separate records.
- **You look first.** In independent review mode, suggestions stay hidden until you have recorded your own assessment.
- **Nothing happens automatically.** No sign-out, no diagnosis sent anywhere, no stain or recut ordered, no slide dismissed and no case reprioritised.
- **Uncertainty stays visible.** "Unknown", "out of scope" and "readers disagree" are shown, not hidden. Overriding the software is one step.
- **Histology staff are part of the design.** Any extra scanning, quality recording or annotation work is measured. It is not shifted quietly onto technologists and assistants.

## Six questions

**1. What does the assistant or technologist do today?**
Receives and checks specimens and parts, supports grossing, then processes, embeds, cuts, stains and labels slides, matches each slide to its case and part, checks quality, and returns slides for recuts or re-stains when needed [to confirm the exact steps in our lab]. How slide-quality problems and their fixes are recorded today: [to confirm].

**2. What does the pathologist do today?**
Reviews glass slides under the microscope. The founder's understanding is that this is several hundred slides a day [to confirm]. For each case the pathologist decides the diagnosis, orders levels or stains when needed, and signs out. Many routine skin biopsies need careful but repetitive screening; the hardest cases need the most judgement.

**3. Which repetitive task does this pilot target?**
Two connected tasks on a defined set of approved, de-identified H&E skin biopsy slides:
- **Histology:** recording slide-quality issues so that each one is linked to the action taken, its outcome, and whether the slide can be used for research.
- **Pathology:** labelling slides as **BCC present** or **BCC absent** (which does not mean benign: it may include other cancers, inflammation or look-alikes), with indeterminate and inadequate allowed, using as little pathologist time as possible.

Whether a software suggestion could later reduce repetitive review of routine skin biopsies is a **separate, later research question**. It would be tested in shadow mode, with no effect on patient care.

**4. What does the software do now, and what is future work?**

| Works now (prototype, research use) | Future (needs dedicated models, data and validation) |
|---|---|
| Imports one tested whole-slide format (Aperio SVS) and shows it with pan and zoom | Detecting BCC on real slides (no trained model exists) |
| Keeps the patient → case → part → block → slide hierarchy, with coded IDs only | Counting cells or mitoses |
| Finds tissue and gives a rough blur screen, both labelled experimental; staff record folds, chatter, staining and other issues by hand | Automatic detection of specific artifact types |
| Records expert labels and outlines, with every change versioned | Precise lesion outlines, margins, biomarker scoring |
| Freezes datasets, keeping each patient's slides on one side of the train/test split | Connection to the lab information system |
| Runs a **pipeline test on synthetic data**, clearly labelled **PIPELINE TEST — NOT PATHOLOGY VALIDATION** | Any clinical use (needs the appropriate regulatory pathway) |
| Shows results with their denominators and confidence limits, and an adjustable cost calculator with fictional defaults | |

The left column follows the implementation plan. Before presenting, check each item against the readiness matrix and remove anything not yet built and tested. The prototype does not assume the lab has a scanner or that slides are digitised.

**5. What stays under physician judgement?**
Everything clinical. Every diagnosis. Every label that becomes ground truth. Whether a quality flag matters and whether to recut or re-stain. The definition of the research task. Settling disagreements between readers. The decision to continue or stop the pilot.

**6. Which measurements will tell us whether the pilot is worthwhile?**
Measured before (baseline) and during the pilot, on matched work:
- histology staff minutes per slide for quality recording, and the extra minutes for any scanning;
- the share of quality issues with a recorded action and outcome, and the time to resolve them;
- pathologist minutes per labelled case, and agreement between readers;
- later, in a reader study: errors, time per case and workload, **pathologist with the tool versus without it**. A model's score on its own cannot show that it helps physicians.

**The pilot is not worthwhile if** the added scanning and annotation time outweighs the time released, if readers make more errors or work more slowly with the tool, or if the data cannot be handled within the agreed authorisations. Those results would be reported, not hidden.

See pilot-protocol.md for the one-page protocol and data-governance.md for the authorisations needed before any patient material is used.
