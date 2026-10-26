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

from mirage.core.tidb_filesystem.rm import rm_recursive
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


@pytest.mark.asyncio
async def test_rm_r_is_one_delete(accessor, drive9):
    drive9.dirs.update({"/root/d", "/root/d/e"})
    drive9.files["/root/d/e/f"] = b"x"

    await rm_recursive(accessor, _path("/fs/d"))

    assert drive9.dirs == {"/root"}
    assert drive9.requests == [("DELETE", "/root/d?recursive")]


@pytest.mark.asyncio
async def test_rm_r_of_missing_is_enoent(accessor, drive9):
    with pytest.raises(FileNotFoundError):
        await rm_recursive(accessor, _path("/fs/nope"))
