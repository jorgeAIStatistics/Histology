"""Command line for benchmarks: ``python -m dermpath.ml.cli`` (design §6).

STUB. Phase 3 adds subcommands that run :func:`dermpath.ml.benchmark.run_benchmark` and
learning curves from JSON configurations under ``workbench/experiments/configs/``. Research
use only.
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    print("dermpath.ml.cli: no commands are implemented yet (research use only).", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
