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
from typing import Any, TypeVar

from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.scope import ROOT, DetectFn, ScopeMatch
from mirage.errors.fs import eisdir, enoent
from mirage.types import FileStat, PathSpec
from mirage.utils.ranges import slice_window

Reader = Callable[
    [A, ScopeMatch, PathSpec, FileStat | None, FileStat | None],
    Awaitable[bytes],
]

WindowedReader = Callable[
    [
        A,
        ScopeMatch,
        PathSpec,
        FileStat | None,
        FileStat | None,
        int | None,
        int | None,
    ],
    Awaitable[bytes],
]

RangedReader = Callable[
    [
        A,
        ScopeMatch,
        PathSpec,
        FileStat | None,
        FileStat | None,
        int,
        int | None,
    ],
    Awaitable[bytes],
]

ReadFn = Callable[..., Awaitable[bytes]]

T = TypeVar("T")

Guard = Callable[[A, ScopeMatch, str], Awaitable[None]]


def make_read(
    detect: DetectFn,
    readers: Mapping[str, Reader[A]],
    *,
    windowed: Mapping[str, WindowedReader[A]] | None = None,
    parented: bool = False,
) -> Callable[..., Awaitable[bytes]]:
    """Build a hierarchy read: classify, dispatch, refuse the rest.

    Readers own their fetches, guards and rendering, handed what is at
    the path (``entry``) and at its parent (``parent``) as the listings
    name them; the kit owns the classification and the ENOENT funnel for
    every non-file shape.

    Args:
        detect (DetectFn): the backend's scope classifier.
        readers (Mapping[str, Reader]): one reader per leaf kind.
        windowed (Mapping[str, WindowedReader]): readers for kinds whose
            content is windowed at the source (postgres rows take a row
            limit/offset the backend pushes into the query); they receive
            the caller's ``limit``/``offset``, which every plain reader
            ignores, matching a filesystem read that has no row notion.
        parented (bool): every read first proves the file's parent
            directory exists, by the row its listing names, so a
            container the listing refuses reads as absent exactly as
            ``ls`` and ``stat`` report it. A backend whose readers
            address the API by the ids in the path asks for it: without
            it, ``cat`` of a board outside ``board_ids`` fetched that
            board by its id. The file itself stays the reader's to prove,
            since a bounded listing need not name every file that exists.
    """

    windows = windowed if windowed is not None else {}

    async def read(
        accessor: A,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
        *,
        limit: int | None = None,
        offset: int | None = None,
    ) -> bytes:
        match = detect(path)
        window = windows.get(match.kind)
        reader = readers.get(match.kind)
        if (
            parented
            and (window is not None or reader is not None)
            and parent is None
            and "/" in path.vfs_path.strip("/")
        ):
            # Named as the file the caller asked for, the way GNU reports
            # `cat missing/f` against the operand rather than its directory.
            raise enoent(path.virtual)
        if window is not None:
            return await window(
                accessor, match, path, entry, parent, limit, offset
            )
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
                raise eisdir(path.virtual)
            raise enoent(path.virtual)
        return await reader(accessor, match, path, entry, parent)

    return read


def per_kind(
    detect: DetectFn,
    answers: Mapping[str, Callable[..., Awaitable[T]]],
    *,
    guard: Guard[A] | None = None,
) -> Callable[..., Awaitable[T | None]]:
    """Build a call only some file kinds answer: classify, guard,
    dispatch, None for the rest.

    The line calls (``first_lines``, ``last_lines``, ``line_count``,
    ``follow``) are answered for a backend's data files (a table's
    rows, a collection's documents) and not for its metadata files (a
    schema, a database.json), which the caller reads the usual way. The
    table names the data kinds once, so no answer repeats the check.

    Args:
        detect (DetectFn): the backend's scope classifier.
        answers (Mapping[str, Callable]): one answer per data kind,
            called as ``answer(accessor, match, path, *args)``.
        guard (Guard | None): proves the matched entity exists before
            its answer runs, called as ``guard(accessor, match,
            virtual)``.
    """

    async def call(
        accessor: A, path: PathSpec, *args: Any, **kwargs: Any
    ) -> T | None:
        match = detect(path)
        answer = answers.get(match.kind)
        if answer is None:
            return None
        if guard is not None:
            await guard(accessor, match, path.virtual)
        return await answer(accessor, match, path, *args, **kwargs)

    return call


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
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> bytes:
        match = detect(path)
        fn = ranged.get(match.kind)
        if fn is not None:
            return await fn(accessor, match, path, entry, parent, offset, size)
        data = await read(accessor, path, entry, parent)
        return slice_window(data, offset, size)

    return read_range
