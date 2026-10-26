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

from mirage.core.tidb_filesystem.rename import rename
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


@pytest.mark.asyncio
async def test_rename_a_file_over_another(accessor, drive9):
    drive9.files.update({"/root/a": b"a", "/root/b": b"b"})

    await rename(accessor, _path("/fs/a"), _path("/fs/b"))

    assert drive9.files == {"/root/b": b"a"}
    assert drive9.count("POST", "/v1/fs:batch-stat") == 1


@pytest.mark.asyncio
async def test_rename_a_directory_with_its_tree(accessor, drive9):
    drive9.dirs.update({"/root/d", "/root/d/e", "/root/x"})
    drive9.files["/root/d/e/f"] = b"x"

    await rename(accessor, _path("/fs/d"), _path("/fs/x/d2"))

    assert drive9.files == {"/root/x/d2/e/f": b"x"}
    assert "/root/d" not in drive9.dirs


@pytest.mark.asyncio
async def test_rename_into_a_missing_folder_is_enoent(accessor, drive9):
    drive9.files["/root/a"] = b"a"

    with pytest.raises(FileNotFoundError):
        await rename(accessor, _path("/fs/a"), _path("/fs/nope/a"))

    assert drive9.files == {"/root/a": b"a"}


@pytest.mark.asyncio
async def test_rename_a_directory_onto_a_full_one_is_enotempty(
    accessor, drive9
):
    drive9.dirs.update({"/root/d", "/root/full"})
    drive9.files["/root/full/x"] = b"x"

    with pytest.raises(OSError) as raised:
        await rename(accessor, _path("/fs/d"), _path("/fs/full"))

    assert raised.value.strerror == "Directory not empty"


@pytest.mark.asyncio
async def test_rename_onto_itself_sends_no_move(accessor, drive9):
    drive9.files["/root/a"] = b"a"

    await rename(accessor, _path("/fs/a"), _path("/fs/a"))

    assert drive9.count("POST", "/root/a") == 0
