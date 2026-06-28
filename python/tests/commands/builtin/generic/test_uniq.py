import pytest

from mirage.commands.builtin.generic.uniq import _parse_count, uniq
from mirage.types import PathSpec


def _unused_read_stream(_accessor, _path):
    raise AssertionError("read_stream should not be called for stdin input")


async def _generator_read_stream(_accessor, _path):
    yield b"dup\ndup\nsolo\n"


async def _collect(stdin: bytes, **kwargs) -> bytes:
    source, _io = await uniq(
        [],
        read_stream=_unused_read_stream,
        stdin=stdin,
        **kwargs,
    )
    chunks = [chunk async for chunk in source]
    return b"".join(chunks)


def test_parse_count_unset_is_none():
    assert _parse_count(None) is None


def test_parse_count_zero_string():
    assert _parse_count("0") == 0


def test_parse_count_positive():
    assert _parse_count("3") == 3


def test_parse_count_negative_raises():
    with pytest.raises(ValueError, match="invalid count"):
        _parse_count("-1")


@pytest.mark.asyncio
async def test_skip_fields_unset_matches_zero():
    data = b"a one\nb one\n"
    unset = await _collect(data)
    zero = await _collect(data, skip_fields="0")
    assert unset == zero == b"a one\nb one\n"


@pytest.mark.asyncio
async def test_skip_fields_collapses_on_second_field():
    data = b"a shared\nb shared\n"
    out = await _collect(data, skip_fields="1")
    assert out == b"a shared\n"


@pytest.mark.asyncio
async def test_skip_chars_offset():
    data = b"Xfoo\nYfoo\n"
    out = await _collect(data, skip_chars="1")
    assert out == b"Xfoo\n"


@pytest.mark.asyncio
async def test_check_chars_limits_comparison():
    data = b"abcAAA\nabcBBB\n"
    out = await _collect(data, check_chars="3")
    assert out == b"abcAAA\n"


@pytest.mark.asyncio
async def test_check_chars_unset_compares_full_line():
    data = b"abcAAA\nabcBBB\n"
    out = await _collect(data)
    assert out == b"abcAAA\nabcBBB\n"


@pytest.mark.asyncio
async def test_check_chars_zero_string_treats_all_lines_as_duplicates():
    # GNU: -w 0 compares zero characters, so every line matches the first
    data = b"abcAAA\nabcBBB\n"
    out = await _collect(data, check_chars="0")
    assert out == b"abcAAA\n"


@pytest.mark.asyncio
async def test_count_prefixes_occurrences():
    data = b"dup\ndup\nsolo\n"
    out = await _collect(data, count=True)
    assert out == b"      2 dup\n      1 solo\n"


@pytest.mark.asyncio
async def test_ignore_case_folds_duplicates():
    data = b"Hello\nhello\n"
    out = await _collect(data, ignore_case=True)
    assert out == b"Hello\n"


@pytest.mark.asyncio
async def test_read_stream_async_generator():
    p = PathSpec(original="/x", directory="/x")
    source, _io = await uniq([p], read_stream=_generator_read_stream)
    out = b"".join([chunk async for chunk in source])
    assert out == b"dup\nsolo\n"
