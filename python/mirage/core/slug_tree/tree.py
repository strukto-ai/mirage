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

from typing import Generic

from mirage.cache.index import NULL_INDEX, IndexCacheStore, LookupStatus
from mirage.cache.index.config import IndexSnapshot
from mirage.core.slug_tree.rows import mount_root
from mirage.core.slug_tree.types import (
    A,
    LoadRows,
    ResolvedDirectory,
    ResolvedFile,
    ResolvedPath,
)
from mirage.errors.fs import enoent, enotdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of, rekey


class SlugTree(Generic[A]):
    """A backend's whole document list, served as a directory tree.

    Every listing of the mount comes from one fetch, so the tree is
    written to the index whole and an expired listing means the tree
    aged out rather than that a folder went away.

    Args:
        load (LoadRows[A]): fetches the documents and lays out each
            folder's rows under a mount prefix.
    """

    def __init__(self, load: LoadRows[A]) -> None:
        self.load = load

    async def ensure(
        self, accessor: A, index: IndexCacheStore, prefix: str
    ) -> dict[str, list[str]] | None:
        listing = await index.list_dir(mount_root(prefix))
        if listing.entries is not None:
            return None
        return await self.refill(accessor, index, prefix)

    async def refill(
        self, accessor: A, index: IndexCacheStore, prefix: str
    ) -> dict[str, list[str]]:
        """Refetch the tree, write every folder's listing, return the rows.

        The rows are returned so a reader can answer from them when the
        index itself will not serve them (fresh refusing every listing
        outside a command).

        Args:
            accessor (A): the mount's accessor.
            index (IndexCacheStore): the index to write.
            prefix (str): the mount prefix the keys are built against.
        """
        rows = await self.load(accessor, prefix)
        children: dict[str, list[str]] = {}
        for directory in sorted(rows):
            entries = sorted(rows[directory], key=lambda item: item[0])
            await index.set_dir(directory, entries)
            stem = "/" if directory == "/" else directory + "/"
            children[directory] = [stem + name for name, _ in entries]
        return index.scope_snapshot(IndexSnapshot({}, children)).children

    async def resolve(
        self, accessor: A, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> ResolvedPath:
        mount_prefix = mount_prefix_of(path.virtual, path.vfs_path) or ""
        refilled = await self.ensure(accessor, index, mount_prefix)
        virtual_key = virtual_key_for(path)
        result = await index.get(virtual_key)
        if result.entry is not None and result.entry.resource_type != "folder":
            return ResolvedFile(
                virtual_key=virtual_key,
                mount_prefix=mount_prefix,
                entry=result.entry,
            )
        if result.entry is None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is None:
                if listing.status != LookupStatus.EXPIRED:
                    raise enoent(path)
                if refilled is None:
                    refilled = await self.refill(accessor, index, mount_prefix)
                if virtual_key not in refilled:
                    raise enoent(path)
        return ResolvedDirectory(
            virtual_key=virtual_key,
            mount_prefix=mount_prefix,
            children=None if refilled is None else refilled.get(virtual_key),
        )

    async def readdir(
        self, accessor: A, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        resolved = await self.resolve(accessor, path, index)
        if not resolved.is_dir:
            raise enotdir(path)
        if resolved.children is not None:
            return resolved.children
        listing = await index.list_dir(resolved.virtual_key)
        if listing.entries is None and listing.status == LookupStatus.EXPIRED:
            refilled = await self.refill(
                accessor, index, resolved.mount_prefix
            )
            if resolved.virtual_key in refilled:
                return refilled[resolved.virtual_key]
        if listing.entries is None:
            raise enoent(path)
        return listing.entries

    async def walk(
        self,
        accessor: A,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        *,
        include_root: bool = False,
        maxdepth: int | None = None,
        strip_prefix: bool = False,
        ignore_missing: bool = False,
        depth: int = 0,
    ) -> list[str]:
        try:
            resolved = await self.resolve(accessor, path, index)
        except (FileNotFoundError, NotADirectoryError):
            if ignore_missing:
                return []
            raise
        current = path.mount_path if strip_prefix else path.virtual
        results = [current] if include_root else []
        if not resolved.is_dir or (maxdepth is not None and depth >= maxdepth):
            return results
        try:
            children = await self.readdir(accessor, path, index)
        except (FileNotFoundError, NotADirectoryError):
            if ignore_missing:
                return results
            raise
        for child in children:
            child_path = PathSpec.from_str_path(
                child, rekey(path.virtual, path.vfs_path, child)
            )
            results.extend(
                await self.walk(
                    accessor,
                    child_path,
                    index,
                    include_root=True,
                    maxdepth=maxdepth,
                    strip_prefix=strip_prefix,
                    ignore_missing=ignore_missing,
                    depth=depth + 1,
                )
            )
        return results


def virtual_key_for(path: PathSpec) -> str:
    raw = path.directory if path.pattern else path.virtual
    prefix = mount_prefix_of(path.virtual, path.vfs_path) or ""
    if prefix:
        root = mount_root(prefix)
        if raw == root or raw.startswith(root + "/"):
            return raw.rstrip("/") or root
        rest = raw.strip("/")
        if not rest:
            return root
        return root + "/" + rest
    stripped = raw.strip("/")
    return "/" + stripped if stripped else "/"
