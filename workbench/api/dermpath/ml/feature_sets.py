"""Feature sets: frozen, immutable specifications of how embeddings are produced (design §5).

STUB. Phase 3 fills this module. Planned contents (``docs/ml-engine-design.md`` §5):

* ``create_feature_set(db, actor, project, *, dataset_version_id | slide_ids, encoder_id,
  execution_mode, patch_policy=None, stain_policy=None, device=None, precision="fp32")``:
  validates the mode against the encoder and the manifest's ``data_mode``, takes the
  per-slide **input snapshot** (slide sha256, object key, mpp, dimensions, level
  downsamples, QC review id, mask object key and sha256, mask downsample, excluded issue
  ids and the sha256 of their regions), records the encoder spec and weights sha, the
  patch and stain policies, the extraction environment
  (:func:`dermpath.ml.artifacts.extraction_env`), computes ``spec_sha256`` over all of it
  and reuses an existing set with the same spec (``uq_feature_set_spec``). Inserts one
  ``feature_set_item`` per slide (status ``pending``) and enqueues ``build_feature_set``.
* ``build_feature_set`` job: resumable (``done`` items skipped), cancellable, idempotent
  per (feature set, slide); builds **all splits, test included, without reading any
  label**; verifies the snapshot (mask sha, streamed slide sha) before extraction and
  refuses with ``FeatureError("input_changed: ...")``; asserts the loaded encoder's
  weights sha equals the set's; writes embeddings (.npy float32, memmap-able) and
  coords/quality/meta (.npz) content-addressed and write-once
  (:meth:`dermpath.storage.ObjectStore.put_content_addressed`); marks the set ``ready``
  in a flush after its items (see :mod:`dermpath.ml.engine_models`). Domain commits are
  fenced with ``ctx.assert_lease(db)``; a settle hook moves the set to ``failed`` when
  the job fails or is canceled outside the handler.
* Coverage aggregation for ``GET /feature-sets/{id}`` (per-slide table, min/median/max,
  zero-patch slides, slides below the coverage floor, uncalibrated count) and
  ``technical_validation`` (seeded re-extraction: max abs difference, identical coords,
  throughput, memory) stored as ``feature_set_validation`` rows.
* Staleness: QC changes after the snapshot never change a set; they are reported.
"""

from __future__ import annotations
