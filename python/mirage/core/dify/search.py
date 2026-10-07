import logging
from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify.client import dify_post
from mirage.core.dify.read import segment_text
from mirage.core.dify.tree import DIFY_TREE, SLUG_NOUN
from mirage.core.slug_tree.rows import normalize_slug
from mirage.core.slug_tree.search import (
    search_scope,
    target_entries,
    validate_query,
)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.score import format_score
from mirage.vfs.search import (
    float_option,
    int_option,
    text_option,
    validate_options,
)
from mirage.vfs.types import SearchQuery, SearchResult

logger = logging.getLogger(__name__)

METHODS = {
    "semantic": "semantic_search",
    "fulltext": "full_text_search",
    "hybrid": "hybrid_search",
    "keyword": "keyword_search",
}


async def search_segments(
    accessor: DifyAccessor,
    query: str,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
    method: str = "semantic",
    top_k: int = 10,
    threshold: float = 0.0,
    mount_prefix: str = "",
) -> list[SearchResult]:
    search_method = validate_args(query, method, top_k, threshold)
    if not mount_prefix and paths:
        mount_prefix = mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
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
            accessor, paths, index
        )
        if not conditions:
            return []
        retrieval_model["metadata_filtering_conditions"] = {
            "logical_operator": "or",
            "conditions": conditions,
        }
    response = await dify_post(
        accessor,
        f"/datasets/{accessor.config.dataset_id}/retrieve",
        {"query": query, "retrieval_model": retrieval_model},
    )
    output = record_results(
        response_records(response.get("records")),
        accessor.config.slug_metadata_name,
        mount_prefix,
    )
    if paths and has_name_based_target and not output:
        logger.debug(
            "Dify scoped search returned no records for name-based documents; "
            "check that Built-in Fields are enabled in Dify dataset metadata."
        )
    return output


def validate_args(
    query: str, method: str, top_k: int, threshold: float
) -> str:
    validate_query(query, top_k)
    if threshold < 0 or threshold > 1:
        raise ValueError("search: threshold must be in [0, 1]")
    if method not in METHODS:
        raise ValueError(
            "search: method must be one of semantic, fulltext, hybrid, keyword"
        )
    return METHODS[method]


async def metadata_conditions(
    accessor: DifyAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
) -> tuple[list[dict[str, Any]], bool]:
    targets = await target_entries(DIFY_TREE, accessor, paths, index)
    slug_values: list[str] = []
    name_values: list[str] = []
    for entry in targets.values():
        if entry.extra.get("has_slug") is True:
            slug_values.append(str(entry.extra["raw_slug"]))
        else:
            name_values.append(entry.name)
    conditions: list[dict[str, Any]] = []
    if slug_values:
        conditions.append(
            {
                "name": accessor.config.slug_metadata_name,
                "comparison_operator": "in",
                "value": sorted(slug_values),
            }
        )
    if name_values:
        conditions.append(
            {
                "name": "document_name",
                "comparison_operator": "in",
                "value": sorted(name_values),
            }
        )
    return conditions, bool(name_values)


def response_records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("Dify search response records must be a list")
    records: list[dict[str, Any]] = []
    for record in value:
        if not isinstance(record, dict):
            raise ValueError("Dify search response records must be objects")
        records.append(record)
    return records


def record_results(
    records: list[dict[str, Any]],
    slug_metadata_name: str,
    mount_prefix: str,
) -> list[SearchResult]:
    contents: list[SearchResult] = []
    for record in records:
        segment = record.get("segment")
        if not isinstance(segment, dict):
            continue
        path = record_path(record, slug_metadata_name, mount_prefix)
        if path is None:
            continue
        score = format_score(record.get("score"))
        header = path if score is None else f"{path}:{score}"
        content = segment_text(segment)
        contents.append(
            (
                PathSpec.from_str_path(
                    path,
                    path.removeprefix(mount_prefix.rstrip("/")).lstrip("/"),
                ),
                f"{header}\n{content}",
            )
        )
    return contents


def record_path(
    record: dict[str, Any],
    slug_metadata_name: str,
    mount_prefix: str,
) -> str | None:
    segment = record.get("segment")
    if not isinstance(segment, dict):
        return None
    document = segment.get("document")
    if not isinstance(document, dict):
        return None
    raw_path = document_path(document, slug_metadata_name)
    if raw_path is None:
        return None
    try:
        normalized = normalize_slug(raw_path, SLUG_NOUN)
    except ValueError:
        logger.debug(
            "Skipping Dify record with invalid slug/name: %r", raw_path
        )
        return None
    prefix = mount_prefix.rstrip("/")
    if not prefix:
        return normalized
    return prefix + normalized


def document_path(
    document: dict[str, Any],
    slug_metadata_name: str,
) -> str | None:
    metadata = document.get("doc_metadata")
    if isinstance(metadata, list):
        for item in metadata:
            if (
                isinstance(item, dict)
                and item.get("name") == slug_metadata_name
                and item.get("value") is not None
            ):
                return str(item["value"])
    if (
        isinstance(metadata, dict)
        and metadata.get(slug_metadata_name) is not None
    ):
        return str(metadata[slug_metadata_name])
    name = document.get("name")
    if name is None:
        return None
    return str(name)


async def search_many(
    accessor: DifyAccessor,
    paths: list[PathSpec],
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> list[SearchResult]:
    validate_options(query, {"top_k", "method", "threshold"})
    top_k = int_option(query, "top_k", 10)
    method = text_option(query, "method", "semantic")
    threshold = float_option(query, "threshold", 0.0)
    targets, prefix = await search_scope(DIFY_TREE, accessor, paths, index)
    return await search_segments(
        accessor,
        query.query,
        targets,
        index,
        top_k=top_k,
        mount_prefix=prefix,
        method=method,
        threshold=threshold,
    )


async def search_resource(
    accessor: DifyAccessor,
    path: PathSpec,
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> list[SearchResult]:
    return await search_many(accessor, [path], query, index)
