"""Inference bundles and label-free inference on new slides (design §8).

STUB. Phase 3 fills this module. Planned contents (``docs/ml-engine-design.md`` §8):

* ``build_bundle(db, actor, run) -> InferenceBundle`` at registration
  (``POST /experiments/{id}/register``): ``content_json`` holds the encoder spec, its sha
  and the weights sha; the patch policy and its sha; the stain policy (with a reference
  sha); the head arrays (content-addressed object key and sha); the class mapping
  (``positive_class``, ``negative_class``, display text, and the statement that negative
  is not benign); calibration, threshold and abstention policy; ``code_tree_sha256`` and
  dependency versions; ``dataset_manifest_sha256`` and the feature set's ``spec_sha256``;
  ``research_use_only: true``. ``bundle_sha256`` is
  :func:`dermpath.ml.engine_models.bundle_sha256_of` of that content (enforced by the ORM
  guard) and the canonical JSON is stored write-once at ``object_key``. The run's
  ``bundle_id`` is set once.
* ``infer_slide`` job for ``POST /bundles/{id}/infer`` ``{slide_id}``: verifies the encoder
  spec and weights sha, extracts features with the bundle's policies (label-free), scores,
  applies calibration, threshold and abstention, and appends an ``inference_prediction``
  row (research only; never a label, never routed to care).
"""

from __future__ import annotations
