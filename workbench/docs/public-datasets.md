# Public datasets for BCC research (research use only)

*This page records which public datasets were considered for the BCC present/absent research task, the one subset actually imported (60 COBRA biopsy slides), how its labels are represented, and what it can and cannot show. The candidate assessment comes from a desk review on 2026-10-26: web pages, papers, dataset landing pages, the GDC API and the public COBRA bucket listing. Counts marked "listing" come from that listing. Facts about the imported subset were measured by importing it into a throwaway database, then re-checked on 2026-10-28 against the frozen dataset version the experiments used (see "Reconciliation" below). Nothing here is a model result; model results are in `ml-engine-report.md`. The working tree reproduces no COBRA patient code or slide file name: examples and test fixtures use fictitious placeholders in COBRA's format (`P000101`, `COBRA-P000111`), checked absent from COBRA's metadata. Earlier commits on this branch do contain three real COBRA pseudonymous patient codes, in these docs and in two test files (commit `9e74298`, which the local remote-tracking ref shows on the remote branch, and the unpushed `7ba0435` and `8a1a59e`). Rewriting that history (a force-push) is the owner's decision.*

## 1. The subset in use: COBRA BCC biopsies

### Source and licence

| | |
|---|---|
| Dataset | COBRA (Classification Of Basal cell carcinoma, Risky skin tumours and Abnormalities), `bcc` package (skin biopsies) |
| Publisher | Radboud University Medical Center (Geijs et al.) |
| Host | AWS Open Data registry, `s3://cobra-pathology` (https://registry.opendata.aws/cobra/). Open access, no account |
| Licence | **CC BY-NC-SA 4.0** (bucket `LICENSE`): attribution required, **non-commercial use only**, share-alike |
| Downloaded | 60 slides (2,472 MB, 6.9–168.7 MB each), the three `bcc` metadata CSVs, `LICENSE` and `README.md`. Approved by the project owner before download; no agreement was accepted and no account was created |
| Kept at | `workbench/var/datasets/cobra/` (`images/`, `subset/selection.csv`, `subset/sha256.txt`, `metadata/`). `var/` is gitignored: the files are never committed |

**Commercial use.** COBRA forbids commercial use, and share-alike applies to adaptations. Whether model weights trained on it count as adaptations is legally unsettled. If the Platinum Dermatology pilot is a commercial arrangement, get legal review before COBRA-derived work is used in it.

### Selection rule

The subset is deterministic, computed from COBRA's own metadata (`bcc_patient.csv`, `bcc_bcc.csv`, `bcc_images.csv`):

1. Eligible slide: specimen method `biopt` (biopsy), and an H&E staining name starting with `HE1` or `HE-Biopt` once spaces are removed.
2. Eligible patient: every one of the patient's slides in the `bcc` package is eligible.
3. Patients are ordered by `sha256("cobra-subset-v1|" + patient_id)`. Taking them in that order:
   - 20 patients with one BCC slide;
   - 20 patients with one non-BCC slide;
   - 4 patients with two BCC slides;
   - 4 patients with two non-BCC slides;
   - 2 patients with one slide of each label.

   Every slide of a selected patient in the `bcc` package is included.

### What was imported (measured)

These counts come from a full import of the 60 files into a throwaway database, followed by a frozen imported-reference dataset:

| | |
|---|---|
| Slides | 60: 30 labelled BCC and 30 non-BCC (COBRA slide labels) |
| Patients | 50. Under the `any_positive` rule, 26 count as positive and 24 as negative |
| Cases (patient × specimen number) | 56. Blocks: 56 |
| Mixed-label patients | 2. One patient has specimen 1 BCC and specimen 2 non-BCC. The other has two slides of the same specimen and block with different labels. (Their codes are kept out of the repository.) |
| Scanner and site | One scanner model as reported by COBRA (`3D Histech Panoramic P1000`), one centre (Radboudumc) |
| Image reading | All 60 opened by OpenSlide 4.0.1 as `generic-tiff`, at 0.4851 µm/px from the TIFF resolution tags. Pyramid levels: 6 levels on 37 slides, 5 on 19, 7 on 3 and 4 on 1. No associated label or macro images |
| Consistency with COBRA's metadata | For all 60, width, height, level count and µm/px after ingest equal `bcc_images.csv`. All 60 sha256 values equal the checksum list |
| Automated QC screen | 60 screens ran and raised 0 heuristic issues |
| Identifier-risk flags | `filename_long_number` on 34 file names. COBRA's file names are 32-character hexadecimal hashes, so these are false positives; they stay visible for human review |
| Near-duplicate screen | 2 candidate pairs, each between different patients with different image sizes (thumbnail dHash distance ≤ 6; the distances are 5 and 6). Within each pair both slides have the same label: one pair is `bcc_absent_not_benign`, the other `bcc_present`. They are candidates for a human decision, not evidence of duplication. With the illustrative split at seed 0 (next row), one pair falls across splits and must be decided or acknowledged before freeze. In the frozen version the experiments used, both pairs are in the development pool, but their members fall in different cross-validation folds, and no human decision has been recorded. The effect is bounded by a sensitivity analysis in `ml-engine-report.md` §3.8 |
| Split at seed 0 (60/20/20, stratified by patient) | **Illustrative only; not the split used by the experiments.** Train 16 positive / 14 negative patients; validation 5 / 5; test 5 / 5. No split lacks a class |

Timing on the development Mac: about 2 s for the import, which copies and verifies 2.4 GB, and about 10 s for the worker to run 60 ingest and 60 QC jobs.

### Reconciliation with the frozen dataset version used by the experiments (2026-10-28)

The ML experiments (`ml-engine-report.md`) use one frozen dataset version of the shared project `proj-cobra-bcc-subset`:
- dataset version `1868803e54c045eba4df9c7a9fd53a7b`, v1, frozen 2026-10-28T03:05Z;
- manifest sha256 `a73bfa56…ca902`;
- split fingerprint `19676e29…47df2`.

Every structural count above matches that version. The split does **not** match the illustrative seed-0 split.

| | Documented above | Frozen version `1868803e` |
|---|---|---|
| Slides / patients | 60 / 50 | 60 / 50 |
| Cases / blocks | 56 / 56 | 56 / 56 |
| Slide labels (BCC present / BCC absent) | 30 / 30 | 30 / 30 |
| Patients under `any_positive` (positive / negative) | 26 / 24 | 26 / 24 |
| Slides counted by **patient** label (from positive / negative patients) | (not stated before) | 32 / 28. The two mixed-label patients' slides count with the positive patients |
| Mixed-label patients | 2 | 2, both in the development pool |
| Site / scanner model / µm/px | one / one / 0.4851 | one / one / 0.4851 |
| Labels | 60 imported reference labels, review state `imported` | same |
| Split | seed 0, 60/20/20 (illustrative) | **seed 20261027, train 0.7 / val 0 / test 0.3**, patient-grouped, stratified on `any_positive` (`dermpath.splits/3`) |
| Development pool (train; no val split) | — | **35 patients** (18 positive / 17 negative); **45 slides** (22 BCC present / 23 BCC absent); 41 cases |
| Test split | — | **15 patients** (8 / 7); **15 slides** (8 / 7); 15 cases. **Never released** in the real study (0 test releases) |

**Which basis a table uses.**
- Slide-label counts (30 / 30, and 22 / 23 in the development pool) count each slide by its own label.
- Patient-label counts (26 / 24 patients; 32 / 28 slides) use the `any_positive` rule.
- The models' prediction unit is the slide (bag).
- The independent units are the 35 development patients.

**Dry-run disclosure.** Before this split was frozen, throwaway dry runs processed 6 COBRA slides from 6 patients in separate databases. 4 of those patients are among the 15 test patients. For 2 of them, dry-run test predictions were looked at (dry-run models trained on about 4 slides). The other 2 were dry-run training patients: their labels were read and their slides were used for the dry-run Macenko references. Separately, the real run's feature-set builds extracted all 15 test slides label-free (fixed encoders, no labels read).

None of that informed any real-cohort run, threshold or candidate. These patients are therefore described as "unreleased in the real study and not used for model selection", not as "untouched". The details are in `ml-engine-report.md` §7 and in the evidence package (`experiments/evidence/cobra-bcc-subset-2026-10-28/test_releases.json`).

Sources for this subsection:
- the driver's s1 report (`experiments/reports/s1.json`, local, gitignored);
- its sanitized mirror `experiments/evidence/cobra-bcc-subset-2026-10-28/dataset.json` (`cohort_reconciliation`, `split_table`, `identity`);
- the inventory copy `…/attachments/pre_fix_inventory.md` §3 (cases per split).

### How it is represented in the workbench

| COBRA field | Workbench record |
|---|---|
| `patient_id` (format `P` + six digits; `P000101` below is an illustrative placeholder, not a COBRA patient) | Coded patient `COBRA-P000101`. This is COBRA's published pseudonymous id; patient sex and age are **not** imported |
| (`patient_id`, `specimennumber`) | One case, accession `COBRA-P000101-S1`, provenance `public_licensed`, site `radboudumc`. The site comes from the dataset documentation (a single centre), not from a per-row field. The case note carries the licence. There is no collection date (COBRA publishes none), so temporal splits are not possible |
| — | Part `A`. COBRA publishes no part or anatomic site |
| `block` | Block designation (`1` for every selected slide) |
| file `<filename>.tif` | Slide: level 1, stain `H&E`, scanner `3d-histech-panoramic-p1000`, provenance `public_licensed`, review state `imported`, original file name kept as metadata. COBRA publishes no section level, so level 1 is a placeholder; two slides of one block both carry level 1. COBRA's staining name (`HE  1`, `HE 1-2-3`) is kept in the import record |
| `label` 1 (`Basal cell carcinoma`) | Slide-scope label `bcc_present`, source `imported_reference` |
| `label` 0 (`Non-malignant`) | Slide-scope label `bcc_absent_not_benign`, source `imported_reference`. **BCC absent is not "benign".** According to the dataset paper, COBRA's non-BCC group contains epidermal dysplasia (actinic keratosis, Bowen's disease) as well as benign conditions |

