# License ledger

*DermPath Research Workbench (working name). Research-use-only prototype. Verified on **2026-10-26**. This is an engineering record, not legal advice. Every commercial-use note below is a question for counsel, not a conclusion.*

> **Research-accessible ≠ commercially permitted.** A model, dataset or repository you can download for research may still forbid commercial use, derivatives or redistribution. A permissive code licence also says nothing about the data a model was trained on.

## How the licences were verified

| Kind | Source of truth used |
|---|---|
| Python packages | PyPI JSON for the **pinned version** (`https://pypi.org/pypi/<name>/<version>/json`, field `license_expression`, else `license`), cross-checked against the `METADATA` of the packages installed in `workbench/api/.venv` and the system interpreter |
| npm packages | The npm registry entry for the pinned version (`https://registry.npmjs.org/<name>/<version>`, field `license`), plus the `license` fields in `workbench/web/package-lock.json` for transitive packages |
| Repositories | The GitHub licence API (`/repos/<owner>/<repo>/license`) and the LICENSE file and README licence section themselves |
| Models | The licence tag and terms on the Hugging Face model card, and the repository README |
| Data | The licence column on the source download page |

**Status legend.**
- **USED**: pinned in `api/requirements.txt` or `web/package.json` and part of the running prototype.
- **USED (system)**: reused from the system Python through a venv created with `--system-site-packages` (see implementation-plan.md section 2).
- **DEV/TEST**: used only to build or test.
- **CONFIGURED, UNVERIFIED**: written into `docker-compose.yml` or an optional code path; not run yet.
- **REFERENCED**: studied or cited; **not installed, vendored or downloaded**.

## A. Python back end and workers

| Package (pinned) | Licence as published | Source checked | Role | Status | Commercial-use implications (questions for counsel) |
|---|---|---|---|---|---|
| openslide-python 1.4.6 | `LGPL-2.1-only AND BSD-3-Clause AND MIT AND LicenseRef-Public-Domain` | PyPI JSON; GitHub `COPYING.LESSER` (LGPL-2.1) | Whole-slide reading, Deep Zoom tiles | USED | The library is LGPL-2.1; the extra BSD, MIT and public-domain terms cover the bundled Deep Zoom example's third-party files (OpenSeadragon, jQuery, a scale-bar plugin). LGPL obligations are usually tied to **distribution** (for example shipping a container image): keep licence texts, keep the library replaceable, and provide source for any modified LGPL component. We use it unmodified. |
| openslide-bin 4.0.1.2 | `LGPL-2.1-only AND BSD-1-Clause AND BSD-2-Clause AND BSD-3-Clause AND (BSD-3-Clause OR GPL-2.0-only) AND BSD-4.3TAHOE AND IJG AND LGPL-2.0-or-later AND (LGPL-2.1-only OR MPL-1.1) AND LGPL-2.1-or-later AND libpng-2.0 AND libtiff AND MIT AND Zlib` | PyPI JSON; package README says it bundles OpenSlide plus third-party native libraries and installs every component licence under `dist-info/licenses/` | Native OpenSlide binaries (cairo, glib, libdicom, libjpeg-turbo, libpng, libtiff, OpenJPEG, pixman, zlib-ng, Zstandard, uthash, proxy-libintl) | USED | **Mixed licence.** Any distributed image must include the `dist-info/licenses/` directory and honour the LGPL components' replaceability and source obligations. One component is offered as `BSD-3-Clause OR GPL-2.0-only`; confirm which option applies. |
| fastapi 0.143.0 | MIT | PyPI JSON | API framework | USED | Permissive; keep the notice. |
| starlette 1.10.0 (transitive) | BSD-3-Clause | Installed METADATA | FastAPI dependency | USED | Permissive. |
| uvicorn 0.54.0 | BSD-3-Clause | PyPI JSON | ASGI server | USED | Permissive. |
| sqlalchemy 2.1.4 | MIT | PyPI JSON | ORM | USED | Permissive. |
| pydantic 2.14.1 / pydantic-core 2.50.1 | MIT / MIT | PyPI JSON; installed METADATA | Validation | USED | Permissive. |
| python-multipart 0.0.32 | Apache-2.0 | PyPI JSON | Form and upload parsing | USED | Permissive; Apache-2.0 includes a patent grant and a NOTICE requirement if present. |
| opentelemetry-api 1.45.1 (transitive) | Apache-2.0 | Installed METADATA | Pulled in by a dependency | USED (transitive) | Permissive. |
| pillow 12.3.0 | MIT-CMU | PyPI JSON; system METADATA | Image encoding (tiles, thumbnails, field images) | USED | Permissive (HPND-style). |
| numpy 2.4.2 | `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0` | PyPI JSON; system METADATA | Arrays, QC metrics | USED (system) | Permissive; the extra terms cover bundled components. |
| scikit-learn 1.9.0 | BSD-3-Clause | PyPI JSON; system METADATA | Baseline head (logistic regression), metrics | USED (system) | Permissive. Its dependencies scipy 1.17.0, joblib 1.5.3 and threadpoolctl 3.6.0 are BSD-licensed (system METADATA). |
| torch 2.14.1 | GitHub `LICENSE`: a BSD-3-Clause-style text (GitHub reports "Other"). PyPI wheel: `Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT` | GitHub LICENSE file; PyPI JSON; system METADATA | Attention-MIL head, training loop | USED (system) | "BSD-style" describes PyTorch's own code; the wheel also bundles third-party components under the other listed permissive licences. Keep notices if redistributed. |
| boto3 | Apache-2.0 (PyPI, latest) | PyPI JSON | Optional `S3ObjectStore` | CONFIGURED, UNVERIFIED (not pinned in `requirements.txt` at the time of writing) | Permissive. Pin it if the S3 path is enabled. |
| pytest 9.1.1 | MIT | PyPI JSON; system METADATA | Tests | DEV/TEST | Permissive. |
| httpx 0.28.1 | BSD-3-Clause | PyPI JSON (`license` field); system METADATA | Test client | DEV/TEST | Permissive. |

