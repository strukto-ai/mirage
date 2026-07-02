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

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.postgres.readdir import is_dir_name, readdir
from mirage.resource.postgres.config import PostgresConfig
from mirage.types import PathSpec


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor(schemas=None) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(dsn="postgres://localhost/db", schemas=schemas))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return _accessor()


@pytest.mark.asyncio
async def test_readdir_root_lists_database_json_and_schemas(accessor, index):
    with patch("mirage.core.postgres.readdir._client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public", "analytics"])
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)
    assert "/database.json" in result
    assert "/public" in result
    assert "/analytics" in result


@pytest.mark.asyncio
async def test_readdir_schema_lists_kinds(accessor, index):
    result = await readdir(
        accessor,
        PathSpec(resource_path=("/public").strip("/"),
                 virtual="/public",
                 directory="/public"), index)
    assert result == ["/public/tables", "/public/views"]


@pytest.mark.asyncio
async def test_readdir_tables_kind_lists_tables(accessor, index):
    with patch("mirage.core.postgres.readdir._client") as mc:
        mc.list_tables = AsyncMock(return_value=["users", "orders"])
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/public/tables").strip("/"),
                     virtual="/public/tables",
                     directory="/public/tables"), index)
    assert "/public/tables/users" in result
    assert "/public/tables/orders" in result


@pytest.mark.asyncio
async def test_readdir_views_kind_unions_views_and_matviews(accessor, index):
    with patch("mirage.core.postgres.readdir._client") as mc:
        mc.list_views = AsyncMock(return_value=["customer_360"])
        mc.list_matviews = AsyncMock(return_value=["daily_revenue"])
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/public/views").strip("/"),
                     virtual="/public/views",
                     directory="/public/views"), index)
    assert "/public/views/customer_360" in result
    assert "/public/views/daily_revenue" in result


@pytest.mark.asyncio
async def test_readdir_entity_lists_schema_and_rows(accessor, index):
    result = await readdir(
        accessor,
        PathSpec(resource_path=("/public/tables/users").strip("/"),
                 virtual="/public/tables/users",
                 directory="/public/tables/users"), index)
    assert result == [
        "/public/tables/users/schema.json",
        "/public/tables/users/rows.jsonl",
    ]


@pytest.mark.asyncio
async def test_readdir_view_entity_lists_schema_and_rows(accessor, index):
    result = await readdir(
        accessor,
        PathSpec(resource_path=("/analytics/views/daily_revenue").strip("/"),
                 virtual="/analytics/views/daily_revenue",
                 directory="/analytics/views/daily_revenue"), index)
    assert result == [
        "/analytics/views/daily_revenue/schema.json",
        "/analytics/views/daily_revenue/rows.jsonl",
    ]


@pytest.mark.asyncio
async def test_readdir_invalid_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                resource_path=("/public/tables/users/extra/foo").strip("/"),
                virtual="/public/tables/users/extra/foo",
                directory="/public/tables/users/extra/foo"), index)


@pytest.mark.asyncio
async def test_readdir_caches_root_listing(accessor, index):
    mock_list_schemas = AsyncMock(return_value=["public"])
    with patch("mirage.core.postgres.readdir._client") as mc:
        mc.list_schemas = mock_list_schemas
        first = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)
        second = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)
    assert first == second
    assert mock_list_schemas.call_count == 1


def test_is_dir_name_classifies_by_extension():
    assert is_dir_name("/public/tables") is True
    assert is_dir_name("/database.json") is False
    assert is_dir_name("/public/tables/users/rows.jsonl") is False
