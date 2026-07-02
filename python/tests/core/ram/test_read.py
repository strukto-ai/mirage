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
from mirage.core.ram.read import read_bytes
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/hello.txt"] = b"hello world"
    s.dirs.add("/sub")
    s.files["/sub/nested.txt"] = b"nested"
    return a


@pytest.mark.asyncio
async def test_read_bytes(store):
    result = await read_bytes(
        store,
        PathSpec(resource_path=("/hello.txt").strip("/"),
                 virtual="/hello.txt",
                 directory="/hello.txt"))
    assert result == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_nested(store):
    result = await read_bytes(
        store,
        PathSpec(resource_path=("/sub/nested.txt").strip("/"),
                 virtual="/sub/nested.txt",
                 directory="/sub/nested.txt"))
    assert result == b"nested"


@pytest.mark.asyncio
async def test_read_bytes_not_found(store):
    with pytest.raises(FileNotFoundError):
        await read_bytes(
            store,
            PathSpec(resource_path=("/nope.txt").strip("/"),
                     virtual="/nope.txt",
                     directory="/nope.txt"))


@pytest.mark.asyncio
async def test_read_bytes_empty_file():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/empty"] = b""
    result = await read_bytes(
        a,
        PathSpec(resource_path=("/empty").strip("/"),
                 virtual="/empty",
                 directory="/empty"))
    assert result == b""


@pytest.mark.asyncio
async def test_read_bytes_binary_data():
    s = RAMStore()

    a = RAMAccessor(s)
    data = bytes(range(256))
    s.files["/bin"] = data
    result = await read_bytes(
        a,
        PathSpec(resource_path=("/bin").strip("/"),
                 virtual="/bin",
                 directory="/bin"))
    assert result == data


@pytest.mark.asyncio
async def test_read_bytes_normalizes_path():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/file.txt"] = b"data"
    result = await read_bytes(
        a,
        PathSpec(resource_path=("file.txt").strip("/"),
                 virtual="file.txt",
                 directory="file.txt"))
    assert result == b"data"
