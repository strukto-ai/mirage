import math
from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.types import PathSpec
from mirage.vfs.types import SearchOps, SearchQuery


def validate_options(query: SearchQuery, allowed: set[str]) -> None:
    unknown = set(query.options) - allowed
    if unknown:
        raise ValueError(
            f"search: unknown options: {', '.join(sorted(unknown))}"
        )


def int_option(query: SearchQuery, key: str, default: int) -> int:
    value = query.options.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"search: {key} must be an integer")
    return value


def float_option(query: SearchQuery, key: str, default: float) -> float:
    value = query.options.get(key, default)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"search: {key} must be a finite number")
    return float(value)


def text_option(query: SearchQuery, key: str, default: str) -> str:
    value = query.options.get(key, default)
    if not isinstance(value, str):
        raise ValueError(f"search: {key} must be a string")
    return value


async def search_resources(
    capability: SearchOps | None,
    accessor: Any,
    paths: list[PathSpec],
    query: SearchQuery,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    """Batch when supported; otherwise concatenate single-scope records.

    Args:
        capability (SearchOps | None): the adapter's resource search.
        accessor (Any): backend client.
        paths (list[PathSpec]): explicit resource scopes.
        query (SearchQuery): backend query and options.
        index (IndexCacheStore): active mount index.
    """
    if capability is None:
        raise NotImplementedError(
            "search: backend does not support resource search"
        )
    if not paths:
        raise ValueError("search: at least one scope is required")
    records: list[tuple[str, str]] = []
    if capability.search_many is not None:
        answer = await capability.search_many(accessor, paths, query, index)
        if answer is None:
            raise NotImplementedError("search: backend declined the query")
        records = answer
    else:
        for path in paths:
            answer = await capability.search(accessor, path, query, index)
            if answer is None:
                raise NotImplementedError("search: backend declined the query")
            records.extend(answer)
    return (
        ("\n".join(record for _, record in records) + "\n").encode()
        if records
        else b""
    )
