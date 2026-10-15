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

from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar

from mirage.accessor.base import Accessor
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of, mounted_path

A = TypeVar("A", bound=Accessor)
A_contra = TypeVar("A_contra", bound=Accessor, contravariant=True)


class ReaddirFn(Protocol[A_contra]):
    def __call__(
        self,
        accessor: A_contra,
        path_spec: PathSpec,
        /,
        entry: FileStat | None = ...,
        parent: FileStat | None = ...,
    ) -> Awaitable[list[FileStat] | DirListing]: ...


def parent_spec(path: PathSpec) -> PathSpec:
    """The PathSpec of the directory holding ``path``, same mount.

    Args:
        path (PathSpec): a path below the mount root.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    parent_virtual = path.virtual.rstrip("/").rsplit("/", 1)[0] or "/"
    return PathSpec(
        virtual=parent_virtual,
        directory=parent_virtual,
        vfs_path=mount_key(parent_virtual, prefix),
    )


def rows_of(listed: list[FileStat] | DirListing) -> list[FileStat]:
    """The listed directory's own children, whichever shape listed them.

    Args:
        listed (list[FileStat] | DirListing): a readdir's answer.
    """
    return listed.entries if isinstance(listed, DirListing) else listed


def is_directory(row: FileStat) -> bool:
    """Whether a listed row is a directory to walk into.

    Args:
        row (FileStat): the row.
    """
    return row.type is FileType.DIRECTORY


async def rows_under(
    readdir: ReaddirFn[A],
    accessor: A,
    directory: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None = None,
    is_dir: Callable[[FileStat], bool] = is_directory,
) -> list[tuple[PathSpec, FileStat]]:
    """Every row below ``directory``, walked through the backend's own
    listings, each directory handed the row its parent's listing named.

    Args:
        readdir (ReaddirFn): the backend's readdir.
        accessor (Accessor): backend accessor.
        directory (PathSpec): the directory walked.
        entry (FileStat | None): what is at ``directory``.
        parent (FileStat | None): what is at its parent.
        is_dir (Callable[[FileStat], bool]): whether a row is a directory
            to walk into.
    """
    found: list[tuple[PathSpec, FileStat]] = []
    pending = [(directory, entry, parent)]
    while pending:
        current, row, above = pending.pop()
        base = current.mount_path.rstrip("/")
        for child in rows_of(await readdir(accessor, current, row, above)):
            path = mounted_path(current, f"{base}/{child.name}")
            found.append((path, child))
            if is_dir(child):
                pending.append((path, child, row))
    return found


async def row_at(
    readdir: ReaddirFn[A], accessor: A, path: PathSpec
) -> tuple[FileStat | None, FileStat | None]:
    """What is at ``path`` and at its parent, as each level's listing
    names it, listed from the mount root down: a walk that starts below
    the root hands its first directory these.

    The mount root is no listing's child, so it answers nothing; a name
    a level does not list answers no row at ``path``.

    Args:
        readdir (ReaddirFn): the backend's readdir.
        accessor (Accessor): backend accessor.
        path (PathSpec): the path.
    """
    key = path.mount_path.strip("/")
    entry: FileStat | None = None
    parent: FileStat | None = None
    current = mounted_path(path, "/")
    for name in key.split("/") if key else []:
        listed = rows_of(await readdir(accessor, current, entry, parent))
        row = next((row for row in listed if row.name == name), None)
        if row is None:
            return None, entry
        entry, parent = row, entry
        current = mounted_path(
            path, f"{current.mount_path.rstrip('/')}/{name}"
        )
    return entry, parent
