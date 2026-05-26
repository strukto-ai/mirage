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
from mirage.core.hf_buckets.exists import exists
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_exists_true_for_file():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.head("https://huggingface.co/buckets/bkt-1/resolve/foo.txt",
               status=200,
               headers={"Content-Length": "3"})
        assert await exists(acc, PathSpec.from_str_path("/foo.txt")) is True


@pytest.mark.asyncio
async def test_exists_false_for_missing():
    cfg = HfBucketsConfig(bucket="o/b", token="t")
    acc = HfBucketsAccessor(cfg)
    with aioresponses() as m:
        m.get("https://huggingface.co/api/buckets/o/b",
              payload={"id": "bkt-1"})
        m.head("https://huggingface.co/buckets/bkt-1/resolve/nope.txt",
               status=404)
        m.get("https://huggingface.co/api/buckets/bkt-1/tree/nope.txt/",
              status=404)
        assert await exists(acc, PathSpec.from_str_path("/nope.txt")) is False
