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

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line


async def resolve_or_empty(ops: CommandIO, accessor: Accessor,
                           paths: list[PathSpec],
                           index: IndexCacheStore | None) -> list[PathSpec]:
    if paths and ops.is_mounted(accessor):
        return await ops.resolve_glob(accessor, paths, index)
    return []


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
    operand.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``stat``.
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
            await ops.stat(accessor, p, index)
        except FS_ERRORS as exc:
            err += fs_error_line(cmd_name, p, exc).encode()
            continue
        readable.append(p)
    return readable, err


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
