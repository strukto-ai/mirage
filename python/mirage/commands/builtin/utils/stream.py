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

from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from contextlib import aclosing

from mirage.commands.builtin.utils.constants import STDIN_HEADER_NAME
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import OutputStream, close_quietly, ensure_stream
from mirage.io.types import ByteSource, materialize
from mirage.rs.stream import OpenStream, close_stream, stream_output_chunks
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, FileType, PathSpec, PolymorphicReadFn


async def read_stdin_async(stdin: ByteSource | None) -> bytes | None:
    return None if stdin is None else await materialize(stdin)


def resolve_source(stdin: ByteSource | None) -> AsyncIterator[bytes]:
    # GNU semantics: no stdin behaves like empty input (/dev/null)
    return ensure_stream(b"" if stdin is None else stdin)


def is_stdin(path: PathSpec, dash: bool = True) -> bool:
    """Whether an operand reads stdin.

    Args:
        path (PathSpec): the operand.
        dash (bool): a literal ``-`` names stdin, as it does for most
            GNU tools; util-linux ``rev`` and binutils ``strings`` open it
            as a file, so only ``/dev/stdin`` is stdin to them.
    """
    return (dash and path.raw_path == "-") or path.virtual == "/dev/stdin"


def never_opened(
    reader: AsyncLineIterator, path: PathSpec, exc: BaseException
) -> bool:
    """Whether a failed read means the operand never opened.

    Nothing arrived from it, and it is neither stdin, which is always
    open, nor a directory, which opens and then fails to read. GNU names
    such an operand as it does a missing one, not as a read error.

    Args:
        reader (AsyncLineIterator): the operand's reader.
        path (PathSpec): the operand.
        exc (BaseException): what the read raised.
    """
    return (
        not reader.loaded
        and not is_stdin(path)
        and not isinstance(exc, IsADirectoryError)
    )


def operand_label(path: PathSpec, stdin_name: str) -> str:
    """The name a command's output gives an operand.

    Only a literal ``-`` is stdin by name: ``/dev/stdin`` reads the same
    bytes, but GNU grep, head and tail name it as the path it is.

    Args:
        path (PathSpec): the operand.
        stdin_name (str): the command's name for ``-``.
    """
    return stdin_name if path.raw_path == "-" else path.raw_path


def operand_header(path: PathSpec | None, after: bool = False) -> bytes:
    """The ``==> name <==`` banner head and tail print above an operand.

    Args:
        path (PathSpec | None): the operand; None for the stdin no operand
            named, which ``-v`` heads with the name ``-`` gets.
        after (bool): whether a block printed before this one, which a
            blank line then separates it from.
    """
    label = (
        STDIN_HEADER_NAME
        if path is None
        else operand_label(path, STDIN_HEADER_NAME)
    )
    return encode_text(("\n" if after else "") + f"==> {label} <==\n")


def shows_headers(verbose: bool, quiet: bool, count: int) -> bool:
    """Whether head or tail banners its operands: under ``-v`` or for more
    than one operand, never under ``-q``.

    Args:
        verbose (bool): ``-v``.
        quiet (bool): ``-q``.
        count (int): the operands as given, a failed one included.
    """
    return (verbose or count > 1) and not quiet


def stdin_stream(
    read: PolymorphicReadFn,
    stdin: ByteSource | None,
    sole: bool = False,
    dash: bool = True,
) -> Callable[[PathSpec], AsyncIterator[bytes]]:
    """Read each operand from its backend, or from stdin for a stdin one.

    Every stdin operand shares one cursor, so a later ``-`` never replays
    bytes an earlier one read, and the cursor never closes the input a
    later one may still read.

    Args:
        read (PolymorphicReadFn): the backend reader.
        stdin (ByteSource | None): the invocation's input.
        sole (bool): stdin has exactly one reader, which takes the input
            itself, so a scan that stops early closes it.
        dash (bool): a literal ``-`` names stdin (see ``is_stdin``).
    """
    backend = normalized_read(read)
    source = resolve_source(stdin)

    async def input_stream() -> AsyncIterator[bytes]:
        async for chunk in source:
            yield chunk

    def stream(path: PathSpec) -> AsyncIterator[bytes]:
        # Bind the backend stream while its mount cache context is active.
        # Byte consumption stays lazy; only stdin needs a shared cursor.
        if not is_stdin(path, dash):
            return backend(path)
        return source if sole else input_stream()

    return stream


def stdin_stat(
    stat: Callable[..., Awaitable[FileStat]],
    dash: bool = True,
) -> Callable[[PathSpec], Awaitable[FileStat]]:
    """Stat each operand on its backend, or as a stream for a stdin one.

    Args:
        stat (Callable): the backend stat.
        dash (bool): a literal ``-`` names stdin (see ``is_stdin``).
    """

    async def probe(path: PathSpec) -> FileStat:
        if is_stdin(path, dash):
            return FileStat(name="-", type=FileType.FIFO)
        return await stat(path)

    return probe


def stream_output(stream: OpenStream, source: ByteSource) -> OutputStream:
    """Drive an already validated stream through bounded calls.

    Args:
        stream (OpenStream): The eagerly opened command engine.
        source (ByteSource): Its input bytes.
    """
    started = False

    async def output() -> AsyncGenerator[bytes, None]:
        nonlocal started
        started = True
        async with aclosing(stream_output_chunks(stream, source)) as bounded:
            async for chunk in bounded:
                yield chunk

    async def close() -> None:
        await close_stream(stream)
        if not started:
            await close_quietly(source)

    return OutputStream(output(), close)
