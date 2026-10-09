import asyncio

import pytest

from mirage.server.mcp.progress import (
    INTERVAL,
    LIMIT,
    OutputProgress,
    collect_execution,
)
from mirage.shell.console.types import Channel
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.shell_execution import ShellExecution


@pytest.mark.asyncio
async def test_previews_decode_channels_incrementally_and_bound_bursts(
    monkeypatch,
):
    messages = []
    now = [0.0]
    monkeypatch.setattr(
        "mirage.server.mcp.progress.time.monotonic", lambda: now[0]
    )

    async def send(value, message):
        messages.append((value, message))

    progress = OutputProgress(send)
    await progress.feed("stdout", b"\xe2")
    assert not messages
    await progress.feed("stderr", b"\xf0\x9f")
    assert not messages
    await progress.feed("stdout", b"\x82\xac")
    assert messages == [(1, "[stdout] €")]
    await progress.feed("stdout", b"a" * (LIMIT * 10))
    await progress.feed("stderr", b"\x99\x82")
    assert len(messages) == 1
    now[0] += INTERVAL
    await progress.feed("stdout", b"z")
    assert messages[1][0] == 2
    assert messages[1][1].startswith("[stdout] …")
    assert len(messages[1][1]) <= LIMIT + len("[stdout] ")
    assert messages[2] == (3, "[stderr] 🙂")
    await progress.feed("stderr", b"\xe2")
    await progress.finish()
    assert messages[-1] == (4, "[stderr] �")


@pytest.mark.asyncio
async def test_trailing_preview_arrives_while_producer_is_silent():
    messages = []
    delivered = asyncio.Event()

    async def send(value, message):
        messages.append((value, message))
        if value == 2:
            delivered.set()

    progress = OutputProgress(send)
    try:
        await progress.feed("stdout", b"first")
        await progress.feed("stdout", b"second")
        assert len(messages) == 1
        await asyncio.wait_for(delivered.wait(), 2)
        assert messages == [(1, "[stdout] first"), (2, "[stdout] second")]
    finally:
        await progress.close()


@pytest.mark.asyncio
async def test_trailing_delivery_failure_cancels_execution_and_is_observed():
    canceled = asyncio.Event()

    async def send(value, message):
        if value == 2:
            raise RuntimeError("closed transport")
        assert message == "[stdout] first"

    progress = OutputProgress(send)
    progress.bind(canceled.set)
    await progress.feed("stdout", b"first")
    await progress.feed("stdout", b"second")
    await asyncio.wait_for(canceled.wait(), 2)
    with pytest.raises(RuntimeError, match="closed transport"):
        await progress.close()


@pytest.mark.asyncio
async def test_collection_joins_producer_after_trailing_preview_failure():
    closed = asyncio.Event()

    async def run(output, cancel, scope):
        try:
            await output.emit(Channel.STDOUT, b"first")
            await output.emit(Channel.STDOUT, b"second")
            await cancel.wait()
            raise MirageAbortError()
        finally:
            closed.set()

    async def send(value, message):
        if value == 2:
            raise RuntimeError("closed transport")
        assert message == "[stdout] first"

    execution = ShellExecution(run, ExecutionScope())
    with pytest.raises(RuntimeError, match="closed transport"):
        await asyncio.wait_for(
            collect_execution(execution, OutputProgress(send)), 2
        )
    assert closed.is_set()
    with pytest.raises(MirageAbortError):
        await execution.wait()
