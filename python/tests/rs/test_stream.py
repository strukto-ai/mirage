import base64
import sys
import threading

import pytest

from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream, run_stream

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