Each imported label stores its provenance as free text in the label's `reason`. That text gives COBRA's label and category verbatim, the method ("COBRA rule-based extraction from free-text pathology reports … not an expert read in this workbench") and the licence. Each slide also has a write-once `import_record.json` in the object store (source file, verified sha256, source row, mapping, label) and audit events `slide.imported` and `label.imported_reference_recorded`. The project's `settings_json.public_dataset` holds the licence, source, label method, limitations and the selection file's sha256. Every frozen manifest that contains `public_licensed` items copies it as `manifest.public_dataset`.

### Label quality and reference standard

COBRA's slide labels were "automatically extracted from free-text pathology reports using a rule-based approach". The dataset paper also reports a reader study in which two pathologists scored 240 BCC slides (Geijs et al., Med Image Anal 2024, https://pubmed.ncbi.nlm.nih.gov/38194735/). The metadata carries `block` and `specimennumber`, so a report-level diagnosis may have been copied to a slide that does not itself show BCC. That is slide-level label noise, and the workbench cannot measure it without expert reads.

The workbench therefore keeps these labels apart from expert labels:

- **Label source `imported_reference`.** These labels are never expert opinions: they never open or resolve a disagreement, have no author, and are written only by importers.
- **Reference standard per dataset.** A dataset version declares `reference_standard`. The default is `expert`, which ignores imported labels: a default dataset on this project has 0 items, and every slide is excluded with `review_state_imported` and `no_reference_label_slide`. To use COBRA's labels, create the dataset with:

  ```json
  {"include_provenance": ["public_licensed"], "reference_standard": "imported_reference",
   "eligible_review_states": ["imported", "pending_review", "approved"],
   "split": {"partition": "random", "seed": 0}}
  ```

  The review state `imported` means nobody has reviewed the slide in this workbench. It is accepted only together with `reference_standard: "imported_reference"`; expert-reference datasets refuse it (`422 review_state_requires_imported_reference`).
