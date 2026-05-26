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
from aioresponses import aioresponses

from mirage.accessor.hf_buckets import HfBucketsAccessor, HfBucketsConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.hf_buckets.readdir import readdir
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_readdir_root_returns_children():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    index = RAMIndexCacheStore(ttl=60)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/api/buckets/bkt-1/tree",
              payload=[
                  {
                      "type": "file",
                      "path": "foo.txt",
                      "size": 4,
                      "xet_hash": "h1"
                  },
                  {
                      "type": "directory",
                      "path": "sub"
                  },
              ])
        out = await readdir(acc, PathSpec.from_str_path("/"), index)
    assert sorted(out) == ["/foo.txt", "/sub"]


@pytest.mark.asyncio
async def test_readdir_subdir():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    index = RAMIndexCacheStore(ttl=60)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/api/buckets/bkt-1/tree/data",
              payload=[
                  {
                      "type": "file",
                      "path": "data/a.json",
                      "size": 1
                  },
                  {
                      "type": "file",
                      "path": "data/b.json",
                      "size": 2
                  },
              ])
        out = await readdir(acc, PathSpec.from_str_path("/data"), index)
    assert sorted(out) == ["/data/a.json", "/data/b.json"]


@pytest.mark.asyncio
async def test_readdir_populates_index_cache():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    index = RAMIndexCacheStore(ttl=60)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/api/buckets/bkt-1/tree",
              payload=[{
                  "type": "file",
                  "path": "foo.txt",
                  "size": 4
              }])
        await readdir(acc, PathSpec.from_str_path("/"), index)
    listing = await index.list_dir("/")
    assert listing.entries == ["/foo.txt"]
