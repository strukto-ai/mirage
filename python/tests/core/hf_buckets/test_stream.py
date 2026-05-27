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
from mirage.core.hf_buckets.stream import range_read, read_stream
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_range_read_inclusive_exclusive():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/buckets/bkt-1/resolve/x", body=b"2345")
        out = await range_read(acc, PathSpec.from_str_path("/x"), 2, 6)
    assert out == b"2345"


@pytest.mark.asyncio
async def test_read_stream_yields_chunks():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/buckets/bkt-1/resolve/x",
              body=b"abcdefghij")
        chunks: list[bytes] = []
        async for c in read_stream(acc,
                                   PathSpec.from_str_path("/x"),
                                   chunk_size=4):
            chunks.append(c)
    assert b"".join(chunks) == b"abcdefghij"


@pytest.mark.asyncio
async def test_read_stream_handles_empty_file():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/buckets/bkt-1/resolve/empty", body=b"")
        chunks: list[bytes] = []
        async for c in read_stream(acc, PathSpec.from_str_path("/empty")):
            chunks.append(c)
    assert chunks == []
