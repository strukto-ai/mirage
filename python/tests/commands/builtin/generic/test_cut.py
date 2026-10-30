import asyncio

import pytest

from mirage.commands.builtin.generic.cut import cut_config, cut_generic
from mirage.commands.config import Context
from mirage.io.stream import close_quietly
from mirage.io.types import IOResult, materialize
from mirage.types import FileStat, FileType, PathSpec


async def cut(paths, *, read_stream, stdin=None, flags=None):
    config = cut_config(flags or {})
    assert not isinstance(config, IOResult), config.stderr
    return await cut_generic(
        config,
        paths,
        Context(flags=flags or {}, stdin=stdin),
        _stat,
        read_stream,
    )


@pytest.mark.parametrize(
    "flags,stderr",
    [
        (
            {"fields": "-"},
            b"cut: invalid range with no endpoint: -\n"
            b"Try 'cut --help' for more information.\n",
        ),
        (
            {"fields": "1", "bytes": "2"},
            b"cut: only one type of list may be specified\n",
        ),
        (
            {"fields": "1", "delimiter": ",,"},
            b"cut: the delimiter must be a single character\n",
        ),
        (
            {"fields": "1", "whitespace_delimited": "tt"},
            b"cut: invalid argument 'tt' for '--whitespace-delimited'\n",
        ),
        (
            {"bytes": "1", "w": True},
            b"cut: '-w' is only meaningful with fields\n",
        ),
    ],
)
@pytest.mark.asyncio
async def test_cut_refuses_in_its_config_before_any_operand(flags, stderr):
    refusal = cut_config(flags)
    assert isinstance(refusal, IOResult)
    assert refusal.exit_code == 1
    assert await materialize(refusal.stderr) == stderr


@pytest.mark.asyncio
@pytest.mark.parametrize("value,expected", [(True, b"\n"), ("", b"a\n")])
async def test_cut_reads_a_bare_whitespace_delimited_apart_from_an_empty_word(
    value, expected
):
    output, io = await cut(
        [],
        read_stream=_no_stream,
        stdin=b" a  b\n",
        flags={"fields": "1", "whitespace_delimited": value},
    )
    assert (await materialize(output), io.exit_code) == (expected, 0)


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

    out, io = await cut(
        [PathSpec.from_str_path(p) for p in ("/missing", "/denied", "/good")],
        read_stream=source,
        flags={"fields": "1", "delimiter": ","},
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


@pytest.mark.asyncio
async def test_cut_preserves_a_bom_in_selected_fields():
    output, io = await cut(
        [],
        read_stream=_no_stream,
        stdin=b"\xef\xbb\xbfa,b\n",
        flags={"fields": "1", "delimiter": ","},
    )
    assert await materialize(output) == b"\xef\xbb\xbfa\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["bytes", "characters", "fields"])
async def test_cut_keeps_raw_delimiter_sentinels_distinct_from_replacement(
    mode,
):
    for source in (b"a\xffb\n", b"a\xef\xbf\xbdb\n"):
        output, io = await cut(
            [],
            read_stream=_no_stream,
            stdin=source,
            flags={mode: "1", "delimiter": "\udcff"},
        )
        assert io.exit_code == 0
        assert await materialize(output) == (
            source if mode == "fields" else b"a\n"
        )
    output, io = await cut(
        [],
        read_stream=_no_stream,
        stdin=b"a\xffb\n",
        flags={"fields": "1", "delimiter": "\udcff", "only_delimited": True},
    )
    assert io.exit_code == 0
    assert await materialize(output) == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["output_delimiter", "args_O"])
async def test_cut_writes_a_raw_output_delimiter_byte_as_typed(name):
    output, io = await cut(
        [],
        read_stream=_no_stream,
        stdin=b"abc\n",
        flags={"characters": "1,3", name: "\udcff"},
    )
    assert io.exit_code == 0
    assert await materialize(output) == b"a\xffc\n"


@pytest.mark.asyncio
async def test_cut_closes_stdin_when_output_is_never_started():
    closed = []

    class Source:
        def __aiter__(self):
            return self

        async def __anext__(self) -> bytes:
            raise AssertionError("input must remain unread")

        async def aclose(self) -> None:
            closed.append(True)

    output, _ = await cut(
        [], read_stream=_no_stream, stdin=Source(), flags={"bytes": "1"}
    )
    await close_quietly(output)
    await close_quietly(output)
    assert closed == [True]
