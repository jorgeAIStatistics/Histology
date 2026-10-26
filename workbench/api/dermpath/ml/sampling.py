"""Deterministic, version-stable selection of patch candidates (research use only).

Strategies
----------
``all``
    Every candidate (``max_patches`` is ignored and stored as None). A hard safety cap
    (``all_safety_cap``) bounds the count; when it binds, the cap is filled by the ``uniform``
    rule below and the cap is recorded in the stats.
``uniform``
    A seeded subset: candidates are ranked by ``sha256(version|seed|salt|x|y)`` and the
    ``max_patches`` lowest ranks are kept. This is stable across NumPy versions (NumPy does
    not promise stable ``Generator`` streams, NEP 19).
``spatial``
    Deterministic spatial stratification (``kd_strata_seeded_pick``): the candidate centres
    are split recursively, along the longer side, into ``max_patches`` compact strata of
    (nearly) equal size, and the lowest-ranked candidate of each stratum is kept. Every
    candidate keeps (nearly) the same inclusion probability as in ``uniform``, so the sample is
    not biased toward any part of the tissue, but no region is left empty. Greedy
    farthest-point selection was measured and rejected: it favours the tissue periphery (on
    CMU-1-Small-Region with 629 candidates of 32 µm it covered LESS tissue within one patch
    side than uniform at 16 and 32 patches); the strata rule covered at least as much as
    uniform in every setting measured (see tests/test_ml_sampling.py).
``lesion_aware``
    EXPERIMENTAL. Spends ``lesion_fraction`` of the budget on candidates that intersect
    regions passed explicitly in ``permitted_lesion_regions``, then fills the rest spatially.
    Those regions must be expert annotations on TRAIN-split slides: every region dict must
    carry ``split == "train"`` and ``source == "expert_annotation"``. It refuses to run
    without them and must never be used for validation or test slides (the caller decides
    the split; this module refuses anything not declared train).

The sampling seed (``SamplingPolicy.seed``) is independent of any model-training seed, so
head-seed variance and sampling variance are not confounded. The optional ``salt`` (for
example the slide sha256) decorrelates slides that share a candidate layout.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass

import numpy as np

SAMPLING_VERSION = "dermpath.sampling/1"
STRATEGIES = ("all", "uniform", "spatial", "lesion_aware")
DEFAULT_ALL_SAFETY_CAP = 50_000
LESION_AWARE_NOTE = ("experimental: lesion-aware sampling uses expert annotations on train-split slides only; "
                     "never for validation or test")


class SamplingError(ValueError):
    """Sampling refused (bad policy, or lesion-aware sampling without permitted regions)."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class SamplingPolicy:
    """How many candidates to keep and how. ``max_patches=None`` keeps all (``all`` only)."""

    strategy: str = "spatial"
    max_patches: int | None = 64
    seed: int = 0
    all_safety_cap: int = DEFAULT_ALL_SAFETY_CAP
    lesion_fraction: float = 0.5

    def __post_init__(self):
        if self.strategy not in STRATEGIES:
            raise SamplingError("unknown_strategy", f"{self.strategy!r} (expected one of {', '.join(STRATEGIES)})")
        if self.strategy == "all":  # only the safety cap bounds "all"; keep the JSON canonical
            object.__setattr__(self, "max_patches", None)
        for name in ("max_patches", "seed", "all_safety_cap"):  # canonical types, so equal policies hash equally
            v = getattr(self, name)
            if isinstance(v, float) and v.is_integer():
                object.__setattr__(self, name, int(v))
            elif v is not None and not isinstance(v, int):
                raise SamplingError("bad_policy", f"{name} must be an integer, got {v!r}")
        object.__setattr__(self, "lesion_fraction", float(self.lesion_fraction))
        if self.max_patches is None and self.strategy != "all":
            raise SamplingError("max_patches_required", f"strategy {self.strategy!r} needs max_patches >= 1")
        if self.max_patches is not None and int(self.max_patches) < 1:
            raise SamplingError("bad_max_patches", f"max_patches must be >= 1, got {self.max_patches}")
        if int(self.all_safety_cap) < 1:
            raise SamplingError("bad_safety_cap", f"all_safety_cap must be >= 1, got {self.all_safety_cap}")
        if not 0.0 <= float(self.lesion_fraction) <= 1.0:
            raise SamplingError("bad_lesion_fraction", f"lesion_fraction must be in [0, 1], got {self.lesion_fraction}")
        if int(self.seed) < 0:
            raise SamplingError("bad_seed", f"seed must be >= 0, got {self.seed}")

    def to_json(self) -> dict:
        return {"version": SAMPLING_VERSION, **asdict(self)}

    @classmethod
    def from_json(cls, data: dict) -> "SamplingPolicy":
        body = {k: v for k, v in dict(data).items() if k != "version"}
        if data.get("version", SAMPLING_VERSION) != SAMPLING_VERSION:
            raise SamplingError("version_mismatch", f"{data.get('version')!r} != {SAMPLING_VERSION!r}")
        return cls(**body)


