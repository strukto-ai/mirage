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

from mirage.core.gdrive.rm import rm_r
from mirage.types import PathSpec


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_rm_r_removes_tree(fake_drive, gdrive_accessor):
    folder = fake_drive.folder("d")
    sub = fake_drive.folder("s", parent=folder)
    fake_drive.add("f.txt", parent=sub, content=b"x")
    await rm_r(gdrive_accessor, spec("/d"))
    assert fake_drive.items == {}


@pytest.mark.asyncio
async def test_rm_r_missing_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await rm_r(gdrive_accessor, spec("/missing"))
