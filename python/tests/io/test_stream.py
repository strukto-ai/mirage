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

import pytest

from mirage.io.async_line_iterator import SharedInput
from mirage.io.stream import (
    SharedStdin,
    async_chain,
    close_quietly,
    discard_streams,
    drain,
    ensure_stream,
    exit_on_empty,
)
from mirage.io.types import IOResult


async def _make_stream(*items):
    for item in items:
        yield item


def test_exit_on_empty_with_items():
    async def _run():
        io = IOResult()
        stream = exit_on_empty(_make_stream(b"a", b"b"), io)
        chunks = [chunk async for chunk in stream]
        assert chunks == [b"a", b"b"]
        assert io.exit_code == 0

    asyncio.run(_run())


def test_exit_on_empty_no_items():
    async def _run():
        io = IOResult()
        stream = exit_on_empty(_make_stream(), io)
        chunks = [chunk async for chunk in stream]
        assert chunks == []
        assert io.exit_code == 1

    asyncio.run(_run())


def test_exit_on_empty_single_item():
    async def _run():
        io = IOResult()
        stream = exit_on_empty(_make_stream(b"only"), io)
        chunks = [chunk async for chunk in stream]
        assert chunks == [b"only"]
        assert io.exit_code == 0

    asyncio.run(_run())


def test_drain_consumes_without_accumulating():
    async def run():
        stream = _make_stream(b"hello", b"world")
        await drain(stream)

    asyncio.run(run())


def test_drain_none():
    async def run():
        await drain(None)

    asyncio.run(run())


def test_drain_bytes():
    async def run():
        await drain(b"hello")

    asyncio.run(run())


def test_async_chain_two_streams():
    async def run():
        a = _make_stream(b"hello ")
        b = _make_stream(b"world")
        chunks = []
        async for chunk in async_chain([a, b]):
            chunks.append(chunk)
        assert b"".join(chunks) == b"hello world"

    asyncio.run(run())


def test_async_chain_with_none():
    async def run():
        a = None
        b = _make_stream(b"world")
        chunks = []
        async for chunk in async_chain([a, b]):
            chunks.append(chunk)
        assert b"".join(chunks) == b"world"

    asyncio.run(run())


def test_async_chain_with_bytes():
    async def run():
        a = b"hello "
        b = b"world"
        chunks = []
        async for chunk in async_chain([a, b]):
            chunks.append(chunk)
        assert b"".join(chunks) == b"hello world"

    asyncio.run(run())


def test_async_chain_closes_the_stream_it_leaves():
    closed: list[str] = []

    async def producer():
        try:
            yield b"a"
            yield b"b"
        finally:
            closed.append("done")

    async def run():
        chain = async_chain([producer()])
        assert await anext(chain) == b"a"
        await chain.aclose()
        assert closed == ["done"]

    asyncio.run(run())


def test_async_chain_empty():
    async def run():
        chunks = []
        async for chunk in async_chain([None, None]):
            chunks.append(chunk)
        assert chunks == []

    asyncio.run(run())


def test_close_quietly_fires_finally():
    """Explicit aclose runs the producer's finally promptly."""
    from mirage.io.stream import close_quietly

    closed = []

    async def producer():
        try:
            for i in range(100):
                yield f"chunk{i}\n".encode()
        finally:
            closed.append("done")

    async def _run():
        p = producer()
        async for _ in p:
            break
        assert closed == [], "finally fires only on close"
        await close_quietly(p)
        assert closed == ["done"], "finally fires after explicit close"

    asyncio.run(_run())


def test_close_quietly_safe_on_bytes_and_none():
    """close_quietly is harmless on non-iterator inputs."""
    from mirage.io.stream import close_quietly

    async def _run():
        await close_quietly(None)
        await close_quietly(b"some bytes")

    asyncio.run(_run())


def test_close_quietly_swallows_exceptions():
    """A broken aclose impl shouldn't propagate."""
    from mirage.io.stream import close_quietly

    class Bad:
        async def aclose(self):
            raise RuntimeError("boom")

    async def _run():
        await close_quietly(Bad())  # should not raise

    asyncio.run(_run())


@pytest.mark.asyncio
async def test_a_shared_input_outlives_a_close_and_not_a_discard():
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"a\n"
            yield b"b\n"
            yield b"c\n"
        finally:
            closed = True

    shared = SharedInput(source())
    assert await shared.lines.readline() == b"a"
    await close_quietly(shared)
    assert await shared.lines.readline() == b"b"
    await discard_streams(shared)
    assert closed
    assert await shared.lines.readline() is None


@pytest.mark.asyncio
async def test_shared_stdin_preserves_unread_bytes_and_serializes_readers():
    pulls = []

    async def source():
        for chunk in [b"", b"abc", b"", b"def"]:
            await asyncio.sleep(0)
            pulls.append(chunk)
            yield chunk

    shared = SharedStdin(source())
    assert not pulls
    first = aiter(shared)
    assert await anext(first) == b"a"
    second = aiter(shared)
    results = await asyncio.gather(*(anext(second) for _ in range(5)))
    assert b"".join(results) == b"bcdef"
    with pytest.raises(StopAsyncIteration):
        await anext(first)
    with pytest.raises(StopAsyncIteration):
        await anext(second)
    assert pulls == [b"", b"abc", b"", b"def"]


@pytest.mark.asyncio
async def test_ensure_stream_wraps_bytes_and_passes_a_stream_through():
    assert [c async for c in ensure_stream(b"hello")] == [b"hello"]
    source = _make_stream(b"foo", b"bar")
    assert ensure_stream(source) is source
