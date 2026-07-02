from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_search_op_delegates_to_core(monkeypatch):
    from mirage.core.dify import search
    from mirage.ops.dify.search import search as search_op

    calls: list[tuple[str, list[PathSpec], dict]] = []

    async def search_segments(accessor, query, paths, index, **kwargs):
        calls.append((query, paths, kwargs))
        return b"result"

    monkeypatch.setattr(search, "search_segments", search_segments)
    paths = [
        PathSpec(resource_path=("/knowledge/a").strip("/"),
                 virtual="/knowledge/a",
                 directory="/knowledge/a")
    ]

    result = await search_op(SimpleNamespace(),
                             paths,
                             "query",
                             index=RAMIndexCacheStore(),
                             method="keyword")

    assert result == b"result"
    assert calls == [("query", paths, {
        "method": "keyword",
        "mount_prefix": ""
    })]