**Watch item: shared system interpreter.** The API venv uses `--system-site-packages`, so everything installed in the system Python is importable. That includes **scikit-survival 0.28.0, licensed GPL-3.0-or-later** (system METADATA), which the workbench does not need. Workbench code must not import it. Any distributable build should use an isolated environment with only the pinned dependencies. [to confirm by engineering: no import of scikit-survival]

At the time of writing, the API environment was still being installed. Re-run the check below once the install completes and update this table if anything new appears:

```bash
# Prints name, version and licence for every installed distribution in the API venv.
workbench/api/.venv/bin/python -c "import importlib.metadata as m; [print(d.metadata['Name'], d.version, d.metadata.get('License-Expression') or d.metadata.get('License')) for d in m.distributions()]"
```

## B. Web front end

| Package (pinned) | Licence (npm registry) | Role | Status | Commercial-use implications |
|---|---|---|---|---|
| next 16.3.8 | MIT | Web framework | USED | Permissive. |
| react 19.2.8, react-dom 19.2.8 | MIT | UI library | USED | Permissive. |
| openseadragon 6.1.1 | BSD-3-Clause (GitHub `LICENSE.txt` agrees) | Tile viewer | USED | Permissive; keep the notice and do not use the project's name to endorse ours. |
| tailwindcss 4.3.3, @tailwindcss/postcss 4.3.3 | MIT | Styling | USED (build) | Permissive. |
| lucide-react 0.577.0 | ISC | Icons | USED | Permissive. |
| clsx 2.1.1, tailwind-merge 3.7.0 | MIT | Class utilities | USED | Permissive. |
| typescript 5.9.3 | Apache-2.0 | Type checking | DEV/TEST | Permissive. |
| vitest 4.1.11 | MIT | Unit tests (ROI calculator) | DEV/TEST | Permissive. |
| @playwright/test 1.64.0 | Apache-2.0 | Browser tests | DEV/TEST | Permissive. |

