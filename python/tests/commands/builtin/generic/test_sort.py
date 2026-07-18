import pytest

from mirage.commands.builtin.generic.sort import sort
from mirage.io.types import materialize
from mirage.types import PathSpec


async def _unused_read_bytes(_path: PathSpec) -> bytes:
    raise AssertionError("read_bytes should not be called")


@pytest.mark.asyncio
async def test_no_operand_uses_empty_standard_input():
    stdout, io = await sort([], read_bytes=_unused_read_bytes)

    assert await materialize(stdout) == b""
    assert io.exit_code == 0
