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
from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.utils.safeguard import (CommandTimeoutError,
                                                     apply_safeguard,
                                                     maybe_with_timeout,
                                                     run_with_timeout)
from mirage.commands.safeguard import CommandSafeguard
from mirage.io.types import materialize
from mirage.types import OnExceed

_TEN = b"".join(f"line{i}\n".encode() for i in range(10))


async def _stream(data: bytes) -> AsyncIterator[bytes]:
    for i in range(0, len(data), 7):
        yield data[i:i + 7]


async def _slow_stream() -> AsyncIterator[bytes]:
    await asyncio.sleep(5)
    yield b"x"


async def _const(value):
    return value


async def _sleep_forever():
    await asyncio.sleep(5)


@pytest.mark.asyncio
async def test_no_safeguard_passthrough():
    out, io = await apply_safeguard(_TEN, None)
    assert out == _TEN and io.exit_code == 0 and io.stderr is None


@pytest.mark.asyncio
async def test_under_limit_not_truncated():
    sg = CommandSafeguard(max_lines=100)
    out, io = await apply_safeguard(_TEN, sg)
    assert out == _TEN and io.stderr is None


@pytest.mark.asyncio
async def test_truncate_by_lines():
    sg = CommandSafeguard(max_lines=3)
    out, io = await apply_safeguard(_TEN, sg)
    assert out == b"line0\nline1\nline2\n"
    assert io.exit_code == 0
    assert b"truncated" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_error_by_lines():
    sg = CommandSafeguard(max_lines=3, on_exceed=OnExceed.ERROR)
    out, io = await apply_safeguard(_TEN, sg)
    assert out is None
    assert io.exit_code == 1
    assert b"truncated" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_truncate_by_bytes():
    sg = CommandSafeguard(max_bytes=10)
    out, io = await apply_safeguard(_TEN, sg)
    assert out == _TEN[:10]
    assert b"truncated" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_streaming_input_truncates_and_stops_early():
    sg = CommandSafeguard(max_lines=2)
    out, io = await apply_safeguard(_stream(_TEN), sg)
    assert out == b"line0\nline1\n"
    assert b"truncated" in (await materialize(io.stderr))


def test_maybe_with_timeout_passthrough_when_no_safeguard():
    stream = _stream(_TEN)
    assert maybe_with_timeout(stream, None, "cat") is stream


def test_maybe_with_timeout_passthrough_when_bytes():
    assert maybe_with_timeout(_TEN, CommandSafeguard(timeout_seconds=1),
                              "cat") == _TEN


def test_maybe_with_timeout_passthrough_when_no_timeout():
    stream = _stream(_TEN)
    assert maybe_with_timeout(stream, CommandSafeguard(max_lines=3),
                              "cat") is stream


def test_maybe_with_timeout_passthrough_when_nonpositive():
    stream = _stream(_TEN)
    assert maybe_with_timeout(stream, CommandSafeguard(timeout_seconds=0),
                              "cat") is stream


@pytest.mark.asyncio
async def test_maybe_with_timeout_wraps_and_fires():
    wrapped = maybe_with_timeout(_slow_stream(),
                                 CommandSafeguard(timeout_seconds=0.1), "cat")
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
