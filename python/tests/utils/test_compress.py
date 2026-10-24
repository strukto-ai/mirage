# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
import asyncio
import gzip
import random
import zlib

import pytest

from mirage.io import yield_budget
from mirage.io.stream import yield_bytes
from mirage.io.types import materialize
from mirage.utils.compress import (
    GzipDataError,
    gunzip_stream,
    gzip_compress_stream,
)

pytestmark = pytest.mark.asyncio

GZIP_CHUNK_SIZE = 65536
GZIP_CRC = "\ngzip: {}: invalid compressed data--crc error"
GZIP_LENGTH = "\ngzip: {}: invalid compressed data--length error"


async def gunzip_partial(
    data: bytes, passthrough: bool = False
) -> tuple[bytes, GzipDataError | None]:
    parts: list[bytes] = []
    try:
        async for part in gunzip_stream(
            yield_bytes(data), passthrough=passthrough
        ):
            parts.append(part)
    except GzipDataError as exc:
        return b"".join(parts), exc
    return b"".join(parts), None


HELLO = gzip.compress(b"hello\n", mtime=0)
HCRC_HEAD = HELLO[:3] + b"\x02" + HELLO[4:10]


class FailingCloseSource:
    def __init__(self):
        self.read = False
        self.closed = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.read:
            raise StopAsyncIteration
        self.read = True
        return b"not gzip"

    async def aclose(self):
        self.closed += 1
        raise OSError("cleanup failure")


async def test_cleanup_failure_preserves_the_gzip_failure_and_closes_once():
    source = FailingCloseSource()
    with pytest.raises(GzipDataError, match="not in gzip format"):
        await materialize(gunzip_stream(source))
    assert source.closed == 1


async def test_every_member_decompresses():
    assert (await gunzip_partial(HELLO + HELLO)) == (b"hello\nhello\n", None)


@pytest.mark.parametrize(
    "data,reason,fatal",
    [
        (b"", "\ngzip: f: unexpected end of file\n", True),
        (b"x", "\ngzip: f: unexpected end of file\n", True),
        (b"hello\n", "\ngzip: f: not in gzip format\n", False),
        (HELLO[:10], "\ngzip: f: unexpected end of file\n", True),
        (HELLO[:-3], "\ngzip: f: unexpected end of file\n", True),
        (
            b"\x1f\x8b\x08\x00garbage-here",
            "\ngzip: f: invalid compressed data--format violated\n",
            True,
        ),
        (
            b"\x1f\x8b\x07",
            "gzip: f: unknown method 7 -- not supported\n",
            False,
        ),
        (
            b"\x1f\x8b\x08\x20",
            "gzip: f is encrypted -- not supported\n",
            False,
        ),
        (
            b"\x1f\x8b\x08\x48",
            "gzip: f has flags 0x48 -- not supported\n",
            False,
        ),
        (
            HCRC_HEAD + b"\0\0" + HELLO[10:],
            "gzip: f: header checksum 0x0000 != computed checksum "
            f"0x{zlib.crc32(HCRC_HEAD) & 0xFFFF:04x}\n",
            False,
        ),
    ],
)
async def test_refusals_carry_gzips_reason_and_severity(data, reason, fatal):
    # gzip 1.13: no header, or a header gzip does not support, is
    # reported and skipped, while a short, truncated or corrupt input
    # ends the run. Only the header refusals come without gzip's leading
    # newline.
    _, failure = await gunzip_partial(data)
    assert (failure.render("f"), failure.fatal) == (reason, fatal)


async def test_optional_header_fields_are_skipped():
    flags = 0x02 | 0x04 | 0x08 | 0x10
    head = HELLO[:3] + bytes([flags]) + HELLO[4:10]
    head += b"\x03\x00abc" + b"name\0" + b"comment\0"
    head += (zlib.crc32(head) & 0xFFFF).to_bytes(2, "little")
    assert (await gunzip_partial(head + HELLO[10:])) == (b"hello\n", None)


@pytest.mark.parametrize(
    "trailer,reasons",
    [
        (b"\0" * 8, (GZIP_CRC, GZIP_LENGTH)),
        (b"\0" * 4 + HELLO[-4:], (GZIP_CRC,)),
        (HELLO[-8:-4] + b"\0" * 4, (GZIP_LENGTH,)),
    ],
)
async def test_trailer_mismatch_follows_the_inflated_bytes(trailer, reasons):
    # gzip 1.13 writes what it inflated, then names each mismatch.

    decoded = gunzip_stream(yield_bytes(HELLO[:-8] + trailer + HELLO))
    assert await anext(decoded) == b"hello\n"
    with pytest.raises(GzipDataError) as exc:
        await anext(decoded)
    assert (exc.value.reasons, exc.value.fatal) == (reasons, True)


