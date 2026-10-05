import pytest

from mirage.commands.builtin.generic.head import head


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
