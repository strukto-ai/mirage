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

from mirage.core.tidb_filesystem.read import read
from mirage.core.tidb_filesystem.stream import read_stream
from mirage.errors.fs import OperationNotSupportedError
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


@pytest.mark.asyncio
async def test_read_window(accessor, drive9):
    drive9.files["/root/a.txt"] = b"0123456789"

    assert await read(accessor, _path("/fs/a.txt"), 3, 4) == b"3456"


@pytest.mark.asyncio
async def test_stream_of_a_large_file(accessor, drive9):
    data = b"z" * 70_000
    drive9.files["/root/big"] = data

    chunks = [c async for c in read_stream(accessor, _path("/fs/big"))]

    assert b"".join(chunks) == data
    assert drive9.leaked == []


@pytest.mark.asyncio
async def test_directory_is_eisdir(accessor, drive9):
    drive9.dirs.add("/root/d")

    with pytest.raises(IsADirectoryError):
        await read(accessor, _path("/fs/d"), 0, 10)


@pytest.mark.asyncio
async def test_stream_of_missing_is_enoent(accessor, drive9):
    with pytest.raises(FileNotFoundError):
        async for _ in read_stream(accessor, _path("/fs/nope")):
            pass


@pytest.mark.asyncio
async def test_extent_file_is_not_supported(accessor, drive9):
    drive9.files["/root/db.sqlite"] = b""
    drive9.extent.add("/root/db.sqlite")

    with pytest.raises(OperationNotSupportedError):
        await read(accessor, _path("/fs/db.sqlite"), 0, 10)
