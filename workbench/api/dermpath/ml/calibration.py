"""Post-hoc score calibration fitted on DEVELOPMENT scores only (design §6, §7). Pure, no DB.

* ``platt``: logistic regression of the label on the score (Platt, 1999), by default on the
  score's logit, with Platt's smoothed targets ``(N₊ + 1) / (N₊ + 2)`` and ``1 / (N₋ + 2)`` so
  the fit stays finite under separation. Newton's method with backtracking (Lin, Lin and
  Weng, 2007).
* ``isotonic``: monotone non-decreasing step function (pool adjacent violators, fitted by
  scikit-learn) applied by linear interpolation between the fitted points, with clipping:
  scores outside the fitted range take the boundary value and outputs stay in [0, 1].
* ``none``: identity.

Fitting refuses any item whose split is ``test`` (:class:`CalibrationOnTestRefused`) and
accepts only the development roles in :data:`FIT_SPLITS`, so test scores can never shape the
calibration that is later applied to them. Fitted parameters are plain JSON (versioned by
:data:`CALIBRATION_SCHEMA`, hashed by ``params_sha256``) and :func:`apply_calibration` needs
only numpy. Calibrated scores are still model outputs: calibration on development data does
not guarantee calibration on another population.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

import numpy as np

from .metrics import binary_labels, canonical_sha256, finite_scores

CALIBRATION_SCHEMA = "dermpath.calibration/1"
METHODS = ("none", "platt", "isotonic")
FIT_SPLITS = ("val", "oof", "calibration")  # development roles a calibration may be fitted on
SCORE_INPUTS = ("logit", "score")
LOGIT_EPS = 1e-6
MIN_PER_CLASS = 5
_NEWTON_MAX_ITER = 100
_NEWTON_MIN_STEP = 1e-10
_NEWTON_SIGMA = 1e-12
_NEWTON_EPS = 1e-5


class CalibrationError(ValueError):
    """Calibration cannot be fitted or applied as requested."""


class CalibrationOnTestRefused(CalibrationError):
    """An item marked ``test`` was offered to a calibration fit."""


def _sigmoid(z: np.ndarray) -> np.ndarray:
    e = np.exp(-np.abs(z))
    return np.where(z >= 0, 1.0 / (1.0 + e), e / (1.0 + e))


def _logit(s: np.ndarray, eps: float) -> np.ndarray:
    c = np.clip(s, eps, 1.0 - eps)
    return np.log(c) - np.log1p(-c)


def _transform(s: np.ndarray, score_input: str, eps: float) -> np.ndarray:
    return _logit(s, eps) if score_input == "logit" else s


def assert_development_only(item_splits: Sequence[str]) -> list[str]:
    """Refuse a fit set that contains any ``test`` item or any role outside :data:`FIT_SPLITS`.
    Returns the sorted distinct roles."""
    splits = [str(v) for v in item_splits]
    n_test = sum(1 for v in splits if v.strip().lower() == "test")
    if n_test:
        raise CalibrationOnTestRefused(
            f"calibration must be fitted on development data only; {n_test} item(s) are marked test")
    other = sorted({v for v in splits if v not in FIT_SPLITS})
    if other:
        raise CalibrationError(f"calibration can be fitted only on {', '.join(FIT_SPLITS)} items; got {other}. "
                               "In-sample training scores are not valid calibration data.")
    return sorted(set(splits))


def _platt_newton(x: np.ndarray, t: np.ndarray) -> tuple[float, float, int, bool]:
    """Minimise the cross-entropy of ``P = 1 / (1 + exp(A·x + B))`` against targets ``t``.
    Returns ``(A, B, iterations, converged)``."""
    n_pos = float((t > 0.5).sum())
    n_neg = float(t.size - n_pos)
    a, b = 0.0, math.log((n_neg + 1.0) / (n_pos + 1.0))

    def objective(a_: float, b_: float) -> float:
        f = x * a_ + b_
        return float(np.sum(np.where(f >= 0, t * f + np.log1p(np.exp(-np.abs(f))),
                                     (t - 1.0) * f + np.log1p(np.exp(-np.abs(f))))))

    fval = objective(a, b)
    it, converged = 0, False
    for it in range(1, _NEWTON_MAX_ITER + 1):
        f = x * a + b
        p = _sigmoid(-f)  # P(y = 1)
        d2 = p * (1.0 - p)
        h11 = _NEWTON_SIGMA + float(np.sum(x * x * d2))
        h22 = _NEWTON_SIGMA + float(np.sum(d2))
        h21 = float(np.sum(x * d2))
        d1 = t - p
        g1, g2 = float(np.sum(x * d1)), float(np.sum(d1))
        if abs(g1) < _NEWTON_EPS and abs(g2) < _NEWTON_EPS:
            converged = True
            break
        det = h11 * h22 - h21 * h21
        da = -(h22 * g1 - h21 * g2) / det
        db = -(-h21 * g1 + h11 * g2) / det
        gd = g1 * da + g2 * db
        step = 1.0
        while step >= _NEWTON_MIN_STEP:
            na, nb = a + step * da, b + step * db
            nf = objective(na, nb)
            if nf < fval + 1e-4 * step * gd:
                a, b, fval = na, nb, nf
                break
            step /= 2.0
        else:
            break  # line search failed; keep the last accepted point
    return a, b, it, converged


def _fit_summary(s: np.ndarray, y: np.ndarray, splits: list[str]) -> dict:
    return {"splits": splits, "n": int(y.size), "n_positive": int(y.sum()), "n_negative": int(y.size - y.sum()),
            "data_sha256": canonical_sha256([[float(a), int(b)] for a, b in zip(s.tolist(), y.tolist())])}


def _finalise(params: dict) -> dict:
    body = {k: v for k, v in params.items() if k != "params_sha256"}
    return {**body, "params_sha256": canonical_sha256(body)}


def identity_calibration() -> dict:
    """``calibration: none``: scores pass through unchanged."""
    return _finalise({"schema": CALIBRATION_SCHEMA, "method": "none", "params": {}, "fitted_on": None,
                      "research_use_only": True})


def fit_calibration(scores, labels, *, method: str, item_splits: Sequence[str], score_input: str = "logit",
                    min_per_class: int = MIN_PER_CLASS, eps: float = LOGIT_EPS) -> dict:
    """Fit a calibration map on DEVELOPMENT scores (val or out-of-fold).

    ``item_splits`` gives every item's role and is required: any ``test`` item raises
    :class:`CalibrationOnTestRefused`, any role outside :data:`FIT_SPLITS` raises
    :class:`CalibrationError`. Both classes need at least ``min_per_class`` items.
    ``score_input`` (Platt only): ``logit`` fits on logit(score) (scores in [0, 1], clipped to
    [eps, 1 − eps]); ``score`` fits on the raw score."""
    if method not in METHODS:
        raise CalibrationError(f"unknown calibration method {method!r}; use one of {', '.join(METHODS)}")
    y = binary_labels(labels)
    s = finite_scores(scores, y.size)
    splits = list(item_splits)
    if len(splits) != y.size:
        raise CalibrationError(f"item_splits has {len(splits)} entries for {y.size} item(s)")
    roles = assert_development_only(splits)
    if method == "none":
        return identity_calibration()
    n_pos, n_neg = int(y.sum()), int(y.size - y.sum())
    if n_pos < int(min_per_class) or n_neg < int(min_per_class):
        raise CalibrationError(f"insufficient evidence to fit {method} calibration: {n_pos} positive and {n_neg} "
                               f"negative item(s); each class needs at least {int(min_per_class)}")
    fitted_on = _fit_summary(s, y, roles)
    if method == "platt":
        if score_input not in SCORE_INPUTS:
            raise CalibrationError(f"score_input must be one of {', '.join(SCORE_INPUTS)}")
        if score_input == "logit" and (s.min() < 0.0 or s.max() > 1.0):
            raise CalibrationError("score_input 'logit' needs scores in [0, 1]")
        x = _transform(s, score_input, eps)
        targets = np.where(y == 1, (n_pos + 1.0) / (n_pos + 2.0), 1.0 / (n_neg + 2.0))
        a, b, iterations, converged = _platt_newton(x, targets)
        slope, intercept, constraint = -a, -b, None
        if slope < 0.0:
            # Decisions use the raw score against the frozen threshold and the calibrated score is reported beside
            # them, so the map must be non-decreasing. A negative slope means the development scores run against the
            # labels: the constrained fit (slope >= 0) is then the intercept-only one, a constant probability equal
            # to the mean Platt target, and the reason is recorded.
            mean_target = float(np.mean(targets))
            slope, intercept = 0.0, float(np.log(mean_target) - np.log1p(-mean_target))
            constraint = (f"slope clamped at 0 (the unconstrained fit gave {-a:.6g}): development scores are "
                          "anti-informative, so the calibrated score is a constant")
        params = {"slope": slope, "intercept": intercept, "score_input": score_input, "eps": float(eps),
                  "formula": "p = 1 / (1 + exp(-(slope * x + intercept))), x = " + (
                      "logit(clip(score, eps, 1 - eps))" if score_input == "logit" else "score"),
                  "targets": "Platt smoothed: (N+ + 1) / (N+ + 2) for positives, 1 / (N- + 2) for negatives",
                  "constraint": "slope >= 0 (rank-preserving)", "constrained": constraint,
                  "iterations": int(iterations), "converged": bool(converged)}
    else:
        from sklearn.isotonic import IsotonicRegression  # lazy: only fitting needs scikit-learn

        iso = IsotonicRegression(increasing=True, y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(s, y)
        params = {"x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_],
                  "increasing": True, "out_of_bounds": "clip",
                  "interpolation": "linear between fitted points; boundary value outside the fitted range"}
    return _finalise({"schema": CALIBRATION_SCHEMA, "method": method, "params": params, "fitted_on": fitted_on,
                      "research_use_only": True})


def calibration_sha256(params: Mapping) -> str:
    return canonical_sha256({k: v for k, v in params.items() if k != "params_sha256"})


def apply_calibration(params: Mapping, scores) -> np.ndarray:
    """Calibrated scores in [0, 1]. Refuses an unknown schema or method and parameters whose
    ``params_sha256`` no longer matches their content."""
    if params.get("schema") != CALIBRATION_SCHEMA:
        raise CalibrationError(f"unknown calibration schema {params.get('schema')!r}")
    if params.get("params_sha256") != calibration_sha256(params):
        raise CalibrationError("calibration parameters were modified after fitting (params_sha256 mismatch)")
    s = finite_scores(scores)
    method, p = params.get("method"), params.get("params") or {}
    if method == "none":
        return s.copy()
    if method == "platt":
        if p["score_input"] == "logit" and s.size and (s.min() < 0.0 or s.max() > 1.0):
            raise CalibrationError("this Platt calibration expects scores in [0, 1]")
        x = _transform(s, p["score_input"], float(p["eps"]))
        return _sigmoid(float(p["slope"]) * x + float(p["intercept"]))
    if method == "isotonic":
        out = np.interp(s, np.asarray(p["x"], dtype=np.float64), np.asarray(p["y"], dtype=np.float64))
        return np.clip(out, 0.0, 1.0)
    raise CalibrationError(f"unknown calibration method {method!r}")


def logistic_recalibration(y, s, *, eps: float = LOGIT_EPS) -> dict:
    """Calibration intercept and slope for REPORTING (not for applying): the maximum-likelihood
    logistic regression of the label on logit(score). Perfect calibration gives slope 1 and
    intercept 0; a slope below 1 means scores are too extreme. ``None`` with a reason when a
    class is missing or the fit does not converge (separation)."""
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    base = {"method": "maximum-likelihood logistic regression of the label on logit(score)",
            "ideal": {"slope": 1.0, "intercept": 0.0}}
    n_pos, n_neg = int(y.sum()), int(y.size - y.sum())
    if n_pos == 0 or n_neg == 0:
        return {**base, "slope": None, "intercept": None,
                "undefined_reason": f"undefined: needs both classes (positives={n_pos}, negatives={n_neg})"}
    if s.min() < 0.0 or s.max() > 1.0:
        return {**base, "slope": None, "intercept": None, "undefined_reason": "undefined: scores are not in [0, 1]"}
    x = _logit(s, eps)
    pos_x, neg_x = x[y == 1], x[y == 0]
    if neg_x.max() <= pos_x.min() or pos_x.max() <= neg_x.min():
        return {**base, "slope": None, "intercept": None,
                "undefined_reason": "not estimable: the classes are separated by the score (the MLE is infinite)"}
    a, b, _, converged = _platt_newton(x, y.astype(np.float64))
    if not converged or not (math.isfinite(a) and math.isfinite(b)):
        return {**base, "slope": None, "intercept": None,
                "undefined_reason": "not estimable: the fit did not converge (classes separable by score)"}
    return {**base, "slope": -a, "intercept": -b, "undefined_reason": None}
