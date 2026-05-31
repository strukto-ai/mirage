import logging

from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.dify._client import dify_post
from mirage.core.dify.path import resolve_path
from mirage.core.dify.walk import walk
from mirage.types import PathSpec

logger = logging.getLogger(__name__)

METHODS = {
    "semantic": "semantic_search",
    "fulltext": "full_text_search",
    "hybrid": "hybrid_search",
    "keyword": "keyword_search",
}


async def search_segments(
    accessor,
    query: str,
    paths: list[PathSpec],
    index: IndexCacheStore,
    method: str = "semantic",
    top_k: int = 10,
    threshold: float = 0.0,
) -> bytes:
    search_method = validate_args(query, method, top_k, threshold)
    retrieval_model = {
        "search_method": search_method,
        "top_k": min(top_k, 100),
        "score_threshold_enabled": threshold > 0,
        "score_threshold": threshold,
        "reranking_enable": False,
    }
    has_name_based_target = False
    if paths:
        conditions, has_name_based_target = await metadata_conditions(
            accessor, paths, index)
        if not conditions:
            return b""
        retrieval_model["metadata_filtering_conditions"] = {
            "logical_operator": "or",
            "conditions": conditions,
        }
    response = await dify_post(
        accessor.config,
        f"/datasets/{accessor.config.dataset_id}/retrieve",
        {
            "query": query,
            "retrieval_model": retrieval_model
        },
    )
    output = records_to_bytes(response.get("records") or [])
    if paths and has_name_based_target and output == b"":
        logger.debug(
            "Dify scoped search returned no records for name-based documents; "
            "check that Built-in Fields are enabled in Dify dataset metadata.")
    return output


def validate_args(query: str, method: str, top_k: int,
                  threshold: float) -> str:
    if not query:
        raise ValueError("search: query is required")
    if len(query) > 250:
        raise ValueError("search: query cannot exceed 250 characters")
    if top_k <= 0:
        raise ValueError("search: top-k must be positive")
    if threshold < 0 or threshold > 1:
        raise ValueError("search: threshold must be in [0, 1]")
    if method not in METHODS:
        raise ValueError(
            "search: method must be one of semantic, fulltext, hybrid, keyword"
        )
    return METHODS[method]


async def metadata_conditions(
    accessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> tuple[list[dict], bool]:
    targets = await target_entries(accessor, paths, index)
    slug_values: list[str] = []
    name_values: list[str] = []
    for entry in targets.values():
        if entry.extra.get("has_slug") is True:
            slug_values.append(str(entry.extra["raw_slug"]))
        else:
            name_values.append(entry.name)
    conditions: list[dict] = []
    if slug_values:
        conditions.append({
            "name": accessor.config.slug_metadata_name,
            "comparison_operator": "in",
            "value": sorted(slug_values),
        })
    if name_values:
        conditions.append({
            "name": "document_name",
            "comparison_operator": "in",
            "value": sorted(name_values),
        })
    return conditions, bool(name_values)


async def target_entries(
    accessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> dict[str, IndexEntry]:
    targets: dict[str, IndexEntry] = {}
    for path in paths:
        resolved = await resolve_path(accessor, path, index)
        if resolved.entry is not None and not resolved.is_dir:
            targets[resolved.entry.id] = resolved.entry
            continue
        if resolved.is_dir:
            children = await walk(accessor,
                                  path,
                                  index,
                                  include_root=False,
                                  strip_prefix=False)
            for child in children:
                child_spec = PathSpec.from_str_path(child, path.prefix)
                child_resolved = await resolve_path(accessor, child_spec,
                                                    index)
                if (child_resolved.entry is not None
                        and not child_resolved.is_dir):
                    targets[child_resolved.entry.id] = child_resolved.entry
    return targets


def records_to_bytes(records: list[dict]) -> bytes:
    contents = []
    for record in records:
        segment = record.get("segment")
        if not isinstance(segment, dict):
            continue
        content = segment.get("content")
        if content is None:
            contents.append("")
        elif isinstance(content, str):
            contents.append(content)
        else:
            contents.append(str(content))
    return "\n".join(contents).encode()
