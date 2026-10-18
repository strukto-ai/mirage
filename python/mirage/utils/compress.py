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

from collections.abc import AsyncGenerator, AsyncIterator, Iterator, Mapping
from contextlib import aclosing

from pydantic import BaseModel, ConfigDict

from mirage.io.cooperative import CHUNK_SIZE, chunks
from mirage.io.stream import close_quietly
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream, open_stream
from mirage.types import JsonValue


class GzipDataError(ValueError):
    """Why ``gzip -d`` cannot decompress one input, in gzip's words.

    ``fatal`` is gzip 1.13's split: an input with no gzip header, or
    with a header naming a method or flag gzip does not support, is
    reported and the run moves on to the next operand, while a truncated
    or corrupt one ends the run, as does a CRC or length mismatch unless
    ``-t`` is only testing. A mismatch in both carries both reasons, in
    gzip's order. ``keeps_output`` says the bytes decoded before the
    failure are whole members: after a refusal of a later member, of
    trailing garbage, or of a trailer. An in-place run still writes them
    when the refusal is not fatal, and tar reads them whatever gzip
    does. ``first_header`` says gzip stopped inside its first member's
    header, before it would create an output file or read a body; on
    stdin that ends the run, as gzip exits there. The reasons are gzip's
    own lines, the program name and any leading newline included, since
    gunzip, zcat, zgrep and tar's child all run gzip.

    Args:
        reasons (tuple[str, ...]): gzip's diagnostic lines, each with
            ``{}`` where the input's name goes.
        fatal (bool): whether gzip stops at this input.
        exit_code (int): One for an error, two for a trailing-data warning.
        keeps_output (bool): whether the bytes decoded before the
            failure are whole members.
        first_header (bool): whether the failure lies in the first
            member's header.
    """

    def __init__(
        self,
        reasons: tuple[str, ...],
        fatal: bool,
        exit_code: int = 1,
        keeps_output: bool = False,
        first_header: bool = False,
    ) -> None:
        super().__init__("\n".join(reasons))
        self.reasons = reasons
        self.fatal = fatal
        self.exit_code = exit_code
        self.keeps_output = keeps_output
        self.first_header = first_header

    def render(self, label: str) -> str:
        """gzip's lines for the failure, the input named ``label``.

        Args:
            label (str): the input as the diagnostic names it.
        """
        return "".join(
            f"{reason.replace('{}', label)}\n" for reason in self.reasons
        )


GZIP_MAGIC = b"\x1f\x8b"
GZIP_CHUNK_SIZE = 65536
GZIP_CRC = "\ngzip: {}: invalid compressed data--crc error"
GZIP_LENGTH = "\ngzip: {}: invalid compressed data--length error"


