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

import zlib
from collections.abc import AsyncIterator, Generator, Iterator
from enum import Enum

from mirage.utils.errors import GzipDataError

GZIP_MAGIC = b"\x1f\x8b"
# gzip 1.13's words for the inputs ``gzip -d`` refuses, ``{}`` standing
# for the input's name.
GZIP_NOT_GZIP = "{}: not in gzip format"
GZIP_EOF = "{}: unexpected end of file"
GZIP_CORRUPT = "{}: invalid compressed data--format violated"
GZIP_CRC = "{}: invalid compressed data--crc error"
GZIP_LENGTH = "{}: invalid compressed data--length error"
GZIP_ENCRYPTED = "{} is encrypted -- not supported"
GZIP_TRAILING = "{}: decompression OK, trailing garbage ignored"
# The member layout of gzip.h: method 8 is deflate, the flag bits
# announce the optional header fields, and the CRC-32 and the length
# modulo 2**32 of the decoded bytes close the member.
GZIP_DEFLATED = 8
GZIP_HEADER_CRC = 0x02
GZIP_EXTRA_FIELD = 0x04
GZIP_ORIG_NAME = 0x08
GZIP_COMMENT = 0x10
GZIP_ENCRYPTED_FLAG = 0x20
GZIP_RESERVED = 0xC0
GZIP_FIXED_HEADER = 10
GZIP_TRAILER = 8
GZIP_CHUNK_SIZE = 65536


async def gzip_compress_stream(
    source: AsyncIterator[bytes],
    level: int,
) -> AsyncIterator[bytes]:
    """Gzip a byte stream chunk by chunk.

    Args:
        source (AsyncIterator[bytes]): plain input chunks.
        level (int): zlib compression level.

    Yields:
        bytes: gzip member bytes, trailer included.
    """
    compressor = zlib.compressobj(level, zlib.DEFLATED, zlib.MAX_WBITS | 16)
    async for chunk in source:
        compressed = compressor.compress(chunk)
        if compressed:
            yield compressed
    tail = compressor.flush()
    if tail:
        yield tail


class MemberPart(Enum):
    """Which part of a gzip member the decoder is reading."""

    HEADER = 0
    BODY = 1
    TRAILER = 2


class HeaderPart(Enum):
    """Optional header fields consumed without retaining their contents."""

    FIXED = 0
    EXTRA_LENGTH = 1
    EXTRA = 2
    NAME = 3
    COMMENT = 4
    CRC = 5
    DONE = 6


