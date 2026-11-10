# How authorized slides would enter the workbench, and what it would take to train and validate a useful model

*Research use only. This is a route map, not a plan that anyone has approved. Every step that involves real slides needs the authorizations in `data-governance.md` first.*

## 1. Before any real slide enters
1. **Authorization in writing.** Required:
   - who may release slides for research, and under which review (IRB or equivalent);
   - who owns the slides, annotations, derived models and publications;
   - who may commercialize.
   
   The founder's working relationship is not data ownership (`data-governance.md`).
2. **A written research protocol** (`pilot-protocol.md`): the task, the population, the reference standard, the endpoints, the sample-size reasoning, the stop rules and shadow mode.
3. **A secured deployment.** The prototype runs in demo mode only, with no real sign-in. Real slides need:
   - real authentication;
   - storage under the institution's control;
   - an access log;
   - an agreed retention period.
4. **De-identification at the source.** Filenames, embedded metadata, label and macro images and reports can all identify a patient. The workbench flags these and never serves label or macro images, but **a checkbox is not de-identification**. The institution's process must remove identifiers before slides arrive.

## 2. How a slide enters (as built)
1. **Scan.** The lab needs a whole-slide scanner, or a scanning service. Neither is assumed.
2. **Upload** (histology assistant role, `Worklist → Upload`):
   - Resumable chunked transfer, with a SHA-256 computed in the browser and checked on the server.
   - Duplicates are refused.
   - Real-data uploads are refused unless the deployment enables them (`WB_ALLOW_REAL_DATA=1`) **and** the uploader records the governance attestation. Both are recorded.
3. **Ingest (worker):**
   - OpenSlide reads the file. Dimensions, pyramid levels, microns per pixel (or "unknown") and objective power are recorded.
   - A thumbnail is made; label and macro images are noted and never served.
   - A corrupt or unsupported file fails with a readable error and never becomes training-eligible.
   - Only **Aperio SVS** is tested; other formats need their own compatibility test first.
4. **Hierarchy.** The slide is linked to coded patient → case → part → block → level and stain. Patients appear only as codes.
5. **Quality review.** The automated screen (tissue fraction, a heuristic focus measure) suggests issues; people confirm them. Issues follow open → reviewed → suggested action → resolution → dataset eligibility. A flag never orders a recut or discards a slide.
6. **Expert review** (pathologist):
   - labels at the scope where they are valid (case, slide or region);
   - independent initial review when the study needs it;
   - disagreement and adjudication;
   - approval or exclusion with a reason.

## 3. From approved slides to a model
1. **Dataset version.** The research lead builds a draft, checks the summary, then:
   - creates **patient-grouped** splits (random, temporal or external site);
   - **freezes** the version, which locks the image hashes, label versions, splits and configuration.
   
   The test set stays locked away from training, threshold choice and active learning.
2. **Encoder.** A pathology foundation encoder is needed for useful features.
   - **UNI** is wired but blocked. It needs legally obtained weights, and its CC-BY-NC-ND licence forbids commercial use, including models trained on its outputs, without approval.
   - A commercial path needs a **separately licensed encoder**, or one trained on data the lab has rights to.
   - The synthetic encoder only proves the plumbing.
3. **Features.** Tissue coordinates at about 0.5 µm/px (when calibration is known), with excluded regions respected. Embeddings are cached by slide hash, encoder and weights hash, preprocessing version and scale.
4. **Training.** Two heads:
   - mean-pooled logistic regression as the baseline;
   - attention MIL, which must beat the baseline to earn its place.
   
   The threshold is chosen on the validation split and frozen. Every run records its seed, code revision, dependencies, manifest hash, weights hash and checkpoint.
5. **Evaluation.** Done once, on the locked test split, by the research lead (audited). It reports:
   - every metric with numerator and denominator;
   - patient-cluster confidence intervals;
   - calibration and abstention;
   - subgroups, only where the numbers allow;
   - an error gallery with false negatives first.

## 4. What it would take to be *useful* (rough, to be refined in the protocol)
| Need | Why | Rough scale (planning only) |
|---|---|---|
| A defined task and population | "BCC present vs absent" in a defined set of H&E skin biopsies is an engineering default. The clinical protocol must define it. | — |
| A reference standard | Expert labels with independent adjudication, at the scope where they are valid | Pathologist time is the scarce resource; measure it in the pilot |
| Enough patients | Sample size follows from the **precision wanted** for sensitivity and specificity (`pilot-protocol.md` has the formula), not from a fixed slide count | For example, about 140 positive cases for ±0.05 around a sensitivity of 0.90 (illustrative) |
| Consecutive cases plus enriched hard cases | Representative performance, plus visibility of difficult mimics; tracked separately | — |
| Scanner and site variation | Real performance depends on scanner, stain and site; subgroups only with enough data | A second scanner or site for external validation |
| A licensed encoder and compute | Feature extraction is the heavy step; a GPU helps but the pipeline runs on CPU | To size from the real slide count |
| A reader study | Model-only AUROC cannot show augmentation. Compare pathologist-with-tool against pathologist-without-tool on errors, time and workload. | A study design approved before it starts |
| Independent replication | Before any claim beyond research use | — |

## 5. What stays human
- Identity of the patient, the diagnosis and sign-out stay with people.
- No stain is ordered and no slide is dismissed or reprioritized by the software.
- Suggestions never become expert truth. The original suggestion and the expert's judgement are stored separately.
