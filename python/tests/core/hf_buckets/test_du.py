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
from mirage.core.hf_buckets.du import du, du_all
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_du_sums_file_sizes_recursive():
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
                    "path": "a.txt",
                    "size": 1
                },
                {
                    "type": "directory",
                    "path": "sub"
                },
                {
                    "type": "file",
                    "path": "sub/b.txt",
                    "size": 10
                },
                {
                    "type": "file",
                    "path": "sub/c.txt",
                    "size": 100
                },
            ],
        )
        total = await du(acc, PathSpec.from_str_path("/"))
    assert total == 111


@pytest.mark.asyncio
async def test_du_all_returns_per_file_with_total():
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
                    "path": "a.txt",
                    "size": 1
                },
                {
                    "type": "directory",
                    "path": "sub"
                },
                {
                    "type": "file",
                    "path": "sub/b.txt",
                    "size": 10
                },
                {
                    "type": "file",
                    "path": "sub/c.txt",
                    "size": 100
                },
            ],
        )
        out = await du_all(acc, PathSpec.from_str_path("/"))
    entries = sorted(out[:-1])
    assert entries == [("/a.txt", 1), ("/sub/b.txt", 10), ("/sub/c.txt", 100)]
    assert out[-1][1] == 111


@pytest.mark.asyncio
async def test_du_subdir_uses_subpath_url_and_strips_key_prefix():
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
                    "size": 5
                },
                {
                    "type": "file",
                    "path": "data/sub/b.json",
                    "size": 7
                },
            ],
        )
        out = await du_all(acc, PathSpec.from_str_path("/"))
    entries = sorted(out[:-1])
    assert entries == [("/a.json", 5), ("/sub/b.json", 7)]
    assert out[-1][1] == 12
