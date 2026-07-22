import pytest

from mirage.commands.builtin.generic.cut import cut, parse_flags
from mirage.io.types import materialize


def _unused_read_stream(_path):
    raise AssertionError("read_stream should not be called for stdin input")


def test_multi_char_delimiter_is_rejected():
    with pytest.raises(ValueError,
                       match="delimiter must be a single character"):
        parse_flags({"d": ",,", "f": "1"})


def test_single_char_delimiter_is_accepted():
    parsed = parse_flags({"d": ",", "f": "1"})
    assert parsed.delimiter == ","


@pytest.mark.asyncio
async def test_multi_char_delimiter_exits_one():
    source, io = await cut(
        [],
        read_stream=_unused_read_stream,
        stdin=b"a,b\n",
        flags={
            "d": ",,",
            "f": "1"
        },
    )

    assert source is None
    assert io.exit_code == 1
    assert b"delimiter must be a single character" in await materialize(
        io.stderr)
