from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.accessor.qdrant import QdrantAccessor
from mirage.resource.qdrant.config import QdrantConfig


@pytest.mark.asyncio
async def test_close_releases_all_clients_and_caches():
    accessor = QdrantAccessor(QdrantConfig())
    first = MagicMock()
    first.close = AsyncMock()
    second = MagicMock()
    second.close = AsyncMock()
    accessor._clients = {1: first, 2: second}
    accessor._search_cache = {("collection", "query", 10): [{"id": 1}]}
    accessor._indexes_ensured = {"collection"}

    await accessor.close()

    first.close.assert_awaited_once_with()
    second.close.assert_awaited_once_with()
    assert accessor._clients == {}
    assert accessor._search_cache == {}
    assert accessor._indexes_ensured == set()
