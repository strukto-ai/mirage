# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.resource.mongodb.config import MongoDBConfig


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


@pytest.mark.asyncio
async def test_client_constructs_async_mongo_client(accessor):
    sentinel = MagicMock()
    with patch("mirage.accessor.mongodb.AsyncMongoClient",
               return_value=sentinel) as ctor:
        client = accessor.client
    assert client is sentinel
    ctor.assert_called_once_with("mongodb://localhost:27017")


@pytest.mark.asyncio
async def test_client_is_cached_per_event_loop(accessor):
    with patch("mirage.accessor.mongodb.AsyncMongoClient",
               side_effect=lambda *a, **k: MagicMock()) as ctor:
        first = accessor.client
        second = accessor.client
    assert first is second
    ctor.assert_called_once()


def test_client_built_outside_event_loop_uses_loopless_key(accessor):
    with patch("mirage.accessor.mongodb.AsyncMongoClient",
               side_effect=lambda *a, **k: MagicMock()) as ctor:
        first = accessor.client
        second = accessor.client
    assert first is second
    ctor.assert_called_once()
    assert 0 in accessor._clients


@pytest.mark.asyncio
async def test_close_releases_all_clients_and_caches(accessor):
    first = MagicMock()
    first.close = AsyncMock()
    second = MagicMock()
    second.close = AsyncMock()
    accessor._clients = {1: first, 2: second}
    accessor._cache = {"db": (100.0, ["row"])}

    await accessor.close()

    first.close.assert_awaited_once_with()
    second.close.assert_awaited_once_with()
    assert accessor._clients == {}
    assert accessor._cache == {}
