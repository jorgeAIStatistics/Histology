# Competitive and evidence review

*DermPath Research Workbench (working name, provisional). Research use only. Sources accessed on **2026-10-26**. Prepared for internal planning and for review by the medical director. This is not a market analysis and contains no market sizing.*

## How to read this document

**Method.** Each source URL in the build brief was fetched on 2026-10-26. Where the brief asked for a status check (current ownership, regulatory status of a third-party skin application), a small number of additional public pages were consulted and are listed in the row. Quotes are kept under 15 words; everything else is paraphrased. People are not named, except the founder, Jorge Rodriguez. Papers are cited by title, journal and DOI.

**Evidence labels.** Every claim carries one of these labels:

| Label | Meaning |
|---|---|
| **[VC] vendor claim** | Stated by a company or an open-source project about its own product, including press releases and trade-press reports of them. Not independently verified by us. |
| **[PR] peer-reviewed finding** | Reported in a peer-reviewed journal article. Still specific to the paper's data, tasks and settings. |
| **[EI] engineering inference** | Our own technical reasoning. Not evidence about any competitor. |
| **[UH] unverified commercial hypothesis** | Our belief about value or demand. It must be tested before it is used in any pitch. |
| **[OP] professional opinion** | A practitioner's commentary. Communication context only, not evidence of accuracy or regulatory requirements. |

**Ground rules applied throughout.**
- **Unknown is not absent.** If a page does not document a feature, the feature is recorded as UNKNOWN. It is not recorded as missing.
- **No internal architecture is inferred.** Public pages show product-level workflows. They do not show proprietary training pipelines, and we do not guess at them.
- **No cross-metric comparisons.** Cell-level detection or counting figures are not slide-level diagnostic accuracy. We never compare our research classifier with OctoPath's cellularity metric or any other unrelated metric.
- **Regulatory statements are narrow.** A clearance, CE mark or certificate applies to the named product, version, configuration and jurisdiction only. Platform interoperability does not confer diagnostic authorisation on an application, and authorisation of one application says nothing about another.
- **Nothing here is evidence for our prototype.** None of these sources shows that the DermPath Research Workbench works, saves time or improves accuracy.

## Summary matrix

