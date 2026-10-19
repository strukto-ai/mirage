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
import json
import os
import subprocess
import sys
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.general.bc.command import bc
from mirage.commands.config import Context
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import FileStat, FileType, PathSpec
from mirage.workspace.files import Files


async def invoke(source: ByteSource):
    output, io = await bc.__wrapped__(
        NOOPAccessor(), [], [], Context(stdin=source)
    )
    assert output is not None and not isinstance(output, bytes)
    return output, io


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1, 7, 16384])
async def test_input_chunk_boundaries_preserve_utf8_and_state(size):
    program = 'x=5/* comment */;print "中",x,"\\n"\nx+=2\nx\n'.encode()

    async def source() -> AsyncGenerator[bytes, None]:
        for offset in range(0, len(program), size):
            yield program[offset : offset + size]

    output, io = await invoke(source())
    assert await materialize(output) == "中5\n7\n".encode()
    assert await materialize(io.stderr) == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("stop", [b"quit", b"halt"])
async def test_stop_drains_output_and_closes_input_without_another_pull(stop):
    closed = False

    async def source() -> AsyncGenerator[bytes, None]:
        nonlocal closed
        try:
            yield b"1\n" * 2000 + stop + b"\n"
            raise AssertionError("bc read after stopping")
        finally:
            closed = True

    output, io = await invoke(source())
    assert await materialize(output) == b"1\n" * 2000
    assert closed
    assert await materialize(io.stderr) == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_quit_in_a_file_leaves_the_files_after_it_unread():
    # GNU bc opens a file once the ones before it have run.
    touched: list[tuple[str, str]] = []

    async def dispatch(name: str, path: PathSpec, /, **_kw):
        touched.append((name, path.virtual))
        if name == "stat":
            return FileStat(name="q.bc", type=FileType.FILE), IOResult()
        return b"7\nquit\n", IOResult()

    output, io = await bc.__wrapped__(
        NOOPAccessor(),
        [PathSpec.from_str_path("/q.bc"), PathSpec.from_str_path("/later.bc")],
        [],
        Context(stdin=b"8\n", vfs=Files(dispatch, ledger=False)),
    )
    assert output is not None and not isinstance(output, bytes)
    assert await materialize(output) == b"7\n"
    assert touched == [("stat", "/q.bc"), ("read", "/q.bc")]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_diagnostics_are_recorded_before_the_consumer_stops():
    closed = False

    async def source() -> AsyncGenerator[bytes, None]:
        nonlocal closed
        try:
            yield b"1/0\n2+2\n"
            raise AssertionError("consumer stopped before the next pull")
        finally:
            closed = True

    output, io = await invoke(source())
    produced = b""
    while len(produced) < 2:
        produced += await anext(output)
    assert produced == b"4\n"
    assert await materialize(io.stderr) == (
        b"Runtime error (func=(main), adr=3): Divide by zero\n"
    )
    assert io.exit_code == 0
    await close_quietly(output)
    assert closed


@pytest.mark.asyncio
async def test_diagnostic_snapshots_remain_cumulative_across_reads():
    async def source() -> AsyncGenerator[bytes, None]:
        for value in (1, 2, 3):
            yield f"1/0\n{value}\n".encode()

    output, io = await invoke(source())
    notice = b"Runtime error (func=(main), adr=3): Divide by zero\n"
    try:
        assert await anext(output) == b"1\n"
        first = io.stderr
        for count in (2, 3):
            assert await anext(output) == f"{count}\n".encode()
            assert await io.materialize_stderr() == notice * count
        assert await materialize(first) == notice
        assert await io.materialize_stderr() == notice * 3
    finally:
        await output.aclose()


@pytest.mark.asyncio
async def test_concurrent_readers_of_one_snapshot_each_read_all_of_it():
    async def source() -> AsyncGenerator[bytes, None]:
        yield b"1/0\n1\n"
        yield b"2\n"

    output, io = await invoke(source())
    notice = b"Runtime error (func=(main), adr=3): Divide by zero\n"
    try:
        assert await anext(output) == b"1\n"
        snapshot = io.stderr
        assert await asyncio.gather(
            materialize(snapshot), io.materialize_stderr()
        ) == [notice, notice]
        assert await io.materialize_stderr() == notice
    finally:
        await output.aclose()


@pytest.mark.asyncio
async def test_finish_runs_no_line_that_input_ends_without_a_newline():
    # As GNU bc: the line never runs, and the open statement is an error.
    async def source() -> AsyncGenerator[bytes, None]:
        yield b"scale=3;"
        yield b"1/2"

    output, io = await invoke(source())
    assert await materialize(output) == b""
    assert await materialize(io.stderr) == b"(standard_in) 1: syntax error\n"


