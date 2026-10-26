"""Feature-set routes (design §5). Mounted under ``/api/v1`` by :mod:`dermpath.main`.

STUB: the router is empty until phase 3 adds:

* ``POST /projects/{pid}/feature-sets`` (``experiment.write``) with
  ``{dataset_version_id | slide_ids, encoder_id, execution_mode, patch_policy?, stain_policy?,
  device?, precision?}``;
* ``GET /feature-sets/{id}`` with aggregated coverage diagnostics;
* ``GET /projects/{pid}/feature-sets``;
* ``POST /feature-sets/{id}/technical-validation``.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["feature-sets"])
