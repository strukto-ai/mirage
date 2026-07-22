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

from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.shell.job_table import Job
from mirage.workspace.executor.jobs import _drain_into


def _job() -> Job:
    return Job(id=1, command="stream", task=None, cwd="/")


async def _yield_on_demand(gate: asyncio.Event):
    yield b"first\n"
    await gate.wait()
    yield b"second\n"


@pytest.mark.asyncio
async def test_drain_into_appends_bytes():
    job = _job()

    await _drain_into(job, b"done\n")

    assert job.stdout == b"done\n"


@pytest.mark.asyncio
async def test_drain_into_tolerates_no_output():
    job = _job()

    await _drain_into(job, None)

    assert job.stdout == b""


@pytest.mark.asyncio
async def test_drain_into_appends_before_the_stream_ends():
    """The point of the whole exercise: output is visible while running."""
    job = _job()
    gate = asyncio.Event()

    task = asyncio.create_task(_drain_into(job, _yield_on_demand(gate)))
    while not job.stdout:
        await asyncio.sleep(0)

    assert job.stdout == b"first\n"
    assert not task.done()

    gate.set()
    await task
    assert job.stdout == b"first\nsecond\n"


@pytest.mark.asyncio
async def test_drain_into_buffers_a_cachable_iterator():
    """Iterating must drain the cache wrapper as materialize would."""
    job = _job()
    gate = asyncio.Event()
    gate.set()
    stream = CachableAsyncIterator(_yield_on_demand(gate))

    await _drain_into(job, stream)

    assert job.stdout == b"first\nsecond\n"
    assert stream.exhausted
    assert b"".join(stream.buffered_chunks) == b"first\nsecond\n"


@pytest.mark.asyncio
async def test_drain_into_consumes_the_stream_without_a_job():
    """A command with no job table still runs for its side effects."""
    gate = asyncio.Event()
    gate.set()
    stream = CachableAsyncIterator(_yield_on_demand(gate))

    await _drain_into(None, stream)

    assert stream.exhausted
