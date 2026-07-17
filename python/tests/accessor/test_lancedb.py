from unittest.mock import MagicMock

import pytest

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.resource.lancedb.config import LanceDBConfig


@pytest.mark.asyncio
async def test_close_releases_all_connections_and_caches():
    accessor = LanceDBAccessor(LanceDBConfig(uri="/tmp/test-lancedb"))
    first = MagicMock()
    second = MagicMock()
    accessor._dbs = {1: first, 2: second}
    accessor._tables = {(1, "items"): MagicMock()}
    accessor._search_cache = {("items", "query", 10): [{"id": 1}]}

    await accessor.close()

    first.close.assert_called_once_with()
    second.close.assert_called_once_with()
    assert accessor._dbs == {}
    assert accessor._tables == {}
    assert accessor._search_cache == {}
