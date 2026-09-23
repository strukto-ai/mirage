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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.mongodb.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.mongodb.config import MongoDBConfig

GENERICS = "mirage.commands.builtin.generic_bind.search._GENERICS"
RESOLVE = "mirage.commands.builtin.generic_bind.adapter.make_resolve_glob"
SEARCH_COLLECTION = "mirage.core.mongodb.search.search_collection"


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


@pytest.fixture
def _stat_reads(monkeypatch):
    # The stat guard is captured by the search factory at import, so fake
    # what it reads at call time: the existence probes and the counters.
    monkeypatch.setattr("mirage.core.mongodb.readdir.entity_exists",
                        AsyncMock(return_value=True))
    monkeypatch.setattr("mirage.core.mongodb.stat.count_documents",
                        AsyncMock(return_value=5))
    monkeypatch.setattr("mirage.core.mongodb.stat.is_view",
                        AsyncMock(return_value=False))
    monkeypatch.setattr("mirage.core.mongodb.stat.get_indexes",
                        AsyncMock(return_value=[]))


def _path(s: str) -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


def _glob_path() -> PathSpec:
    return PathSpec(virtual="/db1/collections/*",
                    directory="/db1/collections",
                    vfs_path="db1/collections/*",
                    pattern="*",
                    resolved=False)


@pytest.mark.asyncio
async def test_rg_lone_collection_uses_pushdown(accessor, _stat_reads):
    search = AsyncMock(return_value=[])
    generic = AsyncMock(side_effect=AssertionError("generic path ran"))
    with patch(
            SEARCH_COLLECTION,
            new=search,
    ), patch.dict(GENERICS, {"rg": generic}):
        _, io = await rg(accessor, [_path("/db1/collections/coll1")],
                         ['target'], CommandOpts(index=NULL_INDEX))

    search.assert_awaited_once()
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_second_operand_skips_pushdown(accessor):
    # Two collection operands are both searchable scopes, and the $regex
    # push-down answers for one: this line silently reported only coll1.
    seen: dict[str, list[str]] = {}
    ops = [_path("/db1/collections/coll1"), _path("/db1/collections/coll2")]

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_COLLECTION,
            new=AsyncMock(side_effect=AssertionError("pushdown ran on 2 ops")),
    ), patch(
            "mirage.core.mongodb.readdir.entity_exists",
            new=AsyncMock(side_effect=AssertionError("stat ran on 2 ops")),
    ), patch.dict(GENERICS, {"rg": fake_generic}):
        await rg(accessor, ops, ['target'], CommandOpts(index=NULL_INDEX))

    assert seen["generic"] == [
        "/db1/collections/coll1", "/db1/collections/coll2"
    ]


@pytest.mark.asyncio
async def test_rg_unresolved_glob_skips_pushdown(accessor):
    seen: dict[str, list[str]] = {}
    resolved = [_path("/db1/collections/coll1")]

    async def fake_resolve(_accessor, _paths, index=None):
        return resolved

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_COLLECTION,
            new=AsyncMock(side_effect=AssertionError("pushdown ran on glob")),
    ), patch(
            "mirage.core.mongodb.readdir.entity_exists",
            new=AsyncMock(side_effect=AssertionError("stat ran on glob")),
    ), patch(
            RESOLVE,
            new=lambda *_args, **_kwargs: fake_resolve,
    ), patch.dict(GENERICS, {"rg": fake_generic}):
        await rg(accessor, [_glob_path()], ['target'],
                 CommandOpts(index=NULL_INDEX))

    assert seen["generic"] == ["/db1/collections/coll1"]
