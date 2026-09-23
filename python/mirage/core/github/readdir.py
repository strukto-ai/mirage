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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                LookupStatus)
from mirage.cache.index.lock import index_lock
from mirage.core.github.repo import ensure_ref
from mirage.core.github.tree import (ensure_live_index, fetch_dir_tree,
                                     refill_index)
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

log = logging.getLogger(__name__)


async def readdir(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    async with index_lock(index, prefix.rstrip("/") or "/"):
        return await _readdir(accessor, path_spec, index)


async def _readdir(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    """Read while the caller holds the mount's index lock through lookup."""
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    await ensure_live_index(accessor, index, prefix)
    listing = await index.list_dir(virtual_key)
    # The index is the whole listing here, not a cache in front of one, so
    # an *expired* answer means the tree aged out, not that the path is
    # gone. Refetch once and ask again. A NOT_FOUND against a live index
    # is a real absence and must not cost a tree fetch.
    if listing.status == LookupStatus.EXPIRED and not accessor.truncated:
        if await refill_index(accessor, index, prefix):
            listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    if accessor.truncated and listing.status in (LookupStatus.NOT_FOUND,
                                                 LookupStatus.EXPIRED):
        return await _fallback_readdir(accessor, virtual_key, index, virtual,
                                       prefix)
    if listing.status == LookupStatus.NOT_FOUND:
        raise enoent(virtual)
    return []


async def _fallback_readdir(
    accessor: GitHubAccessor,
    virtual_key: str,
    index: IndexCacheStore,
    virtual: str,
    prefix: str,
) -> list[str]:
    """Per-directory tree fetch when recursive tree was truncated.

    Args:
        accessor (GitHubAccessor): backend handle.
        virtual_key (str): Mount-absolute directory key.
        index (IndexCacheStore): the mount's index.
        virtual (str): Virtual path, for the error message.
        prefix (str): the mount prefix, which the descent has to strip to
            walk the repository's own path segments.
    """
    parent_sha = await _resolve_dir_sha(accessor, virtual_key, index, prefix)
    if parent_sha is None:
        raise enoent(virtual)
    entries = await fetch_dir_tree(accessor.config, accessor.owner,
                                   accessor.repo, parent_sha, accessor.pool)
    return await _cache_dir(index, virtual_key, entries)


async def _cache_dir(index: IndexCacheStore, virtual_key: str,
                     entries: list[TreeEntry]) -> list[str]:
    """Cache one complete tree listing, including each traversed parent."""
    norm = virtual_key.rstrip("/") or "/"
    child_keys: list[str] = []
    dir_entries: list[tuple[str, IndexEntry]] = []
    for entry in entries:
        child_path = norm.rstrip("/") + "/" + entry.path
        resource_type = "folder" if entry.type == "tree" else "file"
        idx_entry = IndexEntry(
            id=entry.sha,
            name=entry.path,
            resource_type=resource_type,
            size=entry.size,
        )
        dir_entries.append((entry.path, idx_entry))
        child_keys.append(child_path)
    await index.set_dir(norm, dir_entries)
    log.debug("fallback readdir populated %d entries for %s", len(entries),
              virtual_key)
    return sorted(child_keys)


async def _resolve_dir_sha(
    accessor: GitHubAccessor,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str = '',
) -> str | None:
    """Get the tree SHA for a directory path.

    Walks from the current ref, fetching per-directory trees. A cached
    entry may name an old tree even when its parent's listing is fresh.

    Args:
        accessor (GitHubAccessor): backend handle.
        virtual_key (str): Mount-absolute directory key.
        index (IndexCacheStore): the mount's index.
        prefix (str): the mount prefix the keys are built against.
    """
    norm = virtual_key.rstrip("/") or "/"
    stem = prefix.rstrip("/")
    rest = norm[len(stem):] if stem and norm.startswith(stem) else norm
    parts = [p for p in rest.strip("/").split("/") if p]
    current_sha = await ensure_ref(accessor)
    current_path = stem or "/"
    for part in parts:
        entries = await fetch_dir_tree(accessor.config, accessor.owner,
                                       accessor.repo, current_sha,
                                       accessor.pool)
        child_path = current_path.rstrip("/") + "/" + part
        found = next((entry for entry in entries if entry.path == part), None)
        if found is None or found.type != "tree":
            # Remove the former directory before caching a replacement blob.
            await index.invalidate_prefix(child_path)
        await _cache_dir(index, current_path, entries)
        if found is None or found.type != "tree":
            return None
        current_sha = found.sha
        current_path = child_path
    return current_sha
