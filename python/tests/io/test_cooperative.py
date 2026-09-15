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

    timer = asyncio.get_running_loop().call_later(.001, fired.set)
    try:
        assert [c async for c in chunks(source())] == [b"late"]
        # Without a yield per pull the loop never suspends, the
        # timer never runs, and every empty chunk is produced.
        assert produced < 200_000
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


@pytest.mark.asyncio
async def test_aborted_execution_records_failure():
    from mirage import Workspace
    from mirage.resource.ram import RAMResource
    from mirage.workspace.abort import MirageAbortError
    ws = Workspace({"/data": RAMResource()})
    cancel = asyncio.Event()

    async def source():
        asyncio.get_running_loop().call_later(.001, cancel.set)
        yield b"line\n" * 500_000
        # Keep the command unfinished even if the fast scan beats the timer.
        await asyncio.Event().wait()

    try:
        await ws.execute("false")
        session = ws.get_session(ws.default_session_id)
        assert session.last_exit_code == 1
        with pytest.raises(MirageAbortError):
            await ws.execute("wc -l", stdin=source(), cancel=cancel)
        events = await ws.observer.command_events()
        assert len(events) == 2
        assert events[-1]["exit_code"] == 130
        assert session.last_exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cancel_discards_cacheable_input():
    from mirage.io import CachableAsyncIterator
    from mirage.io.cooperative import chunks
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"x" * 100_000
        finally:
            closed = True

    wrapped = CachableAsyncIterator(source())
    stream = chunks(wrapped)
    await anext(stream)
    with pytest.raises(asyncio.CancelledError):
        await stream.athrow(asyncio.CancelledError())
    assert closed
    assert wrapped.buffered_chunks == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["abort", "timeout", "early"])
async def test_pipeline_cache_lifecycle(failure):
    from mirage.io import CachableAsyncIterator, IOResult
    from mirage.io.stream import async_chain
    from mirage.workspace.executor.pipes import handle_pipe
    from mirage.workspace.session import Session
    from mirage.workspace.types import ExecutionNode
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"first"
            yield b"rest"
        finally:
            closed = True

    stream = CachableAsyncIterator(source())

    async def execute(cmd, session, stdin, call_stack):
        if cmd == "cat":
            return async_chain(stream), IOResult(
                reads={"/remote": stream},
                cache=["/remote"]), ExecutionNode(command="cat")
        await anext(stdin)
        if failure == "abort":
            raise asyncio.CancelledError()
        if failure == "timeout":
            raise CommandTimeoutError("wc", 1)
        return b"first", IOResult(), ExecutionNode(command="head")

    run = handle_pipe(execute, ["cat", "wc"], [], Session(session_id="test"))
    if failure == "early":
        await run
        assert not closed
        assert await stream.drain() == b"firstrest"
    else:
        with pytest.raises(asyncio.CancelledError if failure ==
                           "abort" else CommandTimeoutError):
            await run
        assert stream.buffered_chunks == []
    assert closed


@pytest.mark.asyncio
async def test_value_barrier_discards_hidden_cache_read():
    from mirage.io import CachableAsyncIterator, IOResult
    from mirage.shell.barrier import BarrierPolicy, apply_barrier
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"partial"
        finally:
            closed = True

    stream = CachableAsyncIterator(source())

    async def output():
        yield await anext(stream)
        raise RuntimeError("consumer failed")

    io = IOResult(reads={"/remote": stream}, cache=["/remote"])
    with pytest.raises(RuntimeError, match="consumer failed"):
        await apply_barrier(output(), io, BarrierPolicy.VALUE)
    assert closed
    assert stream.buffered_chunks == []


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["read_until", "read_chars"])
async def test_line_reader_discards_cache_on_cancel(method, monkeypatch):
    from mirage.io import CachableAsyncIterator
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"line\n" * 200_000
        finally:
            closed = True

    stream = CachableAsyncIterator(source())
    reader = AsyncLineIterator(stream)
    # Prime the buffer so cancellation happens in the reader, outside chunks().
    await reader.read_chars(1, None)

    async def cancelled_budget():
        raise asyncio.CancelledError()

    monkeypatch.setattr(reader._budget, "run", cancelled_budget)
    with pytest.raises(asyncio.CancelledError):
        if method == "read_until":
            await reader.read_until(b"\n")
        else:
            await reader.read_chars(100, None)
    assert closed
    assert stream.buffered_chunks == []


@pytest.mark.asyncio
async def test_cancel_during_cache_fill_aborts():
    from mirage import Workspace
    from mirage.resource.ram import RAMResource
    from mirage.workspace.abort import MirageAbortError
    ws = Workspace({"/data": RAMResource()})
    cancel = asyncio.Event()

    real_apply_io = ws.apply_io

    async def slow_apply_io(io, records=None, is_cacheable=None):
        if io.exit_code != 0:
            await real_apply_io(io, records=records, is_cacheable=is_cacheable)
            return
        cancel.set()
        await asyncio.Event().wait()

    ws.apply_io = slow_apply_io
    try:
        await ws.execute("false")
        session = ws.get_session(ws.default_session_id)
        with pytest.raises(MirageAbortError):
            await ws.execute("echo hi", cancel=cancel)
        events = await ws.observer.command_events()
        assert events[-1]["exit_code"] == 130
        assert session.last_exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cancel_reaches_a_whole_line_runtime():
    from mirage import LineExecutorMixin, Runtime, Workspace
    from mirage.resource.ram import RAMResource
    from mirage.types import MountMode
    from mirage.workspace.abort import MirageAbortError

    class Hanging(Runtime, LineExecutorMixin):
        name = "hanging"
        captures = ("hangcmd", )

        async def run_line(self, line, stdin, env, cwd):
            await asyncio.Event().wait()

    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.EXEC,
                   runtimes=[Hanging(), "vfs"])
    cancel = asyncio.Event()
    asyncio.get_running_loop().call_later(.01, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await ws.execute("hangcmd now", cancel=cancel)
        events = await ws.observer.command_events()
        assert events[-1]["exit_code"] == 130
    finally:
        await ws.close()
