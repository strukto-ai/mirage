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
from mirage.commands.builtin.mongodb.cat import cat
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


def _path(s: str = "/db1/collections/coll1/documents.jsonl") -> PathSpec:
    return PathSpec(virtual=s, directory=s, resource_path=s.strip("/"))


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
async def test_cat_streams_all_docs_as_extended_json(accessor):
    docs = [{"_id": ObjectId(), "i": i} for i in range(7)]

    async def _fake(*_args, **_kwargs):
        for d in docs:
            yield d

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.cat.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, _ = await cat(accessor, [_path()])
        data = await _drain(source)
    lines = [line for line in data.decode().split("\n") if line]
    assert len(lines) == 7
    for line in lines:
        parsed = json.loads(line)
        assert isinstance(parsed["_id"], dict)
        assert "$oid" in parsed["_id"]


@pytest.mark.asyncio
async def test_cat_n_prepends_line_numbers(accessor):
    docs = [{"_id": ObjectId(), "i": 0}, {"_id": ObjectId(), "i": 1}]

    async def _fake(*_args, **_kwargs):
        for d in docs:
            yield d

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake), patch(
            "mirage.commands.builtin.mongodb.cat.resolve_glob",
            new=AsyncMock(return_value=[_path()])):
        source, _ = await cat(accessor, [_path()], n=True)
        data = await _drain(source)
    lines = data.decode().splitlines()
    assert lines[0].lstrip().startswith("1\t")
    assert lines[1].lstrip().startswith("2\t")
    payload = lines[0].split("\t", 1)[1]
    parsed = json.loads(payload)
    assert "$oid" in parsed["_id"]
