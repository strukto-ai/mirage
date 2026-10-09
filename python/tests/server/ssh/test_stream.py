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
import threading
from collections.abc import Callable, Coroutine
from typing import Any

import asyncssh
import pytest

from mirage.io.types import IOResult
from mirage.server.ssh import stream
from mirage.server.ssh.constants import REFUSAL_WINDOW
from mirage.server.ssh.stream import (
    ChannelInput,
    ChannelOutput,
    LineDiscipline,
    Mark,
    decode,
    deliver,
    encode,
    loop_sender,
)
from mirage.server.stdin import LoopStdin
from mirage.shell.console import JobConsole
from mirage.shell.console.types import Channel
from mirage.types import Refusal
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.shell_execution import ShellExecution

Step = str | BaseException


class FakeStdin:
    """Replays reads the way asyncssh's server stdin answers them.

    A string is data, ``""`` is the line editor's soft EOF, an exception
    is raised from the read, and running off the end is the channel's
    own EOF.
    """

    def __init__(self, steps: list[Step]) -> None:
        self._steps = list(steps)
        self.reads = 0
        self._eof = False

    async def read(self, n: int) -> str:
        self.reads += 1
        await asyncio.sleep(0)
        if not self._steps:
            self._eof = True
            return ""
        step = self._steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step

    def at_eof(self) -> bool:
        return self._eof


class FakeWriter:
    def __init__(self) -> None:
        self.data: list[str] = []

    def write(self, text: str) -> None:
        self.data.append(text)

    async def drain(self) -> None:
        await asyncio.sleep(0)


class FakeProcess:
    def __init__(
        self, steps: list[Step], term_type: str | None = None
    ) -> None:
        self.stdin = FakeStdin(steps)
        self.stdout = FakeWriter()
        self.stderr = FakeWriter()
        self.channel = None
        self.term_type = term_type


async def _started(
    steps: list[Step], max_line: int | None = None
) -> ChannelInput:
    source = ChannelInput(FakeProcess(steps), max_line=max_line)
    source.start()
    return source


def test_every_byte_survives_the_text_round_trip():
    data = bytes(range(256))
    assert encode(decode(data)) == data


@pytest.mark.asyncio
async def test_readline_splits_chunks_into_lines():
    source = await _started(["ec", "ho a\npw", "d\n"])
    assert await source.readline() == b"echo a\n"
    assert await source.readline() == b"pwd\n"
    assert await source.readline() is Mark.EOF
    await source.close()


@pytest.mark.asyncio
async def test_a_final_unterminated_line_is_still_a_line():
    source = await _started(["exit 3"])
    assert await source.readline() == b"exit 3"
    assert await source.readline() is Mark.EOF
    await source.close()


@pytest.mark.asyncio
async def test_soft_eof_ends_one_reader_and_input_continues():
    source = await _started(["line\n", "", "more\n"])
    assert await source.readline() == b"line\n"
    assert await source.readline() is Mark.EOF
    assert await source.readline() == b"more\n"
    await source.close()


@pytest.mark.asyncio
async def test_read_hands_a_line_its_stdin_and_stops_at_soft_eof():
    source = await _started(["cat\n", "a\n", "b\n", "", "next\n"])
    assert await source.readline() == b"cat\n"
    assert await source.read() == b"a\n"
    assert await source.read() == b"b\n"
    assert await source.read() == b""
    assert await source.readline() == b"next\n"
    await source.close()


@pytest.mark.asyncio
async def test_interrupt_at_the_prompt_is_queued_in_band():
    source = await _started(["half", asyncssh.BreakReceived(0), "ls\n"])
    assert await source.readline() == b"half"
    assert await source.readline() is Mark.INTERRUPT
    assert await source.readline() == b"ls\n"
    await source.close()


@pytest.mark.asyncio
async def test_interrupt_goes_to_the_running_line_handler():
    hits = []
    source = ChannelInput(
        FakeProcess([asyncssh.SignalReceived("INT"), "after\n"])
    )
    source.on_interrupt(lambda: hits.append(1))
    source.start()
    assert await source.readline() == b"after\n"
    assert hits == [1]
    await source.close()


@pytest.mark.asyncio
async def test_terminal_resize_is_not_input():
    source = await _started(
        [asyncssh.TerminalSizeChanged(80, 24, 0, 0), "ok\n"]
    )
    assert await source.readline() == b"ok\n"
    await source.close()


@pytest.mark.asyncio
async def test_a_lost_channel_ends_input_for_good():
    source = await _started(["x\n", asyncssh.ConnectionLost("gone")])
    assert await source.readline() == b"x\n"
    assert await source.readline() is Mark.EOF
    assert await source.read() == b""
    await source.close()


