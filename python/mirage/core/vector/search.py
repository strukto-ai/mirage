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

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.probe import A
from mirage.core.vector.types import VectorTree
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.search import (
    float_option,
    int_option,
    text_option,
    validate_options,
)
from mirage.vfs.types import SearchOps, SearchQuery, SearchResult


def _target_table(pinned: str | None, paths: list[PathSpec]) -> str | None:
    if pinned:
        return pinned
    for path in paths:
        key = path.mount_path.strip("/")
        if key:
            return key.split("/")[0]
    return None


async def search_results(
    tree: VectorTree[A],
    accessor: A,
    query: str,
    paths: list[PathSpec],
    *,
    top_k: int,
    threshold: float,
    mount_prefix: str,
) -> list[SearchResult]:
    """Rank a table's rows and render each hit under its canonical path.

    Args:
        tree (VectorTree[A]): the store's hooks.
        accessor (A): the store's accessor.
        query (str): the search text.
        paths (list[PathSpec]): the scopes; the first names the table.
        top_k (int): how many rows the store ranks.
        threshold (float): the rank a hit must pass, 0 for none.
        mount_prefix (str): the mount's prefix the paths are spelled in.
    """
    if not query:
        raise ValueError("search: query is required")
    if top_k <= 0:
        raise ValueError("search: top-k must be positive")
    pinned = tree.pinned(accessor)
    table = _target_table(pinned, paths)
    if table is None:
        raise ValueError("search: no table to search")
    blocks: list[SearchResult] = []
    for row in await tree.search_rows(accessor, table, query, top_k):
        rank = row.get(tree.rank_key)
        if (
            threshold > 0
            and rank is not None
            and tree.drops(float(rank), threshold)
        ):
            continue
        segments, body = tree.hit(accessor, row)
        path = "/".join(
            [mount_prefix.rstrip("/")] + ([] if pinned else [table]) + segments
        )
        header = path if rank is None else f"{path}:{float(rank):.4f}"
        content = body.decode().rstrip("\n")
        blocks.append(
            (
                PathSpec.from_str_path(
                    path, "/".join(([] if pinned else [table]) + segments)
                ),
                f"{header}\n{content}",
            )
        )
    return blocks


def make_search(tree: VectorTree[A]) -> SearchOps:
    """Build a store's ranked search, one native ranking per batch.

    Args:
        tree (VectorTree[A]): the store's hooks.
    """

    async def search_many(
        accessor: A,
        paths: list[PathSpec],
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[SearchResult]:
        validate_options(query, {"top_k", "method", "threshold"})
        top_k = int_option(query, "top_k", tree.search_limit(accessor))
        if not paths:
            raise ValueError("search: at least one scope is required")
        method = text_option(query, "method", "semantic")
        threshold = float_option(query, "threshold", 0.0)
        if method != "semantic":
            raise ValueError("search: only the 'semantic' method is supported")
        return await search_results(
            tree,
            accessor,
            query.query,
            paths,
            top_k=top_k,
            threshold=threshold,
            mount_prefix=mount_prefix_of(paths[0].virtual, paths[0].vfs_path),
        )

    async def search(
        accessor: A,
        path: PathSpec,
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[SearchResult]:
        return await search_many(accessor, [path], query, index)

    return SearchOps(search=search, search_many=search_many)