**Transitive npm packages (169 in `package-lock.json`).** 101 MIT, 21 Apache-2.0, 5 ISC, 2 BSD-3-Clause, 1 0BSD, plus these that need attention:

| Package | Licence | Why it is there | Note |
|---|---|---|---|
| `@img/sharp-libvips-*` 1.3.4 (platform builds; the darwin-arm64 build is installed) and some `@img/sharp-*` builds | LGPL-3.0-or-later (some combined with Apache-2.0 and MIT) | Optional dependency of Next.js image optimisation (`sharp`) | Prebuilt libvips binaries. If a container image or bundle is **distributed**, keep the licence texts and the library replaceable; confirm with counsel. The workbench does not need Next.js image optimisation for slide tiles. |
| `lightningcss` 1.32.0 / 1.33.0 and platform builds | MPL-2.0 | CSS tooling for the build | Build-time; file-level copyleft applies only to modified MPL files. |
| `caniuse-lite` | CC-BY-4.0 | Browser-support data used by build tools | Attribution licence for data. |

## C. Infrastructure named in `docker-compose.yml` (written, not yet run)

| Component | Licence | Source checked | Status | Commercial-use implications |
|---|---|---|---|---|
| SQLite | Public domain | sqlite.org copyright page | USED (default local database through Python) | No licence obligations. |
| PostgreSQL | PostgreSQL License (BSD/MIT-like) | postgresql.org licence page; `COPYRIGHT` file | CONFIGURED, UNVERIFIED | Permissive. |
| MinIO server | **AGPL-3.0** | GitHub licence API | CONFIGURED, UNVERIFIED (local stand-in for S3-compatible storage) | **Flag for counsel before any hosted or commercial deployment.** AGPL obligations can attach to network use of modified versions. We would run it unmodified as a separate service, and any S3-compatible store can replace it behind the `ObjectStore` interface. |

## D. Data and fixtures

| Item | Licence as listed | Source | Status | Notes |
|---|---|---|---|---|
| `CMU-1-Small-Region.svs` (1.85 MB, Aperio SVS) | **CC0** (linked to the CC0 1.0 deed on the download page) | https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/ | USED (committed fixture, `workbench/fixtures/`) | **Unlabeled.** No diagnostic label may be inferred from its name or appearance. It contains label and macro images, which the workbench does not serve. CC0 needs no attribution; we give it anyway in `fixtures/README.md`. |
| `CMU-1.svs` (169.33 MB) | CC0 | Same page | USED, optional (fetched by script with a checksum; gitignored, not committed) | Unlabeled; for multi-level tiling tests. |
| Other files on the same page | Mostly CC0; two files carry a different free-use statement | Same page | Not used | Check each file's own row before use. |
| Synthetic tiles and synthetic embeddings | Generated by our own code | `dermpath/slides/synthetic.py` and the ML smoke test (per implementation-plan.md) | USED | No third-party rights. Contain **no histology**; labelled `DEMO SYNTHETIC` and **PIPELINE TEST — NOT PATHOLOGY VALIDATION**. |
| Fictional seed metadata (cases, parts, users) | Our own | `dermpath/seed.py` (per implementation-plan.md) | USED | Fictional. No real patient names or identifiers. |

## E. Models, research code and tools

