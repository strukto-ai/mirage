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
from mirage.core.hf_buckets.stat import stat
from mirage.types import FileType, PathSpec


@pytest.mark.asyncio
async def test_stat_root_directory_is_local():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    out = await stat(acc, PathSpec.from_str_path("/"))
    assert out.type == FileType.DIRECTORY
    assert out.name == "/"


@pytest.mark.asyncio
async def test_stat_file_returns_size_and_xet_hash():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.head("https://huggingface.co/buckets/bkt-1/resolve/data/x.txt",
               status=200,
               headers={
                   "Content-Length": "11",
                   "X-Xet-Hash": "deadbeef",
                   "Last-Modified": "Mon, 26 May 2026 10:00:00 GMT",
               })
        out = await stat(acc, PathSpec.from_str_path("/data/x.txt"))
    assert out.size == 11
    assert out.fingerprint == "deadbeef"
    assert out.extra["xet_hash"] == "deadbeef"


@pytest.mark.asyncio
async def test_stat_directory_via_tree_probe():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.head("https://huggingface.co/buckets/bkt-1/resolve/data", status=404)
        m.get("https://huggingface.co/api/buckets/bkt-1/tree/data/",
              payload=[{
                  "type": "file",
                  "path": "data/x.txt",
                  "size": 1
              }])
        out = await stat(acc, PathSpec.from_str_path("/data"))
    assert out.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_missing_raises_filenotfound():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.head("https://huggingface.co/buckets/bkt-1/resolve/nope.txt",
               status=404)
        m.get("https://huggingface.co/api/buckets/bkt-1/tree/nope.txt/",
              status=404)
        with pytest.raises(FileNotFoundError):
            await stat(acc, PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_stat_403_propagates_as_client_error():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.head("https://huggingface.co/buckets/bkt-1/resolve/secret.txt",
               status=403)
        with pytest.raises(Exception) as exc_info:
            await stat(acc, PathSpec.from_str_path("/secret.txt"))
    # Should propagate as some HTTP-level exception, not FileNotFoundError.
    assert not isinstance(exc_info.value, FileNotFoundError)
