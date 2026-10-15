import pytest

from mirage.commands.builtin.generic.md5 import md5
from mirage.io.types import materialize


async def _unused_read_bytes(path):
    raise AssertionError(f"md5 read {path} although it had no operand")


@pytest.mark.asyncio
async def test_md5_without_stdin_hashes_empty_input():
    out, _ = await md5([], read_stream=_unused_read_bytes)
    assert await materialize(out) == b"d41d8cd98f00b204e9800998ecf8427e  -\n"
