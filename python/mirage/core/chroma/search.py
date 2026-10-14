from typing import Any

from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.client import PAGE_CHUNK_BATCH_SIZE
from mirage.core.chroma.tree import CHROMA_TREE
from mirage.core.slug_tree.search import (
    search_scope,
    target_entries,
    validate_query,
)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of, mounted_path
from mirage.utils.score import score_from_distance
from mirage.vfs.search import int_option, validate_options
from mirage.vfs.types import SearchQuery


async def search_segments(
    accessor: ChromaAccessor,
    query: str,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
    top_k: int = 10,
    mount_prefix: str = "",
) -> list[str]:
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
    return render_records(
        response, accessor.config.slug_field, mount_prefix, scoped_slugs
    )


def render_records(
    response: dict[str, Any],
    slug_field: str,
    mount_prefix: str,
    scoped_slugs: set[str] | None = None,
) -> list[str]:
    documents = first_result_list(response.get("documents"))
    metadatas = first_result_list(response.get("metadatas"))
    distances = first_result_list(response.get("distances"))
    contents: list[str] = []
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
        contents.append(f"{path}:{score}\n{content}")
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
) -> list[str]:
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
) -> list[str]:
    return await search_many(accessor, [path], query, index)


async def files_containing(
    accessor: ChromaAccessor,
    text: str,
    under: list[PathSpec],
    ignore_case: bool,
    index: IndexCacheStore = NULL_INDEX,
) -> list[PathSpec] | None:
    """The pages with a chunk holding ``text``.

    A page is its chunks joined by line breaks, so a line, and so any
    match grep makes, lies within one chunk, and Chroma's ``$contains``
    over the chunks answers exactly. It matches case, so -i reads every
    page. Below the mount's root only the walked pages are asked.

    Args:
        accessor (ChromaAccessor): the mount's collection.
        text (str): the text searched for.
        under (list[PathSpec]): the directories walked.
        ignore_case (bool): whether case is folded.
        index (IndexCacheStore): the mount's index.
    """
    if ignore_case:
        return None
    field = accessor.config.slug_field
    where: dict[str, Any] | None = None
    if all(scope.mount_path.strip("/") for scope in under):
        walked = await target_entries(CHROMA_TREE, accessor, under, index)
        if not walked:
            return []
        where = {field: {"$in": sorted(walked)}}
    collection = await accessor.get_collection()
    slugs: set[str] = set()
    offset = 0
    while True:
        result = await collection.get(
            where=where,
            where_document={"$contains": text},
            include=["metadatas"],
            limit=PAGE_CHUNK_BATCH_SIZE,
            offset=offset,
        )
        metadatas = result.get("metadatas") or []
        for metadata in metadatas:
            slug = metadata.get(field) if isinstance(metadata, dict) else None
            if slug is not None:
                slugs.add(str(slug).strip("/"))
        if len(result.get("ids") or []) < PAGE_CHUNK_BATCH_SIZE:
            break
        offset += PAGE_CHUNK_BATCH_SIZE
    return [mounted_path(under[0], f"/{slug}") for slug in sorted(slugs)]
