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

from mirage.shell.console.config import KILLED_OUTCOME, Channel, exit_outcome
from mirage.shell.console.job_console import JobConsole
from mirage.shell.console.ram import RAMConsoleStore


@pytest.fixture
def console():
    return JobConsole()


@pytest.mark.asyncio
async def test_wait_finished_survives_an_outcome_bigger_than_the_budget():
    """Retention must never evict the terminal chunk, or this blocks."""
    console = JobConsole(RAMConsoleStore(max_bytes=2))
    await console.emit(Channel.STDOUT, b"payload")
    await console.finish(exit_outcome(0))

    await asyncio.wait_for(console.wait_finished(), timeout=1)


@pytest.mark.asyncio
async def test_emit_then_read_from_the_start(console):
    await console.emit(Channel.STDOUT, b"hello\n")
    await console.emit(Channel.STDERR, b"oops\n")

    chunks, next_seq, _ = await console.read_from(0)

    assert [(c.channel, c.data) for c in chunks] == [
        (Channel.STDOUT, b"hello\n"),
        (Channel.STDERR, b"oops\n"),
    ]
    assert next_seq == 2


@pytest.mark.asyncio
async def test_reading_twice_from_the_cursor_yields_each_chunk_once(console):
    await console.emit(Channel.STDOUT, b"first")
    _, cursor, _ = await console.read_from(0)
    await console.emit(Channel.STDOUT, b"second")

    chunks, _, _ = await console.read_from(cursor)

    assert [c.data for c in chunks] == [b"second"]


@pytest.mark.asyncio
async def test_channels_interleave_in_production_order(console):
    await console.emit(Channel.STDOUT, b"one\n")
    await console.emit(Channel.STDERR, b"two\n")
    await console.emit(Channel.STDOUT, b"three\n")

    assert await console.snapshot() == b"one\ntwo\nthree\n"


@pytest.mark.asyncio
async def test_snapshot_can_select_one_channel(console):
    await console.emit(Channel.STDOUT, b"out")
    await console.emit(Channel.STDERR, b"err")

    assert await console.snapshot(Channel.STDOUT) == b"out"
    assert await console.snapshot(Channel.STDERR) == b"err"


@pytest.mark.asyncio
async def test_snapshot_omits_the_control_chunk(console):
    await console.emit(Channel.STDOUT, b"out")
    await console.finish(exit_outcome(0))

    assert await console.snapshot() == b"out"


@pytest.mark.asyncio
async def test_finish_records_the_outcome_as_a_chunk(console):
    await console.finish(exit_outcome(3))

    chunks, _, _ = await console.read_from(0)

    assert [(c.channel, c.data) for c in chunks] == [
        (Channel.CONTROL, b"exit:3"),
    ]
    assert console.finished


@pytest.mark.asyncio
async def test_finish_is_idempotent(console):
    await console.finish(exit_outcome(0))
    await console.finish(KILLED_OUTCOME)

    chunks, _, _ = await console.read_from(0)

    assert [c.data for c in chunks] == [b"exit:0"]


@pytest.mark.asyncio
async def test_follow_ends_at_the_control_chunk(console):
    await console.emit(Channel.STDOUT, b"a")
    await console.finish(exit_outcome(0))

    seen = [chunk.data async for chunk in console.follow()]

    assert seen == [b"a", b"exit:0"]


@pytest.mark.asyncio
async def test_follow_delivers_chunks_as_they_arrive(console):
    seen: list[bytes] = []

    async def _consume() -> None:
        async for chunk in console.follow():
            seen.append(chunk.data)

    follower = asyncio.create_task(_consume())
    await asyncio.sleep(0)

    await console.emit(Channel.STDOUT, b"early")
    while not seen:
        await asyncio.sleep(0)
    assert seen == [b"early"]
    assert not follower.done()

    await console.finish(exit_outcome(0))
    await asyncio.wait_for(follower, timeout=1)
    assert seen == [b"early", b"exit:0"]


@pytest.mark.asyncio
async def test_follow_can_start_from_a_later_cursor(console):
    await console.emit(Channel.STDOUT, b"skipped")
    await console.emit(Channel.STDOUT, b"kept")
    await console.finish(exit_outcome(0))

    seen = [chunk.data async for chunk in console.follow(1)]

    assert seen == [b"kept", b"exit:0"]


@pytest.mark.asyncio
async def test_wait_finished_returns_once_the_job_ends(console):
    joiner = asyncio.create_task(console.wait_finished())
    await asyncio.sleep(0)
    assert not joiner.done()

    await console.finish(exit_outcome(0))

    await asyncio.wait_for(joiner, timeout=1)


@pytest.mark.asyncio
async def test_wait_finished_returns_immediately_when_already_finished(
        console):
    await console.finish(exit_outcome(0))

    await asyncio.wait_for(console.wait_finished(), timeout=1)


@pytest.mark.asyncio
async def test_truncation_surfaces_to_the_reader():
    console = JobConsole(RAMConsoleStore(max_bytes=2))
    for payload in (b"a", b"b", b"c"):
        await console.emit(Channel.STDOUT, payload)

    chunks, _, truncated = await console.read_from(0)

    assert truncated
    assert [c.data for c in chunks] == [b"b", b"c"]
