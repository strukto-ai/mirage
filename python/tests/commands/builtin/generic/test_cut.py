import asyncio

import pytest

from mirage.commands.builtin.generic.cut import cut, cut_generic, parse_flags
from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec


def test_multi_char_delimiter_is_rejected():
    with pytest.raises(
        ValueError, match="delimiter must be a single character"
    ):
        parse_flags({"delimiter": ",,", "fields": "1"})


def test_single_char_delimiter_is_accepted():
    parsed = parse_flags({"delimiter": ",", "fields": "1"})
    assert parsed.delimiter == ","


# `--whitespace-delimited` has one candidate, so a word choice accepts any
# prefix of it. The refusal keeps cut's own one-line wording; GNU cut has
# no such option, so the rows below are the general rule's answer rather
# than a measured one, and the empty word (which the general rule
# ACCEPTS against a sole candidate) is deliberately not pinned either
# way.
@pytest.mark.parametrize("value", ["trimmed", "trim", "t"])
def test_whitespace_delimited_accepts_an_unambiguous_prefix(value):
    assert (
        parse_flags({"fields": "1", "whitespace_delimited": value}).whitespace
        == "trimmed"
    )


def test_whitespace_delimited_still_refuses_an_unmatched_word():
    with pytest.raises(ValueError) as exc:
        parse_flags({"fields": "1", "whitespace_delimited": "tt"})
    assert str(exc.value) == (
        "cut: invalid argument 'tt' for '--whitespace-delimited'"
    )


async def _no_stream(_path):
    raise AssertionError("cut read with no operand")
    yield b""


@pytest.mark.asyncio
async def test_cut_without_stdin_reads_empty_input():
    out, io = await cut([], read_stream=_no_stream, flags={"fields": "1"})
    assert (await materialize(out), io.exit_code) == (b"", 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("separator", [b"\n", b"\0"])
async def test_cut_emits_a_record_before_reading_the_tail_and_closes(
    separator,
):
    closed = False

    async def source():
        nonlocal closed
        try:
            yield b"left,right" + separator
            raise AssertionError("cut fetched the tail")
        finally:
            closed = True

    output, _ = await cut(
        [],
        read_stream=_no_stream,
        stdin=source(),
        flags={
            "fields": "2",
            "delimiter": ",",
            "zero_terminated": separator == b"\0",
        },
    )
    try:
        assert await anext(output) == b"right" + separator
    finally:
        await output.aclose()
    assert closed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,expected",
    [
        (b"a,b\nc,d\n", b"b\nd\n"),
        (b"a,b\nc,d", b"b\nd\n"),
        (b"a,b\0c,d\0", b"b\0d\0"),
        (b"", b""),
    ],
)
async def test_cut_records_survive_one_byte_chunks(data, expected):
    async def source():
        for byte in data:
            yield bytes([byte])

    output, _ = await cut(
        [],
        read_stream=_no_stream,
        stdin=source(),
        flags={
            "fields": "2",
            "delimiter": ",",
            "zero_terminated": b"\0" in data,
        },
    )
    assert await materialize(output) == expected


async def _stat(path: PathSpec) -> FileStat:
    if path.virtual == "/missing":
        raise FileNotFoundError(path.virtual)
    return FileStat(name=path.virtual, type=FileType.FILE)


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", [b"", b"first,x\n"])
async def test_cut_reports_late_read_errors_and_continues(prefix):
    closed = []

    async def source(path):
        try:
            if path.virtual == "/denied":
                if prefix:
                    yield prefix
                raise PermissionError(path.virtual)
            yield b"good,x\n"
        finally:
            closed.append(path.virtual)

    out, io = await cut_generic(
        [PathSpec.from_str_path(p) for p in ("/missing", "/denied", "/good")],
        [],
        Context(flags={"fields": "1", "delimiter": ","}),
        _stat,
        source,
    )
    assert (
        await materialize(out) == (b"first\n" if prefix else b"") + b"good\n"
    )
    assert await materialize(io.stderr) == (
        b"cut: /missing: No such file or directory\n"
        b"cut: /denied: Permission denied\n"
    )
    assert io.exit_code == 1
    assert closed == ["/denied", "/good"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error", [RuntimeError("backend failed"), asyncio.CancelledError()]
)
async def test_cut_does_not_continue_after_fatal_error_or_cancellation(error):
    opened = []

    async def source(path):
        opened.append(path.virtual)
        raise error
        yield b""

    out, _ = await cut(
        [PathSpec.from_str_path(p) for p in ("/failed", "/untouched")],
        read_stream=source,
        flags={"fields": "1"},
    )
    with pytest.raises(type(error)):
        await materialize(out)
    assert opened == ["/failed"]
