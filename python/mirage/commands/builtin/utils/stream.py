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

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TypeVar

from mirage.commands.builtin.utils.operands import normalized_read
from mirage.io.types import ByteSource, materialize
from mirage.types import FileStat, FileType, PathSpec, PolymorphicReadFn

# The backend config a platform command threads through to its reader.
# Generic rather than a union: the config and the reader that consumes
# it must be the same backend's, which a union would not enforce.
ConfigT = TypeVar("ConfigT")
PathT = TypeVar("PathT")


async def read_stdin_async(stdin: ByteSource | None) -> bytes | None:
    if stdin is None:
        return None
    if isinstance(stdin, bytes):
        return stdin
    chunks: list[bytes] = []
    async for chunk in stdin:
        chunks.append(chunk)
    return b"".join(chunks)


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


def resolve_source(stdin: ByteSource | None) -> AsyncIterator[bytes]:
    if stdin is not None:
        if isinstance(stdin, bytes):
            return _wrap_bytes(stdin)
        return stdin
    # GNU semantics: no stdin behaves like empty input (/dev/null)
    return _wrap_bytes(b"")


async def resolve_text_input(
    read_bytes: Callable[[ConfigT, PathT], Awaitable[bytes]],
    config: ConfigT,
    *,
    inline_text: str | None,
    file_path: PathT | None,
    stdin: ByteSource | None,
    error_message: str,
) -> str:
    """Resolve a platform command's text from flag, file, or stdin.

    Args:
        read_bytes (Callable): backend read ``(config, path) -> bytes``.
        config: the backend config passed through to ``read_bytes``.
        inline_text (str | None): text given inline on the command line.
        file_path (PathT | None): the operand to read the text from, in
            whatever shape ``read_bytes`` takes -- a backend reader wants
            the mount-relative path, not the virtual one.
        stdin (ByteSource | None): piped input.
        error_message (str): raised when no source provides text.
    """
    if inline_text:
        return inline_text
    if file_path is not None:
        return (await read_bytes(config, file_path)).decode(errors="replace")
    raw = await read_stdin_async(stdin)
    if raw is not None:
        return raw.decode(errors="replace")
    raise ValueError(error_message)


def is_stdin(path: PathSpec, dash: bool = True) -> bool:
    """Whether an operand reads stdin.

    Args:
        path (PathSpec): the operand.
        dash (bool): a literal ``-`` names stdin, as it does for most
            GNU tools; util-linux ``rev`` and binutils ``strings`` open it
            as a file, so only ``/dev/stdin`` is stdin to them.
    """
    return (dash and path.raw_path == "-") or path.virtual == "/dev/stdin"


def operand_label(path: PathSpec, stdin_name: str) -> str:
    """The name a command's output gives an operand.

    Only a literal ``-`` is stdin by name: ``/dev/stdin`` reads the same
    bytes, but GNU grep, head and tail name it as the path it is.

    Args:
        path (PathSpec): the operand.
        stdin_name (str): the command's name for ``-``.
    """
    return stdin_name if path.raw_path == "-" else path.raw_path


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


def stdin_bytes(
    read: Callable[..., Awaitable[bytes]], stdin: ByteSource | None
) -> Callable[[PathSpec], Awaitable[bytes]]:
    stream = stdin_stream(read, stdin)

    async def read_bytes(path: PathSpec) -> bytes:
        return await materialize(stream(path))

    return read_bytes


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
