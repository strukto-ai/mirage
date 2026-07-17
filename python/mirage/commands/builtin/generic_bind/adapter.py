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

import functools
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, overload

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.ops.config import StatOverlay
from mirage.types import FileStat, PathSpec
from mirage.utils.glob_walk import resolve_glob_with

OperationFn = Callable[..., Any]


async def overlaid_stat(stat: OperationFn, overlay: StatOverlay,
                        path: PathSpec,
                        index: IndexCacheStore | None) -> FileStat:
    """Stat through the backend, then merge the namespace attr overlay.

    Bound via ``partial(overlaid_stat, stat_fn, overlay)`` so stat-
    rendering commands (ls) show chmod/chown/touch state the backend
    itself cannot hold.

    Args:
        stat (OperationFn): backend stat ``(path, index) -> FileStat``.
        overlay (StatOverlay): namespace merge ``(virtual, stat) -> stat``.
        path (PathSpec): entry being statted.
        index (IndexCacheStore | None): cache index threaded through.
    """
    return overlay(path.virtual, await stat(path, index))


@overload
def with_index(fn: OperationFn, index: IndexCacheStore | None) -> OperationFn:
    ...


@overload
def with_index(fn: None, index: IndexCacheStore | None) -> None:
    ...


def with_index(fn: OperationFn | None,
               index: IndexCacheStore | None) -> OperationFn | None:
    """Bind the runtime cache index into a read op for the generics.

    A generic command calls its injected reader as ``read(accessor, path)``
    with no index, but index-backed backends (gdrive, gmail, slack, ...)
    resolve a path to its real id through the index, so the bound index must
    travel with the reader. Harmless for backends that ignore it. ``None``
    passes through so a backend/test can still opt out of streaming.

    Args:
        fn (OperationFn | None): read op, or None to opt out of streaming.
        index (IndexCacheStore | None): the per-call cache index.
    """
    if fn is None:
        return None
    return functools.partial(fn, index=index)


class Operation(StrEnum):
    WRITE = "write"
    EXISTS = "exists"
    MKDIR = "mkdir"
    UNLINK = "unlink"
    RENAME = "rename"
    COPY = "copy"


@dataclass(frozen=True)
class Builder:
    name: str
    fn: OperationFn
    provision: OperationFn | None = None
    write: bool = False
    aggregate: OperationFn | None = None
    read: bool = False
    requirements: frozenset[Operation] = frozenset()


def make_resolve_glob(readdir: OperationFn,
                      max_glob_matches: int | None = None) -> OperationFn:
    """Build a resolve_glob generic over a backend's readdir.

    Args:
        readdir (OperationFn): backend readdir ``(accessor, path, index)``.
        max_glob_matches (int | None): cap on matches per pattern before
            truncation.
    """

    async def resolve_glob(accessor: Accessor, paths: list[PathSpec],
                           index: IndexCacheStore | None) -> list[PathSpec]:
        return await resolve_glob_with(readdir, accessor, paths, index,
                                       max_glob_matches)

    return resolve_glob


@dataclass(frozen=True)
class CommandIO:
    readdir: OperationFn
    read_bytes: OperationFn
    read_stream: OperationFn
    stat: OperationFn
    is_mounted: OperationFn
    local: bool = True
    max_glob_matches: int | None = None
    write: OperationFn | None = None
    exists: OperationFn | None = None
    mkdir: OperationFn | None = None
    unlink: OperationFn | None = None
    rmdir: OperationFn | None = None
    rm_r: OperationFn | None = None
    rename: OperationFn | None = None
    copy: OperationFn | None = None
    dir_copy: OperationFn | None = None
    create: OperationFn | None = None
    truncate: OperationFn | None = None
    find: OperationFn | None = None
    is_dir_name: OperationFn | None = None
    du_total: OperationFn | None = None
    du_all: OperationFn | None = None

    @property
    def resolve_glob(self) -> OperationFn:
        return make_resolve_glob(self.readdir, self.max_glob_matches)

    def operation(self, op: Operation) -> OperationFn | None:
        operations = {
            Operation.WRITE: self.write,
            Operation.EXISTS: self.exists,
            Operation.MKDIR: self.mkdir,
            Operation.UNLINK: self.unlink,
            Operation.RENAME: self.rename,
            Operation.COPY: self.copy,
        }
        return operations[op]

    def supports(self, requirements: frozenset[Operation]) -> bool:
        return all(self.operation(op) is not None for op in requirements)

    def require(self, op: Operation) -> OperationFn:
        """Return an optional backend op, raising if the backend omits it.

        Builders wire write-side ops (write/mkdir/unlink/rename/...) that
        are ``None`` on read-only backends into generic commands that
        require them. This surfaces the missing capability as a clear
        error instead of a ``NoneType is not callable`` crash.

        Args:
            op (Operation): Required backend operation.
        """
        fn = self.operation(op)
        if fn is None:
            raise NotImplementedError(
                f"operation {op!r} is not supported on this backend")
        return fn
