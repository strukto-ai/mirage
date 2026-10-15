import pytest

from mirage.commands.builtin.generic.rev import rev
from mirage.io.types import materialize


async def _unused_read_stream(path):
    raise AssertionError(f"rev read {path} although it had no operand")


@pytest.mark.asyncio
async def test_rev_without_stdin_reads_empty_input():
    out, io = await rev([], read_stream=_unused_read_stream)
    assert (await materialize(out), io.exit_code) == (b"", 0)
