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
import time
from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.utils.limit import (
    guard_output,
    maybe_with_timeout,
    run_with_timeout,
    with_timeout,
)
from mirage.errors.types import CommandTimeoutError
from mirage.io.types import materialize
from mirage.types import Limit, OnExceed
from tests.fixtures.held_loop import HeldLoop, run_on_held_loop

_TEN = b"".join(f"line{i}\n".encode() for i in range(10))


async def _stream(data: bytes) -> AsyncIterator[bytes]:
    for i in range(0, len(data), 7):
        yield data[i : i + 7]


async def _slow_stream() -> AsyncIterator[bytes]:
    await asyncio.sleep(5)
    yield b"x"


async def _const(value):
    return value


async def _sleep_forever():
    await asyncio.sleep(5)


@pytest.mark.asyncio
async def test_no_limit_passthrough():
    out, err, code = await guard_output(_TEN, None, 0, None)
    assert out == _TEN and code == 0 and err is None


@pytest.mark.asyncio
async def test_under_limit_not_truncated():
    sg = Limit(max_lines=100)
    out, err, _ = await guard_output(_TEN, None, 0, sg)
    assert out == _TEN and err is None


@pytest.mark.asyncio
async def test_truncate_by_lines():
    sg = Limit(max_lines=3)
    out, err, code = await guard_output(_TEN, None, 0, sg)
    assert out == b"line0\nline1\nline2\n"
    assert code == 0
    assert b"truncated" in (await materialize(err))


@pytest.mark.asyncio
async def test_error_by_lines_prints_nothing_and_exits_1():
    sg = Limit(max_lines=3, on_exceed=OnExceed.ERROR)
    out, err, code = await guard_output(_TEN, None, 0, sg)
    assert out == b""
    assert code == 1
    assert b"truncated" in (await materialize(err))


@pytest.mark.asyncio
async def test_truncate_by_bytes():
    sg = Limit(max_bytes=10)
    out, err, _ = await guard_output(_TEN, None, 0, sg)
    assert out == _TEN[:10]
    assert b"truncated" in (await materialize(err))


@pytest.mark.asyncio
async def test_streaming_input_truncates_and_stops_early():
    sg = Limit(max_lines=2)
    out, err, _ = await guard_output(_stream(_TEN), None, 0, sg)
    assert out == b"line0\nline1\n"
    assert b"truncated" in (await materialize(err))


def test_maybe_with_timeout_passthrough_when_no_limit():
    stream = _stream(_TEN)
    assert maybe_with_timeout(stream, None, "cat") is stream


def test_maybe_with_timeout_passthrough_when_bytes():
    assert maybe_with_timeout(_TEN, Limit(timeout_seconds=1), "cat") == _TEN


def test_maybe_with_timeout_passthrough_when_no_timeout():
    stream = _stream(_TEN)
    assert maybe_with_timeout(stream, Limit(max_lines=3), "cat") is stream


def test_maybe_with_timeout_passthrough_when_nonpositive():
    stream = _stream(_TEN)
    assert (
        maybe_with_timeout(stream, Limit(timeout_seconds=0), "cat") is stream
    )


@pytest.mark.asyncio
async def test_maybe_with_timeout_wraps_and_fires():
    wrapped = maybe_with_timeout(
        _slow_stream(), Limit(timeout_seconds=0.1), "cat"
    )
    with pytest.raises(CommandTimeoutError):
        await materialize(wrapped)


@pytest.mark.asyncio
async def test_run_with_timeout_returns_result_when_under_budget():
    assert await run_with_timeout(_const(42), 1.0, "sleep") == 42


@pytest.mark.asyncio
async def test_run_with_timeout_no_timeout_when_seconds_falsy():
    assert await run_with_timeout(_const(7), None, "sleep") == 7


@pytest.mark.asyncio
async def test_run_with_timeout_raises_on_overrun():
    with pytest.raises(CommandTimeoutError):
        await run_with_timeout(_sleep_forever(), 0.1, "sleep")


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk_size", [1, 2, 20])
@pytest.mark.parametrize(
    "data,limit,expected,truncated",
    [
        (b"a\nb\n", Limit(max_lines=2), b"a\nb\n", False),
        (b"a\nb\nc\nd\n", Limit(max_lines=2, max_bytes=7), b"a\nb\n", True),
        (b"abc", Limit(max_lines=0), b"", True),
        (b"abc", Limit(max_bytes=0), b"", True),
        (b"abc", Limit(max_bytes=3), b"abc", False),
        (b"a\nb", Limit(max_lines=1), b"a\n", True),
    ],
)
async def test_bounds_are_independent_of_chunks(
    chunk_size, data, limit, expected, truncated
):
    async def source():
        for at in range(0, len(data), chunk_size):
            yield data[at : at + chunk_size]

    result, err, _ = await guard_output(source(), None, 0, limit)
    assert result == expected
    assert (b"truncated" in await materialize(err)) is truncated


@pytest.mark.asyncio
async def test_limit_closes_its_source_when_output_is_cut():
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"a\nb\nc\n"
            pytest.fail("a capped reader must not request another chunk")
        finally:
            closed = True

    result, _, _ = await guard_output(source(), None, 0, Limit(max_lines=1))
    assert result == b"a\n"
    assert closed


@pytest.mark.asyncio
@pytest.mark.parametrize("pending_pull", [False, True])
async def test_timeout_wrapper_retains_owned_producer_close(pending_pull):
    closed = asyncio.Event()

    class Source:
        def __init__(self):
            self.sent = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self.sent:
                self.sent = True
                return b"prefix"
            await asyncio.Event().wait()

        async def aclose(self):
            closed.set()

    wrapped = maybe_with_timeout(Source(), Limit(timeout_seconds=30), "writer")
    pending = None
    if pending_pull:
        assert await anext(wrapped) == b"prefix"
        pending = asyncio.create_task(anext(wrapped))
        await asyncio.sleep(0)
    await asyncio.wait_for(wrapped.aclose(), 1)
    if pending is not None:
        await asyncio.gather(pending, return_exceptions=True)
    assert closed.is_set()


async def _connection_timeout():
    raise TimeoutError("connect failed")


@pytest.mark.asyncio
async def test_an_inner_timeout_keeps_its_own_reason():
    with pytest.raises(TimeoutError, match="connect failed"):
        await run_with_timeout(_connection_timeout(), 1, "ssh")


@pytest.mark.asyncio
async def test_run_with_timeout_cancels_the_call_it_gives_up_on():
    closed = asyncio.Event()

    async def follow():
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()

    with pytest.raises(CommandTimeoutError):
        await run_with_timeout(follow(), 0.05, "follow")
    assert closed.is_set()


async def _slow_chunks(pause: float) -> AsyncIterator[bytes]:
    yield b"a"
    time.sleep(pause)
    yield b"b"


async def _drain_slow(loop: HeldLoop) -> list[bytes]:
    return [
        chunk async for chunk in with_timeout(_slow_chunks(0.05), 0.01, "cat")
    ]


def test_with_timeout_spends_the_loop_clock_not_real_time():
    # A loop that keeps virtual time spends none while a source
    # computes, so a deadline on it must not fire on real time.
    assert run_on_held_loop(_drain_slow) == [b"a", b"b"]
