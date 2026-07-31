from collections.abc import AsyncIterator
from typing import Any

PATH_TREE_ID = "__path_tree__"
PAGE_CHUNK_BATCH_SIZE = 100


async def fetch_path_tree(accessor) -> str:
    collection = await accessor.get_collection()
    result = await collection.get(ids=[PATH_TREE_ID])
    documents = result.get("documents") or []
    if not documents:
        raise FileNotFoundError(PATH_TREE_ID)
    value = documents[0]
    if value is None:
        raise FileNotFoundError(PATH_TREE_ID)
    if isinstance(value, str):
        return value
    return str(value)


async def fetch_page_chunks(accessor, slug: str) -> str:
    chunks = await page_chunks(accessor, slug)
    return "\n".join(chunk["document"] for chunk in chunks)


async def iter_page_chunks(accessor, slug: str) -> AsyncIterator[str]:
    chunks = await page_chunks(accessor, slug)
    for chunk in chunks:
        yield chunk["document"]


async def page_chunks(accessor, slug: str) -> list[dict[str, Any]]:
    collection = await accessor.get_collection()
    chunks: list[dict[str, Any]] = []
    offset = 0
    while True:
        result = await collection.get(
            where={accessor.config.slug_field: slug},
            include=["documents", "metadatas"],
            limit=PAGE_CHUNK_BATCH_SIZE,
            offset=offset,
        )
        documents = result.get("documents") or []
        metadatas = result.get("metadatas") or [{} for _ in documents]
        for document, metadata in zip(documents, metadatas, strict=True):
            chunks.append({
                "document": "" if document is None else str(document),
                "metadata": metadata if isinstance(metadata, dict) else {},
            })
        if len(documents) < PAGE_CHUNK_BATCH_SIZE:
            break
        offset += PAGE_CHUNK_BATCH_SIZE
    return sorted(chunks,
                  key=lambda item: chunk_index(
                      item["metadata"], accessor.config.chunk_index_field))


async def pages_chunks(
    accessor,
    slugs: list[str],
) -> dict[str, list[dict[str, Any]]]:
    """Fetch every chunk of several pages in one scan.

    Args:
        accessor: chroma accessor.
        slugs (list[str]): page slugs to fetch.

    Returns:
        dict[str, list[dict]]: slug to its chunks in chunk-index order.
    """
    if not slugs:
        return {}
    collection = await accessor.get_collection()
    field = accessor.config.slug_field
    grouped: dict[str, list[dict[str, Any]]] = {slug: [] for slug in slugs}
    offset = 0
    while True:
        result = await collection.get(
            where={field: {
                "$in": slugs
            }},
            include=["documents", "metadatas"],
            limit=PAGE_CHUNK_BATCH_SIZE,
            offset=offset,
        )
        documents = result.get("documents") or []
        metadatas = result.get("metadatas") or [{} for _ in documents]
        for document, metadata in zip(documents, metadatas, strict=True):
            meta = metadata if isinstance(metadata, dict) else {}
            bucket = grouped.get(str(meta.get(field, "")))
            if bucket is None:
                continue
            bucket.append({
                "document": "" if document is None else str(document),
                "metadata": meta,
            })
        if len(documents) < PAGE_CHUNK_BATCH_SIZE:
            break
        offset += PAGE_CHUNK_BATCH_SIZE
    return {
        slug:
        sorted(chunks,
               key=lambda item: chunk_index(item["metadata"], accessor.config.
                                            chunk_index_field))
        for slug, chunks in grouped.items()
    }


async def query_contains(
    accessor,
    pattern: str,
    candidate_slugs: list[str],
    *,
    regex: bool = False,
) -> list[str]:
    if not candidate_slugs:
        return []
    collection = await accessor.get_collection()
    result = await collection.get(
        where={accessor.config.slug_field: {
            "$in": candidate_slugs
        }},
        where_document={"$regex" if regex else "$contains": pattern},
        include=["metadatas"],
    )
    matched: set[str] = set()
    for metadata in result.get("metadatas") or []:
        if isinstance(metadata, dict):
            slug = metadata.get(accessor.config.slug_field)
            if slug is not None:
                matched.add(str(slug))
    return sorted(matched)


def chunk_index(metadata: dict[str, Any], field: str) -> int:
    value = metadata.get(field, 0)
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return 0
