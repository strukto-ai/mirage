import pytest

from mirage.commands.builtin.generic.strings import strings
from mirage.io.types import materialize


async def _unused_read_stream(path):
    raise AssertionError(f"strings read {path} although stdin was given")


@pytest.mark.asyncio
async def test_strings_min_len_filter():
    binary = b"hi\x00longer_string\x00"
    output, _ = await strings(
        [], read_stream=_unused_read_stream, stdin=binary, min_len=5
    )
    decoded = (await materialize(output)).decode()
    assert "longer_string" in decoded
    assert "hi" not in decoded
