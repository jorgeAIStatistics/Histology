"""Benchmark harness and learning curves (design §6).

STUB. Phase 3 fills this module. Planned contents (``docs/ml-engine-design.md`` §6):

* ``run_benchmark(config) -> dict``: an encoder × head grid on **one** frozen manifest and
  identical patient splits; one feature set per encoder with the same patch and sampling
  policy; equal, documented optimisation budgets per head; results grouped in a
  ``comparison_family`` (shared paired-bootstrap seed); encoder effects compared with the
  head fixed and head effects with the encoder fixed, using the paired comparisons of
  :mod:`dermpath.ml.comparison`. Selection uses validation or out-of-fold results only.
* ``learning_curve(...)``: nested, stratified, deterministic subsets of **train patients**
  (e.g. 0.1, 0.25, 0.5, 1.0, several repeats), evaluated on validation or OOF (never test),
  reported with patient counts and confidence intervals.
* Configurations are JSON files under ``workbench/experiments/configs/``; the command line
  is :mod:`dermpath.ml.cli`.
"""

from __future__ import annotations
