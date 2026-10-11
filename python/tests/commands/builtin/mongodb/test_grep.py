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
from mirage.commands.builtin.generic_bind import generic
from mirage.commands.config import CommandOpts
from mirage.types import PathSpec
from mirage.vfs.mongodb import MongoDBVFS
from mirage.vfs.mongodb.config import MongoDBConfig
from tests.fixtures.vfs_io import io_for


@pytest.fixture
def accessor():
    return MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017")
    )


@pytest.fixture
def _stat_reads(monkeypatch):
    # Fake what stat reads: the existence probes and the counters.
    monkeypatch.setattr(
        "mirage.core.mongodb.readdir.entity_exists",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        "mirage.core.mongodb.client.count_documents", AsyncMock(return_value=5)
    )
    monkeypatch.setattr(
        "mirage.core.mongodb.client.is_view", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(
        "mirage.core.mongodb.client.get_indexes", AsyncMock(return_value=[])
    )


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
async def test_grep_m1_short_circuits_after_first_match(accessor, _stat_reads):
    consumed: list[int] = []

    async def _fake(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            tag = "FOUND" if i == 3 else "skip"
            yield {"_id": ObjectId(), "i": i, "tag": tag}

    with patch("mirage.core.mongodb.stream.iter_documents", new=_fake):
        source, _ = await generic("grep").fn(
            accessor,
            [_path()],
            ["FOUND"],
            CommandOpts(
                io=io_for(MongoDBVFS, accessor),
                index=NULL_INDEX,
                flags={"m": "1"},
            ),
        )
        data = await _drain(source)
    assert b"FOUND" in data
    assert len(consumed) < 100
