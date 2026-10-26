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

from mirage.core.tidb_filesystem.rmdir import rmdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


@pytest.mark.asyncio
async def test_rmdir_of_a_full_directory_is_enotempty(accessor, drive9):
    drive9.dirs.add("/root/d")
    drive9.files["/root/d/f"] = b"x"

    with pytest.raises(OSError) as raised:
        await rmdir(accessor, _path("/fs/d"))

    assert raised.value.strerror == "Directory not empty"


@pytest.mark.asyncio
async def test_rmdir_of_a_file_is_enotdir(accessor, drive9):
    drive9.files["/root/f"] = b"x"

    with pytest.raises(NotADirectoryError):
        await rmdir(accessor, _path("/fs/f"))

    assert "/root/f" in drive9.files
