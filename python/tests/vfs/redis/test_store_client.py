from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.vfs.redis.store import RedisStore


@pytest.mark.asyncio
async def test_injected_client_is_borrowed():
    client = MagicMock()
    client.aclose = AsyncMock()
    store = RedisStore(client=client)

    assert store._client is client
    await store.close()

    client.aclose.assert_not_awaited()


@pytest.mark.asyncio
async def test_root_is_a_directory_without_a_server():
    store = RedisStore(url="redis://127.0.0.1:1/0")

    assert await store.has_dir("/") is True
    await store.close()
