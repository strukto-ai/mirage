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

import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.postgres.read import read
from mirage.resource.postgres.config import PostgresConfig
from mirage.types import PathSpec


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor(max_read_rows: int = 10_000,
              max_read_bytes: int = 10 * 1024 * 1024,
              default_row_limit: int = 1000) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(dsn="postgres://localhost/db",
                       max_read_rows=max_read_rows,
                       max_read_bytes=max_read_bytes,
                       default_row_limit=default_row_limit))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_database_json():
    accessor = _accessor()
    fake_doc = {
        "database": "db",
        "schemas": ["public"],
        "tables": [],
        "views": [],
        "relationships": []
    }
    with patch("mirage.core.postgres.read.build_database_json",
               new_callable=AsyncMock,
               return_value=fake_doc):
        out = await read(
            accessor,
            PathSpec(resource_path="database.json",
                     virtual="/database.json",
                     directory="/database.json"))
    parsed = json.loads(out)
    assert parsed == fake_doc


@pytest.mark.asyncio
async def test_read_entity_schema_json_table():
    accessor = _accessor()
    fake_doc = {"schema": "public", "name": "users", "kind": "table"}
    with patch("mirage.core.postgres.read.build_entity_schema_json",
               new_callable=AsyncMock,
               return_value=fake_doc) as mock_fn:
        out = await read(
            accessor,
            PathSpec(resource_path="public/tables/users/schema.json",
                     virtual="/public/tables/users/schema.json",
                     directory="/public/tables/users/schema.json"))
    parsed = json.loads(out)
    assert parsed == fake_doc
    mock_fn.assert_awaited_once_with(accessor, "public", "users", "table")


@pytest.mark.asyncio
async def test_read_entity_schema_json_view_kind():
    accessor = _accessor()
    fake_doc = {"schema": "public", "name": "v1", "kind": "view"}
    with patch("mirage.core.postgres.read.build_entity_schema_json",
               new_callable=AsyncMock,
               return_value=fake_doc) as mock_fn:
        await read(
            accessor,
            PathSpec(resource_path="public/views/v1/schema.json",
                     virtual="/public/views/v1/schema.json",
                     directory="/public/views/v1/schema.json"))
    mock_fn.assert_awaited_once_with(accessor, "public", "v1", "view")


@pytest.mark.asyncio
async def test_read_rows_returns_jsonl():
    accessor = _accessor()
    rows = [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}]
    with patch("mirage.core.postgres.read._client") as mc:
        mc.estimate_size = AsyncMock(return_value=(2, 80))
        mc.fetch_rows = AsyncMock(return_value=rows)
        out = await read(
            accessor,
            PathSpec(resource_path="public/tables/users/rows.jsonl",
                     virtual="/public/tables/users/rows.jsonl",
                     directory="/public/tables/users/rows.jsonl"))
    lines = out.decode().strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0]) == {"id": 1, "name": "a"}


@pytest.mark.asyncio
async def test_read_rows_too_many_rows_raises():
    accessor = _accessor(max_read_rows=100)
    with patch("mirage.core.postgres.read._client") as mc:
        mc.estimate_size = AsyncMock(return_value=(1_000_000, 50))
        with pytest.raises(ValueError, match="too large"):
            await read(
                accessor,
                PathSpec(resource_path="public/tables/users/rows.jsonl",
                         virtual="/public/tables/users/rows.jsonl",
                         directory="/public/tables/users/rows.jsonl"))


@pytest.mark.asyncio
async def test_read_rows_too_many_bytes_raises():
    accessor = _accessor(max_read_rows=10_000_000, max_read_bytes=1024)
    with patch("mirage.core.postgres.read._client") as mc:
        mc.estimate_size = AsyncMock(return_value=(100, 100))
        with pytest.raises(ValueError, match="too large"):
            await read(
                accessor,
                PathSpec(resource_path="public/tables/users/rows.jsonl",
                         virtual="/public/tables/users/rows.jsonl",
                         directory="/public/tables/users/rows.jsonl"))


@pytest.mark.asyncio
async def test_read_rows_with_explicit_limit_bypasses_guard():
    accessor = _accessor(max_read_rows=10)
    rows = [{"id": i} for i in range(5)]
    with patch("mirage.core.postgres.read._client") as mc:
        mc.fetch_rows = AsyncMock(return_value=rows)
        out = await read(accessor,
                         PathSpec(
                             resource_path="public/tables/users/rows.jsonl",
                             virtual="/public/tables/users/rows.jsonl",
                             directory="/public/tables/users/rows.jsonl"),
                         limit=5,
                         offset=0)
        mc.estimate_size.assert_not_called()
    lines = out.decode().strip().split("\n")
    assert len(lines) == 5


@pytest.mark.asyncio
async def test_read_rows_with_only_offset_bypasses_guard():
    accessor = _accessor(max_read_rows=10)
    rows = [{"id": i} for i in range(3)]
    with patch("mirage.core.postgres.read._client") as mc:
        mc.fetch_rows = AsyncMock(return_value=rows)
        await read(accessor,
                   PathSpec(resource_path="public/tables/users/rows.jsonl",
                            virtual="/public/tables/users/rows.jsonl",
                            directory="/public/tables/users/rows.jsonl"),
                   offset=10)
        mc.estimate_size.assert_not_called()


@pytest.mark.asyncio
async def test_read_rows_empty_returns_empty_bytes():
    accessor = _accessor()
    with patch("mirage.core.postgres.read._client") as mc:
        mc.estimate_size = AsyncMock(return_value=(0, 50))
        mc.fetch_rows = AsyncMock(return_value=[])
        out = await read(
            accessor,
            PathSpec(resource_path="public/tables/users/rows.jsonl",
                     virtual="/public/tables/users/rows.jsonl",
                     directory="/public/tables/users/rows.jsonl"))
    assert out == b""


@pytest.mark.asyncio
async def test_read_invalid_path_raises():
    accessor = _accessor()
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(resource_path="public/tables",
                     virtual="/public/tables",
                     directory="/public/tables"))


@pytest.mark.asyncio
async def test_read_view_rows_uses_view_kind_in_error():
    """Error message references views/, not tables/, for a view path."""
    accessor = _accessor(max_read_rows=10)
    with patch("mirage.core.postgres.read._client") as mc:
        mc.estimate_size = AsyncMock(return_value=(10000, 100))
        with pytest.raises(ValueError, match="views/v1"):
            await read(
                accessor,
                PathSpec(resource_path="public/views/v1/rows.jsonl",
                         virtual="/public/views/v1/rows.jsonl",
                         directory="/public/views/v1/rows.jsonl"))
