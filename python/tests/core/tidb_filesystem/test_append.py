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

from mirage.core.tidb_filesystem.append import append
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


async def _stream(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


@pytest.mark.asyncio
async def test_a_large_file_takes_the_bytes_natively(accessor, drive9):
    drive9.part_size = 25_000
    drive9.files["/root/big.bin"] = b"x" * 60_000

    scope = RecordingScope()
    try:
        await append(accessor, _path("/fs/big.bin"), _stream(b"ab", b"cd"))
    finally:
        scope.close()

    assert drive9.files["/root/big.bin"] == b"x" * 60_000 + b"abcd"
    assert drive9.count("GET", "/root") == 0
    assert [(r.op, r.path, r.bytes) for r in scope.records] == [
        ("append", "/fs/big.bin", 4)
    ]


@pytest.mark.asyncio
async def test_an_inline_file_is_read_and_written_back(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    await append(accessor, _path("/fs/a.txt"), b" world")

    assert drive9.files["/root/a.txt"] == b"hello world"


@pytest.mark.asyncio
async def test_a_missing_file_is_made(accessor, drive9):
    await append(accessor, _path("/fs/new.txt"), b"first")

    assert drive9.files["/root/new.txt"] == b"first"


@pytest.mark.asyncio
async def test_nothing_appended_makes_a_missing_file(accessor, drive9):
    await append(accessor, _path("/fs/new.txt"), b"")

    assert drive9.files["/root/new.txt"] == b""
    assert drive9.count("POST", "/root") == 0


@pytest.mark.asyncio
async def test_nothing_appended_leaves_a_file_alone(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    await append(accessor, _path("/fs/a.txt"), b"")

    assert drive9.files["/root/a.txt"] == b"hello"
    assert drive9.count("PUT") == 0


@pytest.mark.asyncio
async def test_a_directory_is_eisdir(accessor, drive9):
    drive9.dirs.add("/root/d")

    with pytest.raises(IsADirectoryError):
        await append(accessor, _path("/fs/d"), b"x")

    assert "/root/d" not in drive9.files


@pytest.mark.asyncio
async def test_a_missing_folder_is_enoent(accessor, drive9):
    with pytest.raises(FileNotFoundError):
        await append(accessor, _path("/fs/nope/a.txt"), b"x")

    assert "/root/nope" not in drive9.dirs
