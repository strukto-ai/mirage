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
from mirage.core.postgres.readdir import readdir
from mirage.types import PathSpec
from mirage.vfs.postgres.config import PostgresConfig


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor(schemas=None) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(dsn="postgres://localhost/db", schemas=schemas)
    )
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


def _names(rows):
    return [row.name for row in rows]


@pytest.fixture
def accessor():
    return _accessor()


@pytest.mark.asyncio
async def test_readdir_root_lists_database_json_and_schemas(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public", "analytics"])
        result = await readdir(
            accessor, PathSpec(vfs_path="", virtual="/", directory="/")
        )
    assert "database.json" in _names(result)
    assert "public" in _names(result)
    assert "analytics" in _names(result)


@pytest.mark.asyncio
async def test_readdir_schema_lists_kinds(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="public", virtual="/public", directory="/public"
            ),
        )
    assert _names(result) == ["tables", "views"]


@pytest.mark.asyncio
async def test_readdir_tables_kind_lists_tables(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        mc.list_tables = AsyncMock(return_value=["users", "orders"])
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="public/tables",
                virtual="/public/tables",
                directory="/public/tables",
            ),
        )
    assert "users" in _names(result)
    assert "orders" in _names(result)


@pytest.mark.asyncio
async def test_readdir_views_kind_unions_views_and_matviews(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        mc.list_views = AsyncMock(return_value=["customer_360"])
        mc.list_matviews = AsyncMock(return_value=["daily_revenue"])
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="public/views",
                virtual="/public/views",
                directory="/public/views",
            ),
        )
    assert "customer_360" in _names(result)
    assert "daily_revenue" in _names(result)


@pytest.mark.asyncio
async def test_readdir_entity_lists_schema_and_rows(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        mc.list_tables = AsyncMock(return_value=["users"])
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="public/tables/users",
                virtual="/public/tables/users",
                directory="/public/tables/users",
            ),
        )
    assert _names(result) == ["schema.json", "semantic.json", "rows.jsonl"]


@pytest.mark.asyncio
async def test_readdir_view_entity_lists_schema_and_rows(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["analytics"])
        mc.list_views = AsyncMock(return_value=["daily_revenue"])
        mc.list_matviews = AsyncMock(return_value=[])
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="analytics/views/daily_revenue",
                virtual="/analytics/views/daily_revenue",
                directory="/analytics/views/daily_revenue",
            ),
        )
    assert _names(result) == ["schema.json", "semantic.json", "rows.jsonl"]


@pytest.mark.asyncio
async def test_readdir_invalid_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="public/tables/users/extra/foo",
                virtual="/public/tables/users/extra/foo",
                directory="/public/tables/users/extra/foo",
            ),
        )


@pytest.mark.asyncio
async def test_readdir_unknown_schema_raises(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path="nope.txt",
                    virtual="/nope.txt",
                    directory="/nope.txt",
                ),
            )


@pytest.mark.asyncio
async def test_readdir_kind_under_unknown_schema_raises(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        mc.list_tables = AsyncMock(return_value=[])
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path="nope/tables",
                    virtual="/nope/tables",
                    directory="/nope/tables",
                ),
            )


@pytest.mark.asyncio
async def test_readdir_unknown_entity_raises(accessor):
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(return_value=["public"])
        mc.list_tables = AsyncMock(return_value=["users"])
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path="public/tables/ghost",
                    virtual="/public/tables/ghost",
                    directory="/public/tables/ghost",
                ),
            )


async def _catalog_schemas(conn, allowlist):
    # `client.list_schemas`'s contract over a catalog holding two schemas.
    return [
        s for s in ("public", "secret") if allowlist is None or s in allowlist
    ]


@pytest.mark.asyncio
async def test_an_entity_under_a_schema_outside_schemas_is_enoent():
    """The entity guard stands in for the listing chain, so it has to
    answer for the schema as well: it used to check only that the table
    existed, and a table under a schema ``schemas`` leaves out listed,
    stat'd and read as if the mount could see it."""
    accessor = _accessor(schemas=["public"])
    with patch("mirage.core.postgres.readdir.client") as mc:
        mc.list_schemas = AsyncMock(side_effect=_catalog_schemas)
        mc.list_tables = AsyncMock(return_value=["users"])
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path="secret/tables/users",
                    virtual="/secret/tables/users",
                    directory="/secret/tables/users",
                ),
            )
        mc.list_tables.assert_not_awaited()