class GzipDecoder:
    """Incremental member decoder with bounded decompressed chunks.

    Frames each member as gzip 1.13 does: it reads the header itself,
    inflates the body raw, and checks the CRC and length trailer only
    after handing out what it inflated, so a damaged trailer costs the
    diagnostic and not the data. gzip ends the run on a mismatch unless
    it is only testing (``gzip -t``), and then moves to the next input.
    A header gzip does not support skips the input, and keeps the
    members before it when it is not the first.

    Args:
        test (bool): whether the run only tests its inputs.
    """

    def __init__(self, test: bool = False) -> None:
        self._test = test
        self._part = MemberPart.HEADER
        self._inflater = zlib.decompressobj(-zlib.MAX_WBITS)
        self._crc = 0
        self._size = 0
        self._seen = False
        self._pending = b""
        self._padding = False
        self._header_part = HeaderPart.FIXED
        self._header_flags = 0
        self._header_crc = 0
        self._extra_remaining = 0

    def _refusal(self, reason: str, exit_code: int = 1) -> GzipDataError:
        """A refusal that skips the input, keeping any complete member.

        Args:
            reason (str): gzip's description, ``{}`` for the name.
            exit_code (int): One for an error, two for trailing garbage.
        """
        return GzipDataError((reason, ), False, exit_code, self._seen)

    def _read_header(self, data: bytes) -> int | None:
        """Consume header fields incrementally, retaining only fixed fields.

        Args:
            data (bytes): the next header bytes, possibly followed by a body.

        Returns:
            int | None: bytes consumed when complete, or None when more
            input is needed. Only incomplete fixed fields are buffered.
        """
        offset = 0
        while self._header_part is not HeaderPart.DONE:
            start = offset
            available = len(data) - offset
            part = self._header_part
            if part is HeaderPart.FIXED:
                if available >= 2 and not data.startswith(GZIP_MAGIC):
                    raise (self._refusal(GZIP_TRAILING, 2)
                           if self._seen else self._refusal(GZIP_NOT_GZIP))
                if available >= 3 and data[2] != GZIP_DEFLATED:
                    raise self._refusal(
                        f"{{}}: unknown method {data[2]} -- not supported")
                if available >= 4:
                    self._header_flags = data[3]
                    if self._header_flags & GZIP_ENCRYPTED_FLAG:
                        raise self._refusal(GZIP_ENCRYPTED)
                    if self._header_flags & GZIP_RESERVED:
                        raise self._refusal(
                            f"{{}} has flags 0x{self._header_flags:x} "
                            "-- not supported")
                if available < GZIP_FIXED_HEADER:
                    self._pending = data[offset:]
                    return None
                offset += GZIP_FIXED_HEADER
                self._header_part = HeaderPart.EXTRA_LENGTH
            elif part is HeaderPart.EXTRA_LENGTH:
                if self._header_flags & GZIP_EXTRA_FIELD:
                    if available < 2:
                        self._pending = data[offset:]
                        return None
                    self._extra_remaining = int.from_bytes(
                        data[offset:offset + 2], "little")
                    offset += 2
                self._header_part = HeaderPart.EXTRA
            elif part is HeaderPart.EXTRA:
                count = min(available, self._extra_remaining)
                offset += count
                self._extra_remaining -= count
                if not self._extra_remaining:
                    self._header_part = HeaderPart.NAME
            elif part in (HeaderPart.NAME, HeaderPart.COMMENT):
                flag = (GZIP_ORIG_NAME
                        if part is HeaderPart.NAME else GZIP_COMMENT)
                if self._header_flags & flag:
                    nul = data.find(b"\0", offset)
                    offset = len(data) if nul == -1 else nul + 1
                    if nul == -1:
                        self._header_crc = zlib.crc32(data[start:offset],
                                                      self._header_crc)
                        return None
                self._header_part = (HeaderPart.COMMENT if part
                                     is HeaderPart.NAME else HeaderPart.CRC)
            else:
                if self._header_flags & GZIP_HEADER_CRC:
                    if available < 2:
                        self._pending = data[offset:]
                        return None
                    stored = int.from_bytes(data[offset:offset + 2], "little")
                    computed = self._header_crc & 0xFFFF
                    if stored != computed:
                        raise self._refusal(
                            f"{{}}: header checksum 0x{stored:04x} "
                            f"!= computed checksum 0x{computed:04x}")
                    offset += 2
                self._header_part = HeaderPart.DONE
            if part is not HeaderPart.CRC:
                self._header_crc = zlib.crc32(data[start:offset],
                                              self._header_crc)
            if self._header_part is part:
                return None
        return offset

    def feed(self, data: bytes) -> Iterator[bytes]:
        """Decode one input chunk without collecting its expansion.

        Args:
            data (bytes): The next compressed chunk.
        """
        data = self._pending + data
        self._pending = b""
        while data:
            if self._part is MemberPart.HEADER:
                if (self._header_part is HeaderPart.FIXED and self._seen
                        and (self._padding or data[0] == 0)):
                    self._padding = True
                    if any(data):
                        raise self._refusal(GZIP_TRAILING, 2)
                    return
                end = self._read_header(data)
                if end is None:
                    return
                data = data[end:]
                self._inflater = zlib.decompressobj(-zlib.MAX_WBITS)
                self._crc = 0
                self._size = 0
                self._part = MemberPart.BODY
            elif self._part is MemberPart.BODY:
                data = yield from self._inflate(data)
            else:
                if len(data) < GZIP_TRAILER:
                    self._pending = data
                    return
                self._check(data[:GZIP_TRAILER])
                data = data[GZIP_TRAILER:]
                self._seen = True
                self._part = MemberPart.HEADER
                self._header_part = HeaderPart.FIXED
                self._header_crc = 0

    def _inflate(self, data: bytes) -> Generator[bytes, None, bytes]:
        """Inflate body bytes, yielding bounded chunks as they decode.

        Args:
            data (bytes): compressed body bytes.

        Returns:
            bytes: the input left over once the body ends, else nothing.
        """
        inflater = self._inflater
        while True:
            try:
                out = inflater.decompress(data, GZIP_CHUNK_SIZE)
            except zlib.error as exc:
                raise GzipDataError((GZIP_CORRUPT, ), True) from exc
            data = (inflater.unused_data
                    if inflater.eof else inflater.unconsumed_tail)
            if out:
                self._crc = zlib.crc32(out, self._crc)
                self._size += len(out)
                yield out
            if inflater.eof:
                self._part = MemberPart.TRAILER
                return data
            if not data and len(out) < GZIP_CHUNK_SIZE:
                return b""

    def _check(self, trailer: bytes) -> None:
        """Compare a member's trailer with the bytes it decoded to.

        Args:
            trailer (bytes): the member's eight trailer bytes.
        """
        reasons: list[str] = []
        if int.from_bytes(trailer[:4], "little") != self._crc:
            reasons.append(GZIP_CRC)
        if int.from_bytes(trailer[4:], "little") != self._size & 0xFFFFFFFF:
            reasons.append(GZIP_LENGTH)
        if reasons:
            raise GzipDataError(tuple(reasons), not self._test, 1, True)

    def finish(self) -> None:
        """Reject an absent header or an unfinished member at EOF.

        GNU gzip 1.13 also treats exactly one trailing nonzero byte as
        fatal EOF, even when it cannot start a member. Two junk bytes
        instead trigger the nonfatal trailing-garbage warning in feed.
        A missing trailer or a partial next header leaves complete decoded
        bodies for tar, but remains fatal for in-place gzip.
        """
        if (not self._seen or self._part is not MemberPart.HEADER
                or self._pending or self._header_part is not HeaderPart.FIXED):
            whole = (self._part is MemberPart.TRAILER
                     or self._part is MemberPart.HEADER and self._seen)
            raise GzipDataError((GZIP_EOF, ), True, keeps_output=whole)


async def gunzip_stream(source: AsyncIterator[bytes],
                        test: bool = False) -> AsyncIterator[bytes]:
    """Decode concatenated members, yielding before reading more input.

    Args:
        source (AsyncIterator[bytes]): Compressed input chunks.
        test (bool): whether the run only tests its inputs.
    """
    decoder = GzipDecoder(test)
    async for chunk in source:
        for out in decoder.feed(chunk):
            yield out
    decoder.finish()


def gunzip_partial(data: bytes) -> tuple[bytes, GzipDataError | None]:
    """What ``gzip -d`` writes from ``data`` before it stops, and why.

    Args:
        data (bytes): Compressed input.
    """
    decoder = GzipDecoder()
    parts: list[bytes] = []
    try:
        for part in decoder.feed(data):
            parts.append(part)
        decoder.finish()
    except GzipDataError as exc:
        return b"".join(parts), exc
    return b"".join(parts), None


def gunzip_checked(data: bytes) -> bytes:
    """Materialize a checked archive for consumers that need all its bytes.

    Args:
        data (bytes): Compressed input, with no trailing garbage.
    """
    decoded, failure = gunzip_partial(data)
    if failure is not None:
        raise failure
    return decoded
