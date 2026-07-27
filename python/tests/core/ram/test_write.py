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
        PathSpec(resource_path="hello.txt",
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
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b"first")
    await write_bytes(
        store,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b"second")
    assert store.store.files["/file.txt"] == b"second"


@pytest.mark.asyncio
async def test_write_bytes_parent_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    # The operand is what a GNU stderr line names, so the error carries the
    # virtual path, not the internal "parent does not exist" phrasing.
    with pytest.raises(FileNotFoundError, match="/no/parent/file.txt"):
        await write_bytes(
            a,
            PathSpec(resource_path="no/parent/file.txt",
                     virtual="/no/parent/file.txt",
                     directory="/no/parent/file.txt"), b"data")
    assert "/no/parent/file.txt" not in s.files


@pytest.mark.asyncio
async def test_write_bytes_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await write_bytes(
            a,
            PathSpec(resource_path="plain/file.txt",
                     virtual="/plain/file.txt",
                     directory="/plain/file.txt"), b"data")
    assert "/plain/file.txt" not in s.files


@pytest.mark.asyncio
async def test_write_bytes_deep_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await write_bytes(
            a,
            PathSpec(resource_path="plain/sub/file.txt",
                     virtual="/plain/sub/file.txt",
                     directory="/plain/sub/file.txt"), b"data")


@pytest.mark.asyncio
async def test_write_bytes_to_subdir(store):
    await write_bytes(
        store,
        PathSpec(resource_path="sub/file.txt",
                 virtual="/sub/file.txt",
                 directory="/sub/file.txt"), b"nested data")
    assert store.store.files["/sub/file.txt"] == b"nested data"


@pytest.mark.asyncio
async def test_write_bytes_root_parent():
    s = RAMStore()

    a = RAMAccessor(s)
    await write_bytes(
        a,
        PathSpec(resource_path="root_file.txt",
                 virtual="/root_file.txt",
                 directory="/root_file.txt"), b"root")
    assert s.files["/root_file.txt"] == b"root"


@pytest.mark.asyncio
async def test_write_bytes_sets_modified(store):
    await write_bytes(
        store,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b"data")
    assert store.store.modified["/file.txt"] is not None
