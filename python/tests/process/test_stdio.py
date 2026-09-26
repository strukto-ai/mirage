import asyncio
from collections.abc import AsyncIterator

import pytest

from mirage.process.stdio import ProcessInput, ProcessOutput
from mirage.shell.console import Channel
from mirage.shell.errors import PipeClosed


async def _read(stream: AsyncIterator[bytes]) -> bytes:
    return b"".join([chunk async for chunk in stream])


@pytest.mark.asyncio
async def test_input_counts_what_its_reader_consumed():
    pipe = ProcessInput()
    reader = asyncio.ensure_future(_read(pipe.stream()))
    await pipe.write(b"x" * 200000)
    pipe.close()
    assert await reader == b"x" * 200000
    assert pipe.bytes_read == 200000


@pytest.mark.asyncio
async def test_a_closed_input_refuses_writes():
    pipe = ProcessInput()
    pipe.close()
    await pipe.write(b"")
    with pytest.raises(PipeClosed):
        await pipe.write(b"late")


@pytest.mark.asyncio
async def test_output_routes_stderr_to_its_own_pipe_unless_merged():
    for merged, expected in ((False, (b"out", b"err")), (True, (b"outerr",
                                                                b""))):
        output = ProcessOutput(merge_stderr=merged)
        reads = asyncio.gather(_read(output.stdout.stream()),
                               _read(output.stderr.stream()))
        await output.emit(Channel.STDOUT, b"out")
        await output.emit(Channel.STDERR, b"err")
        output.end()
        assert tuple(await reads) == expected