# --------------------------------------------------------------------------- helpers


def seeded_ranks(coords: np.ndarray, seed: int, salt: str = "") -> np.ndarray:
    """A version-stable pseudo-random rank per coordinate (uint64), keyed by seed and salt."""
    out = np.empty(coords.shape[0], dtype=np.uint64)
    prefix = f"{SAMPLING_VERSION}|{int(seed)}|{salt}|".encode()
    for i, (x, y) in enumerate(np.asarray(coords, dtype=np.int64).tolist()):
        out[i] = int.from_bytes(hashlib.sha256(prefix + f"{x}|{y}".encode()).digest()[:8], "little")
    return out


def _centres2(coords: np.ndarray, extent: tuple[int, int]) -> np.ndarray:
    """Twice the patch centre in level-0 px, as int64 (exact integers)."""
    c = np.asarray(coords, dtype=np.int64)
    return np.stack([2 * c[:, 0] + int(extent[0]), 2 * c[:, 1] + int(extent[1])], axis=1)


def kd_strata(idx: np.ndarray, k: int, centres: np.ndarray, ranks: np.ndarray) -> list[np.ndarray]:
    """Split ``idx`` into ``k`` spatially compact strata of (nearly) equal size.

    Recursive bisection along the longer side of the current set's bounding box; the order
    along the cut is (coordinate, other coordinate, seeded rank), so it is deterministic.
    """
    if k <= 1 or idx.size <= 1:
        return [idx]
    k1 = k // 2
    n1 = min(max(int(round(idx.size * k1 / k)), 1), idx.size - 1)
    pts = centres[idx]
    spread = pts.max(axis=0) - pts.min(axis=0)
    ax = 0 if spread[0] >= spread[1] else 1
    ordered = idx[np.lexsort((ranks[idx], pts[:, 1 - ax], pts[:, ax]))]
    return kd_strata(ordered[:n1], k1, centres, ranks) + kd_strata(ordered[n1:], k - k1, centres, ranks)


def stratified_pick(allowed: np.ndarray, k: int, centres: np.ndarray, ranks: np.ndarray) -> np.ndarray:
    """``k`` indices among ``allowed`` (bool mask): one lowest-rank pick per k-d stratum."""
    idx = np.flatnonzero(allowed)
    k = int(min(k, idx.size))
    if k <= 0:
        return np.zeros(0, dtype=np.int64)
    if k == idx.size:
        return idx.astype(np.int64)
    picks = [int(s[np.argmin(ranks[s])]) for s in kd_strata(idx, k, centres, ranks) if s.size]
    return np.asarray(picks, dtype=np.int64)


def _validate_permitted(regions) -> list[dict]:
    if not regions:
        raise SamplingError("lesion_aware_requires_permitted_regions",
                            "lesion_aware sampling runs only with explicitly permitted expert regions "
                            "on train-split slides")
    out = []
    for i, r in enumerate(regions):
        if not isinstance(r, dict) or "region" not in r:
            raise SamplingError("bad_permitted_region", f"region {i} must be a dict with a 'region' geometry")
        if r.get("split") != "train":
            raise SamplingError("lesion_region_not_train",
                                f"region {i} declares split={r.get('split')!r}; only train-split annotations "
                                "may steer sampling")
        if r.get("source") != "expert_annotation":
            raise SamplingError("lesion_region_not_expert",
                                f"region {i} declares source={r.get('source')!r}; only expert annotations are permitted")
        out.append(r)
    return out


# --------------------------------------------------------------------------- selection


