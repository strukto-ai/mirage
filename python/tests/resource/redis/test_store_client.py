from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.resource.redis import store as store_module
from mirage.resource.redis.store import RedisStore


@pytest.mark.asyncio
async def test_injected_client_is_borrowed(monkeypatch):
    sync_client = MagicMock()
    monkeypatch.setattr(store_module.sync_redis.Redis, "from_url",
                        MagicMock(return_value=sync_client))
    client = MagicMock()
    client.aclose = AsyncMock()
    store = RedisStore(client=client)

    assert store._client is client
    await store.close()

    client.aclose.assert_not_awaited()
