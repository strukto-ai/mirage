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

from mirage.core.tidb_filesystem.mkdir import mkdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


@pytest.mark.asyncio
async def test_mkdir(accessor, drive9):
    await mkdir(accessor, _path("/fs/d"))

    assert "/root/d" in drive9.dirs


@pytest.mark.asyncio
async def test_mkdir_without_parent_is_enoent(accessor, drive9):
    with pytest.raises(FileNotFoundError):
        await mkdir(accessor, _path("/fs/a/b"))

    assert "/root/a" not in drive9.dirs


@pytest.mark.asyncio
async def test_mkdir_on_a_file_is_eexist(accessor, drive9):
    drive9.files["/root/f"] = b"x"

    with pytest.raises(FileExistsError):
        await mkdir(accessor, _path("/fs/f"))


@pytest.mark.asyncio
async def test_mkdir_p_makes_the_chain(accessor, drive9):
    await mkdir(accessor, _path("/fs/a/b/c"), parents=True)

    assert {"/root/a", "/root/a/b", "/root/a/b/c"} <= drive9.dirs


@pytest.mark.asyncio
async def test_mkdir_p_on_an_existing_directory_sends_nothing(
    accessor, drive9
):
    drive9.dirs.add("/root/d")

    await mkdir(accessor, _path("/fs/d"), parents=True)

    assert drive9.count("POST", "/root/d") == 0


@pytest.mark.asyncio
async def test_mkdir_p_through_a_folder_that_is_also_a_file(accessor, drive9):
    drive9.files["/root/x"] = b"file"
    drive9.dirs.add("/root/x")

    await mkdir(accessor, _path("/fs/x/y"), parents=True)

    assert "/root/x/y" in drive9.dirs


@pytest.mark.asyncio
async def test_mkdir_p_through_a_file_is_enotdir(accessor, drive9):
    drive9.files["/root/f"] = b"x"

    with pytest.raises(NotADirectoryError) as raised:
        await mkdir(accessor, _path("/fs/f/sub"), parents=True)

    assert raised.value.filename == "/fs/f"
    assert "/root/f/sub" not in drive9.dirs
