import pytest

from mirage.commands.builtin.generic.tr import parse_flags, tr
from mirage.io.stream import materialize


def _unused_read_stream(_path):
    raise AssertionError("read_stream should not be called for stdin input")


async def _run(texts, flags, data):
    source, io = await tr(
        [],
        tuple(texts),
        read_stream=_unused_read_stream,
        stdin=data,
        flags=flags,
    )
    return io.exit_code, (await materialize(source)).decode()


def test_parse_flags_reads_short_and_long_forms():
    parsed = parse_flags({"complement": True, "delete": True})
    assert parsed.complement is True
    assert parsed.delete is True
    assert parse_flags({"C": True}).complement is True


@pytest.mark.asyncio
async def test_truncate_set1_truncates_to_set2_length():
    _, out = await _run(["abcde", "xy"], {"t": True}, b"abcde")
    assert out == "xycde"


@pytest.mark.asyncio
async def test_default_pads_set2_to_set1_length():
    _, out = await _run(["abcde", "xy"], {}, b"abcde")
    assert out == "xyyyy"


@pytest.mark.asyncio
async def test_complement_uppercase_C_matches_c():
    _, out = await _run(["0-9", "_"], {"C": True}, b"abc123")
    assert out == "___123"


@pytest.mark.asyncio
async def test_long_forms():
    _, comp = await _run(["0-9", "_"], {"complement": True}, b"abc123")
    assert comp == "___123"
    _, trunc = await _run(["abcde", "xy"], {"truncate_set1": True}, b"abcde")
    assert trunc == "xycde"
    _, deleted = await _run(["abc"], {"delete": True}, b"aabbccdd")
    assert deleted == "dd"
    _, squeezed = await _run(["a-c"], {"squeeze_repeats": True}, b"aabbcc")
    assert squeezed == "abc"
