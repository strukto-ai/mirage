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
from mirage.core.ram.write import write_bytes
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/sub")
    return a


@pytest.mark.asyncio
async def test_write_bytes(store):
    await write_bytes(
        store,
        PathSpec(resource_path=("/hello.txt").strip("/"),
                 virtual="/hello.txt",
                 directory="/hello.txt"), b"hello")
    assert store.store.files["/hello.txt"] == b"hello"
    assert "/hello.txt" in store.store.modified
    assert store.store.modified["/hello.txt"].endswith("Z")
    assert "+00:00" not in store.store.modified["/hello.txt"]


@pytest.mark.asyncio
async def test_write_bytes_overwrite(store):
    await write_bytes(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"), b"first")
    await write_bytes(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"), b"second")
    assert store.store.files["/file.txt"] == b"second"


@pytest.mark.asyncio
async def test_write_bytes_parent_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError,
                       match="parent directory does not exist"):
        await write_bytes(
            a,
            PathSpec(resource_path=("/no/parent/file.txt").strip("/"),
                     virtual="/no/parent/file.txt",
                     directory="/no/parent/file.txt"), b"data")


@pytest.mark.asyncio
async def test_write_bytes_to_subdir(store):
    await write_bytes(
        store,
        PathSpec(resource_path=("/sub/file.txt").strip("/"),
                 virtual="/sub/file.txt",
                 directory="/sub/file.txt"), b"nested data")
    assert store.store.files["/sub/file.txt"] == b"nested data"


@pytest.mark.asyncio
async def test_write_bytes_root_parent():
    s = RAMStore()

    a = RAMAccessor(s)
    await write_bytes(
        a,
        PathSpec(resource_path=("/root_file.txt").strip("/"),
                 virtual="/root_file.txt",
                 directory="/root_file.txt"), b"root")
    assert s.files["/root_file.txt"] == b"root"


@pytest.mark.asyncio
async def test_write_bytes_sets_modified(store):
    await write_bytes(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"), b"data")
    assert store.store.modified["/file.txt"] is not None
