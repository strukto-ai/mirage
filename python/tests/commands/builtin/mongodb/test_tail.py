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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.mongodb.tail import tail
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.vfs.mongodb import MongoDBVFS
from mirage.vfs.mongodb.config import MongoDBConfig
from tests.fixtures.vfs_io import io_for


def _path(s: str) -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


@pytest.mark.asyncio
async def test_tail_does_not_query_a_collection_it_cannot_see(monkeypatch):
    """The ``-f`` change stream queried the collection by the names in the
    path; one the mount cannot see is handed to the generic, which reports
    it absent."""
    monkeypatch.setattr(
        "mirage.core.mongodb.readdir.entity_exists",
        AsyncMock(return_value=False),
    )
    queried = AsyncMock(side_effect=AssertionError("queried the collection"))
    monkeypatch.setitem(tail.__wrapped__.__globals__, "read_tail", queried)
    monkeypatch.setitem(tail.__wrapped__.__globals__, "watch_stream", queried)
    accessor = MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017")
    )
    out, io = await tail(
        accessor,
        [_path("/db1/collections/missing/documents.jsonl")],
        [],
        CommandOpts(
            io=io_for(MongoDBVFS, accessor),
            index=RAMIndexCacheStore(),
            flags={"follow": True},
        ),
    )
    await materialize(out)
    assert io.exit_code == 1
    assert b"No such file or directory" in await materialize(io.stderr)
    queried.assert_not_called()