- **Recorded in the manifest.** `config.reference_standard`, a top-level `reference_standard`, and per item `label_source: "imported_reference"`. A `label_provenance` block holds the accepted label sources, counts by source, the distinct provenance texts, a notice, and the items where a workbench expert currently reads the slide differently. Those items are candidates for review; the imported label is not changed.
- **One rule for training.** `labels.label_source_permitted(source, reference_standard)`: `expert` accepts only expert labels, `imported_reference` accepts only imported reference labels, and model suggestions are never accepted.

Results on this dataset measure agreement with COBRA's report-derived reference. They are not a measure of agreement with a pathologist, and not of clinical performance.

### Limitations

- **Report-derived labels.** Rule-based extraction from reports, not expert reads in this workbench, with the slide-level label noise described above.
- **Single centre and single scanner model.** No site or scanner shift can be measured. The audit's site and scanner confounding tables have one level each.
- **Enriched prevalence.** The subset is 50 % BCC by construction (COBRA's package is about 52 %). Sensitivity and specificity do not depend on prevalence, but PPV and NPV do not transfer to a clinical population; declare a target prevalence to adjust them.
- **Small.** 50 patients. The frozen split has 35 development and 15 test patients, so confidence intervals are wide. This subset exercises the real-image pipeline and its statistics; it cannot support a performance claim.
- **No collection dates.** COBRA publishes none (60 of 60 missing), so a temporal split is impossible on this subset.
- **Non-commercial licence** (CC BY-NC-SA 4.0); see above.
- **Not a validation of clinical performance**, and not a substitute for the protocol's own expert-labelled cohort and an independent external test set.

### Importing (and re-importing)

Run from `workbench/api`, with `WB_VAR_DIR` pointing at the API's var directory. The demo users must exist (`python -m dermpath.seed`); a `--reset` wipes the import, so re-run it afterwards.

```bash
.venv/bin/python -m dermpath.importers.cobra \
  --selection ../var/datasets/cobra/subset/selection.csv \
  --images ../var/datasets/cobra/images \
  --sha256 ../var/datasets/cobra/subset/sha256.txt \
  --metadata ../var/datasets/cobra/metadata \
  --license-file ../var/datasets/cobra/LICENSE \
  --project proj-cobra-bcc-subset
.venv/bin/python -m dermpath.worker --once   # or keep the worker running until the ingest and qc_screen jobs finish
# run the import command again: it changes nothing, and reports ingest status and metadata consistency
```

- The importer copies each file into the private object store only if its sha256 equals `sha256.txt`. The hash is computed while copying, and on a mismatch nothing is stored.
- It then creates the slide through the same path as an upload: the `ingest` job (OpenSlide metadata, thumbnail, ingest manifest), then the automated QC screen.
- It refuses, and lists, any row that:
  - has a differing or unlisted checksum;
  - has a missing file or an unsafe file name;
  - has a label that does not match its category;
  - disagrees with COBRA's metadata (with `--metadata`);
  - would contradict existing records.
- It never changes an existing slide, label or case. `--dry-run` validates and hashes without writing. `--process-jobs` runs the ingest and QC jobs in-process.
- Exit code: 0 when everything was imported, 1 when some rows were refused or the verification found a mismatch, and 2 when the import could not run.

## 2. Candidate datasets considered

| Dataset | Licence and access | Content | Patient identifiers | Labels and quality | Relevance to BCC present/absent |
|---|---|---|---|---|---|
| **COBRA** (Radboudumc), AWS Open Data | CC BY-NC-SA 4.0; open, no account | `bcc` 5,147 TIFF biopsies (211 GB); `ood` 1,248; `resections` 496 (listing). Pyramidal JPEG TIFF, about 0.485 µm/px for biopsies | `patient_id` (5,147 slides from 4,066 patients); group splits on it across packages | Report-derived rule-based slide labels; tissue masks for every slide; 196 resection tumour masks of undocumented authorship; precomputed embeddings from an undocumented encoder | Highest: skin biopsies, BCC against mimics, patient ids. Single site and scanner, enriched. **Used (60-slide subset).** |
| **AIDA BCCC** (Sahlgrenska) | Controlled access (REMS, AIDA BY licence, signatory and PhD-level recipient); treat as non-commercial | 261 BCC and 253 tumour-free punch biopsies, 1,832 excision WSIs, 995 frozen Mohs WSIs; NanoZoomer S360, 0.23 µm/px | Biopsies: one WSI per patient. Excisions: split by tumour | Two dermatopathologists per biopsy, with a third adjudicating about 5.7 % | Best independent external test (another country, site and scanner). Not requested |
| **HISTAI-skin** b1/b2 | CC BY-NC 4.0; gated on Hugging Face | b1 7,710 slides / 1,778 cases; b2 43,757 / 20,621; mostly Aperio, some Hamamatsu and 3DHISTECH | Case ids only, no patient id | Report text and ICD-10; BCC labels would have to be mined and spot-checked | Large multi-scanner external candidate; patient separation not guaranteed. Not requested |
| **AIDA DRSK** | Controlled access (as BCCC) | 99 WSIs, 13 abnormal categories including BCC; three scanners | None | 16,741 polygons; one annotator, confirmed by a senior pathologist | Small multi-scanner localisation check; too few BCC slides to train |
| **Queensland NMSC segmentation** | No CC licence found; commercial use unverified (assume no); open download | 290 sections (140 BCC); stitched microscope-camera mosaics at 0.67 µm/px, not scanner WSIs | None | 12-class pixel masks by one trained scientist | Pixel-level sanity checks only; no non-cancer negatives, so not a present/absent set |
| **TCGA-SKCM** (GDC) | Open access; no explicit licence on the access page | 475 diagnostic SVS slides from 433 patients | TCGA barcodes | Melanoma only | Reader, µm/px and multi-site robustness checks; out-of-distribution negatives. No BCC |
| **CPTAC-CM, GTEx** (NCI IDC) | CC BY 4.0 | DICOM whole-slide images | Subject ids | Melanoma (CPTAC-CM); post-mortem tissue (GTEx) | DICOM reading only. GTEx must never serve as BCC negatives: fixation and post-mortem differences invite shortcut learning |

Rankings from the review:
- **Technical validation of the pixel pipeline:** COBRA, then Queensland, then TCGA-SKCM.
- **A first supervised experiment:** COBRA for development with patient-grouped splits, AIDA BCCC biopsies as the independent external test, and HISTAI-skin as a further multi-scanner test once its labels are mined and checked.

### Not suitable

- **Isolated patch datasets are not a substitute for slide-level validation.** This covers SPIDER-skin (BCC central patches at 224 px; CC BY-NC 4.0, gated), Skin-Path (300 px captioned patches) and Kriegsmann 2022 (tiles; availability unconfirmed). Patches cannot test:
  - tissue detection;
  - tiling and edge handling;
  - µm/px handling and coordinate mapping;
  - aggregation of many patches into one slide-level decision.

  Curated patches also leave out the artefacts, hard negatives and real prevalence that decide slide-level sensitivity and specificity, and patches from one slide or patient can leak across splits. The workbench's claims are about slides and patients, so its evidence must be slides with patient identifiers.
- **Other datasets set aside:**
  - AIDA melmet: melanoma metastases, no BCC.
  - PUMA: regions of interest, not whole slides.
  - CATCH and the canine SCC set: not human tissue.
  - ISIC and HAM10000: dermoscopy photographs, not histology.
  - HistoGPT's training cohort and the Erlangen cohort: not public.
  - AIDA BCCC excisions and Mohs: wrong specimen type, almost no tumour-free cases.

### Open questions before wider use

1. Are COBRA's released `split` column and the paper's internal and external test sets patient-grouped, and are they in the bucket? The workbench computes its own patient-grouped splits either way.
2. Who annotated COBRA's resection masks, and how many readers were there?
3. Which encoder produced COBRA's precomputed embeddings? They are not used here.
4. What is the Queensland dataset's licence?
5. Do the AIDA BCCC CSVs carry patient ids?
6. How many BCC cases does HISTAI-skin hold?
