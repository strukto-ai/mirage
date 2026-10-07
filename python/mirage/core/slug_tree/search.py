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

from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.slug_tree.tree import SlugTree
from mirage.core.slug_tree.types import A
from mirage.types import PathSpec
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES, resolve_glob_with
from mirage.utils.key_prefix import mount_prefix_of, rekey


def validate_query(query: str, top_k: int) -> None:
    if not query:
        raise ValueError("search: query is required")
    if len(query) > 250:
        raise ValueError("search: query cannot exceed 250 characters")
    if top_k <= 0:
        raise ValueError("search: top-k must be positive")


async def target_entries(
    tree: SlugTree[A],
    accessor: A,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> dict[str, IndexEntry]:
    """Every file a search scope covers, keyed by entry id.

    Args:
        tree (SlugTree[A]): the backend's tree.
        accessor (A): the mount's accessor.
        paths (list[PathSpec]): files and folders to search.
        index (IndexCacheStore): the mount's index.
    """
    targets: dict[str, IndexEntry] = {}
    for path in paths:
        resolved = await tree.resolve(accessor, path, index)
        if not resolved.is_dir:
            targets[resolved.entry.id] = resolved.entry
            continue
        for child in await tree.walk(accessor, path, index):
            child_resolved = await tree.resolve(
                accessor,
                PathSpec.from_str_path(
                    child, rekey(path.virtual, path.vfs_path, child)
                ),
                index,
            )
            if not child_resolved.is_dir:
                targets[child_resolved.entry.id] = child_resolved.entry
    return targets


async def search_scope(
    tree: SlugTree[A],
    accessor: A,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> tuple[list[PathSpec], str]:
    """The paths a batch search covers and the prefix its hits print under.

    A scope at the mount root covers the whole collection, which the
    backend searches unfiltered, so it resolves to no paths at all.

    Args:
        tree (SlugTree[A]): the backend's tree.
        accessor (A): the mount's accessor.
        paths (list[PathSpec]): the search scopes, globs unexpanded.
        index (IndexCacheStore): the mount's index.
    """
    if not paths:
        raise ValueError("search: at least one scope is required")
    prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    if any(not path.vfs_path.strip("/") for path in paths):
        return [], prefix
    return await resolve_glob_with(
        tree.readdir, accessor, paths, index, DEFAULT_MAX_GLOB_MATCHES
    ), prefix
