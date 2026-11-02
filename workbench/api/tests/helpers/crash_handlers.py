"""Test-only job handlers, loaded through WB_EXTRA_HANDLER_MODULES / direct import."""

from __future__ import annotations

import time

from dermpath.jobs.registry import register


@register("test_sleep", description="test: long first attempt so a test can kill the worker")
def test_sleep(ctx, payload):
    if ctx.attempt == 1:
        end = time.time() + float(payload.get("seconds", 30))
        while time.time() < end:
            time.sleep(0.05)
    return {"attempt": ctx.attempt, "finished": True}


@register("test_flaky", description="test: fails on early attempts, then succeeds")
def test_flaky(ctx, payload):
    if ctx.attempt < int(payload.get("succeed_on", 2)):
        raise RuntimeError(f"transient failure on attempt {ctx.attempt}")
    return {"attempt": ctx.attempt}


@register("test_cooperative", description="test: reports progress until canceled")
def test_cooperative(ctx, payload):
    for i in range(int(payload.get("steps", 1000))):
        ctx.progress(i / 1000, f"step {i}")
        time.sleep(0.01)
    return {"done": True}
