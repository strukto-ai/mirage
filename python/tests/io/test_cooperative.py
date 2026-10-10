import asyncio

import pytest

from mirage.commands.builtin.generic.wc import wc
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.errors.types import CommandTimeoutError
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
        await run_with_timeout(wc(source()), 0.001, "wc")
    assert closed


@pytest.mark.asyncio
async def test_readline_allows_timer_progress():
    fired = False

    def tick():
        nonlocal fired
        fired = True

    async def source():
        yield b"line\n" * 100_000

    timer = asyncio.get_running_loop().call_later(0.001, tick)
    reader = AsyncLineIterator(source())
    try:
        for _ in range(100_000):
            assert await reader.readline() == b"line"
        assert fired
    finally:
        timer.cancel()


@pytest.mark.asyncio
async def test_empty_chunks_allow_timer_progress():
    from mirage.io.cooperative import chunks

    fired = asyncio.Event()
    produced = 0

    async def source():
        nonlocal produced
        while produced < 200_000 and not fired.is_set():
            produced += 1
            yield b""
        yield b"late"

    timer = asyncio.get_running_loop().call_later(0.001, fired.set)
    try:
        assert [c async for c in chunks(source())] == [b"late"]
        # Without a yield per pull the loop never suspends, the
        # timer never runs, and every empty chunk is produced.
        assert produced < 200_000
    finally:
        timer.cancel()


@pytest.mark.asyncio
async def test_caller_cancel_joins_producer():
    from mirage.utils.abort import MirageAbortError, run_cancellable

    closed = False
    cancel = asyncio.Event()

    async def source():
        nonlocal closed
        try:
            yield b"line\n" * 200_000
        finally:
            closed = True

    timer = asyncio.get_running_loop().call_later(0.001, cancel.set)
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
    assert (
        counts.lines,
        counts.words,
        counts.bytes_,
        counts.chars,
        counts.max_line_length,
    ) == (1, 2, 16_388, 16_387, 16_386)


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


@pytest.mark.asyncio
async def test_aborted_execution_records_failure():
    from mirage import Workspace
    from mirage.utils.abort import MirageAbortError
    from mirage.vfs.ram import RAMVFS

    ws = Workspace({"/data": RAMVFS()})
    cancel = asyncio.Event()

    async def source():
        asyncio.get_running_loop().call_later(0.001, cancel.set)
        yield b"line\n" * 500_000
        # Keep the command unfinished even if the fast scan beats the timer.
        await asyncio.Event().wait()

    try:
        await ws.shell("false")
        session = ws.get_session(ws.default_session_id)
        assert session.last_exit_code == 1
        with pytest.raises(MirageAbortError):
            await ws.shell("wc -l", stdin=source(), cancel=cancel)
        events = await ws.observer.command_events()
        assert len(events) == 2
        assert events[-1]["exit_code"] == 130
        assert session.last_exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cancel_during_cache_fill_aborts():
    from mirage import Workspace
    from mirage.utils.abort import MirageAbortError
    from mirage.vfs.ram import RAMVFS

    ws = Workspace({"/data": RAMVFS()})
    cancel = asyncio.Event()

    real_keep_versions = ws._dispatcher.keep_versions
    stall = False

    async def slow_keep_versions(records, cache_facts, nested=False):
        if not stall:
            await real_keep_versions(records, cache_facts, nested)
            return
        cancel.set()
        await asyncio.Event().wait()

    ws._dispatcher.keep_versions = slow_keep_versions
    try:
        await ws.shell("false")
        stall = True
        session = ws.get_session(ws.default_session_id)
        with pytest.raises(MirageAbortError):
            await ws.shell("echo hi", cancel=cancel)
        events = await ws.observer.command_events()
        assert events[-1]["exit_code"] == 130
        assert session.last_exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cancel_reaches_a_whole_line_runtime():
    from mirage import LineExecutorMixin, Runtime, Workspace
    from mirage.types import MountMode
    from mirage.utils.abort import MirageAbortError
    from mirage.vfs.ram import RAMVFS

    class Hanging(Runtime, LineExecutorMixin):
        name = "hanging"
        captures = ("hangcmd",)

        async def run_line(self, line, stdin, env, cwd):
            await asyncio.Event().wait()

    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[Hanging(), "workspace"]
    )
    cancel = asyncio.Event()
    asyncio.get_running_loop().call_later(0.01, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await ws.shell("hangcmd now", cancel=cancel)
        events = await ws.observer.command_events()
        assert events[-1]["exit_code"] == 130
    finally:
        await ws.close()
