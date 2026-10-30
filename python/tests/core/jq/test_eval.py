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

import pytest

from mirage.core.jq import eval as eval_module
from mirage.core.jq.errors import JqCompileError
from mirage.core.jq.eval import Ending, Engine, local_zone, read_frames
from mirage.core.jq.types import JqError, JqHalt
from mirage.rs.stream import OpenStream


def _frame(tag: int, payload: bytes) -> bytes:
    return bytes([tag]) + len(payload).to_bytes(4, "little") + payload


def test_frames_fold_into_outputs_and_the_stop_that_ended_the_run():
    outputs: list[bytes] = []
    wire = (
        _frame(1, b"1")
        + _frame(4, b'["DEBUG:",1]')
        + _frame(1, b"2")
        + _frame(5, b"x")
        + _frame(2, b"\x00{}")
    )
    assert read_frames(wire, outputs) == JqError("{}", False)
    assert outputs == [b"1", b"2"]
    assert read_frames(_frame(2, b"\x03x"), []) == JqError("x", True, True)
    halt = b'{"message":"bye","string":true,"code":3.0}'
    assert read_frames(_frame(3, halt), []) == JqHalt("bye", True, 3.0)
    with pytest.raises(ValueError):
        read_frames(_frame(9, b""), [])


def test_local_zone_is_the_sessions_tz_else_the_hosts(monkeypatch):
    monkeypatch.setenv("TZ", "EST5EDT")
    assert local_zone({"TZ": ":Asia/Tokyo"}) == ":Asia/Tokyo"
    assert local_zone({"TZ": ""}) == ""
    assert local_zone({}) == "EST5EDT"
    monkeypatch.delenv("TZ")
    monkeypatch.setattr(
        eval_module.os.path,
        "realpath",
        lambda _path: "/usr/share/zoneinfo/Europe/Paris",
    )
    assert local_zone(None) == "Europe/Paris"
    monkeypatch.setattr(eval_module.os.path, "realpath", lambda path: path)
    assert local_zone(None) is None


async def _outputs(engine: Engine, doc: str) -> tuple[list[str], Ending]:
    ending = Ending()
    return [text async for text in engine.run(doc, ending)], ending


@pytest.mark.asyncio
async def test_a_run_dumps_each_output_and_keeps_how_it_ended():
    engine = Engine.open('.[], error("x")', "{}", None)
    try:
        assert await _outputs(engine, '[1,{"a":2}]') == (
            ["1", '{"a":2}'],
            Ending(JqError("x", True, True)),
        )
        assert await _outputs(engine, "[]") == (
            [],
            Ending(JqError("x", True, True)),
        )
    finally:
        await engine.close()


@pytest.mark.asyncio
async def test_input_finds_no_more_input_and_messages_are_dropped():
    engine = Engine.open(
        '(1 | debug), ("x" | stderr), try input catch .', "{}", None
    )
    try:
        assert await _outputs(engine, "null") == (
            ["1", '"x"', '"break"'],
            Ending(),
        )
    finally:
        await engine.close()


@pytest.mark.asyncio
async def test_each_output_goes_out_before_its_run_ends():
    # A run its reader stops is cancelled, so the next value can begin.
    engine = Engine.open("., until(false; .)", "{}", None)
    try:
        for doc in ("1", "2"):
            values = engine.run(doc, Ending())
            assert await asyncio.wait_for(anext(values), 10) == doc
            await values.aclose()
    finally:
        await engine.close()


def test_a_program_jq_refuses_is_refused_with_jqs_report():
    with pytest.raises(JqCompileError, match=r"\njq: 1 compile error\Z"):
        Engine.open("if", "{}", None)
    with pytest.raises(JqCompileError) as error:
        Engine.open('import "a" as a; .', "{}", None)
    assert (
        str(error.value)
        == "jq: error: module not found: a\n\njq: 1 compile error"
    )


@pytest.mark.asyncio
async def test_an_unknown_request_is_refused(monkeypatch):
    engine = Engine.open("input", "{}", None)
    monkeypatch.setattr(
        OpenStream, "request", lambda _stream: ({"op": "fixture"}, b"")
    )
    try:
        with pytest.raises(ValueError, match="unknown host request"):
            await _outputs(engine, "null")
    finally:
        await engine.close()
