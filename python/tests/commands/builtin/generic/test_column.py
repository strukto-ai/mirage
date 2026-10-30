from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.column import column_generic
from mirage.commands.config import Context
from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.io.types import materialize
from mirage.types import PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize("streamed", [False, True])
async def test_column_accepts_bytes_and_streams(streamed):
    async def pieces():
        for byte in b"a 1\nlong 2\n":
            yield bytes([byte])

    def read(path):
        return pieces() if streamed else b"a 1\nlong 2\n"

    out, io = await column_generic(
        [PathSpec.from_str_path("/f")], [], Context(flags={"t": True}), read
    )
    assert await materialize(out) == b"a     1\nlong  2\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_column_feeds_large_operands_without_host_materialization():
    block = b" " * 16383 + b"\n"
    read_bytes = 0

    async def read(path) -> AsyncIterator[bytes]:
        nonlocal read_bytes
        for _ in range(2176):
            read_bytes += len(block)
            yield block

    async def run():
        out, io = await column_generic(
            [PathSpec.from_str_path("/f")],
            [],
            Context(flags={"t": True}),
            read,
        )
        assert await materialize(out) == b""
        assert io.exit_code == 0

    await run_with_memory(MemoryBudget(32 << 20, lambda: 0), run())
    assert read_bytes == 34 << 20
