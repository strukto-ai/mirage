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
from typing import NamedTuple, overload

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.ops.config import StatOverlay
from mirage.types import FileStat, PathSpec
from mirage.utils.glob_walk import resolve_glob_with


async def overlaid_stat(stat: Callable, overlay: StatOverlay, path: PathSpec,
                        index: IndexCacheStore | None) -> FileStat:
    """Stat through the backend, then merge the namespace attr overlay.

    Bound via ``partial(overlaid_stat, stat_fn, overlay)`` so stat-
    rendering commands (ls) show chmod/chown/touch state the backend
    itself cannot hold.

    Args:
        stat (Callable): backend stat callable ``(path, index) -> FileStat``.
        overlay (StatOverlay): namespace merge ``(virtual, stat) -> stat``.
        path (PathSpec): entry being statted.
        index (IndexCacheStore | None): cache index threaded through.
    """
    return overlay(path.virtual, await stat(path, index))


@overload
def with_index(fn: Callable, index: IndexCacheStore | None) -> Callable:
    ...


@overload
def with_index(fn: None, index: IndexCacheStore | None) -> None:
    ...


def with_index(fn: Callable | None,
               index: IndexCacheStore | None) -> Callable | None:
    """Bind the runtime cache index into a read op for the generics.

    A generic command calls its injected reader as ``read(accessor, path)``
    with no index, but index-backed backends (gdrive, gmail, slack, ...)
    resolve a path to its real id through the index, so the bound index must
    travel with the reader. Harmless for backends that ignore it. ``None``
    passes through so a backend/test can still opt out of streaming.

    Args:
        fn (Callable | None): the read op, or None to opt out of streaming.
        index (IndexCacheStore | None): the per-call cache index.
    """
    if fn is None:
        return None
    return functools.partial(fn, index=index)


class Builder(NamedTuple):
    name: str
    fn: Callable
    provision: Callable | None = None
    write: bool = False
    aggregate: Callable | None = None
    read: bool = False


def make_resolve_glob(readdir: Callable,
                      max_glob_matches: int | None = None) -> Callable:
    """Build a resolve_glob generic over a backend's readdir.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``.
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
    readdir: Callable
    read_bytes: Callable
    read_stream: Callable
    stat: Callable
    is_mounted: Callable
    local: bool = True
    max_glob_matches: int | None = None
    write: Callable | None = None
    exists: Callable | None = None
    mkdir: Callable | None = None
    unlink: Callable | None = None
    rmdir: Callable | None = None
    rm_r: Callable | None = None
    rename: Callable | None = None
    copy: Callable | None = None
    dir_copy: Callable | None = None
    create: Callable | None = None
    truncate: Callable | None = None
    find: Callable | None = None
    is_dir_name: Callable | None = None
    du_total: Callable | None = None
    du_all: Callable | None = None

    @property
    def resolve_glob(self) -> Callable:
        return make_resolve_glob(self.readdir, self.max_glob_matches)

    def require(self, op: str) -> Callable:
        """Return an optional backend op, raising if the backend omits it.

        Builders wire write-side ops (write/mkdir/unlink/rename/...) that
        are ``None`` on read-only backends into generic commands that
        require them. This surfaces the missing capability as a clear
        error instead of a ``NoneType is not callable`` crash.

        Args:
            op (str): CommandIO field name of the operation.
        """
        fn = getattr(self, op)
        if fn is None:
            raise NotImplementedError(
                f"operation {op!r} is not supported on this backend")
        return fn
