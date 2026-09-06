import asyncio

import pytest

from mirage.commands.builtin.generic.wc import wc
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.errors import CommandTimeoutError
from mirage.io.async_line_iterator import AsyncLineIterator


@pytest.mark.asyncio
async def test_wc_timeout_closes_producer():
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"line\n" * 200_000
        finally:
            closed = True

    with pytest.raises(CommandTimeoutError):
        await run_with_timeout(wc(source()), .001, "wc")
    assert closed


@pytest.mark.asyncio
async def test_readline_allows_timer_progress():
    fired = False

    def tick():
        nonlocal fired
        fired = True

    async def source():
        yield b"line\n" * 100_000

    timer = asyncio.get_running_loop().call_later(.001, tick)
    reader = AsyncLineIterator(source())
    try:
        for _ in range(100_000):
            assert await reader.readline() == b"line"
        assert fired
    finally:
        timer.cancel()


@pytest.mark.asyncio
async def test_caller_cancel_joins_producer():
    from mirage.workspace.abort import MirageAbortError, run_cancellable

    closed = False
    cancel = asyncio.Event()

    async def source():
        nonlocal closed
        try:
            yield b"line\n" * 200_000
        finally:
            closed = True

    timer = asyncio.get_running_loop().call_later(.001, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await run_cancellable(wc(source()), cancel)
        assert closed
    finally:
        timer.cancel()


@pytest.mark.asyncio
async def test_long_line_preserves_delimiter_and_tail():

    async def source():
        yield b"x" * 100_000 + b"\nlast"

    reader = AsyncLineIterator(source())
    assert await reader.readline() == b"x" * 100_000
    assert await reader.readline() == b"last"
    assert await reader.readline() is None


@pytest.mark.asyncio
async def test_wc_keeps_utf8_and_word_state_across_chunks():
    counts = await wc(("a" * 16_383 + "é x\n").encode())
    assert (counts.lines, counts.words, counts.bytes_, counts.chars,
            counts.max_line_length) == (1, 2, 16_388, 16_387, 16_386)


@pytest.mark.asyncio
async def test_delimiter_spanning_chunk_boundary():
    from mirage.io.async_line_iterator import AsyncLineIterator

    async def source():
        yield b"abc\r"
        yield b"\ndef"

    reader = AsyncLineIterator(source())
    assert await reader.read_until(b"\r\n") == (b"abc", True)
    assert await reader.readline() == b"def"


@pytest.mark.asyncio
async def test_cancelled_read_chars_closes_source():
    from mirage.io.async_line_iterator import AsyncLineIterator
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"x" * 1_000_000
        finally:
            closed = True

    reader = AsyncLineIterator(source())
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(reader.read_chars(1_000_000, None), 0.001)
    assert closed