def select_indices(candidates, policy, *, permitted_lesion_regions=None, salt: str = "") -> tuple[np.ndarray, dict]:
    """Indices (sorted ascending) of the selected candidates, plus stats.

    ``candidates`` is a :class:`dermpath.ml.patching.Candidates` (or any object with
    ``coords`` (N, 2) int64 level-0 top-left and ``extent`` (w, h)). ``policy`` is a
    :class:`SamplingPolicy` or a ``PatchPolicy`` (its ``sampling`` field is used).
    """
    sp: SamplingPolicy = getattr(policy, "sampling", policy)
    if not isinstance(sp, SamplingPolicy):
        raise SamplingError("bad_policy", f"expected a SamplingPolicy, got {type(sp).__name__}")
    coords = np.asarray(candidates.coords, dtype=np.int64).reshape(-1, 2)
    extent = tuple(int(v) for v in candidates.extent)
    n = coords.shape[0]
    stats: dict = {"version": SAMPLING_VERSION, "strategy": sp.strategy, "seed": int(sp.seed),
                   "salted": bool(salt), "max_patches": sp.max_patches, "candidates": int(n)}
    if sp.strategy == "lesion_aware":
        permitted = _validate_permitted(permitted_lesion_regions)
    elif permitted_lesion_regions:
        raise SamplingError("permitted_regions_unused",
                            f"permitted_lesion_regions are only accepted by lesion_aware, not {sp.strategy!r}")
    if n == 0:
        stats.update(selected=0, saturated=False)
        return np.zeros(0, dtype=np.int64), stats
    ranks = seeded_ranks(coords, sp.seed, salt)

    if sp.strategy == "all":
        cap = int(sp.all_safety_cap)
        if n > cap:
            idx = np.sort(np.argsort(ranks, kind="stable")[:cap])
            stats["safety_cap"] = {"cap": cap, "applied": True, "dropped": int(n - cap), "fill_rule": "uniform_rank"}
        else:
            idx = np.arange(n, dtype=np.int64)
            stats["safety_cap"] = {"cap": cap, "applied": False, "dropped": 0}
    else:
        k = int(sp.max_patches)
        if n <= k:
            idx = np.arange(n, dtype=np.int64)
        elif sp.strategy == "uniform":
            idx = np.sort(np.argsort(ranks, kind="stable")[:k])
        elif sp.strategy == "spatial":
            idx = np.sort(stratified_pick(np.ones(n, dtype=bool), k, _centres2(coords, extent), ranks))
            stats["algorithm"] = "kd_strata_seeded_pick"
        else:  # lesion_aware
            from .patching import cells_hit_regions

            inside = cells_hit_regions(coords, extent, [r["region"] for r in permitted])
            n_les = int(round(k * float(sp.lesion_fraction)))
            centres = _centres2(coords, extent)
            les = stratified_pick(inside, n_les, centres, ranks)
            rest_allowed = np.ones(n, dtype=bool)
            rest_allowed[les] = False
            rest = stratified_pick(rest_allowed, k - les.size, centres, ranks)
            idx = np.sort(np.concatenate([les, rest]))
            stats["algorithm"] = "kd_strata_seeded_pick (lesion budget first)"
            stats["lesion"] = {"permitted_regions": len(permitted), "candidates_in_regions": int(inside.sum()),
                               "selected_in_regions": int(inside[idx].sum()), "budget_in_regions": n_les,
                               "experimental": True, "note": LESION_AWARE_NOTE}
    stats["selected"] = int(idx.size)
    stats["saturated"] = bool(idx.size < n)  # True when the bound (or cap) dropped candidates
    return idx.astype(np.int64), stats


def sample(candidates, policy, *, permitted_lesion_regions=None, salt: str = "") -> tuple[np.ndarray, dict]:
    """Selected level-0 coordinates (N, 2) int64, ordered by (y, x), and the sampling stats."""
    idx, stats = select_indices(candidates, policy, permitted_lesion_regions=permitted_lesion_regions, salt=salt)
    coords = np.asarray(candidates.coords, dtype=np.int64).reshape(-1, 2)[idx]
    order = np.lexsort((coords[:, 0], coords[:, 1])) if coords.shape[0] else np.zeros(0, dtype=np.int64)
    return coords[order], stats
