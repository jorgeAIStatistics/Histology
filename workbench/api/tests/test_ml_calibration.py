"""Post-hoc calibration (design §6, §7): fitted on development scores only (test items refused),
Platt agrees with independent optimisers, isotonic agrees with scikit-learn and clips,
parameters are versioned, serialisable and tamper-evident."""

from __future__ import annotations

import json

import numpy as np
import pytest
from scipy.optimize import minimize

from dermpath.ml import calibration as CAL


def _dev(seed: int = 0, n: int = 300):
    rng = np.random.default_rng(seed)
    y = rng.integers(0, 2, n)
    s = np.clip(0.25 * y + 0.75 * rng.random(n), 0.0, 1.0)
    return y, s


# --------------------------------------------------------------------------- development only


def test_fit_refuses_any_item_marked_test():
    y, s = _dev()
    splits = ["val"] * len(y)
    splits[17] = "test"
    for method in ("platt", "isotonic", "none"):
        with pytest.raises(CAL.CalibrationOnTestRefused, match="1 item\\(s\\) are marked test"):
            CAL.fit_calibration(s, y, method=method, item_splits=splits)
    with pytest.raises(CAL.CalibrationOnTestRefused):
        CAL.fit_calibration(s, y, method="platt", item_splits=["TEST"] * len(y))


def test_fit_accepts_only_development_roles():
    y, s = _dev()
    with pytest.raises(CAL.CalibrationError, match="In-sample training scores"):
        CAL.fit_calibration(s, y, method="platt", item_splits=["train"] * len(y))
    with pytest.raises(CAL.CalibrationError, match="item_splits has"):
        CAL.fit_calibration(s, y, method="platt", item_splits=["val"])
    mixed = ["val"] * 150 + ["oof"] * 150
    p = CAL.fit_calibration(s, y, method="platt", item_splits=mixed)
    assert p["fitted_on"]["splits"] == ["oof", "val"] and p["fitted_on"]["n"] == 300


def test_fit_on_development_then_apply_to_test_never_uses_test_scores():
    y, s = _dev(1)
    test_y, test_s = _dev(2)
    p = CAL.fit_calibration(s, y, method="isotonic", item_splits=["val"] * len(y))
    again = CAL.fit_calibration(s, y, method="isotonic", item_splits=["val"] * len(y))
    assert p == again  # the fit is a function of the development data alone
    out = CAL.apply_calibration(p, test_s)
    assert out.shape == test_s.shape and ((out >= 0) & (out <= 1)).all()
    assert p["fitted_on"]["data_sha256"] == CAL.canonical_sha256(
        [[float(a), int(b)] for a, b in zip(s.tolist(), y.tolist())])


def test_minimum_evidence_per_class():
    y = np.array([1] * 3 + [0] * 50)
    s = np.linspace(0.01, 0.99, 53)
    with pytest.raises(CAL.CalibrationError, match="3 positive and 50 negative"):
        CAL.fit_calibration(s, y, method="platt", item_splits=["val"] * 53)
    CAL.fit_calibration(s, y, method="platt", item_splits=["val"] * 53, min_per_class=3)


# --------------------------------------------------------------------------- Platt


@pytest.mark.parametrize("seed", range(4))
def test_platt_matches_sklearn_and_a_generic_optimiser(seed):
    from sklearn.calibration import _sigmoid_calibration

    y, s = _dev(seed)
    p = CAL.fit_calibration(s, y, method="platt", item_splits=["val"] * len(y), score_input="score")
    assert p["params"]["converged"] is True
    a, b = _sigmoid_calibration(s, y)  # P = 1 / (1 + exp(a·f + b)), Platt targets
    assert p["params"]["slope"] == pytest.approx(-a, rel=1e-5)
    assert p["params"]["intercept"] == pytest.approx(-b, rel=1e-5)
    n_pos, n_neg = int(y.sum()), int(len(y) - y.sum())
    t = np.where(y == 1, (n_pos + 1) / (n_pos + 2), 1 / (n_neg + 2))
    r = minimize(lambda w: np.sum(np.logaddexp(0, w[0] * s + w[1])) - np.sum(t * (w[0] * s + w[1])), [0.0, 0.0],
                 method="BFGS", options={"gtol": 1e-10})
    assert [p["params"]["slope"], p["params"]["intercept"]] == pytest.approx(list(r.x), rel=1e-5)


