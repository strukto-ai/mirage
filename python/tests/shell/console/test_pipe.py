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

from mirage.shell.console.pipe import PipeConsole
from mirage.shell.console.types import Channel
from mirage.shell.errors import PipeClosed


@pytest.mark.asyncio
async def test_writes_are_buffered_before_the_reader_takes_them():
    pipe = PipeConsole()
    for chunk in (b"1\n", b"2\n", b"3\n"):
        await asyncio.wait_for(pipe.emit(Channel.STDOUT, chunk), 1)
    pipe.end()
    stream = pipe.stream()
    assert await anext(stream) == b"1\n"
    await stream.aclose()
    await pipe.drain()
    with pytest.raises(PipeClosed):
        await pipe.emit(Channel.STDOUT, b"4\n")


@pytest.mark.asyncio
async def test_reader_close_releases_a_draining_writer_and_refuses_more_output():
    pipe = PipeConsole()
    await asyncio.wait_for(pipe.emit(Channel.STDOUT, b"first"), 1)
    drain = asyncio.create_task(pipe.drain())
    stream = pipe.stream()
    assert await asyncio.wait_for(anext(stream), 1) == b"first"
    await asyncio.sleep(0)
    assert not drain.done()
    await stream.aclose()
    await asyncio.wait_for(drain, 1)
    with pytest.raises(PipeClosed):
        await pipe.emit(Channel.STDOUT, b"second")


@pytest.mark.asyncio
async def test_a_full_buffer_blocks_the_writer_until_the_reader_advances():
    pipe = PipeConsole()
    await pipe.emit(Channel.STDOUT, b"x" * 65536)
    writer = asyncio.create_task(pipe.emit(Channel.STDOUT, b"y"))
    await asyncio.sleep(0)
    assert not writer.done()
    stream = pipe.stream()
    assert len(await anext(stream)) == 16384
    await asyncio.wait_for(writer, 1)
    for _ in range(3):
        assert len(await anext(stream)) == 16384
    assert await anext(stream) == b"y"
    await stream.aclose()


@pytest.mark.asyncio
async def test_stderr_is_retained_without_waiting_for_a_stdout_reader():
    pipe = PipeConsole()
    await asyncio.wait_for(pipe.emit(Channel.STDERR, b"warning"), 1)
    assert await pipe.snapshot(Channel.STDERR) == b"warning"
