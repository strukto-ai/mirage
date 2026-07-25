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


@pytest.mark.asyncio
async def test_zero_field_keydef_exits_two():
    stdout, io = await sort([],
                            read_bytes=_unused_read_bytes,
                            stdin=b"a\nb\n",
                            key_defs=["0"])

    assert await materialize(stdout) == b""
    assert io.exit_code == 2
    assert b"field number is zero" in await materialize(io.stderr)
