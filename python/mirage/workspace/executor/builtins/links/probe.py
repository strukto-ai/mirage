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

import posixpath

from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import MISS_ERRORS, enoent
from mirage.utils.path import CycleError
from mirage.workspace.mount.namespace import Namespace


async def resolve_path_stat(dispatch: DispatchFn,
                            path: PathSpec) -> FileStat | None:
    """What a path is, asked on both channels a backend can answer on.

    A point lookup alone cannot decide. On a prefix store a directory is
    not an object, it is the set of keys under it, so ``stat`` misses
    what ``readdir`` would list. Absence therefore takes *both* channels
    coming back empty, which is the only evidence that nothing is there.

    The listing has to be non-empty to count: those stores answer a
    missing path with ``[]`` rather than raising, and cannot hold an
    empty directory anyway (one with no keys under it does not exist).
    Measured across every integ target: an implicit directory answers
    here, a missing path does not. That holds only while a backend's
    readdir refuses a path it cannot prove: postgres answered
    ``tables``/``views`` under any first segment, and every absent
    schema read as a directory here.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): path to resolve.
    """
    stat: FileStat | None
    try:
        stat, _ = await dispatch("stat", path)
    except MISS_ERRORS:
        stat = None
    if stat is not None:
        return stat
    try:
        entries, _ = await dispatch("readdir", path)
    except MISS_ERRORS:
        return None
    if not entries:
        return None
    return FileStat(name=posixpath.basename(path.virtual.rstrip("/")),
                    type=FileType.DIRECTORY)


async def path_stat(dispatch: DispatchFn, virtual: str) -> FileStat | None:
    """Stat one virtual path through the workspace, None when absent.

    Resolves through the op dispatcher rather than one backend, so a path
    under another mount answers correctly. This is what a traversal
    command asks about its own start point: a directory can be walked, a
    file is reported as itself, and None is GNU's missing-operand error.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path.
    """
    spec = PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1] or "/",
                    vfs_path="")
    return await resolve_path_stat(dispatch, spec)


async def path_readdir(dispatch: DispatchFn, virtual: str) -> list[str]:
    """List one virtual path through the workspace, as virtual paths.

    Resolves through the op dispatcher rather than one backend, so a
    directory served by another mount answers. This is what a walker
    reads once it crosses a mount boundary: the subtree under a nested
    mount lives in a VFS the walker's own accessor cannot open.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path of the directory.
    """
    spec = PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1] or "/",
                    vfs_path="")
    entries, _ = await dispatch("readdir", spec)
    return list(entries)


async def path_exists(dispatch: DispatchFn, virtual: str) -> bool:
    """Whether a resolved virtual path names something that exists.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path.
    """
    try:
        return await path_stat(dispatch, virtual) is not None
    except (OSError, ValueError):
        return False


async def link_target_stat(namespace: Namespace, dispatch: DispatchFn,
                           virtual: str) -> FileStat | None:
    """The stat of what a link points at, or None when it dangles.

    Under ``-L`` the reported entity is the target, so its type drives
    ``-type`` and its size and mtime drive ``-size`` and ``-mtime``. The
    stat goes through dispatch rather than one backend because a link
    may point into another mount.

    Only the two ways a link can legitimately have no target are mapped
    to None: a loop (ELOOP) and a missing target, the latter by
    ``stat_or_none``. Every other backend failure propagates, because a
    permission or connection error is not a dangling link and reporting
    it as one would print the link as ``-type l`` and exit 0.

    Args:
        namespace (Namespace): addressing authority holding the links.
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path of the link.
    """
    try:
        target = namespace.follow(virtual)
    except CycleError:
        return None
    spec = PathSpec(virtual=target,
                    directory=target[:target.rfind("/") + 1] or "/",
                    vfs_path="")
    return await stat_or_none(dispatch, spec)


async def dispatch_stat(dispatch: DispatchFn, path: PathSpec) -> FileStat:
    """Stat a path via dispatch in the shape the generics' probes take.

    ``dest_kind`` and its kin are written against a backend ``stat`` that
    raises on a miss, so a dispatcher answer of nothing becomes ENOENT.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): path to stat.
    """
    stat: FileStat | None
    stat, _ = await dispatch("stat", path)
    if stat is None:
        raise enoent(path)
    return stat


async def stat_or_none(dispatch: DispatchFn,
                       path: PathSpec) -> FileStat | None:
    """Stat a path via dispatch, mapping a missing file to ``None``.

    ENOTDIR counts as missing too: a path under a plain file cannot
    exist, and a folder-id backend (dropbox, box, gdrive) reports it from
    the stat itself, naming the file in the chain, where a keyed store
    answers ENOENT and leaves the chain to the command's own walk.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): path to stat.
    """
    # A missing destination is an expected mv case (plain rename), not an
    # error to surface.
    stat: FileStat | None
    try:
        stat, _ = await dispatch("stat", path)
    except (FileNotFoundError, NotADirectoryError):
        return None
    return stat
