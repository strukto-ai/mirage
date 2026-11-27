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
from mirage.core.gdrive.rm import rm_r
from mirage.types import PathSpec
from tests.fixtures.handed import call


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_rm_r_removes_tree(google_account):
    folder = await google_account.folder("d")
    sub = await google_account.folder("s", folder)
    await google_account.upload("f.txt", b"x", sub)
    await call(rm_r, readdir, google_account.drive_accessor(), spec("/d"))
    assert await google_account.items() == []


@pytest.mark.asyncio
async def test_rm_r_missing_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await call(
            rm_r, readdir, google_account.drive_accessor(), spec("/missing")
        )