| # | Source | Category | Publicly documented workflow (paraphrase) | Intended-use status as stated on the reviewed page | Loaded on 2026-10-26? |
|---|---|---|---|---|---|
| 1 | OctoPath | Cell analysis (H&E, IHC) | Connect slide → choose analysis → cell map, counts, report | Research use only (site footer) | Yes, both pages |
| 2 | Proscia Concentriq | Platform, embeddings, AI portfolio | Image management → embeddings/toolkit or integrated AI apps → review | Mixed by product: AP-Dx stated as cleared; AP and LS RUO; per-app status on the portfolio | Yes; press-release body not retrievable (see row) |
| 2a | Primaa Cleo Skin (on Proscia and other platforms) | Third-party skin AI | Lesion classification incl. BCC, SCC, melanoma, nevus; mitoses, margins, dimensions | **Conflicting across sources** (see row) | Via Proscia portfolio and supplementary pages |
| 2b | Proscia Automated Quality Control | Image QC | Detects and segments artifact regions | RUO (portfolio card) | Via Proscia portfolio |
| 3 | Indica Labs HALO AI | Train-by-example image analysis | Annotate examples → train → quantify | Not stated on the HALO AI page | Yes |
| 4 | Paige | Prostate clinical AI; scanner/IMS integration | Prostate biopsy cancer detection; co-branded platform with Leica scanners | Paige Prostate: FDA marketing authorisation stated; 2023 release: EU/UK CE-IVD and UKCA, US RUO for "various" products | Yes, both pages |
| 5 | Ibex | Task-specific diagnostic AI | Prostate, breast, gastric solutions integrated with IMS, scanners, LIS | Per product and jurisdiction (IVDR, IVDD, RUO in US) | Yes, both pages |
| 6 | Sectra | Enterprise imaging, AI marketplace | Case-centred diagnostic application with integrated AI apps | Not stated on the solution page | Yes, both pages |
| 7 | Leica Aperio GT 450 (Italian page) | Scanner with optional iQC | Scan → automated artifact screening → flag before delivery | RUO (this page's configuration) | Yes |
| 8 | PathPresenter | Vendor-neutral IMS, collaboration, education | Browser review, consults, education, AI integration | Clinical Viewer: FDA 510(k) and CE-IVDR in one stated configuration; RUO elsewhere | Yes, both pages |
| 9 | QuPath | Open-source analysis and annotation | Desktop annotation, analysis, projects | Not for clinical, diagnostic or therapeutic use; GPL-3.0 | Yes, both pages |
| 10 | OpenSlide (Python API) | Open-source WSI reading library | Region reads, pyramid levels, metadata, Deep Zoom tiles | Not applicable (library); LGPL-2.1 | Yes |
| 11 | TRIDENT | Open-source WSI processing toolkit | Segmentation → patching → patch and slide embeddings | CC-BY-NC-ND 4.0; non-commercial academic research | Yes |
| 12 | UNI / UNI2-h | Pretrained pathology encoders | Gated weights → patch embeddings | CC-BY-NC-ND 4.0; gated; no redistribution | Yes (GitHub and both Hugging Face cards) |
| 13 | CLAM paper | Peer-reviewed method | Slide-label weak supervision with attention MIL | Not applicable (paper); code GPL-3.0 file plus a non-commercial statement | Yes |
| 14 | Aiforia | Platform; expert model building | Expert annotation with assistant → model → reviewed results | Aiforia Create: RUO; blog: none stated | Yes (blog plus product page) |
| 15 | Diagnostics 2026 review | Peer-reviewed narrative review | Not applicable | Not applicable | Yes |
| 16 | LinkedIn commentary | Practitioner opinion | Not applicable | Not applicable | **Yes** (sign-in prompts shown; text readable) |

## Detailed rows

### 1. OctoPath

| Field | Record |
|---|---|
| Sources | https://octopath.ai/ ; https://octopath.ai/validation |
| Accessed | 2026-10-26; both pages loaded |
| Publicly documented capability | **[VC]** H&E products built on a model family called Kraken: tumour cellularity and tumour–stroma ratio, immune cells, mitoses, eosinophil and neutrophil counts, pancreatic duct detection and grading. IHC products built on a family called Nemo: ER/PR, HER2, PD-L1 and Ki67 scoring. **[VC]** Workflow: connect a slide (the site claims any scanner and format), choose an analysis, receive an overlay, cell counts and a report aligned with named reporting datasets. **[VC]** The home page reports 14.1 million labelled cells across 14 tissue and cancer types, up to 23 cell types in one pass, and under two minutes per biopsy. **[VC]** The validation page describes held-out cohorts from unseen sites and scanners, a minimum of 100 cases per product, and frozen, numbered releases. It lists per-product figures (for example, agreement with consensus for the cellularity product on 414 cases); some products are marked pilot or validation in progress. **[VC]** The home page claims 5+ peer-reviewed publications; the validation page cites none, and we did not check them. |
| Intended use or regulatory status (as stated) | "Research use only. Not for use in diagnostic procedures." (site footer). The validation page says an ISO 13485 quality system is in preparation. |
| What we can learn or borrow | Clear task selection before analysis. Spatial evidence (overlays) next to concise quantified results. Frozen, versioned releases with per-site monitoring. |
| Unknowns | Any dermatopathology product (none listed; UNKNOWN, not absent). How consensus was formed. Confidence intervals and per-product cohort sizes. Independent external replication. Data rights, pricing, deployment and LIS integration. |
| Caution | Cell detection and counting performance is not slide-level diagnostic accuracy. **We do not compare our BCC research classifier with OctoPath's cellularity metric**: they measure different things on different tasks. |
| Our hypothesis | **[UH]** For a small dermatopathology lab, the first unmet need is not automated cell quantification but turning approved slides into an auditable, labelled research dataset. The OctoPath pattern (choose task → see spatial evidence → see a concise result) is worth copying in our review screens. |
| Falsification experiment | Structured interviews with [to confirm: number] histology staff and pathologists at the target lab, using fictional mock-ups of (a) a cell-quantification output and (b) our dataset and QC workflow. If participants consistently rank quantification as the more urgent need, and do not report difficulty assembling research datasets, the hypothesis fails and the roadmap is revised. |

### 2. Proscia Concentriq

| Field | Record |
|---|---|
| Sources | https://proscia.com/ ; https://proscia.com/press-release/proscia-launches-concentriq-embeddings-and-developer-toolkit-to-unleash-pathology-ai-development ; https://proscia.com/platform/ai-portfolio . Supplementary: https://tissuepathology.com/2024/10/02/proscia-launches-concentriq-embeddings-and-developer-toolkit-to-unleash-pathology-ai-development/ (republished release); trade-press reports of an announced acquisition (for example https://www.medtechdive.com/news/agilent-to-buy-proscia-for-240m/832933/). |
| Accessed | 2026-10-26. Home and portfolio pages loaded. **The press-release URL returned only its headline and metadata; the body text was not retrievable with our tool.** Its embedded metadata shows a 2026 date that conflicts with the republished release (dated 2024-10-02); we treat the date as unverified. |
| Publicly documented capability | **[VC]** Concentriq is presented as a pathology platform spanning research and clinical review, with "interoperable AI applications" and native AI features. **[VC]** Concentriq Embeddings (per the republished release): turns slides into reusable numerical representations; initial models named as DINOv2, PLIP, ConvNext and CTransPath; a Proscia AI Toolkit described as open-source resources (Python client, notebooks, helpers). The release reports an internal case study of faster model development; we did not verify it. **[VC]** The AI portfolio lists, among others: **Proscia Automated Quality Control** (RUO), which the card says "detects and segments images with artifacts"; **Primaa Cleo Skin** (row 2a); foundation-model embeddings from a third party (Bioptimus H-Optimus-1, RUO); and applications from Aiforia, Aignostics, Mindpeak, Pictor Labs, Stratipath, Visiopharm and Waiv. The page shows a partial list with a "Load More" control, so the list is incomplete. **[VC]** The home page notes an announced acquisition of Proscia by Agilent; trade press dated 2026-10-14 reports it as agreed but not yet closed. |
| Intended use or regulatory status (as stated) | Home-page footnote: Concentriq AP-Dx is stated as "cleared for primary clinical diagnosis" (no clearance number or jurisdiction given on the page). Concentriq AP and LS are stated as Research Use Only. Proscia's interoperable AI apps and native AI features are stated as RUO on Concentriq AP; some apps may be interoperable with AP-Dx in some geographies, and the page refers readers to each AI manufacturer for status. Portfolio cards carry per-application labels (RUO or CE-IVD); the portfolio page mentions no FDA or IVDR status. |
| What we can learn or borrow | Common image and metadata infrastructure. Reusable embeddings and interchangeable models. **Per-application regulatory labelling**, which our encoder registry should copy: every model shows its licence and status. |
| Unknowns | How embeddings are computed, stored or versioned (not inferred). Whether QC findings link to corrective actions or to dataset eligibility (UNKNOWN). Annotation-burden tooling. Pricing and fit for a small lab without an enterprise image management system. Effect of the announced ownership change on availability. |
| Key finding | **Skin AI, automated QC and foundation-model embeddings are not empty categories.** All three appear in one commercial portfolio. |
| Our hypothesis | **[UH]** Our only plausible gap is lab-specific linkage (QC issue → human corrective action → dataset eligibility) together with transparent dataset and evaluation provenance, for a lab that does not run an enterprise platform. |
| Falsification experiment | Ask [to confirm: number] target labs whether they have, or plan, an image management system with an AI marketplace. In the pilot, measure the share of QC issues that end with a recorded corrective action and resolution, before (baseline process) and after. If most target labs already get QC and skin AI through their platform **and** baseline traceability is already high, the differentiation fails for them. |

#### 2a. Primaa Cleo Skin (third-party skin application)

| Field | Record |
|---|---|
| Sources | Proscia AI portfolio (above). Supplementary: https://clpmag.com/disease-states/cancer/melanoma/proscia-expands-ai-capabilities-support-skin-pathology-evaluation/ (2025-10-15); https://amplifiermarketplace.sectra.com/pathology/prima-cleo-skin/ ; https://tissuepathology.com/2026/03/27/lumea-partners-with-primaa-to-expand-dermatopathology-offerings-with-cleo-skin-ai/ (press release, 2026-03-24). |
| Accessed | 2026-10-26; all loaded. |
| Publicly documented capability | **[VC]** For H&E skin biopsy and excision tissue. Lesion classification naming **melanoma, nevus, basal cell carcinoma and squamous cell carcinoma**; mitotic figures and hotspots; perineural invasion; tumour dimensions and margin measurements; triage of higher-risk cases. **[VC]** Offered through several platforms: Proscia Concentriq (announced October 2025), the Sectra Amplifier marketplace and a Lumea viewer (March 2026). The Sectra listing states the pathologist must review results and makes the final diagnosis. |
| Intended use or regulatory status (as stated) | **Conflicting.** The Proscia portfolio card shows CE-IVD and an "aid to diagnosis" description. The October 2025 trade article reports the application is not intended for diagnostic use with Concentriq. The Sectra listing shows a "CE" tag without further detail. The Lumea release states regulatory status for the viewer, not for Cleo Skin. No FDA status found (UNKNOWN). **Verify with the manufacturer or the EU database before repeating any status.** |
| Why it matters to us | Our default research template (BCC present vs absent on H&E skin biopsies) overlaps a commercial application's documented scope. **[EI]** We must never present BCC detection as novel. Our research template is an engineering starting point; the value we test is the dataset, QC and evaluation workflow, not the classifier. |
| Unknowns | Performance, validation design, peer-reviewed evidence, pricing and availability in the target lab's jurisdiction (all UNKNOWN from these pages). |
| Falsification experiment | If the target lab already has access to a skin AI application, the pilot's question changes from "build a model" to "can the lab audit, measure and compare any model on its own slides". Test: can the workbench evaluate an externally produced set of predictions (imported as research records, with authorisation) on the lab's frozen test set? If the lab has no need for that, drop the evaluation-workbench angle for that lab. |

### 3. Indica Labs HALO AI

| Field | Record |
|---|---|
| Source | https://indicalab.com/halo-ai/ |
| Accessed | 2026-10-26; loaded |
| Publicly documented capability | **[VC]** A train-by-example interface: users add annotations to train networks without programming, with an AI-assisted annotation tool and real-time tuning during training. **[VC]** Trainable nuclear and membrane segmentation, tissue segmentation and classification (named network options include MiniNet, DenseNet and UNET++), and cell or object phenotyping. **[VC]** Slide quality control (SlideQC) is listed. **[VC]** Pretrained classifiers and phenotypers for several cancer indications (breast, NSCLC, CRC, gastric, HNSCC, ovarian). **[VC]** A train–validate–test workflow and ONNX model import and export. |
| Intended use or regulatory status (as stated) | Not stated on the HALO AI page. A navigation label refers to FDA-cleared diagnostics under a separate product (HALO AP Dx), which we did not assess. |
| What we can learn or borrow | Approachable pathologist annotation; train-by-example interaction; real-time training feedback; **ONNX export as an interoperability pattern**. |
| Unknowns | Skin-specific applications (none listed; UNKNOWN). Patient-grouped split enforcement, dataset freezing and test-set locking (UNKNOWN). Pricing. |
| Our hypothesis | **[UH]** We do **not** claim that easy training or annotation is unique to us. Narrower hypothesis: slide-level labels with optional regions can keep pathologist labelling time per case below [to confirm: target minutes] while capturing disagreement and provenance. |
| Falsification experiment | In the pilot, measure pathologist minutes per approved label (stopwatch or logged active time) and a short burden rating. If time per case exceeds the prespecified target, or pathologists rate the burden unacceptable, revise the labelling design. Optionally compare with a QuPath-based labelling baseline on the same public, non-patient slides. |

### 4. Paige

| Field | Record |
|---|---|
| Sources | https://info.paige.ai/prostate ; https://www.paige.ai/press-releases/paige-and-leica-biosystems-announce-expanded-partnership . Supplementary on ownership: https://clpmag.com/diagnostic-technologies/digital-pathology/tempus-acquires-ai-pathology-company-paige-expand-diagnostic-capabilities/ (2025-08-27); Tempus Form 10-Q for Q3 2025 on sec.gov (passage not readable with our tool; see Unknowns). |
| Accessed | 2026-10-26; both Paige pages loaded |
| Publicly documented capability | **[VC]** Paige Prostate: detection of cancer in prostate needle biopsies; the page describes it as the first AI-based pathology product to receive FDA marketing authorisation; claims validation on slides from over 200 institutions and "numerous peer-reviewed studies" (none cited on the page). **[VC]** The 2023-03-13 release: Paige as Leica Biosystems' preferred image management and viewing provider for the Aperio GT 450, with a co-branded platform, a viewer, an AI-powered worklist, prostate and breast suites, biomarker algorithms and third-party AI deployed through Paige. |
| Intended use or regulatory status (as stated) | Product page: FDA marketing authorisation for Paige Prostate (US); the page also uses the word "approval". The 2023 release footnote: in the EU and UK, various Paige products are CE-IVD and UKCA marked for clinical use with named scanners; in the US, the products referred to are Research Use Only. Status may have changed since 2023. |
| What we can learn or borrow | Evidence tied to the review workflow; task-specific validation; scanner and viewer integration. |
| Unknowns | **Current ownership and availability.** Neither Paige page states ownership. Trade press (August 2025) reports Tempus acquiring Paige; search summaries of Tempus's SEC filings report completion on 2025-08-22, but we could not read the passage directly. **Verify before making any current commercial statement.** Skin products (UNKNOWN). Current labels by jurisdiction. |
| Caution | Authorisation of a named prostate product is not authorisation for any skin model, for other Paige products, or for our prototype. |
| Our hypothesis | **[UH]** Pathologists value evidence shown at the point of review (the slide, the region, the denominators) more than a headline metric. |
| Falsification experiment | In a future reader study, log whether readers open the evidence panel and whether doing so changes time or errors. If use is negligible and has no measurable effect, simplify or remove it. |

### 5. Ibex

| Field | Record |
|---|---|
| Sources | https://ibex-ai.com/solutions/ ; https://ibex-ai.com/ivdr23/ |
| Accessed | 2026-10-26; both loaded |
| Publicly documented capability | **[VC]** Solutions named: Ibex Prostate, Ibex Breast, Ibex Breast HER2 and Ibex Gastric, integrated with third-party image software, scanners and LIS; the page claims more than a hundred further features. **[VC]** The IVDR page (announced 2023-02-09) states Ibex Prostate received a CE mark under the IVDR for supporting pathologists in primary diagnosis of prostate biopsies, providing a Gleason score, tumour size and associated morphologies; it states a plan to migrate breast and gastric products during 2023. **Not documented on these pages:** the order of analysis relative to pathologist review, QC, second-read or triage functions. The brief describes analysis before pathologist review; we could not confirm that from these two pages. |
| Intended use or regulatory status (as stated) | Multiple solutions CE-marked under the IVDD and registered with UK MHRA and Brazil ANVISA (products not named); Ibex First Read for prostate CE-marked under the IVDR; some solutions are "Research Use Only (RUO) in the United States" and not FDA-cleared. Device class, notified body and certificate details are not stated. |
| What we can learn or borrow | Review-queue integration; attention to difficult findings; explicit labelling of status per product and jurisdiction. |
| Unknowns | Skin or dermatopathology products (not mentioned; UNKNOWN). Whether the 2023 migration happened. Current US status per product. |
| Our hypothesis | **[EI]** Our research prototype must not reprioritise, dismiss or route clinical work. Any future triage concept is a separate research question. |
| Falsification experiment | A future shadow-mode study (no influence on care): compare model flags with the final signed-out diagnosis on consecutive eligible cases. If the BCC-present miss rate exceeds a prespecified bound [to confirm], the triage concept is dropped. |

### 6. Sectra

| Field | Record |
|---|---|
| Sources | https://medical.sectra.com/solutionarea/digital-pathology/ ; https://medical.sectra.com/resources/implementing-ai-in-pathology-practice/ |
| Accessed | 2026-10-26; both loaded |
| Publicly documented capability | **[VC]** A primary diagnostic application with integrated worklists, reporting and image review, presenting case information in one place. Enterprise imaging with DICOM and vendor-neutral slides alongside radiology, gross photography and genomics. An AI marketplace (Amplifier Services) with single-contract purchasing; the page claims 50+ pathology AI vendors integrated. **[VC]** The resource is an opinion-style industry reflection dated 2021-01-14 by a Sectra business lead. It argues that AI becomes useful only once it is integrated into daily workflow; describes on-demand versus pre-processing modes; advises against separate log-ins and for storing results in the image management system; notes that self-validation is demanding; and stresses open formats and standards. |
| Intended use or regulatory status (as stated) | Not stated on the solution page (only general compliance language). The 2021 article notes that CE-labelled image AI was available from five vendors at that time. |
| What we can learn or borrow | A case-centred workflow; results stored with the images; standards-based interoperability. **We will not rebuild an enterprise PACS or LIS.** |
| Unknowns | LIS integration specifics (not mentioned on the page; UNKNOWN). Research dataset curation, versioning and split tooling (UNKNOWN). Small-lab pricing. |
| Our hypothesis | **[EI]** The workbench should sit beside an enterprise image system rather than replace it, exchanging standard formats (GeoJSON annotations, coded manifests; DICOM later). |
| Falsification experiment | In the pilot, test export to and import from [to confirm: the lab's image system, if any]. If the lab's existing system already supports frozen research datasets with patient-grouped splits and audit, our scope shrinks to evaluation and QC linkage. |

### 7. Leica Biosystems Aperio GT 450

| Field | Record |
|---|---|
| Source | https://www.leicabiosystems.com/it/digital-pathology/scan/aperio-gt-450/ (Italian page) |
| Accessed | 2026-10-26; loaded |
| Publicly documented capability | **[VC]** Optional Aperio iQC software: AI-enabled detection of whole-slide image artifacts, notifications and a QC dashboard that flags issues and recommends actions, and automatic flagging of substandard slides before scans are delivered. A separate specification line lists an automated image quality check. **[VC]** 32 seconds per 15 × 15 mm at 40×; 81 slides per hour; 450-slide capacity; 0.26 µm/pixel at 40×. |
| Intended use or regulatory status (as stated) | This page states research use only, not for diagnostic procedures; the companion workstation is also stated as RUO. No CE-IVD, FDA or diagnostic configuration is mentioned on this page. Other configurations were not assessed. |
| What we can learn or borrow | Early quality feedback at the point of scanning. |
| Unknowns | Which artifact types iQC detects and its thresholds. Whether flags link to histology corrective actions or to research dataset eligibility (UNKNOWN). |
| Key finding | **QC is established competition**, including scanner-integrated QC. |
| Our hypothesis | **[UH]** (from the brief) Better linkage between QC findings, the human corrective actions taken, and training-data suitability, in our target lab. |
| Falsification experiment | Baseline time-and-motion in the target lab: share of slide-quality issues with a recorded action and outcome, and time from issue to resolution. Repeat with the workbench. If baseline traceability is already high, or the workbench adds more than [to confirm: minutes per slide] of staff work without reducing repeat handling, reject the hypothesis. |

### 8. PathPresenter

| Field | Record |
|---|---|
| Sources | https://www.pathpresenter.com/ ; https://www.mskcc.org/announcements/msk-partners-with-pathpresenter-to-integrate-new-ai-module-for-oncology-research |
| Accessed | 2026-10-26; both loaded |
| Publicly documented capability | **[VC]** A vendor-neutral image management system with integrations for scanners, formats, storage, LIS and AI models; a clinical viewer; a cloud consult portal for remote second opinions; free public and institutional education platforms; a research biorepository module; it states it powers a professional society's AI testing studio. **[VC]** The MSK announcement (2025-04-14) describes integrating MSK's DeepLIIF virtual-staining and quantification algorithm into PathPresenter for oncology research, used by more than 150 MSK pathologists for education and research. |
| Intended use or regulatory status (as stated) | The Clinical Viewer is stated to have FDA 510(k) clearance for primary diagnosis and CE-IVDR certification **in one specified configuration** (a named scanner, file format and display); elsewhere it is stated as research use only. Other modules: not stated. The MSK announcement frames the module as research and education. |
| What we can learn or borrow | Browser review, collaboration and education; analysis integrated into image management; configuration-specific regulatory statements as a model of honest labelling. |
| Unknowns | Research dataset versioning, patient-grouped splits, QC linkage (UNKNOWN). |
| Our hypothesis | **[UH]** Approved, reviewed cases may have secondary value as teaching sets inside the lab. |
| Falsification experiment | Ask pilot pathologists whether reusable teaching cases matter, then track reuse during the pilot. No demand and no reuse means the feature is dropped. |

### 9. QuPath

| Field | Record |
|---|---|
| Sources | https://qupath.github.io/ ; https://github.com/qupath/qupath |
| Accessed | 2026-10-26; both loaded |
| Publicly documented capability | **[VC]** Open-source software for annotation and image analysis, with documentation, tutorials and a community forum. The home page highlights fast annotation; detailed analysis features are documented elsewhere and were not reviewed here. |
| Intended use or regulatory status (as stated) | "QuPath is not intended for clinical, diagnostic or therapeutic purposes." The repository describes it as an academic project for research use only. Licence: GPL-3.0 (repository). The project asks users to cite its publication. |
| What we can learn or borrow | Practical annotation, inspectable analysis, project organisation and interoperable export. |
| Licence note | We exchange **files** (for example GeoJSON), not code. No QuPath source is copied into the workbench. See license-ledger.md. |
| Our hypothesis | **[EI]** GeoJSON exchange (planned P1) lets pathologists use a familiar tool alongside the workbench. |
| Falsification experiment | A round-trip test: export annotations, import into QuPath [version to confirm], re-export, and compare level-0 coordinates. Drift above one pixel, or lost labels, fails the test. |

### 10. OpenSlide (Python API)

| Field | Record |
|---|---|
| Source | https://openslide.org/api/python/ |
| Accessed | 2026-10-26; loaded |
| Publicly documented capability | **[VC]** Reads whole-slide images: `read_region` takes coordinates "in the level 0 reference frame"; pyramid levels; metadata properties including microns per pixel when present; associated images such as **label and macro images**; a Deep Zoom tile generator; a list of supported vendor formats (Aperio, Hamamatsu, Leica, MIRAX, Philips, Ventana, DICOM and others); installation via `openslide-bin`. Licence stated as LGPL-2.1. |
| Use in the prototype | **Used.** The workbench reads slides and generates tiles with OpenSlide. |
| What we can learn or borrow | Level-0 coordinates as the single source of truth for annotations. Label and macro images are an identifier risk, which is why the workbench does not serve them. |
| Unknowns | Behaviour on formats we have not tested. The prototype tests one Aperio SVS fixture first (per implementation-plan.md). |
| Our hypothesis | **[EI]** OpenSlide is sufficient for SVS. No other format is advertised until it passes a compatibility test. |
| Falsification experiment | Per-format compatibility test on a legally reusable fixture: open, read levels, read a region, generate tiles, check metadata. Any failure means the format stays unadvertised. |

### 11. TRIDENT

| Field | Record |
|---|---|
| Source | https://github.com/mahmoodlab/TRIDENT |
| Accessed | 2026-10-26; loaded; README and LICENSE read |
| Publicly documented capability | **[VC]** A whole-slide processing toolkit: tissue segmentation (HEST by default, GrandQC, or classical Otsu), patching at a chosen magnification, and patch- and slide-level feature extraction. The README lists 33 patch encoders and 12 slide encoders (some marked "coming soon"), each with its own licence. |
| Licence (as stated) | CC-BY-NC-ND 4.0; non-commercial, academic research only; commercial use prohibited without prior approval. Downloading an encoder binds the user to that model's licence. The listed segmentation models (HEST, GrandQC) are CC-BY-NC-SA 4.0. |
| Use in the prototype | **Referenced only.** Not installed or vendored. Our tissue mask is an independent Otsu thresholding implementation on a thumbnail ([to confirm by engineering] that no TRIDENT code is copied). |
| What we can learn or borrow | The stage concepts (tissue coordinates → patches → embeddings); a per-encoder licence column, which our encoder registry copies. |
| Our hypothesis | **[EI]** Our pipeline can follow the same stage concepts with independently written code and remain licence-clean. |
| Falsification experiment | A code-provenance check before any release: search the repository for TRIDENT-derived code and confirm each pipeline module's origin. Any match is removed or relicensed. |

### 12. UNI and UNI2-h

| Field | Record |
|---|---|
| Sources | https://github.com/mahmoodlab/UNI ; https://huggingface.co/MahmoodLab/UNI ; https://huggingface.co/MahmoodLab/UNI2-h |
| Accessed | 2026-10-26; all loaded |
| Publicly documented capability | **[VC]** UNI (ViT-L/16, released March 2024) and UNI2-h (ViT-H/14 with registers, released January 2025); the README says UNI2-h was trained on over 200 million H&E and IHC images from more than 350,000 slides. **[PR]** The original UNI model is described in a peer-reviewed paper (*Nature Medicine*, 2024, DOI 10.1038/s41591-024-02857-3); we did not review the paper's results here. |
| Licence and access (as stated) | Licence tag cc-by-nc-nd-4.0 on both model cards. **Gated:** access requires accepting conditions, and the Hugging Face primary email must match an institutional email; personal email domains are listed as grounds for denial. Each user in an organisation must register individually. Use is limited to non-commercial academic research. Commercial use, sale or monetisation of the models **and their derivatives, including models trained on their outputs**, is prohibited without prior approval. Users agree not to distribute, publish or reproduce the models, and not to attempt re-identification of the training data. Clinical use is not addressed. |
| Use in the prototype | **Referenced only.** Weights are not downloaded, not committed and never redistributed. The encoder registry reports a missing-weights state ([to confirm against the built encoder adapter]). |
| Key finding | **[EI]** A classifier trained on UNI embeddings falls inside the stated derivative restriction. Any research result built on UNI cannot move into a commercial product without prior approval from the rights holder. A commercial path needs a separately licensed encoder or one whose licence permits commercial use. |
| Our hypothesis | **[EI]** A licence-compatible encoder may cost some performance on our task; the size of that cost is unknown. |
| Falsification experiment | Research only, with authorised access and authorised data: on the same frozen dataset, compare a permissively licensed encoder with UNI under the same head and splits. If the gap on the validation split is larger than a prespecified margin [to confirm], licensing negotiation becomes a prerequisite for a commercial path. |

### 13. CLAM paper

| Field | Record |
|---|---|
| Source | https://pmc.ncbi.nlm.nih.gov/articles/PMC8711640/ . Code: https://github.com/mahmoodlab/CLAM |
| Accessed | 2026-10-26; loaded (author manuscript version) |
| Citation | "Data-efficient and weakly supervised computational pathology on whole-slide images." *Nature Biomedical Engineering* 2021;5(6):555–570. DOI 10.1038/s41551-020-00682-w. |
| Documented finding | **[PR]** CLAM is a weakly supervised, attention-based multiple-instance learning method that needs only slide-level labels, with instance-level clustering to refine features. Tasks: renal cell carcinoma subtyping (884 public slides), non-small-cell lung cancer subtyping (1,967 public slides) and lymph node metastasis detection (899 public slides), plus independent hospital cohorts, smartphone images and biopsies. The paper reports high AUCs on these tasks, including on independent cohorts. **[PR]** Stated limitations: instances are treated as independent, the feature encoder was not fine-tuned end to end, and attention heatmaps should not be read as pixel-level segmentation. |
| Licence (as stated) | The repository's LICENSE file is GPL-3.0. Its README also states the code is available for non-commercial academic purposes. The two statements appear to differ in what they allow; we treat this as **unresolved** and do not copy CLAM code. |
| What we can learn or borrow | Slide-label weak supervision; the baseline-versus-attention comparison; labelling heatmaps as attention, not segmentation (already a workbench rule). |
| Unknowns | Transfer to dermatopathology or BCC (not studied in this paper). |
| Our hypothesis | **[EI]** On our task, attention-based MIL must outperform a mean-pooled embedding baseline with logistic regression to justify its complexity. |
| Falsification experiment | On the frozen validation split, with patient-cluster bootstrap confidence intervals: if attention MIL does not beat the baseline by a prespecified margin [to confirm], the baseline is kept. |

### 14. Aiforia

| Field | Record |
|---|---|
| Sources | https://www.aiforia.com/resource-library/ai-supercharges-pathologists ; supplementary https://www.aiforia.com/aiforia-create (to check the brief's description of Aiforia Create) |
| Accessed | 2026-10-26; both loaded |
| Publicly documented capability | **[VC]** The resource is a company blog post dated 2025-02-21. It presents AI as support: pathologists review AI output, compare it with their own assessment, adjust it and make the final decision. The article body does not describe Aiforia Create, cites no studies and gives no intended-use statement. **[VC]** The Aiforia Create page describes a cloud tool for building deep learning models without coding, designed for pathologists and other domain experts, with an annotation assistant that suggests regions which users accept, edit or reject; transfer learning; and validation sets with blinded scoring by invited colleagues. **[VC]** The Proscia portfolio lists several Aiforia applications (row 2). |
| Intended use or regulatory status (as stated) | Aiforia Create: stated as Research Use Only. Blog: none stated. Per-application statuses on the Proscia portfolio vary. |
| What we can learn or borrow | Review and correction interaction; expert-friendly annotation; blinded scoring for validation. |
| Caution | **Accept, edit or reject interaction is not unique to us.** This vendor article supports positioning, not proof of our prototype's outcomes. |
| Unknowns | Skin products (none on the pages reviewed; UNKNOWN). Model and data export. Pricing. |
| Our hypothesis | **[UH]** The narrower contribution is keeping the original suggestion and the expert's later judgement as separate records, and recording an independent assessment before any suggestion is shown, so that automation bias can be measured. |
| Falsification experiment | In a pilot reader exercise on public or fictional material, check whether the stored records let us compute, per reader, how often the final label changed after a suggestion was revealed, with confidence intervals. If the records cannot support that analysis, the design fails and is changed. |

### 15. Diagnostics (2026) narrative review

| Field | Record |
|---|---|
| Source | https://pmc.ncbi.nlm.nih.gov/articles/PMC12897247/ |
| Accessed | 2026-10-26; loaded (read in full except the last ~27,000 characters) |
| Citation | "Will AI Replace Physicians in the Near Future? AI Adoption Barriers in Medicine." *Diagnostics* 2026;16(3):396. DOI 10.3390/diagnostics16030396. |
| Type | **[PR]** A peer-reviewed **narrative** review. Its methods state that systematic review procedures (PRISMA) were not applied. No new trial data. |
| Documented findings | **[PR]** AI is strongest in narrow, supervised tasks (triage, detection, measurement, documentation). The authors conclude AI will augment rather than replace physicians in the foreseeable future. Barriers named: generalisation under distribution shift (scanners, protocols, populations), lack of embodiment, hallucination, deskilling, and unresolved liability at higher autonomy. They recommend evaluation beyond isolated performance metrics (robustness, uncertainty, out-of-distribution behaviour, human–AI interaction) and suggest blinded or alternating review against automation bias. Pathology is mentioned briefly, with domain shift and digitisation quality named as obstacles. |
| How we use it | Positioning context only. It is **not** a trial of our product. The underlying primary studies must be verified before any task-specific efficacy claim. |
| Implication | **[EI]** Supports independent initial review, external or temporal evaluation, and a physician-with-tool versus physician-without-tool reader study rather than model-only metrics. |

### 16. LinkedIn commentary

| Field | Record |
|---|---|
| Source | https://www.linkedin.com/pulse/ai-replace-pathologists-reality-every-pathologist-should-kumar-6dbuc |
| Accessed | 2026-10-26. **Accessible**: sign-in prompts were shown but the article text was readable. |
| Type | **[OP]** A perspective article by a consultant histopathologist (author named on the page), dated 2026-06-12. It cites no studies or data. |
| Content (paraphrase) | **[OP]** AI is unlikely to replace pathologists; the future is collaboration. AI already assists with tasks such as tumour detection, lymph node screening, mitotic counting, biomarker scoring and triage. It falls short on clinical correlation, rare diagnoses, artifacts, contextual reasoning and accountability. Repetitive work is the likely target, freeing time for complex cases. |
| How we use it | Communication context only. Not evidence of accuracy and not a source of regulatory requirements. |

## What changed in our plan after this review

1. **No novelty claim for skin AI or BCC detection.** A third-party skin application whose public descriptions name BCC, SCC, melanoma and nevus is offered through several platforms. The BCC template stays an engineering starting point, and the demo must not imply novelty. **[EI]**
2. **QC is positioned as linkage, not detection.** Scanner-integrated QC (Aperio iQC), platform QC (Proscia Automated QC) and analysis-suite QC (HALO SlideQC) exist. Our QC hypothesis is narrowed to issue → human action → resolution → dataset eligibility. **[EI]**
3. **Reusable embeddings are not a differentiator.** They are a commercial platform feature. **[EI]**
4. **Easy annotation and accept, edit or reject review are not unique.** HALO AI and Aiforia Create document both. Our narrower claim is measurement-oriented record keeping (separate suggestion and judgement records; independent initial review). **[UH]**
5. **Licence constraints shape the commercial path.** UNI and TRIDENT are non-commercial, and the UNI terms extend to models trained on its outputs. Encoder adapters must carry licence metadata; no gated weights are bundled; a commercial path needs a licence-compatible encoder. **[EI]**
6. **Ownership is moving.** Paige is reported acquired by Tempus (2025); an acquisition of Proscia by Agilent was announced in October 2026 and was pending at the time of access. Any current commercial statement about these vendors must be re-verified. No transaction is used as a valuation comparable. **[VC via trade press]**
7. **Regulatory status is labelled per product, version, configuration and jurisdiction.** Several vendors do this well (PathPresenter, Ibex, Proscia footnotes). The workbench copies the pattern for its own research-only status and for each encoder's licence. **[EI]**

## Differentiation hypotheses and falsification experiments

**Overall hypothesis (from the brief, stated as a hypothesis).** A focused dermatopathology workbench can make it easier for a smaller lab to turn approved slides into a reliable, auditable research dataset and to measure practical value. **[UH]**

These are **proposed advantages to validate through interviews and pilots. They are not proven competitor deficiencies.** Where a competitor's capability is undocumented, it is UNKNOWN.

| # | Hypothesis **[UH]** | Falsification experiment | Stop or revise if |
|---|---|---|---|
| H1 | Preserving patient → case → specimen part → block → slide → level/stain relationships makes leakage-free datasets easier to build than with the lab's current tools. | Build the same frozen dataset twice: with the lab's current tools [to confirm what they are] and with the workbench. Count patients appearing in more than one split (must be zero) and record staff time. | Current tools achieve zero leakage at similar or lower effort. |
| H2 | Linking preparation and scan QC to corrective actions and dataset exclusions improves traceability in the target lab. | Baseline time-and-motion of slide-quality issues (recorded action, outcome, time to resolution), then the same measurements with the workbench. | Baseline traceability is already high, or the workbench adds more staff time than it saves. |
| H3 | Pathologist annotation burden can stay low while disagreement and provenance are captured. | Logged active labelling time per case and a burden rating; agreement statistics computed from the stored records. | Time per case exceeds the prespecified target, or pathologists decline to continue. |
| H4 | Showing errors, calibration, abstention and scanner or site variation next to headline scores improves how reviewers interpret results. | A comprehension exercise on a **fictional** evaluation report with a planted limitation (for example a scanner-specific drop). Compare correct identification of the limitation with a headline-only report. | No improvement in correct interpretation. |
| H5 | Model and data export is straightforward and reproducible. | Export a frozen dataset and experiment configuration, then rerun in a clean environment from the export alone. | Manifest hashes or metrics do not reproduce. |
| H6 | Total workflow time and cost, including new scanning and annotation work, can be measured honestly and may show net value. | Time-and-motion covering scanning, QC entry and annotation (histology staff and pathologists), entered into the Impact calculator with a realistic realisation fraction. | Incremental staff time exceeds time released. The negative result is reported, not hidden. |

**What "a stronger model" means here.** Better performance on a defined, independent benchmark (an untouched external or temporal test set) at acceptable cost and workload. It does not mean more interface features or a larger parameter count. Model-only AUROC does not establish that physicians do better with the tool; that requires a reader study (see pilot-protocol.md).

## Access log

| Source | Result on 2026-10-26 |
|---|---|
| The 24 source URLs in the brief | All loaded; one (below) without its body text |
| Proscia Embeddings press release (brief URL) | Loaded, but **body text not retrievable** (headline and metadata only); content taken from a republished copy of the same release, cited above |
| Tempus SEC Form 10-Q (supplementary) | Loaded, but the Paige passage was **not readable** within our tool's limits; completion date recorded as reported, to verify |
| LinkedIn commentary | Accessible (sign-in prompts, text readable) |
| Diagnostics review | Final portion (~27,000 characters, after section 7) not read |
