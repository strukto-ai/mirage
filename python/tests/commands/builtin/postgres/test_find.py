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
from mirage.commands.builtin.postgres import COMMANDS
from mirage.resource.postgres.config import PostgresConfig
from mirage.types import PathSpec

MOUNT = "/pg"


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor() -> PostgresAccessor:
    a = PostgresAccessor(PostgresConfig(dsn="postgres://localhost/db"))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for postgres")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual[len(MOUNT):].strip("/"))


def _fake_client(mc) -> None:
    mc.list_schemas = AsyncMock(return_value=["public"])
    mc.list_tables = AsyncMock(return_value=["users"])
    mc.list_views = AsyncMock(return_value=[])
    mc.list_matviews = AsyncMock(return_value=[])
    mc.fetch_columns = AsyncMock(return_value=[{"name": "id"}])
    mc.estimated_row_count = AsyncMock(return_value=10)
    mc.table_size_bytes = AsyncMock(return_value=4096)


async def _run(paths: list[PathSpec], *texts: str, **flags) -> list[str]:
    find = _find_command()
    with patch("mirage.core.postgres.readdir._client") as rd_client, \
         patch("mirage.core.postgres.stat._client") as st_client:
        _fake_client(rd_client)
        _fake_client(st_client)
        stdout, _io = await find(_accessor(),
                                 paths,
                                 *texts,
                                 index=RAMIndexCacheStore(),
                                 **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_plain_find_lists_synthetic_tree():
    lines = await _run([_spec(MOUNT)])
    assert f"{MOUNT}/database.json" in lines
    assert f"{MOUNT}/public/tables/users/schema.json" in lines
    assert f"{MOUNT}/public/tables/users/rows.jsonl" in lines
    assert f"{MOUNT}/public/views" in lines


@pytest.mark.asyncio
async def test_name_and_type_filters():
    files = await _run([_spec(MOUNT)], name="rows.jsonl")
    assert files == [f"{MOUNT}/public/tables/users/rows.jsonl"]
    dirs = await _run([_spec(MOUNT)], type="d")
    assert f"{MOUNT}/public/tables/users" in dirs
    assert all(not d.endswith((".json", ".jsonl")) for d in dirs)


@pytest.mark.asyncio
async def test_depth_window():
    lines = await _run([_spec(MOUNT)], maxdepth="2", mindepth="1")
    assert f"{MOUNT}/database.json" in lines
    assert f"{MOUNT}/public/tables" in lines
    assert MOUNT not in lines
    assert f"{MOUNT}/public/tables/users" not in lines


@pytest.mark.asyncio
async def test_size_filter_counts_rows_jsonl_as_size_zero():
    # rows.jsonl is sizeless (table_size_bytes is storage, not the rendered
    # JSONL length, and lives in extra), so -size treats it as 0.
    hits = await _run([_spec(MOUNT)], type="f", size="+1k")
    assert hits == []
    kept = await _run([_spec(MOUNT)], type="f", size="-1k")
    assert f"{MOUNT}/public/tables/users/rows.jsonl" in kept
