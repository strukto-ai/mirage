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
from mirage.core.hf_buckets.read import read_bytes
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_read_bytes_whole_file():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/buckets/bkt-1/resolve/greet.txt",
              body=b"hello world")
        out = await read_bytes(acc, PathSpec.from_str_path("/greet.txt"))
    assert out == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_offset_size_sends_range_header():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/buckets/bkt-1/resolve/x", body=b"cdef")
        out = await read_bytes(acc,
                               PathSpec.from_str_path("/x"),
                               offset=2,
                               size=4)
        assert out == b"cdef"
        requests = m.requests
        resolve_key = next(k for k in requests if "resolve/x" in str(k[1]))
        assert (requests[resolve_key][-1].kwargs["headers"]["Range"] ==
                "bytes=2-5")


@pytest.mark.asyncio
async def test_read_bytes_404_raises_filenotfound():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/buckets/bkt-1/resolve/nope", status=404)
        with pytest.raises(FileNotFoundError):
            await read_bytes(acc, PathSpec.from_str_path("/nope"))


@pytest.mark.asyncio
async def test_read_bytes_accepts_206_partial_content():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.get("https://huggingface.co/buckets/bkt-1/resolve/x",
              status=206,
              body=b"cdef")
        out = await read_bytes(acc,
                               PathSpec.from_str_path("/x"),
                               offset=2,
                               size=4)
    assert out == b"cdef"