| Item | Licence and terms as stated by the source | Source | Status | Commercial-use implications |
|---|---|---|---|---|
| **UNI** (ViT-L/16) and **UNI2-h** weights | Licence tag **cc-by-nc-nd-4.0**. Gated: accept conditions; the Hugging Face primary email must match an institutional email (personal domains are listed as grounds for denial); each user registers individually. Non-commercial academic research only. Commercial use, sale or monetisation of the models **and derivatives, including models trained on outputs of the models or datasets created from them**, is prohibited without prior approval. Users agree **not to distribute, publish or reproduce** a copy. No attempt to re-identify the training data. Clinical use not addressed. | https://huggingface.co/MahmoodLab/UNI ; https://huggingface.co/MahmoodLab/UNI2-h ; README "License and Terms of Use" at https://github.com/mahmoodlab/UNI | REFERENCED. Weights **not downloaded**, not committed, never redistributed. The encoder registry should show `missing_weights` [to confirm against the built adapter]. | Any classifier trained on UNI embeddings is inside the stated derivative restriction. **No commercial use without prior approval from the rights holder.** The founder's personal email would not meet the stated access condition; access would have to come through an eligible institution and its own agreement. |
| **UNI code repository** | CC-BY-NC-ND 4.0 (LICENSE file and README) | https://github.com/mahmoodlab/UNI | REFERENCED | Non-commercial; no distribution of adapted versions. Do not copy code. |
| **TRIDENT** | **CC-BY-NC-ND 4.0** (LICENSE file). README: non-commercial, academic research only; commercial use prohibited without prior approval; downloading an encoder binds you to that encoder's own licence. Its listed segmentation models (HEST, GrandQC) are CC-BY-NC-SA 4.0. | https://github.com/mahmoodlab/TRIDENT | REFERENCED. Not installed or vendored. | Do not copy or adapt its code. Our tissue mask is an independent Otsu implementation [to confirm by engineering]. |
| Other encoders in TRIDENT's table | Each encoder lists its own licence, from MIT and Apache-2.0 to CC-BY-NC-ND 4.0 and vendor non-commercial licences; several permissively licensed ones are still gated | TRIDENT README | REFERENCED | Check the model card of any encoder before enabling it. Gated access does not imply restrictive terms, and permissive terms do not remove the gate. |
| **CLAM** code | GitHub `LICENSE.md`: **GPL-3.0**. README: "available for non-commercial academic purposes". | https://github.com/mahmoodlab/CLAM | REFERENCED (method only) | The two statements appear to differ in what they allow. **Treat as unresolved.** Our attention-MIL head is written from the published method description, not from CLAM code [to confirm by engineering]. |
| CLAM paper | Journal article (*Nature Biomedical Engineering* 2021, DOI 10.1038/s41551-020-00682-w); author manuscript on PMC | https://pmc.ncbi.nlm.nih.gov/articles/PMC8711640/ | REFERENCED | Citing a method creates no licence obligation; copying code or figures would. |
| **QuPath** | **GPL-3.0** (GitHub licence API and LICENSE). The project states it is not intended for clinical, diagnostic or therapeutic purposes. | https://github.com/qupath/qupath ; https://qupath.github.io/ | REFERENCED. GeoJSON exchange is planned (P1). | Exchanging files with QuPath does not bring its code into ours. **Do not copy QuPath source**; GPL obligations would attach to distributed derivative works. |
| OpenSlide C library (via openslide-bin) | LGPL-2.1 (GitHub `COPYING.LESSER`) | https://github.com/openslide/openslide | USED (bundled in openslide-bin) | See openslide-bin above. |

## Checklist before any commercial step

1. Replace or license every **REFERENCED** non-commercial item that a commercial build would need (encoders above all).
2. Build in an isolated environment containing only pinned dependencies, and regenerate this ledger from it.
3. Ship third-party notices with any distributed artefact: LGPL texts and replaceability for OpenSlide and the optional libvips; MPL and CC-BY notices where they apply.
4. Decide on object storage for hosted use (MinIO's AGPL-3.0 or an alternative) with counsel.
5. Run a code-provenance check (no CLAM, TRIDENT, UNI or QuPath source copied).
6. Remember that licences cover code, weights and data separately. Rights in **slides, annotations, labels and derived models** come from the data-use agreements in data-governance.md, not from any software licence.
