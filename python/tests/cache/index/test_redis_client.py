from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, call

import pytest

from mirage.cache.index.config import IndexEntry
from mirage.cache.index.redis import RedisIndexCacheStore


@pytest.fixture
def client():
    value = MagicMock()
    value.exists = AsyncMock(return_value=1)
    value.ttl = AsyncMock(return_value=-1)
    value.lrange = AsyncMock(return_value=[b"/folder/a.txt"])
    value.scan = AsyncMock(return_value=(
        0,
        [b"test:mirage:idx:entry:/folder/a.txt"],
    ))
    value.get = AsyncMock(
        return_value=(b'{"id":"a","name":"a.txt","resource_type":"file"}'))
    pipe = MagicMock()
    pipe.execute = AsyncMock()
    value.pipeline.return_value = pipe
    return value


@pytest.mark.asyncio
async def test_list_dir_decodes_injected_client_values(client):
    store = RedisIndexCacheStore(client=client)
    result = await store.list_dir("/folder")
    assert result.entries == ["/folder/a.txt"]


@pytest.mark.asyncio
async def test_invalidate_dir_decodes_child_paths(client):
    store = RedisIndexCacheStore(client=client)
    await store.invalidate_dir("/folder")
    pipe = client.pipeline.return_value
    assert pipe.delete.call_args_list == [
        call("mirage:idx:entry:/folder/a.txt"),
        call("mirage:idx:children:/folder"),
    ]


@pytest.mark.asyncio
async def test_entries_decodes_keys_and_json(client):
    store = RedisIndexCacheStore(client=client, key_prefix="test:")
    entries = await store.entries()
    assert entries["/folder/a.txt"].id == "a"


@pytest.mark.asyncio
async def test_falsey_injected_client_is_used_and_not_closed(client):
    client.__bool__.return_value = False
    store = RedisIndexCacheStore(client=client)

    await store.get("/folder/a.txt")
    await store.close()
    await store.close()

    client.get.assert_awaited_once()
    client.aclose.assert_not_called()


@pytest.mark.asyncio
async def test_seed_flushes_before_first_lookup(client):
    store = RedisIndexCacheStore(client=client)
    store.seed(
        {
            "/folder/a.txt": IndexEntry(
                id="a", name="a.txt", resource_type="file")
        },
        {"/folder": ["/folder/a.txt"]},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )

    await store.get("/folder/a.txt")

    client.pipeline.return_value.execute.assert_awaited_once()
