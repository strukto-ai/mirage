import logging
from typing import Any

from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.dify._client import dify_post
from mirage.core.dify.path import resolve_path
from mirage.core.dify.tree import normalize_slug
from mirage.core.dify.walk import walk
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of, rekey
from mirage.utils.score import format_score

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
    mount_prefix: str = "",
) -> bytes:
    search_method = validate_args(query, method, top_k, threshold)
    if not mount_prefix and paths:
        mount_prefix = mount_prefix_of(paths[0].virtual,
                                       paths[0].resource_path)
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
    output = records_to_bytes(
        response.get("records") or [], accessor.config.slug_metadata_name,
        mount_prefix)
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
                child_spec = PathSpec.from_str_path(
                    child, rekey(path.virtual, path.resource_path, child))
                child_resolved = await resolve_path(accessor, child_spec,
                                                    index)
                if (child_resolved.entry is not None
                        and not child_resolved.is_dir):
                    targets[child_resolved.entry.id] = child_resolved.entry
    return targets


def records_to_bytes(
    records: list[dict[str, Any]],
    slug_metadata_name: str,
    mount_prefix: str,
) -> bytes:
    contents: list[str] = []
    for record in records:
        segment = record.get("segment")
        if not isinstance(segment, dict):
            continue
        header = format_record_header(record, slug_metadata_name, mount_prefix)
        if header is None:
            continue
        content = segment_content(segment)
        contents.append(f"{header}\n{content}")
    if not contents:
        return b""
    return ("\n".join(contents) + "\n").encode()


def format_record_header(
    record: dict[str, Any],
    slug_metadata_name: str,
    mount_prefix: str,
) -> str | None:
    path = record_path(record, slug_metadata_name, mount_prefix)
    if path is None:
        return None
    score = format_score(record.get("score"))
    if score is None:
        return path
    return f"{path}:{score}"


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
        normalized = normalize_slug(raw_path)
    except ValueError:
        logger.debug("Skipping Dify record with invalid slug/name: %r",
                     raw_path)
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
            if (isinstance(item, dict)
                    and item.get("name") == slug_metadata_name
                    and item.get("value") is not None):
                return str(item["value"])
    if isinstance(metadata,
                  dict) and metadata.get(slug_metadata_name) is not None:
        return str(metadata[slug_metadata_name])
    name = document.get("name")
    if name is None:
        return None
    return str(name)


def segment_content(segment: dict[str, Any]) -> str:
    content = segment.get("content")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    return str(content)
