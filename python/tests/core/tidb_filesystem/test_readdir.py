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

from mirage.core.tidb_filesystem.readdir import readdir
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


@pytest.mark.asyncio
async def test_listing_is_one_request_sorted(accessor, drive9):
    drive9.files.update({"/root/b.txt": b"bb", "/root/a.txt": b"a"})
    drive9.dirs.add("/root/sub")

    rows = await readdir(accessor, _path("/fs/"))

    assert [(r.name, r.type, r.size) for r in rows] == [
        ("a.txt", FileType.FILE, 1),
        ("b.txt", FileType.FILE, 2),
        ("sub", FileType.DIRECTORY, None),
    ]
    assert drive9.requests == [("GET", "/root?list")]


@pytest.mark.asyncio
async def test_a_name_that_is_both_lists_once_as_the_directory(
    accessor, drive9
):
    drive9.files["/root/both"] = b"file"
    drive9.dirs.add("/root/both")

    rows = await readdir(accessor, _path("/fs/"))

    assert [(r.name, r.type) for r in rows] == [("both", FileType.DIRECTORY)]


@pytest.mark.asyncio
async def test_empty_directory_is_empty(accessor, drive9):
    drive9.dirs.add("/root/empty")

    assert await readdir(accessor, _path("/fs/empty")) == []
    assert drive9.count("POST", "/v1/fs:batch-stat") == 1


@pytest.mark.asyncio
async def test_missing_directory_is_enoent(accessor, drive9):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, _path("/fs/nope"))


@pytest.mark.asyncio
async def test_file_is_enotdir(accessor, drive9):
    drive9.files["/root/a.txt"] = b"x"

    with pytest.raises(NotADirectoryError):
        await readdir(accessor, _path("/fs/a.txt"))


@pytest.mark.asyncio
async def test_rows_sort_by_code_point(accessor, drive9):
    drive9.files.update({"/root/\U0001d538": b"a", "/root/\uff5a": b"z"})

    rows = await readdir(accessor, _path("/fs/"))

    assert [r.name for r in rows] == ["\uff5a", "\U0001d538"]
