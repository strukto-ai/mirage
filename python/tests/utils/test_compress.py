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
import gzip
import zlib

import pytest

from mirage.io.types import materialize
from mirage.utils.compress import (GZIP_CHUNK_SIZE, GZIP_CRC, GZIP_LENGTH,
                                   GzipDecoder, gunzip_checked, gunzip_partial,
                                   gunzip_stream)
from mirage.utils.errors import GzipDataError

HELLO = gzip.compress(b"hello\n", mtime=0)
HCRC_HEAD = HELLO[:3] + b"\x02" + HELLO[4:10]


def test_every_member_decompresses():
    assert gunzip_checked(HELLO + HELLO) == b"hello\nhello\n"


@pytest.mark.parametrize("data,reason,fatal", [
    (b"", "gzip: f: unexpected end of file\n", True),
    (b"x", "gzip: f: unexpected end of file\n", True),
    (b"hello\n", "gzip: f: not in gzip format\n", False),
    (HELLO[:10], "gzip: f: unexpected end of file\n", True),
    (HELLO[:-3], "gzip: f: unexpected end of file\n", True),
    (b"\x1f\x8b\x08\x00garbage-here",
     "gzip: f: invalid compressed data--format violated\n", True),
    (b"\x1f\x8b\x07", "gzip: f: unknown method 7 -- not supported\n", False),
    (b"\x1f\x8b\x08\x20", "gzip: f is encrypted -- not supported\n", False),
    (b"\x1f\x8b\x08\x48", "gzip: f has flags 0x48 -- not supported\n", False),
    (HCRC_HEAD + b"\0\0" + HELLO[10:],
     "gzip: f: header checksum 0x0000 != computed checksum "
     f"0x{zlib.crc32(HCRC_HEAD) & 0xFFFF:04x}\n", False),
])
def test_refusals_carry_gzips_reason_and_severity(data, reason, fatal):
    # gzip 1.13: no header, or a header gzip does not support, is
    # reported and skipped, while a short, truncated or corrupt input
    # ends the run.
    with pytest.raises(GzipDataError) as exc:
        gunzip_checked(data)
    assert (exc.value.render("gzip", "f"), exc.value.fatal) == (reason, fatal)


def test_optional_header_fields_are_skipped():
    flags = 0x02 | 0x04 | 0x08 | 0x10
    head = HELLO[:3] + bytes([flags]) + HELLO[4:10]
    head += b"\x03\x00abc" + b"name\0" + b"comment\0"
    head += (zlib.crc32(head) & 0xFFFF).to_bytes(2, "little")
    assert gunzip_checked(head + HELLO[10:]) == b"hello\n"


@pytest.mark.parametrize("trailer,reasons", [
    (b"\0" * 8, (GZIP_CRC, GZIP_LENGTH)),
    (b"\0" * 4 + HELLO[-4:], (GZIP_CRC, )),
    (HELLO[-8:-4] + b"\0" * 4, (GZIP_LENGTH, )),
])
@pytest.mark.asyncio
async def test_trailer_mismatch_follows_the_inflated_bytes(trailer, reasons):
    # gzip 1.13 writes what it inflated, then names each mismatch.

    async def source():
        yield HELLO[:-8] + trailer + HELLO

    decoded = gunzip_stream(source())
    assert await anext(decoded) == b"hello\n"
    with pytest.raises(GzipDataError) as exc:
        await anext(decoded)
    assert (exc.value.reasons, exc.value.fatal) == (reasons, True)


def test_trailer_mismatch_only_skips_the_input_under_test():
    decoder = GzipDecoder(test=True)
    with pytest.raises(GzipDataError) as exc:
        list(decoder.feed(HELLO[:-8] + b"\0" * 8))
    assert not exc.value.fatal


@pytest.mark.parametrize("data,decoded,keeps", [
    (HELLO + b"junk", b"hello\n", True),
    (HELLO[:-8] + b"\0" * 8, b"hello\n", True),
    (HELLO + HELLO[:-3], b"hello\nhello\n", False),
])
def test_partial_keeps_what_gzip_wrote_before_it_stopped(data, decoded, keeps):
    out, failure = gunzip_partial(data)
    assert (out, failure.keeps_output) == (decoded, keeps)
    assert gunzip_partial(HELLO) == (b"hello\n", None)


@pytest.mark.parametrize("data,keeps", [
    (HELLO[:2] + b"\x07" + HELLO[3:], False),
    (HELLO + HELLO[:2] + b"\x07" + HELLO[3:], True),
    (gzip.compress(b"", mtime=0) + HELLO[:2] + b"\x07", True),
    (HELLO + b"junk", True),
])
def test_a_later_members_refusal_keeps_the_members_before_it(data, keeps):
    with pytest.raises(GzipDataError) as exc:
        gunzip_checked(data)
    assert (exc.value.fatal, exc.value.keeps_output) == (False, keeps)


@pytest.mark.asyncio
@pytest.mark.parametrize("width", [1, 7, 65536])
async def test_member_headers_trailers_and_padding_across_chunks(width):
    data = HELLO + HELLO + b"\0\0"

    async def source():
        for offset in range(0, len(data), width):
            yield data[offset:offset + width]

    assert await materialize(gunzip_stream(source())) == b"hello\nhello\n"


@pytest.mark.asyncio
async def test_expansion_yields_bounded_chunks_before_reading_more_input():
    archive = gzip.compress(b"x" * (GZIP_CHUNK_SIZE * 20))
    reads = []

    async def source():
        reads.append(1)
        yield archive
        reads.append(2)
        yield HELLO

    decoded = gunzip_stream(source())
    assert await anext(decoded) == b"x" * GZIP_CHUNK_SIZE
    assert reads == [1]
    await decoded.aclose()
    assert reads == [1]


@pytest.mark.asyncio
async def test_trailing_warning_follows_valid_output():

    async def source():
        yield HELLO + b"junk"

    decoded = gunzip_stream(source())
    assert await anext(decoded) == b"hello\n"
    with pytest.raises(GzipDataError) as exc:
        await anext(decoded)
    assert exc.value.exit_code == 2
    assert not exc.value.fatal


def test_large_member_preserves_buffered_output():
    data = b"x" * (GZIP_CHUNK_SIZE * 20 + 13)
    assert gunzip_checked(gzip.compress(data)) == data