@pytest.mark.asyncio
async def test_pump_stops_reading_once_the_buffer_is_full(monkeypatch):
    monkeypatch.setattr(stream, "MAX_BUFFERED", 4)
    process = FakeProcess(["aaaa", "bbbb", "cccc"])
    source = ChannelInput(process)
    source.start()
    for _ in range(5):
        await asyncio.sleep(0)
    assert process.stdin.reads == 1
    assert await source.read() == b"aaaa"
    for _ in range(5):
        await asyncio.sleep(0)
    assert process.stdin.reads == 2
    await source.close()


def _discipline(text: str) -> tuple[list[str], str, list[str]]:
    lines: list[str] = []
    marks: list[str] = []
    echo: list[bytes] = []
    LineDiscipline(
        echo.append,
        lambda data: lines.append(data.decode()),
        lambda: marks.append("interrupt"),
        lambda: marks.append("eof"),
    ).feed(text.encode())
    return lines, b"".join(echo).decode(), marks


def test_discipline_echoes_and_hands_over_a_line_at_enter():
    lines, echo, _ = _discipline("ls -l\r")
    assert (lines, echo) == (["ls -l\n"], "ls -l\r\n")


def test_discipline_treats_crlf_as_one_enter():
    assert _discipline("a\r\nb\n")[0] == ["a\n", "b\n"]


def test_discipline_erases_one_code_point_per_backspace():
    lines, echo, _ = _discipline("café\x7f\x7fe\r")
    assert lines == ["cae\n"]
    assert echo.endswith("\b \b\b \be\r\n")


def test_discipline_erases_the_whole_line_on_ctrl_u():
    assert _discipline("wrong\x15ok\r")[0] == ["ok\n"]


def test_discipline_drops_the_half_typed_line_on_ctrl_c():
    lines, _, marks = _discipline("half\x03next\r")
    assert (lines, marks) == (["next\n"], ["interrupt"])


def test_discipline_reports_ctrl_d_only_on_an_empty_line():
    assert _discipline("\x04")[2] == ["eof"]
    assert _discipline("x\x04\r")[2] == []


def test_discipline_swallows_escape_sequences():
    assert _discipline("a\x1b[Ab\x1bOPc\r")[0] == ["abc\n"]


def test_discipline_bounds_a_line_and_rings_past_it():
    lines, echo, _ = _discipline("x" * (stream.MAX_TERMINAL_LINE + 1) + "\r")
    assert lines == ["x" * stream.MAX_TERMINAL_LINE + "\n"]
    assert echo.endswith("\x07\r\n")


@pytest.mark.asyncio
async def test_a_pty_without_a_terminal_type_is_cooked_here():
    process = FakeProcess(["ab\x7fc\r", "\x04"], term_type="")
    source = ChannelInput(process)
    source.start()
    assert await source.readline() == b"ac\n"
    assert await source.readline() is Mark.EOF
    assert "".join(process.stdout.data) == "ab\b \bc\r\n"


@pytest.mark.asyncio
async def test_output_on_a_pty_without_a_terminal_type_is_crlf():
    bare, typed = FakeProcess([], term_type=""), FakeProcess([], "xterm")
    await ChannelOutput(bare, tty=True).write(b"a\nb\n")
    await ChannelOutput(typed, tty=True).write(b"a\nb\n")
    assert (bare.stdout.data, typed.stdout.data) == (
        ["a\r\nb\r\n"],
        ["a\nb\n"],
    )


@pytest.mark.asyncio
async def test_output_folds_stderr_into_stdout_on_a_terminal():
    plain, tty = FakeProcess([]), FakeProcess([], term_type="xterm")
    await ChannelOutput(plain, tty=False).write(b"err", stderr=True)
    await ChannelOutput(tty, tty=True).write(b"err", stderr=True)
    assert (plain.stdout.data, plain.stderr.data) == ([], ["err"])
    assert (tty.stdout.data, tty.stderr.data) == (["err"], [])


def _execution(io: IOResult, *events: tuple[Channel, bytes]) -> ShellExecution:
    async def run(
        output: JobConsole, cancel: asyncio.Event, scope: ExecutionScope
    ) -> IOResult:
        for channel, data in events:
            await output.emit(channel, data)
        return io

    return ShellExecution(run, ExecutionScope())


@pytest.mark.asyncio
async def test_deliver_sends_output_in_the_order_it_was_produced():
    sent: list[tuple[bytes, bool]] = []

    async def send(data: bytes, is_stderr: bool) -> None:
        sent.append((data, is_stderr))

    execution = _execution(
        IOResult(exit_code=3),
        (Channel.STDOUT, b"one"),
        (Channel.STDOUT, b""),
        (Channel.STDERR, b"warn"),
        (Channel.STDOUT, b"two"),
    )
    async with execution:
        result = await deliver(execution, send)
    assert sent == [(b"one", False), (b"warn", True), (b"two", False)]
    assert result.exit_code == 3


