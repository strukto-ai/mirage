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
from mirage.core.ram.stat import stat
from mirage.resource.ram.store import RAMStore
from mirage.types import FileType, PathSpec


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/hello.txt"] = b"hello world"
    s.dirs.add("/sub")
    s.files["/data.json"] = b'{"key": "value"}'
    s.files["/img.png"] = b"\x89PNG"
    return a


@pytest.fixture
def accessor(store):
    return store


@pytest.mark.asyncio
async def test_stat_root():
    s = RAMStore()

    a = RAMAccessor(s)
    result = await stat(a,
                        PathSpec(resource_path="", virtual="/", directory="/"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_file(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="hello.txt",
                 virtual="/hello.txt",
                 directory="/hello.txt"))
    assert result.name == "hello.txt"
    assert result.size == 11
    assert result.type == FileType.TEXT


@pytest.mark.asyncio
async def test_stat_directory(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="sub", virtual="/sub", directory="/sub"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "sub"
    assert result.size is None


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path="nope", virtual="/nope", directory="/nope"))


@pytest.mark.asyncio
async def test_stat_json_file(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="data.json",
                 virtual="/data.json",
                 directory="/data.json"))
    assert result.type == FileType.JSON
    assert result.size == 16


@pytest.mark.asyncio
async def test_stat_image_file(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="img.png",
                 virtual="/img.png",
                 directory="/img.png"))
    assert result.type == FileType.IMAGE_PNG
