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
