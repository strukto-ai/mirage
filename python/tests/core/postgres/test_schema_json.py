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
from mirage.core.postgres._schema_json import (_db_name_from_dsn,
                                               build_database_json,
                                               build_entity_schema_json)
from mirage.vfs.postgres.config import PostgresConfig


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor(dsn: str = "postgres://localhost/acme_prod",
              schemas=None) -> PostgresAccessor:
    a = PostgresAccessor(PostgresConfig(dsn=dsn, schemas=schemas))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.mark.asyncio
async def test_build_database_json_basic():
    accessor = _accessor()
    with patch("mirage.core.postgres._schema_json.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        mc.list_tables = AsyncMock(return_value=["users", "orders"])
        mc.list_views = AsyncMock(return_value=["customer_360"])
        mc.list_matviews = AsyncMock(return_value=["daily_revenue"])
        mc.estimated_row_count = AsyncMock(side_effect=[100, 200])
        mc.table_size_bytes = AsyncMock(side_effect=[1024, 2048])
        mc.fetch_all_relationships = AsyncMock(return_value=[
            {
                "from": {
                    "schema": "public",
                    "table": "orders",
                    "columns": ["user_id"]
                },
                "to": {
                    "schema": "public",
                    "table": "users",
                    "columns": ["id"]
                },
                "kind": "many_to_one",
            },
        ])
        result = await build_database_json(accessor)

    assert result["database"] == "acme_prod"
    assert result["schemas"] == ["public"]
    assert result["tables"] == [
        {
            "schema": "public",
            "name": "users",
            "row_count_estimate": 100,
            "size_bytes_estimate": 1024,
        },
        {
            "schema": "public",
            "name": "orders",
            "row_count_estimate": 200,
            "size_bytes_estimate": 2048,
        },
    ]
    assert result["views"] == [
        {
            "schema": "public",
            "name": "customer_360",
            "kind": "view"
        },
        {
            "schema": "public",
            "name": "daily_revenue",
            "kind": "materialized"
        },
    ]
    assert len(result["relationships"]) == 1


@pytest.mark.asyncio
async def test_build_database_json_empty():
    accessor = _accessor()
    with patch("mirage.core.postgres._schema_json.client") as mc:
        mc.list_schemas = AsyncMock(return_value=[])
        mc.fetch_all_relationships = AsyncMock(return_value=[])
        result = await build_database_json(accessor)
    assert result["schemas"] == []
    assert result["tables"] == []
    assert result["views"] == []
    assert result["relationships"] == []


@pytest.mark.asyncio
async def test_build_entity_schema_json_table_with_pk_and_fk():
    accessor = _accessor()
    with patch("mirage.core.postgres._schema_json.client") as mc:
        mc.fetch_columns = AsyncMock(return_value=[
            {
                "name": "id",
                "type": "uuid",
                "nullable": False
            },
            {
                "name": "team_id",
                "type": "uuid",
                "nullable": True
            },
            {
                "name": "email",
                "type": "text",
                "nullable": False
            },
        ])
        mc.fetch_primary_key = AsyncMock(return_value=["id"])
        mc.fetch_foreign_keys = AsyncMock(return_value=[
            {
                "columns": ["team_id"],
                "references": {
                    "schema": "public",
                    "table": "teams",
                    "columns": ["id"],
                },
            },
        ])
        mc.fetch_indexes = AsyncMock(return_value=[
            {
                "name": "users_email_idx",
                "columns": ["email"],
                "unique": True
            },
        ])
        mc.estimated_row_count = AsyncMock(return_value=42)
        mc.table_size_bytes = AsyncMock(return_value=4096)
        result = await build_entity_schema_json(accessor, "public", "users",
                                                "table")

    assert result["schema"] == "public"
    assert result["name"] == "users"
    assert result["kind"] == "table"
    assert result["row_count_estimate"] == 42
    assert result["size_bytes_estimate"] == 4096
    assert result["primary_key"] == ["id"]
    cols_by_name = {c["name"]: c for c in result["columns"]}
    assert cols_by_name["id"].get("primary_key") is True
    assert "primary_key" not in cols_by_name["team_id"]
    assert cols_by_name["team_id"]["references"] == {
        "schema": "public",
        "table": "teams",
        "column": "id",
    }
    assert "references" not in cols_by_name["email"]
    assert result["foreign_keys"][0]["columns"] == ["team_id"]


@pytest.mark.asyncio
async def test_build_entity_schema_json_view_kind():
    accessor = _accessor()
    with patch("mirage.core.postgres._schema_json.client") as mc:
        mc.fetch_columns = AsyncMock(return_value=[
            {
                "name": "team",
                "type": "text",
                "nullable": True
            },
        ])
        mc.fetch_primary_key = AsyncMock(return_value=[])
        mc.fetch_foreign_keys = AsyncMock(return_value=[])
        mc.fetch_indexes = AsyncMock(return_value=[])
        mc.estimated_row_count = AsyncMock(return_value=0)
        mc.table_size_bytes = AsyncMock(return_value=0)
        result = await build_entity_schema_json(accessor, "public",
                                                "user_summary", "view")
    assert result["kind"] == "view"
    assert result["primary_key"] == []
    assert result["columns"][0] == {
        "name": "team",
        "type": "text",
        "nullable": True,
    }


@pytest.mark.asyncio
async def test_build_entity_schema_json_multi_column_fk():
    accessor = _accessor()
    with patch("mirage.core.postgres._schema_json.client") as mc:
        mc.fetch_columns = AsyncMock(return_value=[
            {
                "name": "tenant_id",
                "type": "uuid",
                "nullable": False
            },
            {
                "name": "user_id",
                "type": "uuid",
                "nullable": False
            },
        ])
        mc.fetch_primary_key = AsyncMock(return_value=["tenant_id", "user_id"])
        mc.fetch_foreign_keys = AsyncMock(return_value=[
            {
                "columns": ["tenant_id", "user_id"],
                "references": {
                    "schema": "public",
                    "table": "accounts",
                    "columns": ["tenant_id", "id"],
                },
            },
        ])
        mc.fetch_indexes = AsyncMock(return_value=[])
        mc.estimated_row_count = AsyncMock(return_value=0)
        mc.table_size_bytes = AsyncMock(return_value=0)
        result = await build_entity_schema_json(accessor, "public",
                                                "memberships", "table")
    cols = {c["name"]: c for c in result["columns"]}
    assert cols["tenant_id"]["references"] == {
        "schema": "public",
        "table": "accounts",
        "column": "tenant_id",
    }
    assert cols["user_id"]["references"] == {
        "schema": "public",
        "table": "accounts",
        "column": "id",
    }


def test_db_name_from_dsn_simple():
    assert _db_name_from_dsn("postgres://localhost/acme_prod") == "acme_prod"


def test_db_name_from_dsn_with_query():
    assert _db_name_from_dsn(
        "postgres://localhost/acme?sslmode=require") == "acme"


def test_db_name_from_dsn_with_user_pass():
    assert _db_name_from_dsn(
        "postgres://u:p@db.example.com:5432/myapp") == "myapp"


def test_db_name_from_dsn_no_db_returns_default():
    assert _db_name_from_dsn("postgres://localhost") == "localhost"
