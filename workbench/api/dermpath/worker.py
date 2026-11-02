"""Worker process entry point: ``python -m dermpath.worker``.

Options:
  --once            process jobs until the queue is idle, then exit
  --poll SECONDS    idle poll interval (default WB_WORKER_POLL_SECONDS or 1.0)
  --worker-id ID    stable worker id (default: host-pid-random)
  --types a,b       only claim these job types

SIGTERM/SIGINT stop the loop after the current job. A worker killed mid-job leaves the
job 'running' with a lease; when the lease expires another worker reclaims it.
"""

from __future__ import annotations

import argparse
import logging
import signal
import threading

from .config import get_settings
from .db import init_db
from .jobs.registry import load_handlers
from .jobs.worker import Worker


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m dermpath.worker")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll", type=float, default=None)
    parser.add_argument("--worker-id", default=None)
    parser.add_argument("--types", default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if not settings.mode_supported:
        logging.error("WB_MODE=%s is not implemented; the worker refuses to start (fail closed)", settings.mode)
        return 2
    init_db()
    report = load_handlers()
    logging.info("handler modules: %s", report)
    worker = Worker(args.worker_id, types=args.types.split(",") if args.types else None)
    if args.once:
        outcomes = worker.run_until_idle()
        for o in outcomes:
            logging.info("job %s %s -> %s %s", o.job_id, o.type, o.status, o.error or "")
        return 0
    stop = threading.Event()

    def _stop(signum, _frame):
        logging.info("signal %s: stopping after the current job", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    worker.run_forever(stop, poll_seconds=args.poll)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
