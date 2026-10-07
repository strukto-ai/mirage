import math
from collections.abc import Iterable
from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.context.session_context import (
    get_admission,
    require_visible,
    session_visibility,
)
from mirage.errors.fs import eacces
from mirage.ops.namespace_view import paths_scoped
from mirage.ops.types import NamespaceView
from mirage.types import PathSpec, Visibility
from mirage.utils.hidden import path_visible
from mirage.vfs.types import SearchOps, SearchQuery, SearchResult


def search_scoped(ns: NamespaceView | None, paths: list[PathSpec]) -> bool:
    """Whether permissions require file-by-file access instead of bulk search.

    Args:
        ns (NamespaceView | None): namespace supplied to a standalone handler.
        paths (list[PathSpec]): search reach, before a native request.
    """
    gate = get_admission()
    return (
        any(gate.scopes(path.virtual) for path in paths)
        if gate is not None
        else paths_scoped(ns, paths)
    )


def check_search(paths: list[PathSpec]) -> Visibility | None:
    """Check search inputs before backend work and capture the reader's view.

    Args:
        paths (list[PathSpec]): concrete search scopes.
    """
    vis = session_visibility()
    gate = get_admission()
    for path in paths:
        require_visible(vis, path)
        # A permission refusal must prevent backend access. A bulk search
        # cannot replace the guarded per-file walk when any entry is ruled.
        if gate is not None and gate.scopes(path.virtual):
            raise eacces(path)
    return vis


def visible_results(
    results: Iterable[SearchResult], vis: Visibility | None
) -> list[SearchResult]:
    """Filter whole records by their file path, including multiline bodies.

    Args:
        results (Iterable[SearchResult]): path-addressed backend records.
        vis (Visibility | None): the view captured before the search started.
    """
    visible: list[SearchResult] = []
    for result in results:
        if (
            not isinstance(result, (tuple, list))
            or len(result) != 2
            or not isinstance(result[0], PathSpec)
            or not isinstance(result[1], str)
        ):
            raise ValueError(
                "search: each result must carry a PathSpec and text"
            )
        path = result[0]
        if (
            path.virtual
            != PathSpec.from_str_path(path.virtual, cwd="/").virtual
        ):
            raise ValueError(
                "search: result paths must be canonical absolute paths"
            )
        if path_visible(vis, result[0]):
            visible.append(result)
    return visible


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
    vis = check_search(paths)
    records: list[SearchResult] = []
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
    lines = [text for _, text in visible_results(records, vis)]
    return ("\n".join(lines) + "\n").encode() if lines else b""
