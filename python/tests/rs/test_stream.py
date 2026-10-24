import asyncio
import base64
import sys
import threading
from collections.abc import Mapping

import pytest

from mirage.concurrency.worker import Worker
from mirage.io.spool import ByteSpool
from mirage.rs.errors import StreamRefusal
from mirage.rs.glob import Glob
from mirage.rs.stream import Served, open_stream, run_stream, serve_requests
from mirage.types import JsonValue
from mirage.workspace import Workspace

DECODE = {"mode": "decode", "ignore_garbage": False}


def test_a_bad_config_refuses_with_no_output():
    with pytest.raises(StreamRefusal) as refused:
        open_stream("base64", {"mode": "nope"})
    assert refused.value.message.startswith("bad stream config")
    assert refused.value.output == b""


@pytest.mark.asyncio
async def test_a_refusal_keeps_the_output_before_it():
    data = bytes(range(256)) * 1024
    out = b""
    with pytest.raises(StreamRefusal) as refused:
        async for part in run_stream(
            "base64", DECODE, base64.b64encode(data) + b"*"
        ):
            out += part
    assert out + refused.value.output == data


def test_one_stream_reads_one_input_after_another():
    stream = open_stream(
        "grep", {"patterns": ["*a"], "syntax": "extended", "count": True}
    )
    assert stream.take_stderr() == (
        b"grep: warning: * at start of expression\n"
    )
    for data, count, status in ((b"a\nb\n", b"1\n", 0), (b"b\n", b"0\n", 1)):
        stream.begin({"label": "in"})
        assert stream.feed(data) == b""
        assert not stream.done()
        assert stream.finish() == count
        assert stream.status() == status


def test_a_stream_of_one_input_refuses_another():
    with pytest.raises(StreamRefusal):
        open_stream("base64", DECODE).begin({})


def test_a_stream_may_be_freed_on_another_thread(monkeypatch):
    # Python's cycle collector frees objects on whichever thread it runs.
    raised = []
    monkeypatch.setattr(sys, "unraisablehook", raised.append)
    held = [open_stream("grep", {"patterns": ["a"], "syntax": "basic"})]
    thread = threading.Thread(target=held.clear)
    thread.start()
    thread.join()
    assert held == [] and raised == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reuse_subject", [False, True])
async def test_glob_replacement_cancellation_prevents_later_output(
    reuse_subject,
):
    glob = Glob("+(?)", True)
    output: list[list[tuple[int, int]]] = []
    subject = "a" * 2_000_000
    if reuse_subject:
        assert glob.end(subject, len(subject)) is None

    async def replace() -> None:
        output.append(await glob.spans(subject, True, None))

    task = asyncio.create_task(replace())
    pending = asyncio.get_running_loop().call_soon(task.cancel)
    try:
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        assert output == []
    finally:
        pending.cancel()
        task.cancel()
        glob.close()


@pytest.mark.asyncio
async def test_foreground_parameter_cancellation_closes_matcher_before_returning(
    monkeypatch,
):
    ws = Workspace({})
    active = set()
    entered = []
    closed = set()
    original_spans = Glob.spans
    original_close = Glob.close
    pending = None

    async def spans(glob, name, all_, anchor):
        nonlocal pending
        active.add(glob)
        entered.append(glob)
        pending = asyncio.get_running_loop().call_soon(task.cancel)
        try:
            return await original_spans(glob, name, all_, anchor)
        finally:
            active.remove(glob)

    def close(glob):
        closed.add(glob)
        original_close(glob)

    monkeypatch.setattr(Glob, "spans", spans)
    monkeypatch.setattr(Glob, "close", close)
    await ws.shell("shopt -s extglob")
    task = asyncio.create_task(
        ws.shell("x=${X//+(?)/x}; touched=yes", env={"X": "a" * 2_000_000})
    )
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
        assert len(entered) == 1
        assert not active
        assert all(glob in closed for glob in entered)
        result = await ws.shell('printf "%s\\n" "${touched-unset}"')
        assert await result.stdout_str() == "unset\n"
    finally:
        if pending is not None:
            pending.cancel()
        task.cancel()
        await ws.close()


@pytest.mark.asyncio
async def test_native_refusal_keeps_message_and_partial_output_through_worker():
    worker = Worker()
    try:
        with pytest.raises(StreamRefusal) as refused:
            await worker.call(
                exec,
                "from mirage.rs.stream import open_stream\n"
                "stream = open_stream('base64', "
                "{'mode': 'decode', 'ignore_garbage': False})\n"
                "stream.feed(b'YQ==*')",
            )
        assert refused.value.message == "base64: invalid input"
        assert str(refused.value) == "base64: invalid input"
        assert refused.value.output == b"a"
        assert await worker.call(len, b"healthy") == 7
    finally:
        await worker.close()


class _Errors(ByteSpool):
    def __init__(self) -> None:
        super().__init__()
        self.sizes: list[int] = []

    async def append(self, data: bytes) -> None:
        self.sizes.append(len(data))
        await super().append(data)


class _NoRequests:
    def __init__(self) -> None:
        self.errors = _Errors()

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        raise AssertionError(f"unexpected request {request!r}")


@pytest.mark.asyncio
async def test_stderr_leaves_the_stream_after_each_drain() -> None:
    program = (
        'BEGIN { for (i = 0; i < 100000; i++) print "line" > "/dev/stderr" }'
    )
    stream = open_stream("awk", {"program": program})
    host = _NoRequests()
    async for _ in serve_requests(stream, host):
        pass
    await host.errors.close()
    assert sum(host.errors.sizes) == 500000
    assert max(host.errors.sizes) < 70000
