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

from collections.abc import AsyncIterator

import pytest

from mirage.core.tidb_filesystem.create import create
from mirage.core.tidb_filesystem.write import write
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


async def _stream(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


@pytest.mark.asyncio
async def test_write_is_one_check_and_one_put(accessor, drive9):
    await write(accessor, _path("/fs/a.txt"), b"hello")

    assert drive9.files["/root/a.txt"] == b"hello"
    assert drive9.requests == [
        ("POST", "/v1/fs:batch-stat"),
        ("PUT", "/root/a.txt?"),
    ]


@pytest.mark.asyncio
async def test_a_streamed_write_goes_up_in_parts(accessor, drive9):
    drive9.part_size = 20_000

    await write(accessor, _path("/fs/big.bin"), _stream(*[b"z" * 10_000] * 6))

    assert drive9.files["/root/big.bin"] == b"z" * 60_000
    assert drive9.count("PUT", "/s3/upload") == 3


@pytest.mark.asyncio
async def test_write_under_a_missing_folder_is_enoent(accessor, drive9):
    with pytest.raises(FileNotFoundError):
        await write(accessor, _path("/fs/nope/a.txt"), b"x")

    assert "/root/nope" not in drive9.dirs
    assert drive9.count("PUT") == 0


@pytest.mark.asyncio
async def test_write_under_a_file_is_enotdir(accessor, drive9):
    drive9.files["/root/a.txt"] = b"x"

    with pytest.raises(NotADirectoryError):
        await write(accessor, _path("/fs/a.txt/b"), b"x")


@pytest.mark.asyncio
async def test_write_onto_a_directory_is_eisdir(accessor, drive9):
    drive9.dirs.add("/root/d")

    with pytest.raises(IsADirectoryError):
        await write(accessor, _path("/fs/d"), b"x")

    assert "/root/d" not in drive9.files


@pytest.mark.asyncio
async def test_create_writes_an_empty_file(accessor, drive9):
    await create(accessor, _path("/fs/empty"))

    assert drive9.files["/root/empty"] == b""
