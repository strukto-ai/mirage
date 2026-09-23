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

import logging
from functools import partial

from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.core.object_store.driver import (A, C, FindHints,
                                             ObjectStoreDriver, ReaddirFn,
                                             TreeEntry)
from mirage.types import PathSpec
from mirage.utils import key_prefix as kp
from mirage.utils.errors import listing_error
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def _probe_file(driver: ObjectStoreDriver[A, C], conn: C, kpfx: str,
                      key: str) -> bool:
    return await driver.head(conn, kp.apply(kpfx, key)) is not None


async def _probe_dir(driver: ObjectStoreDriver[A, C], conn: C, kpfx: str,
                     key: str) -> bool:
    return await driver.probe_prefix(conn, kp.apply_dir(kpfx, key))


def make_readdir(driver: ObjectStoreDriver[A, C]) -> ReaddirFn[A]:
    """Build a prefix listing with index write-back over one driver.

    Args:
        driver (ObjectStoreDriver): the store's native surface.
    """

    async def readdir(accessor: A,
                      path_spec: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> list[str]:
        prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
        # When called from resolve_glob with a pattern (e.g. *.txt),
        # use path.directory for the listing. Direct callers (ls, ops)
        # pass pattern=None so path.virtual is used.
        path = path_spec.directory if path_spec.pattern else path_spec.virtual
        if prefix and path.startswith(prefix):
            rest = path[len(prefix):]
            if prefix.endswith("/") or rest == "" or rest.startswith("/"):
                path = rest or "/"
        kpfx = driver.key_prefix_of(accessor)
        raw_key = prefix + path if prefix else path
        virtual_key = raw_key.rstrip("/") or "/"
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
        await cached_entry(index, virtual_key)
        pfx = kp.apply_dir(kpfx, path)
        names: list[str] = []
        dir_keys: set[str] = set()
        sizes: dict[str, int | None] = {}
        times: dict[str, str] = {}
        saw_key = False
        async with driver.connect(accessor) as conn:
            async for child in driver.list_children(conn, pfx):
                saw_key = True
                if child.kind == "marker":
                    continue
                key = "/" + kp.strip(kpfx, child.key)
                if child.kind == "d":
                    if key in dir_keys:
                        continue
                    names.append(key)
                    dir_keys.add(key)
                else:
                    names.append(key)
                    sizes[key] = child.size
                    times[key] = child.modified
            if not saw_key and path.strip("/"):
                # An empty directory is a zero-byte marker object keyed at
                # the prefix itself, so a prefix holding no key at all --
                # not even that marker -- is a path the store does not
                # have. Without this, `ls` on a missing path rendered an
                # empty directory and exited 0 where every real filesystem
                # reports ENOENT. The mount root is exempt: it exists
                # because it is mounted.
                raise await listing_error(
                    path_spec, path, partial(_probe_file, driver, conn, kpfx),
                    partial(_probe_dir, driver, conn, kpfx))
        names = sorted(names)
        if len(names) > driver.scope_error:
            logger.warning(
                "%s readdir: %s returned %d entries (limit %d)",
                driver.vfs,
                virtual_key,
                len(names),
                driver.scope_error,
            )
        virtual_entries = sorted((prefix + e if prefix else e) for e in names)
        index_entries = []
        for e in names:
            name = e.rsplit("/", 1)[-1]
            if e in dir_keys:
                # Store "folders" are synthetic prefixes with no object of
                # their own, so there is no mtime or size to record.
                entry = IndexEntry(id=e,
                                   name=name,
                                   resource_type=ResourceType.FOLDER,
                                   extra={"object_store_collision": True}
                                   if e in sizes else {})
            else:
                entry = IndexEntry(id=e,
                                   name=name,
                                   resource_type=ResourceType.FILE,
                                   size=sizes.get(e),
                                   remote_time=times.get(e, ""))
            index_entries.append((name, entry))
        await index.set_dir(virtual_key, index_entries)
        return virtual_entries

    return readdir


async def cached_entry(index: IndexCacheStore,
                       virtual: str) -> IndexEntry | None:
    """Trust metadata only while a listing still proves the path exists.

    Args:
        index (IndexCacheStore): metadata and expiring directory listings.
        virtual (str): virtual path to validate.
    """
    entry = (await index.get(virtual)).entry
    if entry is None:
        return None
    parent = virtual.rsplit("/", 1)[0] or "/"
    siblings = (await index.list_dir(parent)).entries
    if siblings is not None and virtual in siblings:
        return entry
    if (entry.resource_type == ResourceType.FOLDER
            and (await index.list_dir(virtual)).entries is not None):
        return entry
    # A later listing must not revive metadata from an expired generation.
    await index.invalidate_prefix(virtual)
    return None


async def cached_tree(index: IndexCacheStore, virtual: str,
                      key: str) -> list[TreeEntry] | None:
    """Read a complete subtree only while every directory listing is fresh.

    Args:
        index (IndexCacheStore): metadata from previous listings.
        virtual (str): virtual directory root.
        key (str): corresponding backend prefix.
    """
    if index is NULL_INDEX:
        return None
    found: list[TreeEntry] = []
    pending = [(virtual, key)]
    while pending:
        directory, prefix = pending.pop()
        listing = await index.list_dir(directory)
        if listing.entries is None:
            return None
        for child in listing.entries:
            hit = await index.get(child)
            entry = hit.entry
            if entry is None or entry.extra.get("object_store_collision"):
                return None
            child_key = prefix + child.rsplit("/", 1)[-1]
            if entry.resource_type == ResourceType.FOLDER:
                found.append(TreeEntry(key=child_key + "/"))
                pending.append((child, child_key + "/"))
            elif entry.size is None:
                return None
            else:
                found.append(
                    TreeEntry(key=child_key,
                              size=entry.size,
                              modified=entry.remote_time))
    # A cached empty listing proves that the directory exists.
    return found or [TreeEntry(key=key)]


async def cache_tree(index: IndexCacheStore, virtual: str, key: str,
                     entries: list[TreeEntry]) -> None:
    """Publish complete directory listings after a successful recursive walk.

    Args:
        index (IndexCacheStore): metadata index to populate.
        virtual (str): virtual directory root.
        key (str): corresponding backend prefix.
        entries (list[TreeEntry]): unfiltered backend rows, including markers.
    """
    if index is NULL_INDEX:
        return
    if any(row.size is None and not row.key.endswith("/") for row in entries):
        return
    directories: dict[str, dict[str, IndexEntry]] = {virtual: {}}
    files: set[str] = set()
    for row in entries:
        if not row.key.startswith(key) or row.key == key:
            continue
        relative = row.key[len(key):].rstrip("/")
        if not relative:
            continue
        parts = relative.split("/")
        parent = virtual
        for i, name in enumerate(parts):
            child = parent.rstrip("/") + "/" + name
            is_dir = i < len(parts) - 1 or row.key.endswith("/")
            if is_dir:
                directories.setdefault(child, {})
            else:
                files.add(child)
            directories[parent][name] = IndexEntry(
                id=child,
                name=name,
                resource_type=ResourceType.FOLDER
                if is_dir else ResourceType.FILE,
                size=None if is_dir else row.size,
                remote_time="" if is_dir else row.modified)
            parent = child
    # A single index path cannot represent both a file and a prefix.
    if files.intersection(directories):
        return
    for directory, children in directories.items():
        await index.set_dir(directory, list(children.items()))


async def read_tree(
        driver: ObjectStoreDriver[A, C],
        accessor: A,
        path: PathSpec,
        index: IndexCacheStore,
        hints: FindHints | None = None) -> tuple[list[TreeEntry], bool]:
    """Reuse a complete tree, or cache a successful backend listing.

    Args:
        driver (ObjectStoreDriver): backend primitives.
        accessor (Accessor): backend connection configuration.
        path (PathSpec): operand root.
        index (IndexCacheStore): invocation's metadata index.
        hints (FindHints | None): find pushdown; None includes a file root.
    """
    kpfx = driver.key_prefix_of(accessor)
    stem = kp.apply(kpfx, path.mount_path).rstrip("/")
    prefix = stem + "/" if stem else ""
    virtual = path.virtual.rstrip("/") or "/"
    root = await cached_entry(index, virtual)
    collision = root is not None and root.extra.get("object_store_collision")
    known_directory = (not path.mount_path.strip("/")
                       or (root is not None
                           and root.resource_type == ResourceType.FOLDER))
    cached = (await cached_tree(index, virtual, prefix) if not collision and
              (hints is not None or known_directory) else None)
    if cached is not None:
        return cached, False
    if hints is None:
        hit = root
        parent = await index.list_dir(virtual.rsplit("/", 1)[0] or "/")
        if (parent.entries is not None and virtual in parent.entries
                and hit is not None and hit.resource_type == ResourceType.FILE
                and hit.size is not None):
            return [TreeEntry(key=stem, size=hit.size)], False
    async with driver.connect(accessor) as conn:
        narrowed = False
        if hints is None:
            iterator = driver.list_subtree(conn, stem)
        elif driver.find_tree is not None:
            iterator, narrowed = driver.find_tree(conn, prefix, hints)
        else:
            iterator = driver.list_tree(conn, prefix)
        entries = [entry async for entry in iterator]
        exists = narrowed and not entries and await driver.probe_prefix(
            conn, prefix)
        if not narrowed and not any(e.key == stem for e in entries) and (any(
                e.key.startswith(prefix)
                for e in entries) or not path.mount_path.strip("/")):
            await cache_tree(index, virtual, prefix, entries)
            # A find prefix omits a coexisting file root. Verify that slot
            # before publishing a folder that later commands trust.
            if (hints is None or (known_directory and not collision)
                    or (index is not NULL_INDEX
                        and await driver.head(conn, stem) is None)):
                await index.put(
                    virtual,
                    IndexEntry(id=virtual,
                               name=virtual.rsplit("/", 1)[-1] or "/",
                               resource_type=ResourceType.FOLDER))
    return entries, exists
