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
from mirage.core.postgres.stat import stat
from mirage.resource.postgres.config import PostgresConfig
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor() -> PostgresAccessor:
    a = PostgresAccessor(PostgresConfig(dsn="postgres://localhost/db"))
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


@pytest.fixture(autouse=True)
def _exists(monkeypatch):
    monkeypatch.setattr("mirage.core.postgres.stat._schema_exists",
                        AsyncMock(return_value=True))
    monkeypatch.setattr("mirage.core.postgres.stat._entity_exists",
                        AsyncMock(return_value=True))


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor,
                        PathSpec(resource_path="", virtual="/", directory="/"),
                        index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_database_json(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path="database.json",
                 virtual="/database.json",
                 directory="/database.json"), index)
    assert result.type == FileType.JSON
    assert result.name == "database.json"


@pytest.mark.asyncio
async def test_stat_schema(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path="public",
                 virtual="/public",
                 directory="/public"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["schema"] == "public"


@pytest.mark.asyncio
async def test_stat_kind_tables(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path="public/tables",
                 virtual="/public/tables",
                 directory="/public/tables"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra == {"schema": "public", "kind": "tables"}


@pytest.mark.asyncio
async def test_stat_kind_views(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path="analytics/views",
                 virtual="/analytics/views",
                 directory="/analytics/views"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra == {"schema": "analytics", "kind": "views"}


@pytest.mark.asyncio
async def test_stat_entity_table(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path="public/tables/users",
                 virtual="/public/tables/users",
                 directory="/public/tables/users"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "users"
    assert result.extra == {
        "schema": "public",
        "kind": "tables",
        "name": "users"
    }


@pytest.mark.asyncio
async def test_stat_entity_schema_json(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path="public/tables/users/schema.json",
                 virtual="/public/tables/users/schema.json",
                 directory="/public/tables/users/schema.json"), index)
    assert result.type == FileType.JSON
    assert result.name == "schema.json"
    assert result.extra == {
        "schema": "public",
        "kind": "tables",
        "name": "users"
    }


@pytest.mark.asyncio
async def test_stat_entity_rows_jsonl(accessor, index):
    with patch("mirage.core.postgres.stat._client") as mc:
        mc.fetch_columns = AsyncMock(return_value=[
            {
                "name": "id",
                "type": "uuid",
                "nullable": False
            },
            {
                "name": "email",
                "type": "text",
                "nullable": False
            },
        ])
        mc.estimated_row_count = AsyncMock(return_value=42)
        mc.table_size_bytes = AsyncMock(return_value=4096)
        result = await stat(
            accessor,
            PathSpec(resource_path="public/tables/users/rows.jsonl",
                     virtual="/public/tables/users/rows.jsonl",
                     directory="/public/tables/users/rows.jsonl"), index)
    assert result.type == FileType.TEXT
    assert result.name == "rows.jsonl"
    assert result.size == 4096
    assert result.fingerprint is not None
    assert len(result.fingerprint) == 64
    assert result.extra["row_count"] == 42
    assert result.extra["size_bytes"] == 4096
    assert result.extra["schema"] == "public"
    assert result.extra["kind"] == "tables"
    assert result.extra["name"] == "users"


@pytest.mark.asyncio
async def test_stat_view_entity_rows(accessor, index):
    with patch("mirage.core.postgres.stat._client") as mc:
        mc.fetch_columns = AsyncMock(return_value=[
            {
                "name": "team",
                "type": "text",
                "nullable": True
            },
        ])
        mc.estimated_row_count = AsyncMock(return_value=2)
        mc.table_size_bytes = AsyncMock(return_value=128)
        result = await stat(
            accessor,
            PathSpec(resource_path="analytics/views/daily_revenue/rows.jsonl",
                     virtual="/analytics/views/daily_revenue/rows.jsonl",
                     directory="/analytics/views/daily_revenue/rows.jsonl"),
            index)
    assert result.type == FileType.TEXT
    assert result.extra["kind"] == "views"


@pytest.mark.asyncio
async def test_stat_fingerprint_changes_with_row_count(accessor, index):
    with patch("mirage.core.postgres.stat._client") as mc:
        mc.fetch_columns = AsyncMock(return_value=[
            {
                "name": "id",
                "type": "uuid",
                "nullable": False
            },
        ])
        mc.table_size_bytes = AsyncMock(return_value=100)
        mc.estimated_row_count = AsyncMock(return_value=10)
        first = await stat(
            accessor,
            PathSpec(resource_path="public/tables/users/rows.jsonl",
                     virtual="/public/tables/users/rows.jsonl",
                     directory="/public/tables/users/rows.jsonl"), index)
        mc.estimated_row_count = AsyncMock(return_value=20)
        second = await stat(
            accessor,
            PathSpec(resource_path="public/tables/users/rows.jsonl",
                     virtual="/public/tables/users/rows.jsonl",
                     directory="/public/tables/users/rows.jsonl"), index)
    assert first.fingerprint != second.fingerprint


@pytest.mark.asyncio
async def test_stat_invalid_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path="public/tables/users/extra/foo",
                     virtual="/public/tables/users/extra/foo",
                     directory="/public/tables/users/extra/foo"), index)


@pytest.mark.asyncio
async def test_stat_missing_schema_raises(accessor, index):
    with patch("mirage.core.postgres.stat._schema_exists",
               AsyncMock(return_value=False)):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path=mount_key("/pg/__nf_missing__.txt",
                                                 "/pg"),
                         virtual="/pg/__nf_missing__.txt",
                         directory="/pg/__nf_missing__.txt"), index)


@pytest.mark.asyncio
async def test_stat_missing_entity_raises(accessor, index):
    with patch("mirage.core.postgres.stat._entity_exists",
               AsyncMock(return_value=False)):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path="public/tables/nope",
                         virtual="/public/tables/nope",
                         directory="/public/tables/nope"), index)
