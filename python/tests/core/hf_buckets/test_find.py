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
from mirage.core.hf_buckets.find import find
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_find_root_returns_sorted_files_only():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get(
            "https://huggingface.co/api/buckets/bkt-1/tree?recursive=true",
            payload=[
                {
                    "type": "file",
                    "path": "z.txt",
                    "size": 3
                },
                {
                    "type": "directory",
                    "path": "sub"
                },
                {
                    "type": "file",
                    "path": "sub/a.txt",
                    "size": 2
                },
                {
                    "type": "file",
                    "path": "a.txt",
                    "size": 1
                },
            ],
        )
        out = await find(acc, PathSpec.from_str_path("/"))
    assert out == ["/a.txt", "/sub/a.txt", "/z.txt"]


@pytest.mark.asyncio
async def test_find_subdir_uses_subpath_url():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get(
            ("https://huggingface.co/api/buckets/"
             "bkt-1/tree/data?recursive=true"),
            payload=[
                {
                    "type": "file",
                    "path": "data/a.json",
                    "size": 1
                },
                {
                    "type": "file",
                    "path": "data/sub/b.json",
                    "size": 2
                },
            ],
        )
        out = await find(acc, PathSpec.from_str_path("/data"))
    assert out == ["/data/a.json", "/data/sub/b.json"]


@pytest.mark.asyncio
async def test_find_strips_key_prefix():
    cfg = HfBucketsConfig(bucket="o/b", token="t", key_prefix="data/")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get(
            ("https://huggingface.co/api/buckets/"
             "bkt-1/tree/data?recursive=true"),
            payload=[
                {
                    "type": "file",
                    "path": "data/a.json",
                    "size": 1
                },
                {
                    "type": "file",
                    "path": "data/sub/b.json",
                    "size": 2
                },
            ],
        )
        out = await find(acc, PathSpec.from_str_path("/"))
    assert out == ["/a.json", "/sub/b.json"]
