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

from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Callable,
    Iterator,
    Mapping,
)
from contextlib import aclosing

from pydantic import BaseModel, ConfigDict

from mirage.io.stream import close_quietly
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import (
    OpenStream,
    close_stream,
    open_stream,
    stream_output_chunks,
)
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


class GzipFailure(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    reasons: list[str]
    fatal: bool
    exit_code: int
    keeps_output: bool
    first_header: bool


class GzipFacts(BaseModel):
    """What ``gzip -l`` and ``-v`` read off an input besides its data.

    Attributes:
        name (str | None): the first member's stored name, None when it
            stores none.
        mtime (int): the first member's stored time, 0 for none.
        header (int): the bytes the first member's header and trailer
            take, none once a second member follows, as the reference
            counts them.
        compressed (int): the bytes read.
        crc (int): the CRC the input's last eight bytes claim.
        size (int): the length, modulo 2**32, they claim.
    """

    model_config = ConfigDict(strict=True, extra="forbid")
    name: str | None = None
    mtime: int = 0
    header: int = 0
    compressed: int = 0
    crc: int = 0
    size: int = 0


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


async def _codec_stream(
    source: AsyncIterator[bytes],
    config: Mapping[str, JsonValue],
    on_facts: Callable[[GzipFacts], None] | None = None,
) -> AsyncGenerator[bytes, None]:
    stream = open_stream("compress", config)

    async def input_chunks() -> AsyncGenerator[bytes, None]:
        async for part in source:
            yield part

    try:
        async with aclosing(
            stream_output_chunks(stream, input_chunks(), owns_stream=False)
        ) as parts:
            async for data in parts:
                for part in _output(stream, data):
                    yield part
        if failure := _failure(stream):
            raise failure
        if on_facts is not None:
            on_facts(GzipFacts.model_validate_json(stream.metadata()))
    except StreamRefusal as exc:
        if exc.output:
            yield exc.output
        raise ValueError(exc.message) from exc
    finally:
        await close_stream(stream)
        await close_quietly(source)


async def gzip_compress_stream(
    source: AsyncIterator[bytes], level: int, name: str = "", mtime: int = 0
) -> AsyncIterator[bytes]:
    """Encode a gzip stream, preserving source ownership in the host.

    Args:
        source (AsyncIterator[bytes]): uncompressed chunks.
        level (int): compression level.
        name (str): original basename.
        mtime (int): the time stored in the header, 0 for none.
    """
    result = _codec_stream(
        source,
        {
            "operation": "encode",
            "format": "gzip",
            "level": level,
            "name": name,
            "mtime": mtime,
        },
    )
    async with aclosing(result):
        async for part in result:
            yield part


async def gunzip_stream(
    source: AsyncIterator[bytes],
    test: bool = False,
    passthrough: bool = False,
    on_facts: Callable[[GzipFacts], None] | None = None,
) -> AsyncGenerator[bytes, None]:
    """Decode concatenated members and close the source before reporting failure.

    Args:
        source (AsyncIterator[bytes]): compressed chunks.
        test (bool): whether trailer failures only skip the input.
        passthrough (bool): whether non-gzip boundary bytes are copied.
        on_facts (Callable | None): called with the input's facts once
            it decodes whole.
    """
    result = _codec_stream(
        source,
        {
            "operation": "decode",
            "format": "gzip",
            "test": test,
            "passthrough": passthrough,
        },
        on_facts,
    )
    async with aclosing(result):
        async for part in result:
            yield part


async def read_gzip_facts(source: AsyncIterator[bytes]) -> GzipFacts:
    """Read an input's facts the way ``gzip -l`` does: checked whole, as
    ``-t`` checks it, with nothing written.

    Args:
        source (AsyncIterator[bytes]): compressed chunks.

    Raises:
        GzipDataError: the input does not open as gzip.
    """
    found: list[GzipFacts] = []
    result = _codec_stream(
        source,
        {"operation": "decode", "format": "gzip", "list": True},
        found.append,
    )
    async with aclosing(result):
        async for _ in result:
            pass
    return found[0]
