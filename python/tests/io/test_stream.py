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

from mirage.io.stream import (async_chain, drain, exit_on_empty,
                              merge_stdout_stderr, quiet_match)
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


def test_quiet_match_with_items():

    async def _run():
        io = IOResult(exit_code=1)
        stream = quiet_match(_make_stream(b"a", b"b"), io)
        chunks = [chunk async for chunk in stream]
        assert chunks == []
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
        async for chunk in async_chain(a, b):
            chunks.append(chunk)
        assert b"".join(chunks) == b"hello world"

    asyncio.run(run())


def test_async_chain_with_none():

    async def run():
        a = None
        b = _make_stream(b"world")
        chunks = []
        async for chunk in async_chain(a, b):
            chunks.append(chunk)
        assert b"".join(chunks) == b"world"

    asyncio.run(run())


def test_async_chain_with_bytes():

    async def run():
        a = b"hello "
        b = b"world"
        chunks = []
        async for chunk in async_chain(a, b):
            chunks.append(chunk)
        assert b"".join(chunks) == b"hello world"

    asyncio.run(run())


def test_async_chain_empty():

    async def run():
        chunks = []
        async for chunk in async_chain(None, None):
            chunks.append(chunk)
        assert chunks == []

    asyncio.run(run())


def test_quiet_match_no_items():

    async def _run():
        io = IOResult(exit_code=1)
        stream = quiet_match(_make_stream(), io)
        chunks = [chunk async for chunk in stream]
        assert chunks == []
        assert io.exit_code == 1

    asyncio.run(_run())


def test_merge_stdout_stderr_emits_stderr_first():

    async def _run():
        io = IOResult(stderr=b"warn: bad\n")
        merged = merge_stdout_stderr(_make_stream(b"out1\n", b"out2\n"), io)
        chunks = [chunk async for chunk in merged]
        assert chunks[0] == b"warn: bad\n"
        assert chunks[1:] == [b"out1\n", b"out2\n"]

    asyncio.run(_run())


def test_merge_stdout_stderr_clears_io_stderr():
    """After merge, io.stderr is cleared so the pipeline accumulator
    does not double-emit it as pipeline stderr.
    """

    async def _run():
        io = IOResult(stderr=b"err\n")
        merged = merge_stdout_stderr(_make_stream(b"x"), io)
        async for _ in merged:
            pass
        assert io.stderr is None

    asyncio.run(_run())


def test_merge_stdout_stderr_streams_stdout_lazy():
    """Stdout chunks pass through one at a time, never materialized."""
    pulls = 0

    async def _lazy(n):
        nonlocal pulls
        for i in range(n):
            pulls += 1
            yield f"chunk{i}\n".encode()

    async def _run():
        io = IOResult(stderr=b"hi\n")
        merged = merge_stdout_stderr(_lazy(1000), io)
        seen = 0
        async for _ in merged:
            seen += 1
            if seen >= 5:
                break
        # 5 stdout chunks + 1 stderr blob = 6 yields; producer pulled
        # at most ~5 times, not 1000.
        assert pulls < 50, f"expected lazy pulls (~5), got {pulls}"

    asyncio.run(_run())


def test_merge_stdout_stderr_no_stderr():
    """No stderr → just streams stdout."""

    async def _run():
        io = IOResult()
        merged = merge_stdout_stderr(_make_stream(b"a", b"b"), io)
        chunks = [chunk async for chunk in merged]
        assert chunks == [b"a", b"b"]

    asyncio.run(_run())


def test_merge_stdout_stderr_bytes_stdout():
    """stdout as bytes (not iterator) still works."""

    async def _run():
        io = IOResult(stderr=b"e\n")
        merged = merge_stdout_stderr(b"out\n", io)
        chunks = [chunk async for chunk in merged]
        assert chunks == [b"e\n", b"out\n"]

    asyncio.run(_run())


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


def test_chain_cachables_live_pull_in_order():
    from mirage.io.cachable_iterator import CachableAsyncIterator
    from mirage.io.stream import chain_cachables

    async def _run():
        a = CachableAsyncIterator(_make_stream(b"a1", b"a2"))
        b = CachableAsyncIterator(_make_stream(b"b1"))
        chunks = [c async for c in chain_cachables(a, b)]
        assert chunks == [b"a1", b"a2", b"b1"]

    asyncio.run(_run())


def test_chain_cachables_replays_drained_iterator():
    from mirage.io.cachable_iterator import CachableAsyncIterator
    from mirage.io.stream import chain_cachables

    async def _run():
        a = CachableAsyncIterator(_make_stream(b"a1", b"a2"))
        b = CachableAsyncIterator(_make_stream(b"b1"))
        assert await a.drain() == b"a1a2"
        assert await b.drain() == b"b1"
        chunks = [c async for c in chain_cachables(a, b)]
        assert chunks == [b"a1", b"a2", b"b1"]

    asyncio.run(_run())


def test_chain_cachables_replays_partial_then_drained():
    from mirage.io.cachable_iterator import CachableAsyncIterator
    from mirage.io.stream import chain_cachables

    async def _run():
        a = CachableAsyncIterator(_make_stream(b"a1", b"a2", b"a3"))
        b = CachableAsyncIterator(_make_stream(b"b1"))
        chain = chain_cachables(a, b)
        assert await chain.__anext__() == b"a1"
        await a.drain()
        await b.drain()
        rest = [c async for c in chain]
        assert rest == [b"a2", b"a3", b"b1"]

    asyncio.run(_run())


def test_chain_cachables_early_stop_leaves_later_untouched():
    from mirage.io.cachable_iterator import CachableAsyncIterator
    from mirage.io.stream import chain_cachables

    async def _run():
        a = CachableAsyncIterator(_make_stream(b"a1", b"a2"))
        b = CachableAsyncIterator(_make_stream(b"b1"))
        chain = chain_cachables(a, b)
        assert await chain.__anext__() == b"a1"
        await chain.aclose()
        assert b.buffered_chunks == []
        assert not b.exhausted

    asyncio.run(_run())
