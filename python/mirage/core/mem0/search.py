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

import math

from mirage.accessor.mem0 import Mem0Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.mem0.client import search_memories
from mirage.core.mem0.readdir import readdir
from mirage.core.mem0.scope import detect_scope
from mirage.errors.fs import enoent
from mirage.types import PathSpec
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.score import format_score
from mirage.vfs.search import (
    float_option,
    int_option,
    text_option,
    validate_options,
)
from mirage.vfs.types import SearchQuery, SearchResult


def _validate(query: str, top_k: int, threshold: float) -> None:
    if not query:
        raise ValueError("search: query is required")
    if top_k <= 0:
        raise ValueError("search: top-k must be positive")
    if not math.isfinite(threshold) or threshold < 0 or threshold > 1:
        raise ValueError("search: threshold must be in [0, 1]")


async def search_results(
    accessor: Mem0Accessor,
    query: str,
    *,
    mount_prefix: str,
    top_k: int,
    threshold: float,
    memory_ids: set[str] | None = None,
) -> list[SearchResult]:
    """Run a semantic search in the scope and render ranked results.

    Args:
        accessor (Mem0Accessor): mem0 accessor.
        query (str): search query.
        mount_prefix (str): mount prefix for rendered paths.
        top_k (int): number of results.
        threshold (float): minimum similarity score.
        memory_ids (set[str] | None): optional result id allowlist.
    """
    _validate(query, top_k, threshold)
    results = await search_memories(
        accessor.client,
        query,
        accessor.config.scope_filter,
        top_k=top_k,
        threshold=threshold,
    )
    lines: list[SearchResult] = []
    for r in results:
        memory_id = str(r["id"])
        if memory_ids is not None and memory_id not in memory_ids:
            continue
        path = f"{mount_prefix.rstrip('/')}/{memory_id}.json"
        score = format_score(r.get("score"))
        header = path if score is None else f"{path}:{score}"
        lines.append(
            (
                PathSpec.from_str_path(path, f"{memory_id}.json"),
                f"{header}\n{r.get('memory', '')}",
            )
        )
    return lines


async def search_many(
    accessor: Mem0Accessor,
    paths: list[PathSpec],
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> list[SearchResult]:
    validate_options(query, {"top_k", "method", "threshold"})
    top_k = int_option(query, "top_k", accessor.config.default_search_limit)
    if not paths:
        raise ValueError("search: at least one scope is required")
    prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    method = text_option(query, "method", "semantic")
    threshold = float_option(query, "threshold", 0.0)
    if method != "semantic":
        raise ValueError("search: only the 'semantic' method is supported")
    targets = (
        []
        if any(not p.vfs_path.strip("/") for p in paths)
        else await make_resolve_glob(readdir)(accessor, paths, index)
    )
    ids: set[str] | None = (
        None if any(not p.vfs_path.strip("/") for p in paths) else set()
    )
    for path in targets:
        match = detect_scope(path)
        if match.kind != "memory":
            raise enoent(path.virtual)
        if ids is not None:
            ids.add(match.slots["memory_id"])
    return await search_results(
        accessor,
        query.query,
        mount_prefix=prefix,
        top_k=top_k,
        threshold=threshold,
        memory_ids=ids,
    )


async def search_resource(
    accessor: Mem0Accessor,
    path: PathSpec,
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> list[SearchResult]:
    return await search_many(accessor, [path], query, index)
