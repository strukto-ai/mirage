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

from mirage.types import PathSpec
from mirage.vfs.postgres import PostgresConfig, PostgresVFS
from mirage.workspace import Workspace
from tests.fixtures.mount_commands import mount_commands
from tests.fixtures.vfs_io import served


def test_vfs_name():
    res = PostgresVFS(PostgresConfig(dsn="postgres://localhost/db"))
    assert res.name == "postgres"
    assert res.caches_reads is False


def test_vfs_registers_three_ops():
    res = PostgresVFS(PostgresConfig(dsn="postgres://localhost/db"))
    op_names = served(res)
    assert {"read", "readdir", "stat"} <= op_names


def test_vfs_registers_commands():
    res = PostgresVFS(PostgresConfig(dsn="postgres://localhost/db"))
    cmd_names = {rc.name for rc in mount_commands(res)}
    expected = {
        "cat",
        "find",
        "head",
        "jq",
        "ls",
        "stat",
        "tail",
        "tree",
        "wc",
        "grep",
        "rg",
    }
    assert expected <= cmd_names


@pytest.mark.asyncio
async def test_vfs_in_registry():
    from mirage.vfs.registry import REGISTRY, build_vfs

    assert "postgres" in REGISTRY
    res = build_vfs("postgres", config={"dsn": "postgres://localhost/db"})
    assert res.name == "postgres"


def test_vfs_get_state_redacts_dsn():
    res = PostgresVFS(PostgresConfig(dsn="postgres://user:pw@host/db"))
    state = res.get_state()
    assert state["type"] == "postgres"
    assert state["config"]["dsn"] == "<REDACTED>"
    assert "redacted_fields" not in state


def test_vfs_load_state_noop():
    res = PostgresVFS(PostgresConfig(dsn="postgres://localhost/db"))
    res.load_state({"type": "postgres"})


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


async def _catalog_schemas(conn, allowlist):
    return [
        s for s in ("public", "secret") if allowlist is None or s in allowlist
    ]


@pytest.mark.asyncio
async def test_a_mount_reads_only_what_its_listings_name():
    """A read stands on the entity row the mount hands it, so a table
    under a schema ``schemas`` leaves out reads as absent without a
    query, and one under a listed schema reads."""
    vfs = PostgresVFS(
        PostgresConfig(dsn="postgres://localhost/db", schemas=["public"])
    )
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    vfs.accessor.pool = AsyncMock(return_value=pool)
    ws = Workspace({"/pg/": vfs})
    built = AsyncMock(return_value={"name": "users"})
    with (
        patch(
            "mirage.core.postgres.client.list_schemas",
            AsyncMock(side_effect=_catalog_schemas),
        ),
        patch(
            "mirage.core.postgres.client.list_tables",
            AsyncMock(return_value=["users"]),
        ),
        patch("mirage.core.postgres.read.build_entity_schema_json", built),
    ):
        with pytest.raises(FileNotFoundError):
            await ws.dispatch(
                "read",
                PathSpec.from_str_path("/pg/secret/tables/users/schema.json"),
            )
        built.assert_not_awaited()
        data, _ = await ws.dispatch(
            "read",
            PathSpec.from_str_path("/pg/public/tables/users/schema.json"),
        )
    assert b'"users"' in data
