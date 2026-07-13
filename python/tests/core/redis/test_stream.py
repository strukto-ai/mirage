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

import os

import pytest
import pytest_asyncio

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.stream import stream
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def mk_store():
    stores = []

    async def _make(prefix, files=None):
        s = RedisStore(url=REDIS_URL, key_prefix=prefix)
        await s.clear()
        await s.add_dir("/")
        if files:
            for path, data in files.items():
                await s.set_file(path, data)
        stores.append(s)
        return RedisAccessor(s)

    yield _make
    for s in stores:
        await s.clear()
        await s.close()


@pytest.mark.asyncio
async def test_stream_reads_content(mk_store):
    a = await mk_store("test:stream:1:", {"/file.txt": b"hello world"})
    chunks = []
    async for chunk in stream(a, PathSpec.from_str_path("/file.txt")):
        chunks.append(chunk)
    assert b"".join(chunks) == b"hello world"


@pytest.mark.asyncio
async def test_stream_single_chunk(mk_store):
    a = await mk_store("test:stream:2:", {"/file.txt": b"data"})
    chunks = []
    async for chunk in stream(a, PathSpec.from_str_path("/file.txt")):
        chunks.append(chunk)
    assert len(chunks) == 1


@pytest.mark.asyncio
async def test_stream_not_found(mk_store):
    a = await mk_store("test:stream:3:")
    with pytest.raises(FileNotFoundError):
        async for _ in stream(a, PathSpec.from_str_path("/nope.txt")):
            pass


@pytest.mark.asyncio
async def test_stream_empty_file(mk_store):
    a = await mk_store("test:stream:4:", {"/empty": b""})
    chunks = []
    async for chunk in stream(a, PathSpec.from_str_path("/empty")):
        chunks.append(chunk)
    assert b"".join(chunks) == b""
