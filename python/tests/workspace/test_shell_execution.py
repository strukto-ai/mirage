import asyncio

import pytest

from mirage import ShellExecution, Workspace
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.types import IOResult
from mirage.policy import Action, ExecuteResultContext, Policy
from mirage.shell.console import JobConsole
from mirage.shell.console.types import Channel
from mirage.utils.abort import MirageAbortError
from mirage.workspace.execution import ExecutionScope


@pytest.mark.asyncio
async def test_events_bound_output_and_keep_final_status_separate():
    started = asyncio.Event()
    finished = asyncio.Event()

    async def run(output, cancel, scope):
        started.set()
        await output.emit(Channel.STDOUT, b"a" * (CHUNK_SIZE * 8))
        await output.emit(Channel.STDERR, b"warning")
        await output.emit(Channel.STDOUT, b"tail")
        finished.set()
        return IOResult(exit_code=7, writes={"/a": b"saved"})

    execution = ShellExecution(run, ExecutionScope())
    await started.wait()
    assert not finished.is_set()
    result = await execution.collect()
    assert (
        await result.materialize_stdout() == b"a" * (CHUNK_SIZE * 8) + b"tail"
    )
    assert await result.materialize_stderr() == b"warning"
    assert result.exit_code == 7
    assert result.writes == {"/a": b"saved"}
    assert await (await execution.wait()).materialize_stdout() == b""


@pytest.mark.asyncio
async def test_collect_awaits_event_observer_and_preserves_output():
    entered, release, finished = (asyncio.Event() for _ in range(3))
    seen = []

    async def run(output, cancel, scope):
        await output.emit(Channel.STDOUT, b"a" * (CHUNK_SIZE * 8))
        await output.emit(Channel.STDERR, b"warning")
        finished.set()
        return IOResult(exit_code=7, writes={"/a": b"saved"})

    async def observe(event):
        seen.append(event.stream)
        if len(seen) == 1:
            entered.set()
            await release.wait()

    execution = ShellExecution(run, ExecutionScope())
    collecting = asyncio.create_task(execution.collect(on_event=observe))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert seen == ["stdout"]
        assert not collecting.done()
        assert not finished.is_set()
        release.set()
        result = await asyncio.wait_for(collecting, 1)
        assert result.stdout == b"a" * (CHUNK_SIZE * 8)
        assert result.stderr == b"warning"
        assert result.exit_code == 7
        assert result.writes == {"/a": b"saved"}
        assert seen == ["stdout"] * 8 + ["stderr"]
        assert await (await execution.wait()).materialize_stdout() == b""
    finally:
        release.set()
        await execution.aclose()
        await asyncio.gather(collecting, return_exceptions=True)


@pytest.mark.asyncio
async def test_collect_observer_failure_joins_producer_cleanup():
    closed = asyncio.Event()
    observed = []

    async def run(output, cancel, scope):
        try:
            await output.emit(Channel.STDOUT, b"prefix")
            await cancel.wait()
            raise MirageAbortError()
        finally:
            closed.set()

    async def observe(event):
        observed.append(event.data)
        raise ValueError("preview failed")

    execution = ShellExecution(run, ExecutionScope())
    with pytest.raises(ValueError, match="preview failed"):
        await asyncio.wait_for(execution.collect(on_event=observe), 1)
    assert observed == [b"prefix"]
    assert closed.is_set()
    with pytest.raises(MirageAbortError):
        await execution.wait()


@pytest.mark.asyncio
async def test_late_failure_follows_accepted_prefix():
    async def run(output, cancel, scope):
        await output.emit(Channel.STDOUT, b"prefix")
        await output.emit(Channel.STDERR, b"warning")
        raise ValueError("late failure")

    execution = ShellExecution(run, ExecutionScope())
    async with execution:
        assert (await anext(execution.events)).data == b"prefix"
        assert (await anext(execution.events)).stream == Channel.STDERR
        with pytest.raises(ValueError, match="late failure"):
            await anext(execution.events)
        with pytest.raises(ValueError, match="late failure"):
            await execution.wait()


