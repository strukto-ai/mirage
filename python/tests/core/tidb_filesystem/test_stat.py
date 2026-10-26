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

from mirage.core.tidb_filesystem.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


@pytest.mark.asyncio
async def test_file_stat_is_one_head(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    found = await stat(accessor, _path("/fs/a.txt"))

    assert (found.name, found.size, found.type) == ("a.txt", 5, FileType.FILE)
    assert found.modified is not None
    assert drive9.requests == [("HEAD", "/root/a.txt?")]


@pytest.mark.asyncio
async def test_mount_root_is_a_directory_without_a_request(accessor, drive9):
    found = await stat(accessor, _path("/fs/"))

    assert found.type == FileType.DIRECTORY
    assert drive9.requests == []


@pytest.mark.asyncio
async def test_trailing_slash_asks_for_the_directory(accessor, drive9):
    drive9.files["/root/both"] = b"file"
    drive9.dirs.add("/root/both")

    plain = await stat(accessor, _path("/fs/both"))
    slashed = await stat(accessor, _path("/fs/both/"))

    assert plain.type == FileType.FILE
    assert slashed.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_file_asked_as_a_directory_is_enotdir(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    with pytest.raises(NotADirectoryError):
        await stat(accessor, _path("/fs/a.txt/"))


@pytest.mark.asyncio
async def test_missing_under_a_file_is_enotdir(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    with pytest.raises(NotADirectoryError) as raised:
        await stat(accessor, _path("/fs/a.txt/x"))

    assert raised.value.filename == "/fs/a.txt/x"


@pytest.mark.asyncio
async def test_missing_is_enoent(accessor, drive9):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _path("/fs/nope"))
