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

from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.unlink import unlink
from mirage.types import PathSpec
from tests.fixtures.handed import call, entry_at


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_unlink_removes_file(fake_drive, gdrive_accessor):
    fake_drive.add("f.txt", content=b"x")
    await call(unlink, readdir, gdrive_accessor, spec("/f.txt"))
    assert fake_drive.find("f.txt") is None


@pytest.mark.asyncio
async def test_unlink_missing_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await call(unlink, readdir, gdrive_accessor, spec("/missing.txt"))


@pytest.mark.asyncio
async def test_unlink_folder_raises(fake_drive, gdrive_accessor):
    fake_drive.folder("d")
    with pytest.raises(IsADirectoryError):
        await call(unlink, readdir, gdrive_accessor, spec("/d"))


@pytest.mark.asyncio
async def test_an_unlink_removes_the_file_at_the_path_now(
    fake_drive, gdrive_accessor
):
    # The listing named a.txt; another client then renamed that file to
    # b.txt and made a new a.txt. The unlink removes the new a.txt.
    moved = fake_drive.add("a.txt", content=b"old")
    path = PathSpec.from_str_path("/a.txt")
    listed = await entry_at(readdir, gdrive_accessor, path)
    fake_drive.items[moved]["name"] = "b.txt"
    made = fake_drive.add("a.txt", content=b"other")
    await unlink(gdrive_accessor, path, listed)
    assert made not in fake_drive.items
    assert moved in fake_drive.items
