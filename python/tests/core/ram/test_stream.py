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

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.stream import stream
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_stream_reads_content():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/file.txt"] = b"hello world"
    chunks = []
    async for chunk in stream(a, PathSpec.from_str_path("/file.txt")):
        chunks.append(chunk)
    assert b"".join(chunks) == b"hello world"


@pytest.mark.asyncio
async def test_stream_single_chunk():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/file.txt"] = b"data"
    chunks = []
    async for chunk in stream(a, PathSpec.from_str_path("/file.txt")):
        chunks.append(chunk)
    assert len(chunks) == 1


@pytest.mark.asyncio
async def test_stream_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        async for _ in stream(a, PathSpec.from_str_path("/nope.txt")):
            pass


@pytest.mark.asyncio
async def test_stream_empty_file():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/empty"] = b""
    chunks = []
    async for chunk in stream(a, PathSpec.from_str_path("/empty")):
        chunks.append(chunk)
    assert b"".join(chunks) == b""