async def test_trailer_mismatch_only_skips_the_input_under_test():
    with pytest.raises(GzipDataError) as exc:
        await materialize(
            gunzip_stream(yield_bytes(HELLO[:-8] + b"\0" * 8), test=True)
        )
    assert not exc.value.fatal


@pytest.mark.parametrize(
    "data,decoded,keeps",
    [
        (HELLO + b"junk", b"hello\n", True),
        (HELLO[:-8] + b"\0" * 8, b"hello\n", True),
        (HELLO + HELLO[:-3], b"hello\nhello\n", True),
    ],
)
async def test_partial_keeps_what_gzip_wrote_before_it_stopped(
    data, decoded, keeps
):
    out, failure = await gunzip_partial(data)
    assert (out, failure.keeps_output) == (decoded, keeps)
    assert (await gunzip_partial(HELLO)) == (b"hello\n", None)


@pytest.mark.parametrize(
    "data,keeps",
    [
        (HELLO[:2] + b"\x07" + HELLO[3:], False),
        (HELLO + HELLO[:2] + b"\x07" + HELLO[3:], True),
        (gzip.compress(b"", mtime=0) + HELLO[:2] + b"\x07", True),
        (HELLO + b"junk", True),
    ],
)
async def test_a_later_members_refusal_keeps_the_members_before_it(
    data, keeps
):
    _, failure = await gunzip_partial(data)
    assert (failure.fatal, failure.keeps_output) == (False, keeps)


@pytest.mark.parametrize("width", [1, 7, 65536])
async def test_member_headers_trailers_and_padding_across_chunks(width):
    data = HELLO + HELLO + b"\0\0"

    async def source():
        for offset in range(0, len(data), width):
            yield data[offset : offset + width]

    assert await materialize(gunzip_stream(source())) == b"hello\nhello\n"


async def test_expansion_yields_bounded_chunks_before_reading_more_input():
    archive = gzip.compress(b"x" * (GZIP_CHUNK_SIZE * 20))
    reads = []
    closed = []

    async def source():
        try:
            reads.append(1)
            yield archive
            reads.append(2)
            yield HELLO
        finally:
            closed.append(True)

    compressed = source()
    decoded = gunzip_stream(compressed)
    assert await anext(decoded) == b"x" * GZIP_CHUNK_SIZE
    assert reads == [1]
    await decoded.aclose()
    assert reads == [1]
    assert closed == [True]


@pytest.mark.parametrize("data", [b"not gzip", HELLO[:-8] + b"\0" * 8])
async def test_decode_failure_awaits_source_cleanup(data):
    closing, release, closed = (asyncio.Event() for _ in range(3))

    async def source():
        try:
            yield data
            raise AssertionError("read past corrupt member")
        finally:
            closing.set()
            await release.wait()
            closed.set()

    compressed = source()
    decoding = asyncio.create_task(materialize(gunzip_stream(compressed)))
    try:
        await asyncio.wait_for(closing.wait(), 1)
        assert not decoding.done()
        assert not closed.is_set()
        release.set()
        with pytest.raises(GzipDataError):
            await decoding
        assert closed.is_set()
    finally:
        release.set()
        await asyncio.gather(decoding, return_exceptions=True)
        await compressed.aclose()


async def test_trailing_warning_follows_valid_output():
    decoded = gunzip_stream(yield_bytes(HELLO + b"junk"))
    assert await anext(decoded) == b"hello\n"
    with pytest.raises(GzipDataError) as exc:
        await anext(decoded)
    assert exc.value.exit_code == 2
    assert not exc.value.fatal


async def test_large_member_preserves_buffered_output():
    data = b"x" * (GZIP_CHUNK_SIZE * 20 + 13)
    assert (await gunzip_partial(gzip.compress(data))) == (data, None)


@pytest.mark.parametrize(
    "data,keeps",
    [
        (HELLO[:-8], True),
        (HELLO[:-3], True),
        (HELLO + HELLO[:2], True),
        (HELLO[:2], False),
        (HELLO + HELLO[:10], False),
        (HELLO[:-9], False),
    ],
)
@pytest.mark.parametrize("width", [1, 7, 65536])
async def test_eof_distinguishes_complete_bodies_from_partial_ones(
    data, keeps, width
):
    exhausted = False

    async def source():
        nonlocal exhausted
        for offset in range(0, len(data), width):
            yield data[offset : offset + width]
        exhausted = True

    with pytest.raises(GzipDataError) as exc:
        await materialize(gunzip_stream(source()))
    assert exhausted
    assert exc.value.fatal
    assert exc.value.keeps_output is keeps


