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

from mirage.core.hf_buckets.read import read_bytes
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_read_bytes_whole_file(make_acc):
    acc = make_acc({"greet.txt": b"hello world"})
    out = await read_bytes(acc, PathSpec.from_str_path("/greet.txt"))
    assert out == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_offset_size_returns_slice(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read_bytes(acc, PathSpec.from_str_path("/x"), offset=2, size=4)
    assert out == b"cdef"


@pytest.mark.asyncio
async def test_read_bytes_missing_raises_filenotfound(make_acc):
    acc = make_acc({})
    with pytest.raises(FileNotFoundError):
        await read_bytes(acc, PathSpec.from_str_path("/nope"))


@pytest.mark.asyncio
async def test_read_bytes_offset_only(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read_bytes(acc, PathSpec.from_str_path("/x"), offset=3)
    assert out == b"def"
