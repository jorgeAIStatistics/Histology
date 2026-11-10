"""Statistics for the dataset audit (design §9): contingency tables and association measures. Pure functions.

Association is reported as Cramér's V (descriptive; 0 = no association, 1 = complete) with a two-sided Fisher
exact test for 2 × 2 tables and a χ² test (no continuity correction) otherwise. Tests count PATIENTS, one
observation each, because slides of one patient are not independent; slide tables are descriptive only. A p-value
is never a verdict on confounding: a small cohort can hide strong confounding and a large one can flag a trivial
association. Undefined statistics are ``None`` with a reason, never NaN.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping

UNIT_NOTE = ("Tests count patients (one observation each); slides of one patient are not independent, so slide "
             "tables are descriptive only. Cramér's V is descriptive; p-values are not a verdict on confounding.")


def contingency(pairs: Iterable[tuple[str, str]]) -> dict[str, dict[str, int]]:
    """``[(row, col), ...]`` → ``{row: {col: count}}`` with sorted keys."""
    t: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r, c in pairs:
        t[r][c] += 1
    return {r: dict(sorted(cs.items())) for r, cs in sorted(t.items())}


def association(table: Mapping[str, Mapping[str, int]]) -> dict:
    """Cramér's V and an independence test for a ``{row: {col: count}}`` table (empty margins dropped)."""
    rows = sorted(r for r, cs in table.items() if sum(cs.values()) > 0)
    cols = sorted({c for r in rows for c, n in table[r].items() if n > 0})
    n = sum(table[r].get(c, 0) for r in rows for c in cols)
    out: dict = {"n": n, "rows": len(rows), "cols": len(cols)}
    if len(rows) < 2 or len(cols) < 2:
        return {**out, "cramers_v": None, "test": None, "p_value": None,
                "undefined_reason": "fewer than two observed levels in a margin"}
    import numpy as np
    from scipy.stats import chi2_contingency, fisher_exact

    mat = np.array([[table[r].get(c, 0) for c in cols] for r in rows], dtype=float)
    chi2, p_chi2, dof, expected = chi2_contingency(mat, correction=False)
    v = math.sqrt(chi2 / (n * (min(len(rows), len(cols)) - 1))) if n else None
    if mat.shape == (2, 2):
        _, p = fisher_exact(mat.astype(int), alternative="two-sided")
        test = "fisher_exact (two-sided)"
    else:
        p, test = p_chi2, "chi_square (no continuity correction)"
    return {**out, "cramers_v": round(float(v), 4) if v is not None else None, "test": test,
            "p_value": round(float(p), 6), "dof": int(dof), "min_expected": round(float(expected.min()), 3),
            "low_expected_counts": bool((expected < 5).any()), "undefined_reason": None}


def patient_attribute(values: Iterable[str | None]) -> str:
    """One value per patient: the single observed value, ``multiple`` or ``unknown``."""
    seen = {v for v in values if v}
    return seen.pop() if len(seen) == 1 else ("multiple" if seen else "unknown")
