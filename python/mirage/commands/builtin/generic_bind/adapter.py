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
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES, make_resolve_glob

OperationFn = Callable[..., Any]


async def overlaid_stat(stat: OperationFn, overlay: StatOverlay,
                        path: PathSpec, index: IndexCacheStore) -> FileStat:
    """Stat through the backend, then merge the namespace attr overlay.

    Bound via ``partial(overlaid_stat, stat_fn, overlay)`` so stat-
    rendering commands (ls) show chmod/chown/touch state the backend
    itself cannot hold.

    Args:
        stat (OperationFn): backend stat ``(path, index) -> FileStat``.
        overlay (StatOverlay): namespace merge ``(virtual, stat) -> stat``.
        path (PathSpec): entry being statted.
        index (IndexCacheStore): cache index threaded through.
    """
    return overlay(path.virtual, await stat(path, index))


@overload
def bound_op(fn: OperationFn, accessor: Accessor,
             index: IndexCacheStore) -> OperationFn:
    ...


@overload
def bound_op(fn: None, accessor: Accessor, index: IndexCacheStore) -> None:
    ...


def bound_op(fn: OperationFn | None, accessor: Accessor,
             index: IndexCacheStore) -> OperationFn | None:
    """Bind the backend accessor and cache index into an op for the generics.

    A generic command calls its injected ops as ``op(path)``: backend
    identity (the accessor) and index-backed path resolution (gdrive,
    gmail, slack, ... resolve a path to its real id through the index)
    are wiring, so both bind here, mirroring the TS builders' closures.
    ``None`` passes through so a backend/test can still opt out of
    streaming.

    Args:
        fn (OperationFn | None): backend op ``(accessor, path, *, index)``,
            or None to opt out of streaming.
        accessor (Accessor): backend handle bound into the op.
        index (IndexCacheStore): the per-call cache index.
    """
    if fn is None:
        return None
    return functools.partial(fn, accessor, index=index)


class Operation(StrEnum):
    WRITE = "write"
    EXISTS = "exists"
    MKDIR = "mkdir"
    UNLINK = "unlink"
    RMDIR = "rmdir"
    RENAME = "rename"
    COPY = "copy"
    TRUNCATE = "truncate"


@dataclass(frozen=True)
class Builder:
    name: str
    fn: OperationFn
    provision: OperationFn | None = None
    write: bool = False
    aggregate: OperationFn | None = None
    read: bool = False
    requirements: frozenset[Operation] = frozenset()


@dataclass(frozen=True)
class CommandIO:
    readdir: OperationFn
    read_bytes: OperationFn
    read_stream: OperationFn
    stat: OperationFn
    is_mounted: OperationFn
    local: bool = True
    max_glob_matches: int | None = DEFAULT_MAX_GLOB_MATCHES
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
    append: OperationFn | None = None
    set_attrs: OperationFn | None = None

    @property
    def resolve_glob(self) -> OperationFn:
        return make_resolve_glob(self.readdir, self.max_glob_matches)

    def operation(self, op: Operation) -> OperationFn | None:
        operations = {
            Operation.WRITE: self.write,
            Operation.EXISTS: self.exists,
            Operation.MKDIR: self.mkdir,
            Operation.UNLINK: self.unlink,
            Operation.RMDIR: self.rmdir,
            Operation.RENAME: self.rename,
            Operation.COPY: self.copy,
            Operation.TRUNCATE: self.truncate,
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
