# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio

from mirage.io.cachable_iterator import CachableAsyncIterator


async def _async_source_two_chunks():
    yield b"aaa"
    yield b"bbb"


async def _async_source_three_chunks():
    yield b"aaa"
    yield b"bbb"
    yield b"ccc"


async def _run_yields_chunks():
    ci = CachableAsyncIterator(_async_source_two_chunks())
    chunks = []
    async for chunk in ci:
        chunks.append(chunk)
    assert chunks == [b"aaa", b"bbb"]


async def _run_drain_after_partial():
    ci = CachableAsyncIterator(_async_source_three_chunks())
    chunk = await ci.__anext__()
    assert chunk == b"aaa"
    result = await ci.drain()
    assert result == b"aaabbbccc"


async def _run_drain_without_iteration():
    ci = CachableAsyncIterator(_async_source_two_chunks())
    assert await ci.drain() == b"aaabbb"


def test_cachable_async_iterator_yields_chunks():
    asyncio.run(_run_yields_chunks())


def test_cachable_async_iterator_drain_after_partial():
    asyncio.run(_run_drain_after_partial())


def test_cachable_async_iterator_drain_without_iteration():
    asyncio.run(_run_drain_without_iteration())


async def _run_exhausted_false_before_full_consumption():
    ci = CachableAsyncIterator(_async_source_two_chunks())
    assert ci.exhausted is False
    await ci.__anext__()
    assert ci.exhausted is False


async def _run_exhausted_true_after_full_iteration():
    ci = CachableAsyncIterator(_async_source_two_chunks())
    async for _ in ci:
        pass
    assert ci.exhausted is True


async def _run_exhausted_true_after_drain():
    ci = CachableAsyncIterator(_async_source_two_chunks())
    await ci.__anext__()
    await ci.drain()
    assert ci.exhausted is True


async def _run_drain_includes_already_consumed():
    ci = CachableAsyncIterator(_async_source_three_chunks())
    await ci.__anext__()
    await ci.__anext__()
    result = await ci.drain()
    assert result == b"aaabbbccc"


async def _slow_source():
    yield b"aaa"
    await asyncio.sleep(0.05)
    yield b"bbb"
    await asyncio.sleep(0.05)
    yield b"ccc"


def test_cachable_async_iterator_exhausted_false_before_full():
    asyncio.run(_run_exhausted_false_before_full_consumption())


def test_cachable_async_iterator_exhausted_true_after_iteration():
    asyncio.run(_run_exhausted_true_after_full_iteration())


def test_cachable_async_iterator_exhausted_true_after_drain():
    asyncio.run(_run_exhausted_true_after_drain())


def test_cachable_async_iterator_drain_includes_already_consumed():
    asyncio.run(_run_drain_includes_already_consumed())


async def _failing_source():
    yield b"aaa"
    raise RuntimeError("source failed")


async def _closable_source(events: list[str]):
    try:
        yield b"x" * 100
        yield b"y" * 100
        yield b"z" * 100
    finally:
        events.append("closed")


async def _tracked_source(events: list[str]):
    try:
        events.append("first")
        yield b"x" * 100
        events.append("second")
        yield b"y" * 100
    finally:
        events.append("closed")


async def _run_drain_bounded_closes_source_on_exceed():
    events: list[str] = []
    ci = CachableAsyncIterator(_closable_source(events))
    data = await ci.drain_bounded(150)
    assert data is None
    assert ci.buffered_chunks == []
    assert events == ["closed"]


async def _run_drain_bounded_checks_existing_buffer():
    events: list[str] = []
    ci = CachableAsyncIterator(_tracked_source(events))
    assert await ci.__anext__() == b"x" * 100
    data = await ci.drain_bounded(50)
    assert data is None
    assert ci.buffered_chunks == []
    assert events == ["first", "closed"]


async def _run_drain_bounded_within_budget_drains_fully():
    events: list[str] = []
    ci = CachableAsyncIterator(_closable_source(events))
    data = await ci.drain_bounded(1000)
    assert data == b"x" * 100 + b"y" * 100 + b"z" * 100


def test_cachable_async_iterator_drain_bounded_closes_source_on_exceed():
    asyncio.run(_run_drain_bounded_closes_source_on_exceed())


def test_cachable_async_iterator_drain_bounded_checks_existing_buffer():
    asyncio.run(_run_drain_bounded_checks_existing_buffer())


def test_cachable_async_iterator_drain_bounded_within_budget():
    asyncio.run(_run_drain_bounded_within_budget_drains_fully())
