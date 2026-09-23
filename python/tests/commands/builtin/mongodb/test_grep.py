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
from bson import ObjectId

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.mongodb.grep import grep
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.mongodb.config import MongoDBConfig

GENERICS = "mirage.commands.builtin.generic_bind.search._GENERICS"
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


def _path(s: str = "/db1/collections/coll1/documents.jsonl") -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


async def _drain(source) -> bytes:
    if source is None:
        return b""
    if isinstance(source, (bytes, bytearray)):
        return bytes(source)
    chunks: list[bytes] = []
    async for chunk in source:
        chunks.append(chunk)
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_grep_streams_and_finds_match(accessor, _stat_reads):
    docs = [{"_id": ObjectId(), "i": i, "name": f"item-{i}"} for i in range(5)]
    docs[2]["name"] = "target-2"

    async def _fake(*_args, **_kwargs):
        for d in docs:
            yield d

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake):
        source, io = await grep(accessor, [_path()], ['target'],
                                CommandOpts(index=NULL_INDEX))
        data = await _drain(source)
    text = data.decode()
    assert "target-2" in text
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_m1_short_circuits_after_first_match(accessor, _stat_reads):
    consumed: list[int] = []

    async def _fake(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            tag = "FOUND" if i == 3 else "skip"
            yield {"_id": ObjectId(), "i": i, "tag": tag}

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake):
        source, _ = await grep(accessor, [_path()], ['FOUND'],
                               CommandOpts(index=NULL_INDEX, flags={'m': '1'}))
        data = await _drain(source)
    assert b"FOUND" in data
    assert len(consumed) < 100


@pytest.mark.asyncio
async def test_grep_second_operand_skips_pushdown(accessor):
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
    ), patch.dict(GENERICS, {"grep": fake_generic}):
        await grep(accessor, ops, ['target'], CommandOpts(index=NULL_INDEX))

    assert seen["generic"] == [
        "/db1/collections/coll1", "/db1/collections/coll2"
    ]


@pytest.mark.asyncio
async def test_grep_lone_collection_still_uses_pushdown(accessor, _stat_reads):
    search = AsyncMock(return_value=[])
    generic = AsyncMock(side_effect=AssertionError("generic path ran"))
    with patch(
            SEARCH_COLLECTION,
            new=search,
    ), patch.dict(GENERICS, {"grep": generic}):
        _, io = await grep(accessor, [_path("/db1/collections/coll1")],
                           ['target'], CommandOpts(index=NULL_INDEX))

    search.assert_awaited_once()
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_no_match_returns_exit_code_1(accessor, _stat_reads):
    docs = [{"_id": ObjectId(), "name": f"item-{i}"} for i in range(3)]

    async def _fake(*_args, **_kwargs):
        for d in docs:
            yield d

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake):
        source, io = await grep(accessor, [_path()], ['absent_pattern_xyz'],
                                CommandOpts(index=NULL_INDEX))
        _ = await _drain(source)
    assert io.exit_code == 1