@pytest.mark.asyncio
async def test_close_before_first_pull_unblocks_saturated_writer():
    started = asyncio.Event()
    closed = asyncio.Event()

    async def run(output, cancel, scope):
        try:
            started.set()
            await output.emit(Channel.STDOUT, b"a" * (CHUNK_SIZE * 8))
            return IOResult()
        finally:
            closed.set()

    execution = ShellExecution(run, ExecutionScope())
    await started.wait()
    await asyncio.wait_for(
        asyncio.gather(execution.aclose(), execution.aclose()), 1
    )
    assert closed.is_set()
    with pytest.raises(MirageAbortError):
        await execution.wait()


@pytest.mark.asyncio
async def test_close_during_pending_pull_joins_producer():
    ready = asyncio.Event()
    closed = asyncio.Event()

    async def run(output, cancel, scope):
        try:
            ready.set()
            await cancel.wait()
            raise MirageAbortError()
        finally:
            closed.set()

    execution = ShellExecution(run, ExecutionScope())
    pending = asyncio.create_task(anext(execution.events))
    await ready.wait()
    await asyncio.wait_for(execution.aclose(), 1)
    await asyncio.gather(pending, return_exceptions=True)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_streamed_session_preserves_mutations_and_event_order():
    ws = Workspace({})
    try:
        session = await ws.session("sdk-test")
        execution = await session.shell(
            "export SDK_STREAM=yes; echo one; echo two >&2", stream=True
        )
        assert isinstance(execution, ShellExecution)
        async with execution:
            events = [
                (event.stream, event.data) async for event in execution.events
            ]
            result = await execution.wait()
        assert events == [
            (Channel.STDOUT, b"one\n"),
            (Channel.STDERR, b"two\n"),
        ]
        assert (
            await result.materialize_stdout()
            == await result.materialize_stderr()
            == b""
        )
        assert (
            await (
                await session.shell('echo "$SDK_STREAM"')
            ).materialize_stdout()
            == b"yes\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_workspace_close_reaches_handle_before_first_pull():
    ws = Workspace({})
    execution = await ws.shell("sleep 60; echo never", stream=True)
    await asyncio.wait_for(ws.close(), 1)
    with pytest.raises(MirageAbortError):
        await execution.wait()


@pytest.mark.asyncio
async def test_pre_cancelled_handle_has_no_effects():
    ws = Workspace({})
    cancel = asyncio.Event()
    cancel.set()
    try:
        execution = await ws.shell(
            "export SHOULD_NOT_EXIST=yes", cancel=cancel, stream=True
        )
        with pytest.raises(MirageAbortError):
            await execution.wait()
        await execution.aclose()
        assert (
            await (
                await ws.shell('echo "$SHOULD_NOT_EXIST"')
            ).materialize_stdout()
            == b"\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_context_exit_closes_even_when_events_are_kept():
    ws = Workspace({})
    execution = await ws.shell(
        "echo prefix; sleep 60; echo never", stream=True
    )
    events = execution.events
    try:
        async with execution:
            async for event in events:
                assert event.data == b"prefix\n"
                break
        with pytest.raises(MirageAbortError):
            await execution.wait()
        with pytest.raises(StopAsyncIteration):
            await anext(events)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_immediate_session_cancel_reaches_streamed_invocation():
    ws = Workspace({})
    try:
        execution = await ws.shell("sleep 60; echo never", stream=True)
        assert await ws.cancel() == 1
        with pytest.raises(MirageAbortError):
            await execution.wait()
        await execution.aclose()
    finally:
        await ws.close()


class _ApproveOutput(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return None


class _StuckSink(JobConsole):
    def __init__(self) -> None:
        super().__init__()
        self.reached = asyncio.Event()

    async def emit(self, channel: Channel, data: bytes) -> None:
        self.reached.set()
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_cancel_reaches_a_held_output_drain():
    ws = Workspace({})
    ws.policies.add(_ApproveOutput())
    sink = _StuckSink()
    line = asyncio.create_task(ws.shell("echo held", sink=sink))
    try:
        await asyncio.wait_for(sink.reached.wait(), 5)
        assert await ws.cancel() == 1
        with pytest.raises(MirageAbortError):
            await line
    finally:
        line.cancel()
        await asyncio.gather(line, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
async def test_pipeline_streams_its_last_stage():
    ws = Workspace({})
    try:
        execution = await ws.shell(
            "{ echo ready; sleep 60; echo never; } | cat", stream=True
        )
        async with execution:
            event = await asyncio.wait_for(anext(execution.events), 5)
            assert event.data == b"ready\n"
    finally:
        await ws.close()
