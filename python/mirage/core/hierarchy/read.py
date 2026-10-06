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

from collections.abc import Awaitable, Callable, Mapping

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.probe import A, assert_parent
from mirage.core.hierarchy.scope import ROOT, DetectFn, ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import PathSpec, StatFn
from mirage.utils.ranges import slice_window

Reader = Callable[[A, ScopeMatch, PathSpec, IndexCacheStore], Awaitable[bytes]]

WindowedReader = Callable[
    [A, ScopeMatch, PathSpec, IndexCacheStore, int | None, int | None],
    Awaitable[bytes],
]

RangedReader = Callable[
    [A, ScopeMatch, PathSpec, IndexCacheStore, int, int | None],
    Awaitable[bytes],
]

ReadFn = Callable[..., Awaitable[bytes]]


def make_read(
    detect: DetectFn,
    readers: Mapping[str, Reader[A]],
    *,
    windowed: Mapping[str, WindowedReader[A]] | None = None,
    stat: StatFn | None = None,
) -> Callable[..., Awaitable[bytes]]:
    """Build a hierarchy read: classify, dispatch, refuse the rest.

    Readers own their fetches, guards and rendering; the kit owns the
    classification and the ENOENT funnel for every non-file shape.

    Args:
        detect (DetectFn): the backend's scope classifier.
        readers (Mapping[str, Reader]): one reader per leaf kind.
        windowed (Mapping[str, WindowedReader]): readers for kinds whose
            content is windowed at the source (postgres rows take a row
            limit/offset the backend pushes into the query); they receive
            the caller's ``limit``/``offset``, which every plain reader
            ignores, matching a filesystem read that has no row notion.
        stat (StatFn | None): the backend's stat. Given, every read
            first proves the file's parent directory exists the way stat
            proves it (``assert_parent``), so a container the listing
            refuses reads as absent exactly as ``ls`` and ``stat`` report
            it. A backend whose readers address the API by the ids in
            the path passes it: without it, ``cat`` of a board outside
            ``board_ids`` fetched that board by its id. The file itself
            stays the reader's to prove, since a bounded listing need
            not name every file that exists.
    """

    windows = windowed if windowed is not None else {}

    async def read(
        accessor: A,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        *,
        limit: int | None = None,
        offset: int | None = None,
    ) -> bytes:
        match = detect(path)
        window = windows.get(match.kind)
        reader = readers.get(match.kind)
        if stat is not None and (window is not None or reader is not None):
            await assert_parent(stat, accessor, path, index)
        if window is not None:
            return await window(accessor, match, path, index, limit, offset)
        if reader is None:
            # A directory that exists by construction (the root, or a
            # probed=False scope) read as a file is EISDIR. Everything
            # else is reported absent: a matched shape alone is no proof
            # the node exists, and GNU says "No such file" for a missing
            # name, "Is a directory" only for a real one.
            if match.kind == ROOT or (
                match.scope is not None
                and not match.scope.leaf
                and not match.scope.probed
            ):
                raise IsADirectoryError(path.virtual)
            raise enoent(path.virtual)
        return await reader(accessor, match, path, index)

    return read


def make_read_range(
    detect: DetectFn,
    read: ReadFn,
    *,
    ranged: Mapping[str, RangedReader[A]],
) -> ReadFn:
    """Build a byte-ranged read over a hierarchy read.

    A rendered file has no remote range to ask for — its bytes do not
    exist until the read renders them — so the window is sliced after
    the fact. A stored blob does (discord and slack attachments serve
    HTTP range requests), and downloading the whole file to keep a
    slice would defeat the ranged read; those kinds name a ranged
    reader here and push the window to the source.

    Args:
        detect (DetectFn): the backend's scope classifier.
        read (ReadFn): the backend's full read, usually ``make_read``'s.
        ranged (Mapping[str, RangedReader]): per-kind readers that push
            the byte window to the source.
    """

    async def read_range(
        accessor: A,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        match = detect(path)
        fn = ranged.get(match.kind)
        if fn is not None:
            return await fn(accessor, match, path, index, offset, size)
        data = await read(accessor, path, index)
        return slice_window(data, offset, size)

    return read_range