@pytest.mark.parametrize("width", [1, 7, 65536])
@pytest.mark.parametrize("fields", [b"\0\0\0\0", b"\x03\0abcname\0comment\0"])
async def test_optional_fields_and_header_crc_across_chunks(width, fields):
    head = HELLO[:3] + b"\x1e" + HELLO[4:10] + fields
    member = (
        head + (zlib.crc32(head) & 0xFFFF).to_bytes(2, "little") + HELLO[10:]
    )
    data = member + member

    async def source():
        for offset in range(0, len(data), width):
            yield data[offset : offset + width]

    assert await materialize(gunzip_stream(source())) == b"hello\nhello\n"


@pytest.mark.parametrize("flag", [0x04, 0x08, 0x10, 0x02])
@pytest.mark.parametrize("prefix", [b"", HELLO])
async def test_eof_in_consumed_optional_fields_is_still_fatal(flag, prefix):
    head = HELLO[:3] + bytes([flag]) + HELLO[4:10]
    extra = b"\xff\xffabc" if flag == 0x04 else b""
    with pytest.raises(GzipDataError) as exc:
        await materialize(gunzip_stream(yield_bytes(prefix + head + extra)))
    assert exc.value.fatal
    assert exc.value.keeps_output is bool(prefix)


@pytest.mark.parametrize("flag", [0x08, 0x10])
@pytest.mark.parametrize("terminated", [False, True])
async def test_long_header_fields_use_bounded_memory(flag, terminated):
    head = HELLO[:3] + bytes([flag | 0x02]) + HELLO[4:10]
    chunk = b"x" * GZIP_CHUNK_SIZE

    async def source():
        yield head
        crc = zlib.crc32(head)
        for _ in range(128):
            yield chunk
            crc = zlib.crc32(chunk, crc)
        if terminated:
            crc = zlib.crc32(b"\0", crc) & 0xFFFF
            yield b"\0" + crc.to_bytes(2, "little") + HELLO[10:]

    decoded = gunzip_stream(source())
    if terminated:
        assert await materialize(decoded) == b"hello\n"
    else:
        with pytest.raises(GzipDataError, match="unexpected end of file"):
            await materialize(decoded)


async def test_named_gzip_header_moves_the_truncation_boundary():
    named = await materialize(
        gzip_compress_stream(yield_bytes(b"hello\nworld\n"), -1, name="a.txt")
    )
    assert named[3] & 8
    assert named[10:16] == b"a.txt\0"
    data, failure = await gunzip_partial(named[:20])
    assert data == b"hel"
    assert failure is not None
    assert (await gunzip_partial(named)) == (b"hello\nworld\n", None)
    unnamed = await materialize(
        gzip_compress_stream(yield_bytes(b"hello\nworld\n"), -1)
    )
    assert (await gunzip_partial(unnamed[:20]))[0] == b"hello\nwor"


@pytest.mark.parametrize("level", [-1, 1, 9])
async def test_gzip_stream_bounds_incompressible_output(level):
    data = random.Random(42).randbytes(512 * 1024)

    parts = [
        part async for part in gzip_compress_stream(yield_bytes(data), level)
    ]
    assert max(map(len, parts)) <= 16384
    assert gzip.decompress(b"".join(parts)) == data


async def test_gzip_stream_produces_output_before_eof_and_closes_its_source():
    closed = []

    async def source():
        try:
            yield b"hello"
            raise AssertionError("read past first output")
        finally:
            closed.append(True)

    stream = gzip_compress_stream(source(), -1)
    assert (await anext(stream))[:2] == b"\x1f\x8b"
    await stream.aclose()
    assert closed == [True]


async def test_output_only_draining_yields_to_cancellation_and_closes_source(
    monkeypatch,
):
    monkeypatch.setattr(yield_budget, "YIELD_SWITCHES", 0)
    size = GZIP_CHUNK_SIZE * 20
    archive = gzip.compress(b"x" * size)
    first_output = asyncio.Event()
    closed = asyncio.Event()
    written = 0

    async def source():
        try:
            yield archive
        finally:
            closed.set()

    async def consume():
        nonlocal written
        async for data in gunzip_stream(source()):
            written += len(data)
            first_output.set()

    task = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(first_output.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert 0 < written < size
        assert closed.is_set()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
