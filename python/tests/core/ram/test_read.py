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

import tracemalloc

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.read import read
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevStore
from mirage.vfs.ram.store import RAMStore


@pytest.mark.asyncio
@pytest.mark.parametrize("factory", [RAMStore, DevStore])
async def test_small_read_of_a_modified_file_allocates_only_the_window(
    factory,
):
    store = factory()
    accessor = RAMAccessor(store)
    path = PathSpec.from_str_path("/log")
    store.files["/log"] = bytes(4 << 20)
    store.files.splice("/log", 32, b"before")
    tracemalloc.start()
    try:
        snapshot = await read(accessor, path, 32, 6)
        store.files.splice("/log", 32, b"after!")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 1 << 20
    assert snapshot == b"before"
    assert await read(accessor, path, 32, 6) == b"after!"


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/hello.txt"] = b"hello world"
    s.dirs.add("/sub")
    s.files["/sub/nested.txt"] = b"nested"
    return a


@pytest.mark.asyncio
async def test_read_window_from_a_plain_file_mapping():
    accessor = RAMAccessor(RAMStore(files={"/log": b"hello"}))
    assert await read(accessor, PathSpec.from_str_path("/log"), 1, 3) == b"ell"


@pytest.mark.asyncio
async def test_read_bytes(store):
    result = await read(
        store,
        PathSpec(
            vfs_path="hello.txt", virtual="/hello.txt", directory="/hello.txt"
        ),
    )
    assert result == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_nested(store):
    result = await read(
        store,
        PathSpec(
            vfs_path="sub/nested.txt",
            virtual="/sub/nested.txt",
            directory="/sub/nested.txt",
        ),
    )
    assert result == b"nested"


@pytest.mark.asyncio
async def test_read_bytes_not_found(store):
    with pytest.raises(FileNotFoundError):
        await read(
            store,
            PathSpec(
                vfs_path="nope.txt", virtual="/nope.txt", directory="/nope.txt"
            ),
        )


@pytest.mark.asyncio
async def test_read_bytes_empty_file():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/empty"] = b""
    result = await read(
        a, PathSpec(vfs_path="empty", virtual="/empty", directory="/empty")
    )
    assert result == b""


@pytest.mark.asyncio
async def test_read_bytes_binary_data():
    s = RAMStore()

    a = RAMAccessor(s)
    data = bytes(range(256))
    s.files["/bin"] = data
    result = await read(
        a, PathSpec(vfs_path="bin", virtual="/bin", directory="/bin")
    )
    assert result == data


@pytest.mark.asyncio
async def test_read_bytes_normalizes_path():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/file.txt"] = b"data"
    result = await read(
        a,
        PathSpec(
            vfs_path="file.txt", virtual="file.txt", directory="file.txt"
        ),
    )
    assert result == b"data"


@pytest.mark.asyncio
async def test_read_bytes_directory_is_eisdir(store):
    with pytest.raises(IsADirectoryError):
        await read(store, PathSpec.from_str_path("/sub"))
