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
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.postgres.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.postgres.config import PostgresConfig

GENERICS = "mirage.commands.builtin.generic_bind.search._GENERICS"
SEARCH_ENTITY = "mirage.core.postgres.search.search_entity"


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


@pytest.fixture
def accessor():
    a = PostgresAccessor(config=PostgresConfig(
        dsn="postgres://u:p@localhost:5432/db"))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.fixture
def _guard_reads(monkeypatch):
    # The stat guard is captured by the search factory at import, so fake
    # what it reads at call time: the pool (above) and the client queries.
    monkeypatch.setattr("mirage.core.postgres.client.list_tables",
                        AsyncMock(return_value=["books"]))
    monkeypatch.setattr("mirage.core.postgres.client.fetch_columns",
                        AsyncMock(return_value=[]))
    monkeypatch.setattr("mirage.core.postgres.client.estimated_row_count",
                        AsyncMock(return_value=0))
    monkeypatch.setattr("mirage.core.postgres.client.table_size_bytes",
                        AsyncMock(return_value=0))


def _path(s: str = "/public/tables/books/rows.jsonl") -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


@pytest.mark.asyncio
async def test_rg_multi_pattern_skips_native_search(accessor):
    # A newline-joined multi -e set must bypass the native pushdown and
    # still reach the generic with the operand intact (#347).
    seen: dict[str, object] = {}

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_ENTITY,
            new=AsyncMock(side_effect=AssertionError("native search ran")),
    ), patch.dict(GENERICS, {"rg": fake_generic}):
        _, io = await rg(
            accessor, [_path()], [],
            CommandOpts(index=NULL_INDEX, flags={'e': ['ada', 'ben']}))

    assert io.exit_code == 0
    assert seen["generic"] == ["/public/tables/books/rows.jsonl"]


@pytest.mark.asyncio
async def test_rg_single_pattern_uses_native_search(accessor, _guard_reads):
    search = AsyncMock(return_value=[])
    generic = AsyncMock(side_effect=AssertionError("generic ran"))
    with patch(
            SEARCH_ENTITY,
            new=search,
    ), patch.dict(GENERICS, {"rg": generic}):
        _, io = await rg(accessor, [_path()], ['ada'],
                         CommandOpts(index=NULL_INDEX))

    assert io.exit_code == 1
    search.assert_awaited_once()
