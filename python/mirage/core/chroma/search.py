from typing import Any

from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.tree import CHROMA_TREE
from mirage.core.slug_tree.search import (
    search_scope,
    target_entries,
    validate_query,
)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.score import score_from_distance
from mirage.vfs.search import int_option, validate_options
from mirage.vfs.types import SearchQuery, SearchResult


async def search_segments(
    accessor: ChromaAccessor,
    query: str,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
    top_k: int = 10,
    mount_prefix: str = "",
) -> list[SearchResult]:
    validate_query(query, top_k)
    if not mount_prefix and paths:
        mount_prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    kwargs: dict[str, Any] = {
        "query_texts": [query],
        "n_results": top_k,
        "include": ["documents", "metadatas", "distances"],
    }
    scoped_slugs: set[str] | None = None
    if paths:
        scoped_slugs = set(
            (await target_entries(CHROMA_TREE, accessor, paths, index)).keys()
        )
        if not scoped_slugs:
            return []
        kwargs["where"] = {
            accessor.config.slug_field: {"$in": sorted(scoped_slugs)}
        }
    collection = await accessor.get_collection()
    response = await collection.query(**kwargs)
    return query_results(
        response, accessor.config.slug_field, mount_prefix, scoped_slugs
    )


def query_results(
    response: dict[str, Any],
    slug_field: str,
    mount_prefix: str,
    scoped_slugs: set[str] | None = None,
) -> list[SearchResult]:
    documents = first_result_list(response.get("documents"))
    metadatas = first_result_list(response.get("metadatas"))
    distances = first_result_list(response.get("distances"))
    contents: list[SearchResult] = []
    for index, document in enumerate(documents):
        metadata = metadatas[index] if index < len(metadatas) else {}
        if not isinstance(metadata, dict):
            continue
        slug = metadata.get(slug_field)
        if slug is None:
            continue
        slug_value = str(slug).strip("/")
        if scoped_slugs is not None and slug_value not in scoped_slugs:
            continue
        score = score_from_distance(
            distances[index] if index < len(distances) else None
        )
        path = "/" + slug_value
        prefix = mount_prefix.rstrip("/")
        if prefix:
            path = prefix + path
        content = "" if document is None else str(document)
        contents.append(
            (
                PathSpec.from_str_path(path, slug_value),
                f"{path}:{score}\n{content}",
            )
        )
    return contents


def first_result_list(value: Any) -> list[Any]:
    if not isinstance(value, list):
        return []
    if value and isinstance(value[0], list):
        return value[0]
    return value


async def search_many(
    accessor: ChromaAccessor,
    paths: list[PathSpec],
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> list[SearchResult]:
    validate_options(query, {"top_k"})
    top_k = int_option(query, "top_k", 10)
    targets, prefix = await search_scope(CHROMA_TREE, accessor, paths, index)
    return await search_segments(
        accessor,
        query.query,
        targets,
        index,
        top_k=top_k,
        mount_prefix=prefix,
    )


async def search_resource(
    accessor: ChromaAccessor,
    path: PathSpec,
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> list[SearchResult]:
    return await search_many(accessor, [path], query, index)
