# Data governance template

*DermPath Research Workbench (working name). Research-use-only prototype.*

> **This is a template for review. It is not legal advice and not an approved policy.** Every bracketed item is a decision that the responsible institution, its research review body and its counsel must make. Nothing here asserts that any authorisation, agreement or review exists today. Completing this template does not make any data use lawful or approved.

**Default position until this template is completed and signed:** the workbench holds only **public CC0 test data** and **synthetic or fictional** material. No patient material enters it.

**Public licensed research datasets** (provenance `public_licensed`, for example the COBRA BCC subset under CC BY-NC-SA 4.0) are published third-party data, not patient material entering through this workbench. They are imported only by an importer that verifies checksums and records the licence on the project, on each case and in every frozen manifest; their labels are the dataset's own reference (`imported_reference`), never expert reads. Licence conditions (for example non-commercial, share-alike) bind every use of these items and of anything derived from them; see `license-ledger.md` and `public-datasets.md`.

## 1. Who may authorise what

| Decision | Who decides | Status |
|---|---|---|
| Access to patient slides, images, reports or metadata for research | [to confirm: data owner, for example the laboratory or institution, through its designated official] | [not yet requested] |
| Research review (IRB or equivalent; exemption or waiver decisions) | [to confirm: name of the review body] | [not yet submitted] |
| De-identification method and sign-off | [to confirm: privacy officer or honest broker] | [not yet defined] |
| Use of the employer's equipment, staff time or premises | [to confirm: laboratory management] | [not yet requested] |
| Scanning of glass slides for research | [to confirm: laboratory management and the medical director] | [not yet requested] |
| Data use agreement, including rights in derived work | [to confirm: institution's legal or contracts office] | [not yet drafted] |
| Publication | [to confirm: as set in the agreement] | [not yet agreed] |
| Commercialisation of anything derived from the data | [to confirm: institution's technology transfer office or equivalent, and any other rights holders] | [not yet discussed] |

**The founder's relationship is not data ownership.** Jorge Rodriguez's role as a histology assistant, and his professional relationship with the medical director, give access to expertise and a possible pilot setting. They do not give permission to use patient data, do not create a partnership, and do not confer any right in slides, images, reports, annotations or anything derived from them. Any access comes through the institution's own process.

The medical director's review of this template is review only. It does not imply endorsement by the medical director or the employer.

## 2. De-identification approach and its limits

**Approach (proposed).**
1. De-identification is done **before** data reaches the workbench, by [to confirm: the institution's honest broker or designated staff], under the institution's procedure.
2. The workbench stores a **coded patient ID** only. The key linking codes to identities stays with [to confirm: the honest broker] and never enters the workbench.
3. Dates are shifted or generalised according to [to confirm: rule]. Accession numbers are replaced with study codes.
4. A second person checks a sample of each batch [to confirm: sampling rule] before release.

**Identifier sources to check in every batch.** A slide file carries more than pixels.

| Source | Risk | Control |
|---|---|---|
| **Filenames** | Often contain accession numbers, names or dates | Rename to study codes before transfer; the workbench also stores a safe filename, but that is a second line of defence, not the first. |
| **File metadata** (for example SVS/TIFF tags, scanner properties) | Can contain accession numbers, operator names, dates, barcodes, device serials | Strip or overwrite with a validated tool [to confirm which]; verify by reading the metadata back. |
| **Label images** | A photograph of the slide label: names, accession numbers, barcodes | Remove from the file before transfer where the format allows. The workbench does **not** serve label images, but a stored file still contains them. |
| **Macro (overview) images** | Often include the label area | As for label images. |
| **Pathology reports and free text** | Names, dates, locations, clinical history, other identifiers in narrative text | Do not import reports into the prototype. If report-derived labels are needed, transfer only the coded label. |
| **Burned-in text or marks on the tissue image** | Handwriting or stickers captured in the scan | Visual review of a sample; exclude affected slides. |
| **Rare diagnoses, unusual sites, small populations** | Re-identification through combination of facts | Generalise or exclude; record the decision. |

**A checkbox is not proof.** The workbench records a governance attestation at upload, but it does **not** treat that record as evidence that a file is de-identified. De-identification is shown by the institution's procedure and its verification records.

**Residual risk is never zero.** Images themselves can carry information that could in principle contribute to re-identification when combined with other data. Access controls and agreements remain necessary after de-identification.

## 3. Data use agreement: points to settle

Before any patient-derived material is used, a written agreement should settle, at minimum:

| Topic | Questions to answer |
|---|---|
| **Parties** | Who is the data provider (institution, laboratory, employer)? Who is the recipient (an individual, a company, a research group)? [to confirm] |
| **Permitted purpose** | The exact research task (for example: BCC present versus BCC absent on H&E skin biopsies, research only). Anything else needs a new agreement. |
| **Slides and images** | Who owns the glass slides and the scanned images? Can images leave the institution? Where may they be stored? |
| **Annotations and labels** | Who owns pathologist annotations and labels made on institutional time or material? |
| **Derived models** | Who owns models trained on the data, their weights and their outputs? Can they be used outside the institution? |
| **Background licences** | Which third-party models or code were used (for example any encoder with non-commercial or derivative restrictions; see license-ledger.md)? Do their terms permit the intended use of the derived model? |
| **Publications** | Review rights, authorship, acknowledgement, timelines. |
| **Commercialisation** | Is any commercial use permitted? Under what licence, revenue share or approval? Who decides? |
| **Employment and inventions** | Does an employment agreement or institutional policy assign rights in work done by employees (including the founder) to the employer? [to confirm with the employer] |
| **Confidentiality** | What is confidential, and for how long? |
| **Security** | Minimum controls (section 4). |
| **Retention and return** | How long data is kept, how it is returned or destroyed, and how destruction is evidenced. |
| **Incidents** | Who is notified of a suspected breach, how fast, and by whom. |
| **Termination** | What happens to data, annotations and derived models when the agreement ends. |

## 4. Storage, access, retention, deletion and audit

The left column is the proposed requirement. The right column describes what the prototype is designed to do, per implementation-plan.md. **Design intentions are not verified controls.** Verify each against the readiness report before relying on it.

| Area | Proposed requirement | Prototype design (to verify) |
|---|---|---|
| Location | Data stays on [to confirm: institution-approved infrastructure]. | Local private object store outside any web root; optional S3-compatible store. No public bucket. |
| Authentication | Institutional single sign-on or equivalent, with named accounts. | **Not implemented.** Demo mode is a role switch for fictional users, **not authentication**. Any other mode refuses every request (fails closed). Real data must not be loaded until secured mode exists and is reviewed. |
| Authorisation | Least privilege by role and project. | Backend role and project checks on every project-scoped route. |
| Image access | Short-lived, user-bound access. | Signed, short-lived tile tokens bound to slide, user and expiry. Label and macro images are not served. |
| Encryption | At rest and in transit, per the institution's standard. | [to confirm with deployment]. Encryption alone is not a compliance claim. |
| Logging | Logs never contain pixels, credentials or identifiers. | Audit events exclude pixels and credentials by design. |
| Audit | Who did what, when and why; tamper-evident. | Append-only audit events with actor, role, action, entity, before/after and reason. |
| Retention | [to confirm: period] after study end, then deletion. | [not implemented: retention schedule] |
| Deletion | Verified deletion of originals, derived files, embeddings, checkpoints and backups. | [not implemented: verified deletion workflow]. Soft deletion of annotations keeps history; it is not data destruction. |
| Backups | Same controls as primary storage. | [to confirm with deployment] |
| Export | Only coded data, only to approved destinations. | Exports carry coded IDs and hashes; destinations are not restricted by the software. [Process control required.] |

**No compliance claim.** Nothing in this document or the prototype claims HIPAA compliance, FDA readiness, CLIA or CAP readiness, or conformity with any other regime.

## 5. Prohibited uses

- **No upload of patient material to public model APIs, public chatbots or third-party demos**, including vendor trial portals and online model demos. This includes images, crops, thumbnails, reports, screenshots and metadata.
- No use of patient material for any purpose outside the signed agreement.
- No copying of patient material to personal devices, personal email or personal cloud storage.
- No inference of diagnostic labels from filenames.
- No use of model outputs in patient care. The prototype makes no diagnosis, orders nothing, dismisses nothing and reprioritises nothing.
- No re-identification attempts, including on any third-party model's training data (some model terms forbid this explicitly; see license-ledger.md).

## 6. People and workload

- Histotechnologists and assistants are part of the design. Any **extra scanning, QC entry or annotation work is measured** (time-and-motion) and agreed with laboratory management. It is not shifted invisibly onto them.
- Pathologist annotation time is measured and agreed in advance.
- Participation by staff is voluntary [to confirm with the institution's policy].

## 7. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Data owner representative | [ ] | [ ] | [ ] |
| Research review body | [ ] | [ ] | [ ] |
| Privacy or de-identification lead | [ ] | [ ] | [ ] |
| Laboratory management | [ ] | [ ] | [ ] |
| Medical director (review) | [ ] | [ ] | [ ] |
| Counsel | [ ] | [ ] | [ ] |
| Founder (Jorge Rodriguez) | | Acknowledges that no data right arises from his role or relationship | [ ] |
