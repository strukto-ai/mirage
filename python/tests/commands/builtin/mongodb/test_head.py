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
from unittest.mock import AsyncMock, patch

import pytest
from bson import ObjectId

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.commands.builtin.mongodb.head import head
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
async def test_head_default_returns_first_10_lines(accessor):
    consumed: list[int] = []

    async def _fake(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            yield {"_id": ObjectId(), "i": i}

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.head.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, _ = await head(accessor, [_path()])
        data = await _drain(source)
    lines = [line for line in data.decode().split("\n") if line]
    assert len(lines) == 10
    assert len(consumed) <= 11


@pytest.mark.asyncio
async def test_head_n5_short_circuits_after_5_docs(accessor):
    consumed: list[int] = []

    async def _fake(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            yield {"_id": ObjectId(), "i": i}

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.head.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, _ = await head(accessor, [_path()], n="5")
        data = await _drain(source)
    lines = [line for line in data.decode().split("\n") if line]
    assert len(lines) == 5
    assert len(consumed) <= 6


@pytest.mark.asyncio
async def test_head_output_uses_extended_json_for_oid(accessor):
    oid = ObjectId()
    docs = [{"_id": oid, "title": "first"}]

    async def _fake(*_args, **_kwargs):
        for d in docs:
            yield d

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.head.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, _ = await head(accessor, [_path()], n="1")
        data = await _drain(source)
    parsed = json.loads(data.decode().strip())
    assert parsed["_id"] == {"$oid": str(oid)}
    assert parsed["title"] == "first"


@pytest.mark.asyncio
async def test_head_c_bytes_mode_short_circuits(accessor):
    consumed: list[int] = []

    async def _fake(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            yield {"_id": ObjectId(), "i": i, "filler": "x" * 100}

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.head.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, _ = await head(accessor, [_path()], c="50")
        data = await _drain(source)
    assert len(data) == 50
    assert len(consumed) <= 2
