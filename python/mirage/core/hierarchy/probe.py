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

from collections.abc import Awaitable
from functools import partial
from typing import Protocol, TypeVar

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.cache.index.warm import entry_or_warm
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

A = TypeVar("A", bound=Accessor)
A_contra = TypeVar("A_contra", bound=Accessor, contravariant=True)


class ReaddirFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path_spec: PathSpec,
                 index: IndexCacheStore = ...) -> Awaitable[list[str]]:
        ...


async def assert_listed(readdir: ReaddirFn[A], accessor: A, path: PathSpec,
                        index: IndexCacheStore) -> None:
    """Raise ENOENT unless the path appears in its parent's listing.

    Every path shape a fixed hierarchy serves is recognizable from the
    text alone, but a recognizable shape is not evidence the entry
    exists. The parent listing is index-cached, so validating costs one
    listing per directory rather than one API call per stat.

    Args:
        readdir (ReaddirFn): the backend's readdir.
        accessor (Accessor): backend accessor.
        path (PathSpec): VFS-relative path being stat'd.
        index (IndexCacheStore): index cache.

    Raises:
        FileNotFoundError: the entry is absent from its parent listing.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    parent_virtual = path.virtual.rstrip("/").rsplit("/", 1)[0] or "/"
    entries = await readdir(
        accessor,
        PathSpec(virtual=parent_virtual,
                 directory=parent_virtual,
                 vfs_path=mount_key(parent_virtual, prefix)),
        index=index,
    )
    names = {entry.rstrip("/").rsplit("/", 1)[-1] for entry in entries}
    if path.vfs_path.rstrip("/").rsplit("/", 1)[-1] not in names:
        raise enoent(path.virtual)


async def listed_size(index: IndexCacheStore, path: PathSpec) -> int | None:
    """Return the size the parent listing recorded for this path.

    Args:
        index (IndexCacheStore): index cache.
        path (PathSpec): VFS-relative path being stat'd.
    """
    # assert_listed has just populated the parent directory, so any size
    # the listing computed is already in the index.
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    lookup = await index.get(prefix + "/" + path.vfs_path)
    return lookup.entry.size if lookup.entry is not None else None


async def resolve_entry(readdir: ReaddirFn[A], accessor: A, path: PathSpec,
                        index: IndexCacheStore) -> IndexEntry | None:
    """Resolve the path's index entry, listing its parent when cold.

    Id-addressed backends can only turn a path into an id through the
    index, so the entry is the proof of existence AND the id source; this
    wraps ``entry_or_warm`` with the parent-readdir warm every such
    backend used to spell by hand.

    Args:
        readdir (ReaddirFn): the backend's readdir.
        accessor (Accessor): backend accessor.
        path (PathSpec): VFS-relative path being resolved.
        index (IndexCacheStore): index cache.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    key = path.vfs_path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
    warm = None
    if parent_virtual != virtual_key:
        warm = partial(
            readdir,
            accessor,
            PathSpec(virtual=parent_virtual,
                     directory=parent_virtual,
                     vfs_path=mount_key(parent_virtual, prefix)),
            index=index,
        )
    return await entry_or_warm(index, virtual_key, warm)
