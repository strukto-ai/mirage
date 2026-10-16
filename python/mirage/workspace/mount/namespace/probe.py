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

from mirage.commands.builtin.utils.paths import resolve_path_stat
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.types import DotWalkLoop, FsCondition
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec
from mirage.utils.path import CycleError
from mirage.view.types import NamespaceLinks


async def path_stat(
    dispatch: DispatchFn, virtual: str | PathSpec
) -> FileStat | None:
    """Stat one virtual path through the workspace, None when absent.

    Resolves through the op dispatcher rather than one backend, so a path
    under another mount answers correctly. This is what a traversal
    command asks about its own start point: a directory can be walked, a
    file is reported as itself, and None is GNU's missing-operand error.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str | PathSpec): absolute virtual path.
    """
    spec = PathSpec.from_str_path(virtual, cwd="/")
    return await resolve_path_stat(dispatch, spec)


async def miss_condition(
    dispatch: DispatchFn, virtual: str | PathSpec
) -> FsCondition:
    """The condition a diagnostic names for a path ``path_stat`` found
    nothing at.

    ``path_stat`` answers None for both ways a lookup fails, since an
    existence probe treats them alike, while a diagnostic names the one
    the stat met: ENOTDIR for a path under a plain file, ELOOP for one a
    link loop stands in, ENOENT for the rest. Asked only after a miss, so
    its round trip is on the failure path.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str | PathSpec): absolute virtual path.
    """
    try:
        await dispatch("stat", PathSpec.from_str_path(virtual, cwd="/"))
    except NotADirectoryError:
        return FsCondition.ENOTDIR
    except MISS_ERRORS:
        return FsCondition.ENOENT
    except DotWalkLoop:
        return FsCondition.ELOOP
    return FsCondition.ENOENT


async def path_readdir(
    dispatch: DispatchFn, virtual: str | PathSpec
) -> list[str]:
    """List one virtual path through the workspace, as virtual paths.

    Resolves through the op dispatcher rather than one backend, so a
    directory served by another mount answers. This is what a walker
    reads once it crosses a mount boundary: the subtree under a nested
    mount lives in a VFS the walker's own accessor cannot open.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str | PathSpec): absolute virtual path of the directory.
    """
    spec = PathSpec.from_str_path(virtual, cwd="/")
    entries, _ = await dispatch("readdir", spec)
    return list(entries)


async def path_exists(dispatch: DispatchFn, virtual: str | PathSpec) -> bool:
    """Whether a resolved virtual path names something that exists.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str | PathSpec): absolute virtual path.
    """
    try:
        return await path_stat(dispatch, virtual) is not None
    except (OSError, ValueError):
        return False


def resolve_link(namespace: NamespaceLinks, virtual: str) -> str:
    """Where a path really points, as the dispatcher can address it.

    The namespace's walk, with a relative target's walk up from the
    link's own directory (``../a.txt``) collapsed, which the dispatcher does
    not do for a path it is handed whole. The link's directory is a real
    one, since the table keys every link by its resolved parent, so the
    ``..`` it names is that directory's parent.

    Args:
        namespace (Namespace): addressing authority holding the links.
        virtual (str): absolute virtual path.

    Raises:
        CycleError: when the chain loops past the hop limit (ELOOP).
    """
    return posixpath.normpath(namespace.follow(virtual))


async def link_target_stat(
    namespace: NamespaceLinks, dispatch: DispatchFn, virtual: str
) -> FileStat | None:
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
        target = resolve_link(namespace, virtual)
    except CycleError:
        return None
    spec = PathSpec(
        virtual=target,
        directory=target[: target.rfind("/") + 1] or "/",
        vfs_path="",
    )
    return await stat_or_none(dispatch, spec)


async def stat_or_none(
    dispatch: DispatchFn, path: PathSpec
) -> FileStat | None:
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