@pytest.mark.asyncio
async def test_deliver_sends_output_before_the_line_ends():
    release = asyncio.Event()
    first = asyncio.Event()

    async def run(
        output: JobConsole, cancel: asyncio.Event, scope: ExecutionScope
    ) -> IOResult:
        await output.emit(Channel.STDOUT, b"ready")
        await release.wait()
        return IOResult()

    async def send(data: bytes, is_stderr: bool) -> None:
        first.set()

    async with ShellExecution(run, ExecutionScope()) as execution:
        delivering = asyncio.create_task(deliver(execution, send))
        await asyncio.wait_for(first.wait(), 5)
        assert not delivering.done()
        release.set()
        await asyncio.wait_for(delivering, 5)


_W = REFUSAL_WINDOW
_SAID = b"rm: cannot remove '/data': Device or resource busy\n"
_BUSY = "cannot remove '/data': Device or resource busy"
_MORE = b"y" * (_W * 4)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stdout,stderr,reason,said",
    [
        (b"", b"rm: cannot remove 'x': Permission denied\n", "sealed", False),
        # A mount root's EBUSY lets the rest of the line run, so its
        # diagnostic can sit at either end of a long output, or end
        # right at the first window with its newline the next byte.
        (_MORE, _MORE + _SAID, _BUSY, True),
        (_MORE, _SAID + _MORE, _BUSY, True),
        (_MORE, b"f" * (_W - len(_SAID)) + b"\n" + _SAID + _MORE, _BUSY, True),
        # A long line cut right after the reason's words says nothing.
        (
            b"a" * (_W - 8) + b": sealed" + b"z" * 64 + b"\n",
            b"",
            "sealed",
            False,
        ),
    ],
    ids=["appended", "end", "start", "window_edge", "cut_line"],
)
async def test_deliver_appends_the_refusal_unless_the_output_says_why(
    stdout: bytes, stderr: bytes, reason: str, said: bool
):
    sent: list[tuple[bytes, bool]] = []

    async def send(data: bytes, is_stderr: bool) -> None:
        sent.append((data, is_stderr))

    refusal = Refusal(kind="deny", reason=reason, scope="operand")
    execution = _execution(
        IOResult(exit_code=1, refusal=refusal),
        (Channel.STDOUT, stdout),
        (Channel.STDERR, stderr),
    )
    async with execution:
        await deliver(execution, send)
    line = (f"policy denied: {reason}\n".encode(), True)
    assert (sent[-1] == line) is not said


def _run_other_loop(
    coro_factory: Callable[[], Coroutine[Any, Any, list[bytes]]],
) -> list[bytes]:
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        return asyncio.run_coroutine_threadsafe(coro_factory(), loop).result(
            timeout=5
        )
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join()
        loop.close()


@pytest.mark.asyncio
async def test_loop_stdin_and_sender_cross_to_the_channel_loop():
    process = FakeProcess(["piped\n", "more"])
    source = ChannelInput(process)
    source.start()
    home = asyncio.get_running_loop()
    output = ChannelOutput(process, tty=False)

    async def on_workspace_loop() -> list[bytes]:
        got = [chunk async for chunk in LoopStdin(source, home)]
        await loop_sender(output, home)(b"done", False)
        return got

    got = await asyncio.to_thread(_run_other_loop, on_workspace_loop)
    assert got == [b"piped\n", b"more"]
    assert process.stdout.data == ["done"]
    await source.close()


@pytest.mark.asyncio
async def test_readline_takes_its_own_bound():
    long = await _started(["aaaaaa\n"], max_line=4)
    wide = await _started(["aaaaaa\n"], max_line=8)
    try:
        assert await long.readline() is Mark.LIMIT
        assert await wide.readline() == b"aaaaaa\n"
    finally:
        await long.close()
        await wide.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("tail", ["x", "x\n", "xx\nignored\n"])
async def test_readline_bounds_accumulated_input(monkeypatch, tail):
    monkeypatch.setattr(stream, "MAX_LINE", 4)
    source = await _started(["aa", "aa", tail])
    try:
        assert await source.readline() is Mark.LIMIT
    finally:
        await source.close()


@pytest.mark.asyncio
async def test_readline_accepts_limit_and_resets_for_next_line(monkeypatch):
    monkeypatch.setattr(stream, "MAX_LINE", 4)
    source = await _started(["aaaa\nbbbb\n"])
    try:
        assert await source.readline() == b"aaaa\n"
        assert await source.readline() == b"bbbb\n"
    finally:
        await source.close()
