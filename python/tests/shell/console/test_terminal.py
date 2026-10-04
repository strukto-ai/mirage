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

from mirage.shell.console import Channel, JobConsole, Tee, Terminal
from mirage.shell.descriptors import Recorder


class _Paced(JobConsole):
    """A reader that lets the loop turn before it takes each chunk."""

    async def emit(self, channel: Channel, data: bytes) -> None:
        await asyncio.sleep(0)
        await super().emit(channel, data)


async def _write_until(tty: Terminal, stop: asyncio.Event) -> None:
    """Write a numbered line as a job on every turn of the loop.

    Args:
        tty (Terminal): the terminal the job writes to.
        stop (asyncio.Event): ends the writes once set.
    """
    count = 0
    while not stop.is_set():
        count += 1
        await tty.jobs.emit(Channel.STDOUT, f"{count}\n".encode())
        await asyncio.sleep(0)


class _Stalled(JobConsole):
    """A reader whose writes wait for ``release``."""

    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def emit(self, channel: Channel, data: bytes) -> None:
        self.entered.set()
        await self.release.wait()
        await super().emit(channel, data)


@pytest.mark.asyncio
async def test_a_line_takes_what_reached_the_terminal_in_order():
    tty = Terminal()
    await tty.jobs.emit(Channel.STDOUT, b"early\n")
    await tty.emit(Channel.STDOUT, b"line\n")
    await tty.emit(Channel.STDERR, b"warn\n")
    await tty.jobs.emit(Channel.STDOUT, b"late\n")
    assert tty.take() == (b"early\nline\nlate\n", b"warn\n")
    assert tty.take() == (b"", b"")


@pytest.mark.asyncio
async def test_a_job_writes_into_the_statement_running():
    tty = Terminal()
    statement = Recorder()
    tty.jobs.recorder = statement
    await tty.jobs.emit(Channel.STDOUT, b"bg\n")
    tty.jobs.recorder = None
    await tty.jobs.emit(Channel.STDOUT, b"after\n")
    assert statement.chunks == [(Channel.STDOUT, b"bg\n")]
    assert tty.take() == (b"after\n", b"")


@pytest.mark.asyncio
async def test_a_reader_gets_what_waited_and_then_everything():
    tty = Terminal()
    await tty.jobs.emit(Channel.STDOUT, b"waited\n")
    reader = JobConsole()
    await tty.attach(reader)
    await tty.emit(Channel.STDOUT, b"now\n")
    assert await reader.snapshot(Channel.STDOUT) == b"waited\nnow\n"
    assert tty.take() == (b"", b"")


@pytest.mark.asyncio
async def test_a_job_writing_while_a_reader_attaches_lands_after_what_waited():
    tty = Terminal()
    await tty.jobs.emit(Channel.STDOUT, b"one\n")
    await tty.jobs.emit(Channel.STDOUT, b"two\n")
    reader = _Stalled()
    attach = asyncio.create_task(tty.attach(reader))
    await reader.entered.wait()
    job = asyncio.create_task(tty.jobs.emit(Channel.STDOUT, b"meanwhile\n"))
    await asyncio.sleep(0)
    assert not job.done()
    reader.release.set()
    await attach
    await job
    assert await reader.snapshot(Channel.STDOUT) == b"one\ntwo\nmeanwhile\n"
    assert tty.reader is reader


@pytest.mark.asyncio
async def test_a_noisy_job_does_not_hold_a_reader_from_attaching():
    tty = Terminal()
    stop = asyncio.Event()
    job = asyncio.create_task(_write_until(tty, stop))
    await asyncio.sleep(0.01)
    reader = _Paced()
    await asyncio.wait_for(tty.attach(reader), 1)
    assert tty.reader is reader
    stop.set()
    await job
    lines = (await reader.snapshot(Channel.STDOUT)).decode().split()
    assert lines == [str(n) for n in range(1, len(lines) + 1)]


@pytest.mark.asyncio
async def test_a_line_ended_while_its_reader_attaches_never_attaches_it():
    tty = Terminal()
    await tty.jobs.emit(Channel.STDOUT, b"waited\n")
    reader = _Stalled()
    attach = asyncio.create_task(tty.attach(reader))
    await reader.entered.wait()
    job = asyncio.create_task(tty.jobs.emit(Channel.STDOUT, b"meanwhile\n"))
    await asyncio.sleep(0)
    tty.drop_line()
    await job
    reader.release.set()
    await attach
    assert tty.reader is None
    await tty.jobs.emit(Channel.STDOUT, b"later\n")
    assert tty.take() == (b"meanwhile\nlater\n", b"")


@pytest.mark.asyncio
async def test_an_abandoned_line_keeps_only_its_jobs_output():
    tty = Terminal()
    await tty.emit(Channel.STDOUT, b"line\n")
    await tty.jobs.emit(Channel.STDOUT, b"job\n")
    tty.drop_line()
    assert tty.take() == (b"job\n", b"")


@pytest.mark.asyncio
async def test_bounded_output_goes_back_ahead_of_later_output():
    tty = Terminal()
    await tty.emit(Channel.STDOUT, b"long line\n")
    out, err = tty.drain()
    await tty.jobs.emit(Channel.STDOUT, b"later\n")
    tty.put_back(out[:4], err)
    assert tty.take() == (b"longlater\n", b"")


@pytest.mark.asyncio
async def test_tee_keeps_the_console_and_copies_the_bytes():
    console, copy = JobConsole(), JobConsole()
    tee = Tee(console, copy)
    await tee.emit(Channel.STDOUT, b"x")
    assert await console.snapshot(Channel.STDOUT) == b"x"
    assert await copy.snapshot(Channel.STDOUT) == b"x"
