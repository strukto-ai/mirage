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

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from mirage.commands.builtin.utils.operands import operand_name
from mirage.ops.types import MountView
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import MISS_ERRORS
from mirage.utils.key_prefix import mount_key


def to_pathspec(path: Any, prefix: str = "") -> PathSpec:
    if isinstance(path, PathSpec):
        return path
    return PathSpec(virtual=path,
                    directory=path,
                    vfs_path=mount_key(path, prefix))


def mount_parent_readdir(
    readdir: Callable[[str | PathSpec], Awaitable[list[str]]],
    mounts: MountView | None,
) -> Callable[[str | PathSpec], Awaitable[list[str]]]:
    """Wrap a walker's readdir so a mount parent lists as empty, not absent.

    A directory that exists only because mounts sit under it (``/repos``
    when ``/repos/alpha`` is mounted) has no backend to list it, so the
    readdir raises and a recursive command reports the operand missing
    even as the fan-out searches the mounts below it and prints hits.
    Empty is the honest answer for the primary backend: the directory is
    there, and it owns nothing in it.

    Empty rather than the mount names, because the fan-out already runs
    the command once per descendant mount and concatenates. Listing them
    here would search each one twice.

    Only for an absence, which is why the catch is ``MISS_ERRORS`` and
    not the walk's own wider set: a directory the backend refused with
    EACCES or ENOTSUP is there and holds data this run cannot read, and
    calling it empty would let ``grep -r`` print the descendant mount's
    hits and exit 0 while silently omitting it. A refusal that is not
    absence keeps propagating and gets reported.

    The visible descendants, not every descendant. Answering at all
    tells the session the directory is there, and a directory that
    exists only because of a mount it may not be told about is a
    directory it may not be told about either: a hidden mount under an
    otherwise absent parent has to keep reading as absence, the same
    way the mount itself does.

    Args:
        readdir (Callable): the bound readdir the walk uses.
        mounts (MountView | None): the mount boundaries; without them
            there is nothing to check and the readdir passes through.
    """
    if mounts is None:
        return readdir

    async def listing(path: str | PathSpec) -> list[str]:
        try:
            return await readdir(path)
        except MISS_ERRORS:
            virtual = path.virtual if isinstance(path, PathSpec) else path
            if mounts.visible_descendants(virtual):
                return []
            raise

    return listing


def mount_parent_stat(
    stat: Callable[[str | PathSpec], Awaitable[FileStat]],
    mounts: MountView | None,
) -> Callable[[str | PathSpec], Awaitable[FileStat]]:
    """Wrap a walker's stat so a mount parent reports as a directory.

    The twin of :func:`mount_parent_readdir`, and the reason a recursive
    search over ``/repos`` reported it missing while still printing hits
    from ``/repos/alpha``: the operand was statted before it was walked,
    the primary backend has no such path, and the miss was reported as
    absence.

    The mount table decides, not the dispatcher. A dispatched stat would
    answer for paths inside the descendant mounts too, which is exactly
    what the primary run must not see: the fan-out searches each of them
    separately, so claiming their entries here would search them twice.
    A path with visible mounts strictly under it is the only case, and
    its row is a directory with no size, the same row the namespace
    serves. Visible, because a row is a disclosure: the parent of a
    mount this session may not be told about stays absent, which is
    what every other verb already answers there.

    An absence only, the same as its readdir twin: a backend that
    refused the path rather than not having it is reporting something
    the run must not paper over with a synthesized row.

    Args:
        stat (Callable): the bound stat the walk uses.
        mounts (MountView | None): the mount boundaries; without them
            there is nothing to check and the stat passes through.
    """
    if mounts is None:
        return stat

    async def probe(path: str | PathSpec) -> FileStat:
        try:
            return await stat(path)
        except MISS_ERRORS:
            virtual = path.virtual if isinstance(path, PathSpec) else path
            if not mounts.visible_descendants(virtual):
                raise
            return FileStat(name=operand_name(to_pathspec(virtual)),
                            type=FileType.DIRECTORY)

    return probe


# The call_* helpers adapt a bound op (accessor and index already bound,
# called as ``op(path)``) so grep/rg can walk with plain string keys.


async def call_readdir(
    readdir_fn: Callable[[PathSpec], Awaitable[list[str]]],
    path: str | PathSpec,
    prefix: str = "",
) -> list[str]:
    return await readdir_fn(to_pathspec(path, prefix))


async def call_stat(
    stat_fn: Callable[[PathSpec], Awaitable[FileStat]],
    path: str | PathSpec,
    prefix: str = "",
) -> FileStat:
    return await stat_fn(to_pathspec(path, prefix))


async def call_read_bytes(
    read_fn: Callable[[PathSpec], Awaitable[bytes]],
    path: str | PathSpec,
    prefix: str = "",
) -> bytes:
    return await read_fn(to_pathspec(path, prefix))


async def stream_from_bytes(
    read_fn: Callable[..., Any],
    accessor: Any,
    path: Any,
    index: Any = None,
    prefix: str = "",
) -> AsyncIterator[bytes]:
    # CommandIO-level adapter: raw ``(accessor, path, index)`` shape.
    yield await read_fn(accessor, to_pathspec(path, prefix), index)
