import asyncio
import base64
import json
import sys
import threading
from collections.abc import Mapping

import pytest

from mirage._rs import Stream, StreamError
from mirage.concurrency.worker import Worker
from mirage.io.spool import ByteSpool
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import (
    Served,
    close_stream,
    open_stream,
    run_stream,
    serve_requests,
)
from mirage.types import JsonValue

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


@pytest.mark.asyncio
async def test_closed_wrapper_keeps_terminal_results_without_native_owner():
    stream = open_stream(
        "grep", {"patterns": ["*a"], "syntax": "extended", "count": True}
    )
    stream.begin({"label": "in"})
    stream.feed(b"b\n")
    assert stream.finish() == b"0\n"
    await close_stream(stream)
    await close_stream(stream)
    assert not stream.live
    assert stream.status() == 1
    assert stream.take_stderr() == b"grep: warning: * at start of expression\n"
    assert stream.take_stderr() == b""
    with pytest.raises(RuntimeError, match="stream is closed"):
        stream.feed(b"a\n")


@pytest.mark.asyncio
async def test_close_settles_retirement_despite_repeated_cancellation(
    monkeypatch,
):
    stream = open_stream("base64", DECODE)
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def retirement(*_):
        entered.set()
        await release.wait()
        assert stream.live
        calls.append("drained")
        yield b""

    monkeypatch.setattr(stream, "cancel", lambda: True)
    monkeypatch.setattr("mirage.rs.stream._drained", retirement)
    closing = asyncio.create_task(close_stream(stream))
    await entered.wait()
    closing.cancel()
    await asyncio.sleep(0)
    closing.cancel()
    again = asyncio.create_task(close_stream(stream))
    release.set()
    await asyncio.gather(closing, again)
    assert calls == ["drained"]
    assert not stream.live


def test_a_stream_of_one_input_refuses_another():
    with pytest.raises(StreamRefusal):
        open_stream("base64", DECODE).begin({})


def test_a_stream_that_answers_no_test_refuses_one():
    with pytest.raises(StreamError, match="answers no test"):
        Stream("base64", json.dumps(DECODE).encode()).test(b"")


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
