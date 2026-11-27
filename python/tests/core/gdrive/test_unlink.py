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
async def test_unlink_removes_file(google_account):
    await google_account.upload("f.txt", b"x")
    await call(
        unlink, readdir, google_account.drive_accessor(), spec("/f.txt")
    )
    assert await google_account.find("f.txt") is None


@pytest.mark.asyncio
async def test_unlink_missing_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await call(
            unlink,
            readdir,
            google_account.drive_accessor(),
            spec("/missing.txt"),
        )


@pytest.mark.asyncio
async def test_unlink_folder_raises(google_account):
    await google_account.folder("d")
    with pytest.raises(IsADirectoryError):
        await call(
            unlink, readdir, google_account.drive_accessor(), spec("/d")
        )


@pytest.mark.asyncio
async def test_an_unlink_removes_the_file_at_the_path_now(google_account):
    # The listing named a.txt; another client then renamed that file to
    # b.txt and made a new a.txt. The unlink removes the new a.txt.
    moved = await google_account.upload("a.txt", b"old")
    accessor = google_account.drive_accessor()
    path = PathSpec.from_str_path("/a.txt")
    listed = await entry_at(readdir, accessor, path)
    await google_account.patch(moved, name="b.txt")
    made = await google_account.upload("a.txt", b"other")
    await unlink(accessor, path, listed)
    ids = {item["id"] for item in await google_account.items()}
    assert made not in ids
    assert moved in ids
