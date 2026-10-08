import pytest

from mirage.commands.builtin.generic.head import head, head_multi
from mirage.types import PathSpec


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
