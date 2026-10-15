import pytest

from mirage.commands.builtin.generic.unexpand import (
    unexpand,
)
from mirage.io.stream import close_quietly
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_first_output_closes_inputs_without_reading_the_tail():
    opened = []
    closed = []

    async def source(path):
        opened.append(path.virtual)
        try:
            yield b"        b\n"
            raise AssertionError(
                "stream fetched the tail before its first output"
            )
        finally:
            closed.append(path.virtual)

    paths = [PathSpec.from_str_path(f"/input{i}") for i in range(1)]
    output, io = await unexpand(paths, read_stream=source)
    try:
        assert await anext(output) == b"\tb\n"
    finally:
        await close_quietly(output)
    assert len(opened) == 1
    assert sorted(closed) == sorted(opened)
    assert io.exit_code == 0
