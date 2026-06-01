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

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.hf_buckets.readdir import readdir
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_readdir_root_returns_children(make_acc):
    acc = make_acc({"hello.txt": b"x", "data/file.txt": b"y"})
    entries = await readdir(acc, PathSpec.from_str_path("/"),
                            RAMIndexCacheStore(ttl=60))
    assert "/data" in entries
    assert "/hello.txt" in entries


@pytest.mark.asyncio
async def test_readdir_subdir(make_acc):
    acc = make_acc({
        "data/a.txt": b"a",
        "data/sub/b.txt": b"b",
        "other.txt": b"o"
    })
    entries = await readdir(acc, PathSpec.from_str_path("/data"),
                            RAMIndexCacheStore(ttl=60))
    assert sorted(entries) == ["/data/a.txt", "/data/sub"]


@pytest.mark.asyncio
async def test_readdir_populates_index_cache(make_acc):
    acc = make_acc({"f.txt": b"hello"})
    cache = RAMIndexCacheStore(ttl=60)
    await readdir(acc, PathSpec.from_str_path("/"), cache)
    lookup = await cache.get("/f.txt")
    assert lookup.entry is not None
    assert lookup.entry.size == 5
    assert lookup.entry.resource_type == "file"
