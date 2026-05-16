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
from mirage.commands.builtin.mongodb.grep.grep import grep
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


def _path(s: str = "/db1/collections/coll1/documents.jsonl") -> PathSpec:
    return PathSpec(original=s, directory=s)


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
async def test_grep_streams_and_finds_match(accessor):
    docs = [{"_id": ObjectId(), "i": i, "name": f"item-{i}"} for i in range(5)]
    docs[2]["name"] = "target-2"

    async def _fake(*_args, **_kwargs):
        for d in docs:
            yield d

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.grep.grep.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, io = await grep(accessor, [_path()], "target")
        data = await _drain(source)
    text = data.decode()
    assert "target-2" in text
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_m1_short_circuits_after_first_match(accessor):
    consumed: list[int] = []

    async def _fake(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            tag = "FOUND" if i == 3 else "skip"
            yield {"_id": ObjectId(), "i": i, "tag": tag}

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.grep.grep.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, _ = await grep(accessor, [_path()], "FOUND", m="1")
        data = await _drain(source)
    assert b"FOUND" in data
    assert len(consumed) < 100


@pytest.mark.asyncio
async def test_grep_no_match_returns_exit_code_1(accessor):
    docs = [{"_id": ObjectId(), "name": f"item-{i}"} for i in range(3)]

    async def _fake(*_args, **_kwargs):
        for d in docs:
            yield d

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.grep.grep.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, io = await grep(accessor, [_path()], "absent_pattern_xyz")
        _ = await _drain(source)
    assert io.exit_code == 1
