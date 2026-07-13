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

from mirage.cache.index import IndexCacheStore, IndexEntry, LookupStatus
from mirage.core.github.tree import fetch_dir_tree
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

log = logging.getLogger(__name__)


async def readdir(accessor, path: PathSpec,
                  index: IndexCacheStore) -> list[str]:
    virtual = path.virtual
    if isinstance(path, PathSpec):
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        path = path.directory if path.pattern else path.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    path = path.rstrip("/") or "/"
    listing = await index.list_dir(path)
    if listing.entries is not None:
        if prefix and listing.entries and not listing.entries[0].startswith(
                prefix):
            return [prefix + e for e in listing.entries]
        return listing.entries
    if listing.status == LookupStatus.NOT_FOUND:
        if accessor.truncated:
            return await _fallback_readdir(accessor, path, index, virtual,
                                           prefix)
        raise enoent(virtual)
    return []


async def _fallback_readdir(
    accessor,
    path: str,
    index: IndexCacheStore,
    virtual: str,
    prefix: str = "",
) -> list[str]:
    """Per-directory tree fetch when recursive tree was truncated."""
    parent_sha = await _resolve_dir_sha(accessor, path, index)
    if parent_sha is None:
        raise enoent(virtual)
    entries = await fetch_dir_tree(accessor.config, accessor.owner,
                                   accessor.repo, parent_sha)
    norm = "/" + path.strip("/")
    child_keys: list[str] = []
    for entry in entries:
        child_path = norm + "/" + entry.path
        resource_type = "folder" if entry.type == "tree" else "file"
        idx_entry = IndexEntry(
            id=entry.sha,
            name=entry.path,
            resource_type=resource_type,
            size=entry.size,
        )
        index._entries[child_path] = idx_entry
        child_keys.append(child_path)
    index._children[norm] = sorted(child_keys)
    log.debug("fallback readdir populated %d entries for %s", len(entries),
              path)
    virtual_keys = sorted((prefix + k if prefix else k) for k in child_keys)
    return virtual_keys


async def _resolve_dir_sha(accessor, path: str,
                           index: IndexCacheStore) -> str | None:
    """Get the tree SHA for a directory path.

    Walks from root if needed, fetching per-directory trees.
    """
    norm = "/" + path.strip("/")
    result = await index.get(norm)
    if result.entry is not None:
        return result.entry.id
    parts = norm.strip("/").split("/")
    current_sha = accessor.ref
    current_path = ""
    for part in parts:
        entries = await fetch_dir_tree(accessor.config, accessor.owner,
                                       accessor.repo, current_sha)
        found = False
        for entry in entries:
            if entry.path == part:
                current_sha = entry.sha
                current_path += "/" + part
                idx_entry = IndexEntry(
                    id=entry.sha,
                    name=entry.path,
                    resource_type="folder" if entry.type == "tree" else "file",
                    size=entry.size,
                )
                index._entries[current_path] = idx_entry
                found = True
                break
        if not found:
            return None
    return current_sha
