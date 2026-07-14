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

from collections.abc import AsyncIterator, Callable
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, eisdir, fs_error_line
from mirage.utils.path import norm, parent


async def resolve_or_empty(ops: CommandIO, accessor: Accessor,
                           paths: list[PathSpec],
                           index: IndexCacheStore | None) -> list[PathSpec]:
    if paths and ops.is_mounted(accessor):
        return await ops.resolve_glob(accessor, paths, index)
    return []


async def _is_implicit_dir(ops: CommandIO, accessor: Accessor, path: PathSpec,
                           index: IndexCacheStore | None) -> bool:
    """Whether a path that failed stat with ENOENT is an implicit directory.

    Keyed backends (RAM/Redis/S3) have no directory entries: stat of a
    prefix that only exists through deeper keys raises ENOENT. The operand's
    own readdir cannot serve as the probe: synthetic hierarchies fabricate
    children for any name (postgres answers ``tables/views`` for a missing
    schema) and database backends raise driver errors for missing tables.
    The parent listing is authoritative instead: the operand is an implicit
    directory only if its parent's readdir lists it. When the operand is
    the mount root there is no parent to list, so its own readdir decides
    (root listings are real in every backend). Any probe failure is a
    negative probe (the original ENOENT stands), never an error to surface,
    which is why the except is deliberately broad.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``readdir``.
        accessor (Accessor): Backend accessor.
        path (PathSpec): The operand whose stat raised ENOENT.
        index (IndexCacheStore | None): Index cache store for ``readdir``.
    """
    target = norm(path.virtual)
    key = path.resource_path.strip("/")
    if not key:
        try:
            entries = await ops.readdir(accessor, path, index)
        except Exception:
            return False
        return bool(entries)
    parent_key = key.rsplit("/", 1)[0] if "/" in key else ""
    parent_virtual = parent(target)
    parent_path = PathSpec(virtual=parent_virtual,
                           directory=parent_virtual,
                           resource_path=parent_key)
    try:
        entries = await ops.readdir(accessor, parent_path, index)
    except Exception:
        return False
    return any(norm(entry) == target for entry in entries)


async def split_readable(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore | None,
    cmd_name: str,
) -> tuple[list[PathSpec], bytes]:
    """Partition operands into readable paths and GNU stderr lines.

    Read-family commands (cat/head/tail/wc) process remaining operands
    after one fails, per GNU coreutils: each failed operand becomes one
    ``<cmd>: <path>: <strerror>`` line and the command exits 1 while still
    emitting output for the operands that resolved. Each path is stat'ed
    eagerly so a lazy output stream never aborts mid-drain on a missing
    operand. A directory operand is refused with GNU's ``Is a directory``:
    explicit directories via the stat type, implicit keyed-backend
    directories via a readdir probe on ENOENT (#457).

    Args:
        ops (CommandIO): Backend I/O bundle providing ``stat``/``readdir``.
        accessor (Accessor): Backend accessor.
        paths (list[PathSpec]): Glob-resolved operands in command order.
        index (IndexCacheStore | None): Index cache store for ``stat``.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[PathSpec], bytes]: Readable operands in order, and the
        concatenated stderr lines for the failed ones (``b""`` if none).
    """
    readable: list[PathSpec] = []
    err = b""
    for p in paths:
        try:
            st = await ops.stat(accessor, p, index)
        except FileNotFoundError as exc:
            failure: OSError = exc
            if await _is_implicit_dir(ops, accessor, p, index):
                failure = eisdir(p)
            err += fs_error_line(cmd_name, p, failure).encode()
            continue
        except FS_ERRORS as exc:
            err += fs_error_line(cmd_name, p, exc).encode()
            continue
        if getattr(st, "type", None) == FileType.DIRECTORY:
            err += fs_error_line(cmd_name, p, eisdir(p)).encode()
            continue
        readable.append(p)
    return readable, err


async def _read_refusing_dirs(ops: CommandIO, index: IndexCacheStore | None,
                              accessor: Accessor,
                              path: PathSpec) -> AsyncIterator[bytes]:
    try:
        st = await ops.stat(accessor, path, index)
    except FileNotFoundError:
        if await _is_implicit_dir(ops, accessor, path, index):
            raise eisdir(path) from None
        raise
    if getattr(st, "type", None) == FileType.DIRECTORY:
        raise eisdir(path)
    async for chunk in ops.read_stream(accessor, path, index):
        yield chunk


def dir_refusing_read(ops: CommandIO,
                      index: IndexCacheStore | None) -> Callable:
    """Read-stream callable that reports directory operands as EISDIR.

    For generics that read per operand and format FS errors inline (wc):
    the raw backend read raises ENOENT for an implicit keyed-backend
    directory, so the injected reader refines the error the same way
    ``split_readable`` does before the generic formats the line (#457).

    Args:
        ops (CommandIO): Backend I/O bundle providing ``stat``/``readdir``
            and ``read_stream``.
        index (IndexCacheStore | None): Index cache store bound into reads.
    """
    return partial(_read_refusing_dirs, ops, index)


async def resolve_readable(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore | None,
    cmd_name: str,
) -> tuple[list[PathSpec], bytes]:
    """Resolve globs, then drop unreadable operands via ``split_readable``.

    The read-family builder entry: an empty result with empty stderr means
    stdin mode (no path operands were given), while an empty result with
    stderr lines means every operand failed and the builder must not fall
    back to stdin.

    Args:
        ops (CommandIO): Backend I/O bundle.
        accessor (Accessor): Backend accessor.
        paths (list[PathSpec]): Raw path operands (may hold globs).
        index (IndexCacheStore | None): Index cache store.
        cmd_name (str): Command name for the stderr prefix.
    """
    resolved = await resolve_or_empty(ops, accessor, paths, index)
    if not resolved:
        return [], b""
    return await split_readable(ops, accessor, resolved, index, cmd_name)


async def merge_split_errors(
    result: tuple[ByteSource | None, IOResult],
    err: bytes,
) -> tuple[ByteSource | None, IOResult]:
    """Attach ``split_readable`` stderr lines to a generic's result.

    Args:
        result (tuple[ByteSource | None, IOResult]): The generic's return.
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
