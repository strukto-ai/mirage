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

from mirage.core.hf_buckets.stream import range_read, read_stream
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_range_read_returns_slice(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await range_read(acc, PathSpec.from_str_path("/x"), 1, 4)
    assert out == b"bcd"


@pytest.mark.asyncio
async def test_read_stream_yields_chunks(make_acc):
    acc = make_acc({"x": b"abcdefgh"})
    chunks = []
    async for c in read_stream(acc, PathSpec.from_str_path("/x"),
                               chunk_size=3):
        chunks.append(c)
    assert b"".join(chunks) == b"abcdefgh"
    assert len(chunks) >= 2


@pytest.mark.asyncio
async def test_read_stream_handles_empty_file(make_acc):
    acc = make_acc({"empty": b""})
    chunks = [
        c async for c in read_stream(acc, PathSpec.from_str_path("/empty"))
    ]
    assert b"".join(chunks) == b""
