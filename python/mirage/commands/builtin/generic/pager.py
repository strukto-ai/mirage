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

from collections.abc import AsyncIterator

from mirage.commands.builtin.generic.decompress import gzip_suffix
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import resolve_source, stdin_stream
from mirage.commands.config import Context
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, ReadStreamFn
from mirage.utils.compress import GzipDataError, gunzip_stream

GZIP_SUFFIX = ".gz"
LESS_FAMILY = frozenset({"less", "zless"})
ZIPPED = frozenset({"zless", "zmore"})


def _header(name: str) -> bytes:
    return encode_text(f"::::::::::::::\n{name}\n::::::::::::::\n")


def _gzip_name(name: str) -> str:
    """The name gzip complains of: the operand with ``.gz`` tried on it.

    Args:
        name (str): the operand.
    """
    return name if gzip_suffix(name, GZIP_SUFFIX) else name + GZIP_SUFFIX


async def _opened(source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """``source`` read up to its first chunk, so a failed open raises here.

    Args:
        source (AsyncIterator[bytes]): an input not yet read.
    """
    first = await anext(source, None)

    async def resumed() -> AsyncIterator[bytes]:
        try:
            if first is not None:
                yield first
                async for chunk in source:
                    yield chunk
        finally:
            await close_quietly(source)

    return resumed()


async def _pages(
    paths: list[PathSpec],
    read: ReadStreamFn,
    stdin: ByteSource | None,
    command: str,
    io: IOResult,
) -> AsyncIterator[bytes]:
    """The operands one after another, with what each program says of one
    it cannot open. With no terminal to page on, ``less`` shows a name
    only the first time it is given, and ``more`` heads each file with
    its name; ``zmore`` does only for several.

    Args:
        paths (list[PathSpec]): the operands, ``+cmd`` words dropped.
        read (ReadStreamFn): the mount's reader.
        stdin (ByteSource | None): the line's standard input.
        command (str): ``less``, ``more``, ``zless`` or ``zmore``.
        io (IOResult): takes the stderr.
    """
    zipped = command in ZIPPED
    lines: list[str] = []

    def complain(line: str) -> None:
        lines.append(line)
        io.stderr = format_records(lines)

    if not paths:
        source = resolve_source(stdin)
        decoded = gunzip_stream(source, passthrough=True) if zipped else source
        async for chunk in decoded:
            yield chunk
        return
    source_of = stdin_stream(read, stdin, dash=command != "more")
    headed = command == "more" or (command == "zmore" and len(paths) > 1)
    seen: set[str] = set()
    for path in paths:
        name = path.raw_path
        if command in LESS_FAMILY:
            if path.virtual in seen:
                continue
            seen.add(path.virtual)
        if command == "zmore" and headed:
            yield _header(name)
        try:
            opened = await _opened(source_of(path))
        except IsADirectoryError:
            if command == "more":
                yield encode_text(f"\n*** {name}: directory ***\n\n")
            if command not in LESS_FAMILY:
                continue
            yield encode_text(f"{name} is a directory\n")
            continue
        except FS_ERRORS as exc:
            why = fs_strerror(exc)
            if command == "more":
                complain(f"more: cannot open {name}: {why}")
                continue
            if command == "zmore":
                yield encode_text(f"gzip: {_gzip_name(name)}: {why}\n")
                continue
            if zipped:
                complain(f"gzip: {_gzip_name(name)}: {why}")
            yield encode_text(f"{name}: {why}\n")
            continue
        if command == "more":
            yield _header(name)
        body = gunzip_stream(opened, passthrough=True) if zipped else opened
        try:
            async for chunk in body:
                yield chunk
        except GzipDataError as exc:
            complain(exc.render(name).rstrip("\n"))
        finally:
            await close_quietly(body)
            await close_quietly(opened)


async def pager_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read: ReadStreamFn,
    command: str,
) -> tuple[ByteSource | None, IOResult]:
    """Run a pager with nothing to page on, as these exit 0 whatever the
    files were. Pinned against less 668, util-linux 2.41.5 and gzip 1.13.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused.
        ctx (Context): Stdin from the dispatcher.
        read (ReadStreamFn): the mount's reader.
        command (str): ``less``, ``more``, ``zless`` or ``zmore``.
    """
    io = IOResult()
    return _pages(paths, read, ctx.stdin, command, io), io


__all__ = ["pager_generic"]
