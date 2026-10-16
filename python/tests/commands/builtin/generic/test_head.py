import asyncio

import pytest

from mirage.commands.builtin.generic.head import head, head_generic, head_multi
from mirage.commands.config import CommandOpts
from mirage.errors.fs import eacces, efbig
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec


async def _drain(gen):
    return b"".join([c async for c in gen])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chunks,flags,expected",
    [
        ([b"hel", b"lo wor", b"ld"], {"c": 8}, b"hello wo"),
        ([b"a\nb", b"\nc\nd\n"], {"n": 2}, b"a\nb\n"),
    ],
)
async def test_head_reads_across_chunks(chunks, flags, expected):
    async def src():
        for chunk in chunks:
            yield chunk

    assert await _drain(head(src(), **flags)) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,flags,expected",
    [
        (
            b"".join(b"%d\n" % i for i in range(1, 15)),
            {},
            b"".join(b"%d\n" % i for i in range(1, 11)),
        ),
        (b"a\nb\nc\nd\n", {"n": -1}, b"a\nb\nc\n"),
    ],
)
async def test_head_selects_lines(data, flags, expected):
    assert await _drain(head(data, **flags)) == expected


@pytest.mark.asyncio
async def test_head_stops_consuming_stream_after_n_lines():
    consumed = []

    async def src():
        for line in [b"a\n", b"b\n", b"c\n", b"d\n", b"e\n"]:
            consumed.append(line)
            yield line

    chunks = [c async for c in head(src(), n=2)]
    assert b"".join(chunks) == b"a\nb\n"
    assert consumed == [b"a\n", b"b\n"]


@pytest.mark.asyncio
@pytest.mark.parametrize("piece", [b"x", b""], ids=["unended", "empty"])
@pytest.mark.parametrize("n", [1, -1])
async def test_head_lets_a_cancel_into_ready_input(n, piece):
    # Every pull is ready and no line ends, so only the scan's own
    # checkpoint lets the loop run the cancel.
    async def src():
        for _ in range(2_000_000):
            yield piece

    loop = asyncio.get_running_loop()
    start = loop.time()
    task = asyncio.ensure_future(_drain(head(src(), n=n)))
    loop.call_later(0.005, task.cancel)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert loop.time() - start < 1


class _Tracked:
    """A source that remembers being closed; collection never closes it."""

    def __init__(self, *chunks: bytes) -> None:
        self.chunks = list(chunks)
        self.closed = False

    def __aiter__(self) -> "_Tracked":
        return self

    async def __anext__(self) -> bytes:
        if not self.chunks:
            raise StopAsyncIteration
        return self.chunks.pop(0)

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags", [{"c": 1}, {"n": 1}, {"n": 5}], ids=["bytes", "lines", "eof"]
)
async def test_head_closes_its_source_when_it_stops(flags):
    # At its limit or at the end alike: an unfinished read releases its
    # mount at once, not when the generator is collected.
    src = _Tracked(b"a\nb\n", b"c\n")
    await _drain(head(src, **flags))
    assert src.closed


@pytest.mark.asyncio
async def test_head_multi_closes_the_operand_its_reader_stopped_on():
    sources = {"/d/a": _Tracked(b"a\n" * 50), "/d/b": _Tracked(b"b\n")}
    paths = [PathSpec.from_str_path(p) for p in sources]
    out = head_multi(paths, read=lambda p: sources[p.virtual], n=20)
    await out.__anext__()
    await out.aclose()
    assert sources["/d/a"].closed
    assert not sources["/d/b"].closed


async def _file_stat(p: PathSpec) -> FileStat:
    return FileStat(name=p.virtual, type=FileType.FILE)


def _counted_reads(body: bytes, reads: list[str]):
    async def stream(p: PathSpec):
        reads.append(p.virtual)
        yield body

    return stream


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags, asked",
    [
        ({}, 10),
        ({"lines": "2"}, 2),
        ({"lines": "0"}, None),
        ({"lines": "-1"}, None),
        ({"bytes": "3"}, None),
        ({"lines": "2", "zero_terminated": True}, None),
    ],
)
async def test_head_asks_first_lines_for_a_line_count(flags, asked):
    reads: list[str] = []
    calls: list[int] = []

    async def first_lines(p: PathSpec, n: int) -> bytes:
        calls.append(n)
        return b"a\nb\n"

    out, io = await head_generic(
        [PathSpec.from_str_path("/t")],
        [],
        CommandOpts(flags=flags),
        _file_stat,
        _counted_reads(b"x\ny\nz\n", reads),
        first_lines,
    )
    data = await materialize(out)
    assert calls == ([] if asked is None else [asked])
    if asked is not None:
        assert (data, reads) == (b"a\nb\n", [])


@pytest.mark.asyncio
async def test_head_reads_a_file_first_lines_leaves_to_the_read():
    reads: list[str] = []

    async def first_lines(p: PathSpec, n: int) -> None:
        return None

    out, _ = await head_generic(
        [PathSpec.from_str_path("/t")],
        [],
        CommandOpts(flags={"lines": "2"}),
        _file_stat,
        _counted_reads(b"x\ny\nz\n", reads),
        first_lines,
    )
    assert await materialize(out) == b"x\ny\n"
    assert reads == ["/t"]


@pytest.mark.asyncio
async def test_head_reads_standard_input_without_first_lines():
    async def first_lines(p: PathSpec, n: int) -> bytes:
        raise AssertionError(f"asked first_lines of {p.virtual}")

    out, io = await head_generic(
        [PathSpec.from_str_path("-")],
        [],
        CommandOpts(flags={"lines": "1"}, stdin=b"in\nmore\n"),
        _file_stat,
        _counted_reads(b"", []),
        first_lines,
    )
    assert await materialize(out) == b"in\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_head_reports_a_failed_operand_and_prints_the_next():
    async def first_lines(p: PathSpec, n: int) -> bytes:
        if p.virtual == "/big":
            raise efbig(p)
        return b"ok\n"

    out, io = await head_generic(
        [PathSpec.from_str_path("/big"), PathSpec.from_str_path("/small")],
        [],
        CommandOpts(flags={"lines": "1"}),
        _file_stat,
        _counted_reads(b"", []),
        first_lines,
    )
    assert await materialize(out) == (b"==> /big <==\n\n==> /small <==\nok\n")
    assert io.exit_code == 1
    assert await materialize(io.stderr) == (
        b"head: error reading '/big': File too large\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "names,expected",
    [
        (["/locked", "/small"], b"==> /small <==\nok\n"),
        (
            ["/small", "/locked", "/small"],
            b"==> /small <==\nok\n\n==> /small <==\nok\n",
        ),
    ],
)
async def test_head_prints_no_header_for_an_operand_it_may_not_open(
    names, expected
):
    async def first_lines(p: PathSpec, n: int) -> bytes:
        if p.virtual == "/locked":
            raise eacces(p)
        return b"ok\n"

    out, io = await head_generic(
        [PathSpec.from_str_path(name) for name in names],
        [],
        CommandOpts(flags={"lines": "1"}),
        _file_stat,
        _counted_reads(b"", []),
        first_lines,
    )
    assert await materialize(out) == expected
    assert io.exit_code == 1
    assert await materialize(io.stderr) == (
        b"head: cannot open '/locked' for reading: Permission denied\n"
    )
