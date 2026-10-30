import gzip

import pytest

from mirage.commands.builtin.generic.zgrep import zgrep_generic
from mirage.io.stream import close_quietly, ensure_stream
from mirage.types import PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,expected",
    [
        ({"count": True}, b"2\n"),
        ({"files_with_matches": True}, b"/f.gz\n"),
        ({"only_matching": True}, b"hello\n"),
    ],
)
async def test_early_close_settles_status_and_closes_the_reader(
    flags, expected
):
    closed = False
    reads = 0
    compressed = gzip.compress(b"hello\n")

    async def read(path):
        nonlocal closed, reads
        try:
            for _ in range(2):
                reads += 1
                yield compressed
        finally:
            closed = True

    body, io = await zgrep_generic(
        [PathSpec.from_str_path("/f.gz")], ["hello"], flags, read=read
    )
    output = ensure_stream(body)
    try:
        assert await anext(output) == expected
    finally:
        await close_quietly(output)
    assert io.exit_code == 0
    assert await io.materialize_stderr() == b""
    assert closed
    assert reads == (2 if flags.get("count") else 1)


@pytest.mark.asyncio
async def test_early_close_keeps_a_trailer_failure_and_its_diagnostic():
    damaged = bytearray(gzip.compress(b"hello\n"))
    damaged[-8] ^= 1

    async def read(path):
        yield bytes(damaged)

    body, io = await zgrep_generic(
        [PathSpec.from_str_path("/f.gz")],
        ["hello"],
        {"count": True},
        read=read,
    )
    output = ensure_stream(body)
    try:
        assert await anext(output) == b"1\n"
    finally:
        await close_quietly(output)
    assert io.exit_code == 2
    assert b"crc error" in await io.materialize_stderr()
