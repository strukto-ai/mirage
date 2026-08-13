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

import inspect
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from functools import partial

from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import (FileType, PathSpec, PolymorphicReadFn, ReadBytesFn,
                          StatFn)
from mirage.utils.errors import FS_ERRORS, eisdir, fs_error_line
from mirage.utils.stream import ensure_stream


async def split_readable(
    paths: list[PathSpec],
    stat: StatFn,
    cmd_name: str,
) -> tuple[list[PathSpec], bytes]:
    """Partition operands into readable paths and GNU stderr lines.

    Read-family commands (cat/head/tail/wc) process remaining operands
    after one fails, per GNU coreutils: each failed operand becomes one
    ``<cmd>: <path>: <strerror>`` line and the command exits 1 while
    still emitting output for the operands that resolved. Each path is
    stat'ed eagerly so a lazy output stream never aborts mid-drain on a
    missing operand. A directory operand is refused with GNU's ``Is a
    directory``: explicit directories via the stat type here, implicit
    keyed-backend directories via the ``dir_aware_stat`` wiring (#457).
    Non-filesystem errors keep propagating. Lives inside the generics so
    every wrapper — factory builders and bespoke backend commands alike
    — inherits the behavior; mirrors ``splitReadable`` in operands.ts.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        stat (StatFn): Bound stat called as ``stat(path)``.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[PathSpec], bytes]: Readable operands in order, and the
        concatenated stderr lines for the failed ones (``b""`` if none).
    """
    readable: list[PathSpec] = []
    err = b""
    for p in paths:
        try:
            st = await stat(p)
        except FS_ERRORS as exc:
            err += fs_error_line(cmd_name, p, exc).encode()
            continue
        if getattr(st, "type", None) == FileType.DIRECTORY:
            err += fs_error_line(cmd_name, p, eisdir(p)).encode()
            continue
        readable.append(p)
    return readable, err


@dataclass(frozen=True, slots=True)
class ReadOperand:
    """One successfully read operand.

    Args:
        path (PathSpec): The operand that was read.
        data (bytes): Its materialized content.
    """

    path: PathSpec
    data: bytes


async def read_operands(
    paths: list[PathSpec],
    read: PolymorphicReadFn,
    cmd_name: str,
) -> tuple[list[ReadOperand], bytes]:
    """Read every operand eagerly, turning failures into GNU stderr lines.

    Each operand whose read fails with a filesystem error becomes one
    ``<cmd>: <path>: <strerror>`` line and the remaining operands still
    process (the read-family rule). Non-filesystem errors keep
    propagating. Mirrors ``readOperands`` in operands.ts.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        read (PolymorphicReadFn): Bound reader called as ``read(path)``;
            may return bytes, an awaitable of bytes, or a byte stream.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[ReadOperand], bytes]: The operands read in order, and
        the concatenated stderr lines for the failed ones.
    """
    ok: list[ReadOperand] = []
    err = b""
    for p in paths:
        try:
            source = read(p)
            if inspect.isawaitable(source):
                source = await source
            data = await materialize(source)
        except FS_ERRORS as exc:
            err += fs_error_line(cmd_name, p, exc).encode()
            continue
        ok.append(ReadOperand(p, data))
    return ok, err


def operands_io(err: bytes, cache: list[str] | None = None) -> IOResult:
    """IOResult carrying operand-split stderr lines.

    Exit 1 when any operand failed, exit 0 otherwise; mirrors
    ``operandsIo`` in operands.ts.

    Args:
        err (bytes): Concatenated stderr lines, ``b""`` for none.
        cache (list[str] | None): Paths worth caching, if any.
    """
    return IOResult(exit_code=0 if not err else 1,
                    stderr=err or None,
                    cache=cache if cache is not None else [])


async def merge_split_errors(
    result: tuple[ByteSource | None, IOResult],
    err: bytes,
) -> tuple[ByteSource | None, IOResult]:
    """Attach ``split_readable`` stderr lines to a generic's result.

    Args:
        result (tuple[ByteSource | None, IOResult]): The body's return.
        err (bytes): Stderr lines for the operands dropped by the split;
            when non-empty the command exits 1, per GNU.
    """
    if not err:
        return result
    out, io = result
    existing = await materialize(io.stderr) if io.stderr else b""
    io.stderr = existing + err
    io.exit_code = 1
    return out, io


async def _awaited_stream(
        source: "Awaitable[bytes | AsyncIterator[bytes]]"
) -> AsyncIterator[bytes]:
    async for chunk in ensure_stream(await source):
        yield chunk


def _call_normalized(read: PolymorphicReadFn,
                     path: PathSpec) -> AsyncIterator[bytes]:
    # The reader is invoked NOW, not when the returned stream is first
    # drained: a cache-aware factory reader captures the active cache
    # manager at call time, inside the command's cache-manager scope,
    # which is gone by drain time. Only the rare awaitable-of-bytes
    # reader keeps a deferred step, and it carries no such scope.
    source = read(path)
    if inspect.isawaitable(source):
        return _awaited_stream(source)
    return ensure_stream(source)


def normalized_read(
        read: PolymorphicReadFn) -> Callable[[PathSpec], AsyncIterator[bytes]]:
    """Normalize a polymorphic bound reader to always yield a stream.

    The loose ``read`` contract lets a backend hand back bytes, an
    awaitable of bytes, or an async byte stream; a generic that streams
    per operand wants exactly one shape.

    Args:
        read (PolymorphicReadFn): Bound reader called as ``read(path)``.
    """
    return partial(_call_normalized, read)


async def _read_materialized(read: PolymorphicReadFn, path: PathSpec) -> bytes:
    source = read(path)
    if inspect.isawaitable(source):
        source = await source
    return await materialize(source)


def materialized_read(read: PolymorphicReadFn) -> ReadBytesFn:
    """Normalize a polymorphic bound reader to always return bytes.

    The buffering twin of ``normalized_read``, for generic bodies that
    take a whole-file ``read_bytes`` reader.

    Args:
        read (PolymorphicReadFn): Bound reader called as ``read(path)``.
    """
    return partial(_read_materialized, read)
