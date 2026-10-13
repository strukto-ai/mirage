import asyncio
import re
from unittest.mock import AsyncMock

import pytest

from mirage.concurrency.worker import Worker
from mirage.utils.regex import AsyncRegex


@pytest.mark.asyncio
async def test_buffered_subjects_go_ahead_on_the_invocation_worker(
    monkeypatch,
):
    worker = Worker()
    sends = AsyncMock(wraps=worker.send)
    monkeypatch.setattr(worker, "send", sends)
    try:
        for _ in range(2):
            pattern = AsyncRegex(re.compile("(x+)+"), worker=worker)
            await pattern.prepare("x", lambda: ["xx", "no match"])
            await pattern.prepare("xx")
            assert len(list(pattern.finditer("xx"))) == 1
            await pattern.prepare("no match")
            assert pattern.search("no match") is None
            await pattern.close()
        assert sends.call_count == 6
        assert (
            worker._process is not None and worker._process.returncode is None
        )
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_a_slow_subject_sent_ahead_does_not_hold_back_the_current_one():
    pattern = AsyncRegex(re.compile("ok|^(a+)+$"))
    try:
        async with asyncio.timeout(10):
            await pattern.prepare("ok", lambda: ["a" * 40 + "!"])
        assert pattern.search("ok") is not None
    finally:
        await pattern.close()


@pytest.mark.asyncio
async def test_answers_left_unread_never_reach_the_next_pattern():
    worker = Worker()
    try:
        first = AsyncRegex(re.compile("(x+)+"), worker=worker)
        await first.prepare("x", lambda: ["xx", "xxx"])
        await first.close()
        second = AsyncRegex(re.compile("(y+)+"), worker=worker)
        await second.prepare("y")
        assert len(list(second.finditer("y"))) == 1
        await second.close()
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_a_bounded_subject_is_searched_in_place():
    worker = Worker()
    pattern = AsyncRegex(re.compile("x"), worker=worker)
    try:
        await pattern.prepare("x", lambda: ["xx", "no match"])
        await pattern.prepare("xx")
        assert len(list(pattern.finditer("xx"))) == 2
        await pattern.prepare("no match")
        assert pattern.search("no match") is None
        assert worker._process is None
    finally:
        await pattern.close()
        await worker.close()


@pytest.mark.asyncio
async def test_only_a_subject_past_the_limit_starts_the_worker():
    worker = Worker()
    pattern = AsyncRegex(re.compile("x.*y"), worker=worker)
    long = "x" * 1000 + "y"
    try:
        await pattern.prepare("x y")
        assert worker._process is None
        await pattern.prepare(long)
        assert worker._process is not None
        match = pattern.search(long)
        assert match is not None and match.end() == len(long)
    finally:
        await pattern.close()
        await worker.close()