@pytest.mark.asyncio
async def test_input_failure_preserves_prior_diagnostics_and_closes_input():
    closed = False

    async def source() -> AsyncGenerator[bytes, None]:
        nonlocal closed
        try:
            yield b"1/0\n"
            raise PermissionError("input failed")
        finally:
            closed = True

    output, io = await invoke(source())
    with pytest.raises(PermissionError, match="input failed"):
        await materialize(output)
    assert closed
    assert await materialize(io.stderr) == (
        b"Runtime error (func=(main), adr=3): Divide by zero\n"
    )


@pytest.mark.asyncio
async def test_cancellation_closes_an_input_waiting_for_more_data():
    waiting = asyncio.Event()
    closed = False

    async def source() -> AsyncGenerator[bytes, None]:
        nonlocal closed
        try:
            yield b"2+2\n"
            waiting.set()
            await asyncio.Event().wait()
        finally:
            closed = True

    output, _ = await invoke(source())
    assert await anext(output) == b"4\n"
    pending = asyncio.create_task(anext(output))
    await waiting.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert closed


@pytest.mark.asyncio
async def test_concurrent_invocations_have_separate_registers_and_variables():
    async def evaluate(program: bytes):
        output, io = await invoke(program)
        return await materialize(output), await materialize(io.stderr)

    first, second = await asyncio.gather(
        evaluate(b"scale=3;x=9;obase=16\nx;scale\n"),
        evaluate(b"x;scale;obase\n"),
    )
    assert first == (b"9\n3\n", b"")
    assert second == (b"0\n0\n10\n", b"")


@pytest.mark.asyncio
async def test_closing_unconsumed_output_closes_unread_input():
    class Source:
        closed = False

        def __aiter__(self):
            return self

        async def __anext__(self) -> bytes:
            raise AssertionError("input must remain unread")

        async def aclose(self) -> None:
            self.closed = True

    source = Source()
    output, _ = await invoke(source)
    await close_quietly(output)
    assert source.closed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("1.0^1000000000000", "1.000\n"),
        ("(-1.00)^1000000000001", "-1.000\n"),
        ("0.00^1000000000000", "0\n"),
        ("0^0", "1\n"),
        ("1.0^-1000000000000", "1.000\n"),
        ("(-1.00)^-1000000000001", "-1.000\n"),
        (".1^1000000000000", "0\n"),
        (".10^-2", "100.000\n"),
        ("1.2^3", "1.728\n"),
        ("1.2^-3", ".578\n"),
        ("(-1.20)^-3", "-.578\n"),
    ],
)
async def test_power_preserves_scale_at_the_command_boundary(
    expression, expected
):
    output, io = await invoke(("scale=3;" + expression + "\n").encode())
    assert await materialize(output) == expected.encode()
    assert await materialize(io.stderr) == b""


@pytest.mark.parametrize(
    "expression",
    [
        "2^1000000",
        "2^-1000000",
        "2^" + str(10**100),
        "2^-" + str(10**100),
        ".1^-10000000000000000000000000000000000",
        "2^32768*2^32768",
        "1" * 16001,
        "." + "0" * 16000 + "1",
    ],
    ids=lambda text: text[:40],
)
def test_resource_refusal_recovers_without_allocating_unbounded_values(
    expression,
):
    script = """
import asyncio
import json
import sys
from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.general.bc.command import bc
from mirage.commands.config import Context
from mirage.io.types import materialize
async def run():
    output, io = await bc.__wrapped__(NOOPAccessor(), [], [], Context(
        stdin=(sys.argv[1] + ";99\\n2+2\\n").encode()))
    result = await materialize(output)
    errors = await materialize(io.stderr)
    print(json.dumps([result.decode(), errors.decode(), io.exit_code]))
asyncio.run(run())
"""
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[5]))
    result = subprocess.run(
        [sys.executable, "-c", script, expression],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
        env=env,
    )
    assert json.loads(result.stdout) == [
        "4\n",
        "Runtime error (func=(main), adr=3): Arithmetic limit exceeded\n",
        0,
    ]


@pytest.mark.asyncio
async def test_remainder_scale_growth_refuses_and_recovers():
    program = "a=.1;scale=100;" + "a=a%(3*a);" * 200 + "obase=2;a\n2+2\n"
    output, io = await invoke(program.encode())
    assert await materialize(output) == b"4\n"
    assert await materialize(io.stderr) == (
        b"Runtime error (func=(main), adr=3): Arithmetic limit exceeded\n"
    )