class GzipFailure(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    reasons: list[str]
    fatal: bool
    exit_code: int
    keeps_output: bool
    first_header: bool


def _failure(stream: OpenStream) -> GzipDataError | None:
    if not stream.status():
        return None
    failure = GzipFailure.model_validate_json(stream.take_stderr())
    return GzipDataError(
        tuple(failure.reasons),
        failure.fatal,
        failure.exit_code,
        failure.keeps_output,
        failure.first_header,
    )


def _output(stream: OpenStream, data: bytes) -> Iterator[bytes]:
    failure = _failure(stream)
    if data:
        yield data
    if failure is not None:
        raise failure


def _push(stream: OpenStream, data: bytes) -> Iterator[bytes]:
    for offset in range(0, len(data), CHUNK_SIZE):
        yield from _output(
            stream, stream.feed(data[offset : offset + CHUNK_SIZE])
        )
        while stream.busy():
            yield from _output(stream, stream.drain())


class GzipDecoder:
    """Checked gzip decoding through the shared bounded compression stream.

    Args:
        test (bool): whether trailer failures only skip the input.
        passthrough (bool): whether non-gzip boundary input is copied.
    """

    def __init__(self, test: bool = False, passthrough: bool = False) -> None:
        self._stream = open_stream(
            "compress",
            {
                "operation": "decode",
                "format": "gzip",
                "test": test,
                "passthrough": passthrough,
            },
        )

    def feed(self, data: bytes) -> Iterator[bytes]:
        """Decode bounded pieces of the next input chunk.

        Args:
            data (bytes): compressed input.
        """
        return _push(self._stream, data)

    def finish(self) -> Iterator[bytes]:
        """Check the end of the final member."""
        yield from _output(self._stream, self._stream.finish())
        while self._stream.busy():
            yield from _output(self._stream, self._stream.drain())


async def _codec_stream(
    source: AsyncIterator[bytes], config: Mapping[str, JsonValue]
) -> AsyncGenerator[bytes, None]:
    stream = open_stream("compress", config)
    budget = YieldBudget()
    async for data in source:
        await budget.run()
        for offset in range(0, len(data), CHUNK_SIZE):
            await budget.run()
            try:
                output = stream.feed(data[offset : offset + CHUNK_SIZE])
                for part in _output(stream, output):
                    yield part
                while stream.busy():
                    await budget.run()
                    for part in _output(stream, stream.drain()):
                        yield part
            except StreamRefusal as exc:
                if exc.output:
                    yield exc.output
                raise ValueError(exc.message) from exc
    await budget.run()
    try:
        for part in _output(stream, stream.finish()):
            yield part
        while stream.busy():
            await budget.run()
            for part in _output(stream, stream.drain()):
                yield part
    except StreamRefusal as exc:
        if exc.output:
            yield exc.output
        raise ValueError(exc.message) from exc


def gzip_compress(data: bytes, level: int = -1, name: str = "") -> bytes:
    """Encode one gzip member.

    Args:
        data (bytes): uncompressed bytes.
        level (int): compression level.
        name (str): original basename.
    """
    stream = open_stream(
        "compress",
        {
            "operation": "encode",
            "format": "gzip",
            "level": level,
            "name": name,
        },
    )
    parts = list(_push(stream, data))
    parts.append(stream.finish())
    while stream.busy():
        parts.append(stream.drain())
    return b"".join(parts)


async def gzip_compress_stream(
    source: AsyncIterator[bytes], level: int, name: str = ""
) -> AsyncIterator[bytes]:
    """Encode a gzip stream, preserving source ownership in the host.

    Args:
        source (AsyncIterator[bytes]): uncompressed chunks.
        level (int): compression level.
        name (str): original basename.
    """
    async with aclosing(chunks(source)) as bounded:
        result = _codec_stream(
            bounded,
            {
                "operation": "encode",
                "format": "gzip",
                "level": level,
                "name": name,
            },
        )
        async with aclosing(result):
            async for part in result:
                yield part


async def gunzip_stream(
    source: AsyncIterator[bytes], test: bool = False, passthrough: bool = False
) -> AsyncIterator[bytes]:
    """Decode concatenated members and close the source before reporting failure.

    Args:
        source (AsyncIterator[bytes]): compressed chunks.
        test (bool): whether trailer failures only skip the input.
        passthrough (bool): whether non-gzip boundary bytes are copied.
    """
    result = _codec_stream(
        source,
        {
            "operation": "decode",
            "format": "gzip",
            "test": test,
            "passthrough": passthrough,
        },
    )
    try:
        async with aclosing(result):
            async for part in result:
                yield part
    finally:
        await close_quietly(source)


def gunzip_partial(
    data: bytes, passthrough: bool = False
) -> tuple[bytes, GzipDataError | None]:
    """Return bytes decoded before a gzip failure, plus its reason.

    Args:
        data (bytes): compressed input.
        passthrough (bool): whether non-gzip boundary bytes are copied.
    """
    decoder = GzipDecoder(passthrough=passthrough)
    parts: list[bytes] = []
    try:
        parts.extend(decoder.feed(data))
        parts.extend(decoder.finish())
    except GzipDataError as exc:
        return b"".join(parts), exc
    return b"".join(parts), None


async def deflate_raw_stream(
    source: AsyncIterator[bytes],
) -> AsyncIterator[bytes]:
    """Encode a raw deflate stream.

    Args:
        source (AsyncIterator[bytes]): uncompressed chunks.
    """
    async with aclosing(chunks(source)) as bounded:
        result = _codec_stream(
            bounded, {"operation": "encode", "format": "raw"}
        )
        async with aclosing(result):
            async for part in result:
                yield part


async def inflate_raw_stream(
    source: AsyncIterator[bytes],
) -> AsyncIterator[bytes]:
    """Decode a raw deflate stream with bounded output.

    Args:
        source (AsyncIterator[bytes]): compressed chunks.
    """
    async with aclosing(chunks(source)) as bounded:
        result = _codec_stream(
            bounded, {"operation": "decode", "format": "raw"}
        )
        async with aclosing(result):
            async for part in result:
                yield part
