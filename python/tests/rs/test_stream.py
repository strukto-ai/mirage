import asyncio
import base64
import sys
import threading

import pytest

from mirage.rs.errors import StreamRefusal
from mirage.rs.glob import Glob
from mirage.rs.stream import open_stream, run_stream, stream_output
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
async def test_unstarted_output_closes_its_source_without_pulling():
    class Source:
        def __init__(self):
            self.closed = 0

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise AssertionError("unstarted output pulled input")

        async def aclose(self):
            self.closed += 1

    source = Source()
    output = stream_output(open_stream("base64", DECODE), source)
    await output.aclose()
    await output.aclose()
    assert source.closed == 1
