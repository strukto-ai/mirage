from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.chroma.path import resolve_path
from mirage.core.chroma.walk import walk
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of, rekey
from mirage.utils.score import score_from_distance


async def search_segments(
    accessor,
    query: str,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
    top_k: int = 10,
    mount_prefix: str = "",
) -> bytes:
    validate_args(query, top_k)
    if not mount_prefix and paths:
        mount_prefix = mount_prefix_of(paths[0].virtual,
                                       paths[0].resource_path)
    kwargs: dict[str, Any] = {
        "query_texts": [query],
        "n_results": top_k,
        "include": ["documents", "metadatas", "distances"],
    }
    scoped_slugs: set[str] | None = None
    if paths:
        scoped_slugs = set((await target_entries(accessor, paths,
                                                 index)).keys())
        if not scoped_slugs:
            return b""
        kwargs["where"] = {
            accessor.config.slug_field: {
                "$in": sorted(scoped_slugs)
            }
        }
    collection = await accessor.get_collection()
    response = await collection.query(**kwargs)
    return query_result_to_bytes(response, accessor.config.slug_field,
                                 mount_prefix, scoped_slugs)


def validate_args(query: str, top_k: int) -> None:
    if not query:
        raise ValueError("search: query is required")
    if len(query) > 250:
        raise ValueError("search: query cannot exceed 250 characters")
    if top_k <= 0:
        raise ValueError("search: top-k must be positive")


async def target_entries(
    accessor,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
) -> dict[str, IndexEntry]:
    targets: dict[str, IndexEntry] = {}
    for path in paths:
        resolved = await resolve_path(accessor, path, index)
        if resolved.entry is not None and not resolved.is_dir:
            targets[str(resolved.entry.extra["slug"])] = resolved.entry
            continue
        if resolved.is_dir:
            children = await walk(accessor,
                                  path,
                                  index,
                                  include_root=False,
                                  strip_prefix=False)
            for child in children:
                child_spec = PathSpec.from_str_path(
                    child, rekey(path.virtual, path.resource_path, child))
                child_resolved = await resolve_path(accessor, child_spec,
                                                    index)
                if (child_resolved.entry is not None
                        and not child_resolved.is_dir):
                    targets[str(child_resolved.entry.extra["slug"]
                                )] = child_resolved.entry
    return targets


def query_result_to_bytes(
    response: dict[str, Any],
    slug_field: str,
    mount_prefix: str,
    scoped_slugs: set[str] | None = None,
) -> bytes:
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
        score = score_from_distance(distances[index] if index <
                                    len(distances) else None)
        path = "/" + slug_value
        prefix = mount_prefix.rstrip("/")
        if prefix:
            path = prefix + path
        content = "" if document is None else str(document)
        contents.append(f"{path}:{score}\n{content}")
    if not contents:
        return b""
    return ("\n".join(contents) + "\n").encode()


def first_result_list(value: object) -> list:
    if not isinstance(value, list):
        return []
    if value and isinstance(value[0], list):
        return value[0]
    return value
