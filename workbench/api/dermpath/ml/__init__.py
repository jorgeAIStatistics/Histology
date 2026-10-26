"""ML pipeline, evaluation and research model registry (research use only).

Pipeline: frozen dataset version → tissue coordinates (QC mask, Otsu fallback) at a
calibrated scale (or a recorded *uncalibrated* fixed pyramid level) → bounded, seeded
patch sampling that respects human-excluded QC regions → frozen encoder → embeddings
cached as :class:`~dermpath.ml.models.FeatureArtifact` → slide or case bags → head
(mean-pooled logistic regression, or gated attention MIL) → threshold chosen on the
validation split and frozen → predictions and evaluations computed from stored
:class:`~dermpath.ml.models.Prediction` rows.

Honesty rules enforced in code
------------------------------
* Anything derived from the ``synthetic-deterministic-v1`` encoder (or from synthetic,
  procedural images) carries ``synthetic: true`` and :data:`PIPELINE_TEST_BANNER`.
* The test split is reachable only after the validation threshold is frozen, only by the
  research lead, and every access is audited.
* Attention weights are labelled as attention: never segmentation, never an explanation.
* Model outputs never become expert labels. Active learning proposes items only.
* Registered models are research candidates. Nothing is ever deployed.
"""

PIPELINE_TEST_BANNER = "PIPELINE TEST — NOT PATHOLOGY VALIDATION"
RESEARCH_NOTICE = ("Research use only. Not a medical device. Results describe this experiment's data only and "
                   "are not evidence of diagnostic performance.")
ATTENTION_NOTICE = "Attention weights — not tumour segmentation and not a causal explanation"
SCORE_NOTE = "scores are not probabilities unless calibrated"