def test_platt_on_logit_input_and_under_separation():
    y, s = _dev(5)
    p = CAL.fit_calibration(s, y, method="platt", item_splits=["oof"] * len(y))
    assert p["params"]["score_input"] == "logit" and "logit(clip(score" in p["params"]["formula"]
    out = CAL.apply_calibration(p, [0.0, 0.5, 1.0])
    assert np.all(np.diff(out) > 0) and np.isfinite(out).all()
    sep_y = np.array([0] * 20 + [1] * 20)
    sep_s = np.r_[np.linspace(0.0, 0.3, 20), np.linspace(0.7, 1.0, 20)]
    sep = CAL.fit_calibration(sep_s, sep_y, method="platt", item_splits=["val"] * 40)
    assert np.isfinite(sep["params"]["slope"]) and sep["params"]["converged"]  # Platt targets keep it finite
    assert CAL.apply_calibration(sep, [1.0])[0] < 1.0
    with pytest.raises(CAL.CalibrationError, match="needs scores in \\[0, 1\\]"):
        CAL.fit_calibration(s * 3, y, method="platt", item_splits=["val"] * len(y))


# --------------------------------------------------------------------------- isotonic


@pytest.mark.parametrize("seed", range(4))
def test_isotonic_matches_sklearn_with_clipping(seed):
    from sklearn.isotonic import IsotonicRegression

    y, s = _dev(seed, n=150)
    s = np.round(s, 2)  # ties in the fitting scores
    p = CAL.fit_calibration(s, y, method="isotonic", item_splits=["val"] * len(y))
    ref = IsotonicRegression(increasing=True, y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(s, y)
    probe = np.r_[-0.5, 0.0, np.random.default_rng(seed).random(200), 1.0, 1.7]
    assert CAL.apply_calibration(p, np.clip(probe, 0, 1)) == pytest.approx(ref.predict(np.clip(probe, 0, 1)),
                                                                           abs=1e-12)
    out = CAL.apply_calibration(p, probe)  # out of the fitted range → boundary values
    assert out[0] == pytest.approx(p["params"]["y"][0]) and out[-1] == pytest.approx(p["params"]["y"][-1])
    assert (np.diff(CAL.apply_calibration(p, np.sort(probe))) >= -1e-15).all()
    assert ((out >= 0) & (out <= 1)).all()


# --------------------------------------------------------------------------- serialisation and versioning


def test_params_are_json_versioned_and_tamper_evident():
    y, s = _dev(6)
    for method in ("platt", "isotonic", "none"):
        p = CAL.fit_calibration(s, y, method=method, item_splits=["val"] * len(y))
        assert p["schema"] == CAL.CALIBRATION_SCHEMA and p["research_use_only"] is True
        round_trip = json.loads(json.dumps(p, allow_nan=False))
        assert np.array_equal(CAL.apply_calibration(round_trip, s), CAL.apply_calibration(p, s))
        assert p["params_sha256"] == CAL.calibration_sha256(p)
    p = CAL.fit_calibration(s, y, method="platt", item_splits=["val"] * len(y))
    tampered = {**p, "params": {**p["params"], "slope": p["params"]["slope"] * 2}}
    with pytest.raises(CAL.CalibrationError, match="modified after fitting"):
        CAL.apply_calibration(tampered, s)
    with pytest.raises(CAL.CalibrationError, match="unknown calibration schema"):
        CAL.apply_calibration({**p, "schema": "dermpath.calibration/0"}, s)
    with pytest.raises(CAL.CalibrationError, match="unknown calibration method"):
        CAL.fit_calibration(s, y, method="beta", item_splits=["val"] * len(y))
    assert np.array_equal(CAL.apply_calibration(CAL.identity_calibration(), s), s)


# --------------------------------------------------------------------------- reporting: calibration slope


def test_logistic_recalibration_slope_and_intercept():
    rng = np.random.default_rng(0)
    s = rng.uniform(0.02, 0.98, 20000)
    y = (rng.random(20000) < s).astype(int)  # calibrated by construction
    ok = CAL.logistic_recalibration(y, s)
    assert ok["slope"] == pytest.approx(1.0, abs=0.08) and ok["intercept"] == pytest.approx(0.0, abs=0.08)
    sharp = 1 / (1 + np.exp(-3 * np.log(s / (1 - s))))  # over-confident scores → slope ≈ 1/3
    assert CAL.logistic_recalibration(y, sharp)["slope"] == pytest.approx(1 / 3, abs=0.05)
    sep = CAL.logistic_recalibration([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9])
    assert sep["slope"] is None and "separated" in sep["undefined_reason"]
    one = CAL.logistic_recalibration([1, 1], [0.1, 0.9])
    assert one["slope"] is None and "both classes" in one["undefined_reason"]
