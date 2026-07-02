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
from mirage.core.hf_buckets.glob import resolve_glob
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_resolve_glob_passes_through_resolved_paths(make_acc):
    acc = make_acc({})
    index = RAMIndexCacheStore(ttl=60)
    p = PathSpec.from_str_path("/data/a.txt")
    out = await resolve_glob(acc, [p], index)
    assert out == [p]


@pytest.mark.asyncio
async def test_resolve_glob_expands_basename_pattern(make_acc):
    acc = make_acc({
        "data/a.txt": b"a",
        "data/b.json": b"b",
        "data/sub/c.txt": b"c",
    })
    index = RAMIndexCacheStore(ttl=60)
    pattern = PathSpec(
        resource_path=("/data/*.txt").strip("/"),
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    out = await resolve_glob(acc, [pattern], index)
    paths = sorted(p.virtual for p in out)
    assert paths == ["/data/a.txt"]


@pytest.mark.asyncio
async def test_resolve_glob_string_input_passthrough(make_acc):
    acc = make_acc({})
    index = RAMIndexCacheStore(ttl=60)
    out = await resolve_glob(acc, ["/data/a.txt"], index)
    assert len(out) == 1
    assert out[0].virtual == "/data/a.txt"
